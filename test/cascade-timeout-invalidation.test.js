// Issue #101 (nalayahfowlkest-ship-it): claude-opus-4.6-thinking,
// upstream "context deadline exceeded" mid-stream. The error surfaces
// to the client, but on the next turn the model only sees the latest
// tool_result with no earlier user prompts:
//
//   "I can see the content from a previous tool call ... However, I
//    don't have the earlier conversation context that explains what
//    specific task you'd like me to work on."
//
// Root cause: when cascade upstream times out mid-stream, the cascade
// trajectory is left in an inconsistent state (the assistant never
// finished, but the prior tool_result chunk is in there). The proxy
// previously restored the cascade entry to the reuse pool unconditionally
// (because reuseEntryDead was only set on explicit "cascade not_found"
// errors). Next request reused the half-broken trajectory.
//
// Fix (chat.js stream + non-stream catch blocks): also mark the entry
// dead when the error message matches "context deadline exceeded" or
// "Client.Timeout or context cancellation while reading body". Static
// analysis below pins both code paths.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_JS = readFileSync(join(__dirname, '..', 'src/handlers/chat.js'), 'utf8');

describe('upstream-timeout cascade invalidation (#101)', () => {
  test('stream catch block matches the timeout patterns and sets reuseEntryDead', () => {
    // Find the streamResponse-side catch block. The whole region we care
    // about sits between the `lastErr = err;` assignment and the rate-
    // limit branch — pin it explicitly so a future refactor that splits
    // the block doesn't silently regress.
    const m = CHAT_JS.match(/lastErr = err;\s+reuseEntry = null;[\s\S]{0,1500}?const isAuthFail = /);
    assert.ok(m, 'stream catch block region not found — refactor may have changed shape');
    const region = m[0];
    assert.match(region, /context deadline exceeded/i,
      'stream timeout regex must mention "context deadline exceeded"');
    assert.match(region, /context cancellation while reading body/i,
      'stream timeout regex must mention "context cancellation while reading body"');
    assert.match(region, /client\\?\.timeout/i,
      'stream timeout regex must include Client.Timeout fallback');
    assert.match(region, /reuseEntryDead = true/,
      'stream timeout branch must set reuseEntryDead = true');
  });

  test('non-stream branch matches the same timeout patterns and sets reuseEntryDead', () => {
    // The non-stream path in handleChatCompletions checks
    // `result.body?.error?.message`. Verify the same invalidation logic
    // exists there — without it, non-stream callers (some Cherry Studio
    // configurations, Anthropic SDK with stream=false) would still
    // restore the broken cascade.
    const m = CHAT_JS.match(/if \(result\.reuseEntryInvalid\) reuseEntryDead = true;[\s\S]{0,800}?lastErr = result;/);
    assert.ok(m, 'non-stream invalidation region not found — refactor may have changed shape');
    const region = m[0];
    assert.match(region, /context deadline exceeded/i);
    assert.match(region, /context cancellation while reading body/i);
    assert.match(region, /client\\?\.timeout/i);
    assert.match(region, /reuseEntryDead = true/);
  });

  test('regex actually matches the user-reported error message verbatim', () => {
    // Real error from #101:
    //   "Encountered retryable error from model provider: context
    //    deadline exceeded (Client.Timeout or context cancellation
    //    while reading body)"
    // Reproduce the regex literally to make sure it triggers.
    const re = /context deadline exceeded|context cancellation while reading body|client\.timeout/i;
    const userError = 'Encountered retryable error from model provider: context deadline exceeded (Client.Timeout or context cancellation while reading body)';
    assert.ok(re.test(userError),
      'regex must match the literal error string from issue #101');
  });

  test('regex does NOT match unrelated rate-limit / panel-state errors', () => {
    // Negative cases — make sure we don't over-match and accidentally
    // invalidate the cascade for transient errors that should retry on
    // the same trajectory.
    const re = /context deadline exceeded|context cancellation while reading body|client\.timeout/i;
    assert.equal(re.test('rate limit exceeded for model claude-opus-4-7'), false);
    assert.equal(re.test('Panel state not found for sessionId xxx'), false);
    assert.equal(re.test('cascade not_found upstream after 3 retries'), false);
    assert.equal(re.test('internal error occurred (Error ID: abc)'), false);
  });
});
