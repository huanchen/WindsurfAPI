// #103 (denvey): allowlist/blocklist must auto-inherit between a base
// model and its `-thinking` reasoning variant.
//
// Pre-fix UX bug: the dashboard surfaces base names (e.g.
// `claude-opus-4.6`); a user who carefully allowlists that name still
// gets a 403 the moment a request resolves to `claude-opus-4.6-thinking`,
// with no obvious connection to anything they configured. Same trap on
// the blocklist side: an operator who blocks the base would be surprised
// to see -thinking slip past.
//
// Other suffixes (-fast, -1m, -low/medium/high/xhigh, -mini, -nano,
// -codex, -max-*) are intentionally NOT inherited — those represent
// distinct entitlements (different context window, latency tier,
// pricing, or model architecture).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getModelAccessConfig,
  isModelAllowed,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';

const original = getModelAccessConfig();
after(() => {
  setModelAccessMode(original.mode);
  setModelAccessList(original.list);
});

describe('isModelAllowed thinking-variant inheritance (#103)', () => {
  test('allowlist: base entry implies the -thinking sibling', () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-opus-4.6']);
    assert.equal(isModelAllowed('claude-opus-4.6').allowed, true);
    assert.equal(isModelAllowed('claude-opus-4.6-thinking').allowed, true,
      'allowlisting the base must auto-allow the -thinking sibling');
  });

  test('allowlist: -thinking entry implies the base sibling', () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-sonnet-4.6-thinking']);
    assert.equal(isModelAllowed('claude-sonnet-4.6-thinking').allowed, true);
    assert.equal(isModelAllowed('claude-sonnet-4.6').allowed, true);
  });

  test('allowlist: unrelated suffixes (-fast / -1m / -high) are NOT inherited', () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-opus-4.6']);
    // These represent distinct entitlements (context window, tier,
    // pricing) — they must remain individually gated.
    assert.equal(isModelAllowed('claude-opus-4.6-fast').allowed, false);
    assert.equal(isModelAllowed('claude-opus-4.6-1m').allowed, false);
    assert.equal(isModelAllowed('claude-opus-4.6-high').allowed, false);
  });

  test('allowlist: empty list rejects everything (including -thinking)', () => {
    setModelAccessMode('allowlist');
    setModelAccessList([]);
    assert.equal(isModelAllowed('claude-opus-4.6').allowed, false);
    assert.equal(isModelAllowed('claude-opus-4.6-thinking').allowed, false);
  });

  test('blocklist: base entry also blocks the -thinking sibling', () => {
    setModelAccessMode('blocklist');
    setModelAccessList(['claude-opus-4.6']);
    const baseRes = isModelAllowed('claude-opus-4.6');
    const thinkRes = isModelAllowed('claude-opus-4.6-thinking');
    assert.equal(baseRes.allowed, false);
    assert.equal(thinkRes.allowed, false,
      'blocking the base must auto-block the -thinking sibling');
    assert.match(thinkRes.reason || '', /-thinking|claude-opus-4\.6/);
  });

  test('blocklist: -thinking entry also blocks the base sibling', () => {
    setModelAccessMode('blocklist');
    setModelAccessList(['claude-sonnet-4.6-thinking']);
    assert.equal(isModelAllowed('claude-sonnet-4.6-thinking').allowed, false);
    assert.equal(isModelAllowed('claude-sonnet-4.6').allowed, false);
  });

  test('blocklist: unrelated suffixes pass when only the base is blocked', () => {
    setModelAccessMode('blocklist');
    setModelAccessList(['claude-opus-4.6']);
    assert.equal(isModelAllowed('claude-opus-4.6-fast').allowed, true);
    assert.equal(isModelAllowed('claude-opus-4.6-mini').allowed, true);
    assert.equal(isModelAllowed('claude-opus-4.6-codex').allowed, true);
  });

  test('mode=all bypasses inheritance entirely (everything allowed)', () => {
    setModelAccessMode('all');
    setModelAccessList(['claude-opus-4.6']);  // list ignored in 'all' mode
    assert.equal(isModelAllowed('claude-opus-4.6-thinking').allowed, true);
    assert.equal(isModelAllowed('any-other-model').allowed, true);
  });
});
