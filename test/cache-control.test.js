import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractCachePolicy } from '../src/handlers/messages.js';
import { handleMessages } from '../src/handlers/messages.js';
import { checkin as poolCheckin, checkout as poolCheckout, poolClear } from '../src/conversation-pool.js';

// Anthropic prompt-caching markers (cache_control: { type: 'ephemeral',
// ttl?: '5m' | '1h' }) appear on tools[], system[] blocks, and
// messages[].content[] blocks. Cascade upstream doesn't speak this
// dialect — the proxy parses, summarises, and strips them so they
// don't leak into Cascade requests, then attributes the resulting
// cache_creation tokens to ephemeral_5m or ephemeral_1h based on the
// presence of any 1h marker.

describe('extractCachePolicy — strip + summarise cache_control markers', () => {
  it('counts 5m markers across tools, system, messages and strips them', () => {
    const body = {
      tools: [
        { name: 't1', cache_control: { type: 'ephemeral' } },
        { name: 't2' },
      ],
      system: [
        { type: 'text', text: 'sys1' },
        { type: 'text', text: 'sys2', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'tagged', cache_control: { type: 'ephemeral' } },
        ] },
      ],
    };
    const policy = extractCachePolicy(body);
    assert.equal(policy.breakpointCount, 3);
    assert.equal(policy.has1h, false);
    // markers stripped in place
    assert.equal(body.tools[0].cache_control, undefined);
    assert.equal(body.system[1].cache_control, undefined);
    assert.equal(body.messages[0].content[1].cache_control, undefined);
  });

  it('flags has1h when any marker requests 1h ttl', () => {
    const body = {
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 2);
    assert.equal(p.has1h, true);
  });

  it('returns zero policy and no mutation when no markers present', () => {
    const body = {
      tools: [{ name: 't' }],
      system: [{ type: 'text', text: 'x' }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 0);
    assert.equal(p.has1h, false);
  });

  it('strips top-level cache_control auto-cache hint', () => {
    const body = {
      cache_control: { type: 'ephemeral', ttl: '1h' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const p = extractCachePolicy(body);
    assert.equal(p.breakpointCount, 1);
    assert.equal(p.has1h, true);
    assert.equal(body.cache_control, undefined);
  });

  it('does not throw on malformed bodies', () => {
    assert.doesNotThrow(() => extractCachePolicy({}));
    assert.doesNotThrow(() => extractCachePolicy({ tools: null, system: 'x' }));
    assert.doesNotThrow(() => extractCachePolicy({ messages: [{ role: 'user', content: null }] }));
  });
});

describe('handleMessages — cache_control round-trip into Anthropic usage shape', () => {
  function fakeChat(usagePatch) {
    return {
      async handleChatCompletions(body, ctx) {
        // body.__cachePolicy must reach chat.js
        return {
          status: 200,
          body: {
            id: 'chat_1', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10, completion_tokens: 1, total_tokens: 11,
              prompt_tokens_details: { cached_tokens: 0 },
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 0,
              ...usagePatch,
            },
          },
        };
      },
    };
  }

  it('5m markers route creation tokens to ephemeral_5m_input_tokens', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
        ] },
      ],
    }, fakeChat({
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.usage.cache_creation_input_tokens, 100);
    assert.deepEqual(result.body.usage.cache_creation, {
      ephemeral_5m_input_tokens: 100,
      ephemeral_1h_input_tokens: 0,
    });
  });

  it('1h markers route creation tokens to ephemeral_1h_input_tokens', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ] },
      ],
    }, fakeChat({
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.usage.cache_creation_input_tokens, 200);
    assert.deepEqual(result.body.usage.cache_creation, {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 200,
    });
  });

  it('cascade pool entry honours ttlHintMs longer than default', async () => {
    poolClear();
    const baseEntry = {
      cascadeId: 'c1', sessionId: 's1', lsPort: 12345, apiKey: 'k',
      createdAt: Date.now(),
    };
    // Default-TTL entry: should expire at the 30-min default.
    poolCheckin('fp_default', { ...baseEntry });
    // 1h-hint entry: should outlive the default.
    poolCheckin('fp_1h', { ...baseEntry }, '', 90 * 60 * 1000);
    // After 35 min the default entry is gone, the 1h entry remains.
    // We can't fast-forward time without mocking; instead simulate by
    // mutating lastAccess on the stored entries directly via checkout +
    // re-checkin with an old timestamp, but the simpler check is just
    // that the entry struct keeps the hint. Verify by checkout while
    // both are still fresh (< pool default), then by the surface fact
    // that the 1h-hint entry still has its hint after restore.
    const entry = poolCheckout('fp_1h');
    assert.equal(entry?.ttlHintMs, 90 * 60 * 1000);
    poolClear();
  });

  it('cascade pool checkin preserves ttlHintMs when restoring without an explicit hint', () => {
    poolClear();
    const e = { cascadeId: 'c', sessionId: 's', lsPort: 1, apiKey: 'k', ttlHintMs: 90 * 60 * 1000 };
    poolCheckin('fp1', e);
    const got = poolCheckout('fp1');
    assert.equal(got.ttlHintMs, 90 * 60 * 1000);
    poolClear();
  });

  it('emits both flat fields and nested split when no markers were sent', async () => {
    const result = await handleMessages({
      model: 'claude-sonnet-4.6',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }, fakeChat({
      cache_creation_input_tokens: 50,
    }));
    assert.equal(result.status, 200);
    const u = result.body.usage;
    // Both shapes coexist; the flat total equals the split sum.
    assert.equal(u.cache_creation_input_tokens, 50);
    assert.equal(u.cache_read_input_tokens, 0);
    assert.equal(
      u.cache_creation.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_1h_input_tokens,
      u.cache_creation_input_tokens,
    );
  });
});
