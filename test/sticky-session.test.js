import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We test the module's internal API directly. Because the module reads
// env vars at import time, we set them before the dynamic import.
process.env.STICKY_SESSION_ENABLED = '1';
process.env.STICKY_SESSION_TTL_MS = '5000'; // 5s for testing
process.env.STICKY_SESSION_MAX = '3';

const {
  isStickyEnabled, getStickyBinding, setStickyBinding,
  clearStickyBinding, clearBindingsForAccount, stickyStats,
} = await import('../src/account/sticky-session.js');

describe('sticky-session', () => {
  beforeEach(() => {
    // Clear all bindings between tests
    clearStickyBinding('caller-a');
    clearStickyBinding('caller-b');
    clearStickyBinding('caller-c');
    clearStickyBinding('caller-d');
    clearStickyBinding('caller-e');
  });

  it('isStickyEnabled returns true when env is set', () => {
    assert.equal(isStickyEnabled(), true);
  });

  it('returns null for unknown callerKey', () => {
    assert.equal(getStickyBinding('unknown-key'), null);
  });

  it('returns null for empty callerKey', () => {
    assert.equal(getStickyBinding(''), null);
  });

  it('set then get returns binding', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1');
    const b = getStickyBinding('caller-a');
    assert.deepEqual(b, { accountId: 'acct-1', apiKey: 'key-1' });
  });

  it('update existing binding', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1');
    setStickyBinding('caller-a', 'acct-2', 'key-2');
    const b = getStickyBinding('caller-a');
    assert.deepEqual(b, { accountId: 'acct-2', apiKey: 'key-2' });
  });

  it('clearStickyBinding removes the binding', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1');
    assert.equal(clearStickyBinding('caller-a'), true);
    assert.equal(getStickyBinding('caller-a'), null);
  });

  it('clearStickyBinding returns false for missing key', () => {
    assert.equal(clearStickyBinding('nonexistent'), false);
  });

  it('clearBindingsForAccount removes all bindings for an account', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1');
    setStickyBinding('caller-b', 'acct-1', 'key-1');
    setStickyBinding('caller-c', 'acct-2', 'key-2');
    const removed = clearBindingsForAccount('acct-1');
    assert.equal(removed, 2);
    assert.equal(getStickyBinding('caller-a'), null);
    assert.equal(getStickyBinding('caller-b'), null);
    assert.deepEqual(getStickyBinding('caller-c'), { accountId: 'acct-2', apiKey: 'key-2' });
  });

  it('evicts oldest when over MAX_BINDINGS', () => {
    // MAX is 3 — add 4 to trigger eviction
    setStickyBinding('caller-a', 'acct-1', 'key-1');
    setStickyBinding('caller-b', 'acct-2', 'key-2');
    setStickyBinding('caller-c', 'acct-3', 'key-3');
    setStickyBinding('caller-d', 'acct-4', 'key-4');
    // After eviction we should have at most 3 bindings
    const stats = stickyStats();
    assert.ok(stats.bindings <= 3, `expected <=3 bindings, got ${stats.bindings}`);
    // The newest binding should always survive
    assert.notEqual(getStickyBinding('caller-d'), null);
  });

  it('stickyStats returns stats object', () => {
    const stats = stickyStats();
    assert.equal(stats.enabled, true);
    assert.equal(typeof stats.bindings, 'number');
    assert.equal(typeof stats.hitRate, 'string');
    assert.equal(stats.maxBindings, 3);
    assert.equal(stats.ttlMs, 5000);
  });

  it('ignores set with empty callerKey or accountId', () => {
    setStickyBinding('', 'acct-1', 'key-1');
    setStickyBinding('caller-a', '', 'key-1');
    assert.equal(getStickyBinding(''), null);
    assert.equal(getStickyBinding('caller-a'), null);
  });

  // ── P0 Fix: model dimension ──────────────────────────────

  it('different models get independent bindings', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1', 'claude-opus-4-7');
    setStickyBinding('caller-a', 'acct-2', 'key-2', 'claude-sonnet-4-6');
    const opus = getStickyBinding('caller-a', 'claude-opus-4-7');
    const sonnet = getStickyBinding('caller-a', 'claude-sonnet-4-6');
    assert.deepEqual(opus, { accountId: 'acct-1', apiKey: 'key-1' });
    assert.deepEqual(sonnet, { accountId: 'acct-2', apiKey: 'key-2' });
  });

  it('model-less get and set use wildcard key', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1');
    const b = getStickyBinding('caller-a');
    assert.deepEqual(b, { accountId: 'acct-1', apiKey: 'key-1' });
    // Should NOT match a model-specific binding
    setStickyBinding('caller-a', 'acct-2', 'key-2', 'opus');
    const wild = getStickyBinding('caller-a');
    assert.deepEqual(wild, { accountId: 'acct-1', apiKey: 'key-1' });
    const specific = getStickyBinding('caller-a', 'opus');
    assert.deepEqual(specific, { accountId: 'acct-2', apiKey: 'key-2' });
  });

  // ── P0 Fix: clearStickyBinding with model ─────────────────

  it('clearStickyBinding with modelKey clears only that model', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1', 'opus');
    setStickyBinding('caller-a', 'acct-2', 'key-2', 'sonnet');
    clearStickyBinding('caller-a', 'opus');
    assert.equal(getStickyBinding('caller-a', 'opus'), null);
    assert.notEqual(getStickyBinding('caller-a', 'sonnet'), null);
  });

  it('clearStickyBinding without modelKey clears all models', () => {
    setStickyBinding('caller-a', 'acct-1', 'key-1', 'opus');
    setStickyBinding('caller-a', 'acct-2', 'key-2', 'sonnet');
    setStickyBinding('caller-a', 'acct-3', 'key-3');
    clearStickyBinding('caller-a');
    assert.equal(getStickyBinding('caller-a', 'opus'), null);
    assert.equal(getStickyBinding('caller-a', 'sonnet'), null);
    assert.equal(getStickyBinding('caller-a'), null);
  });

  // ── P0 Fix: fallback clears stale binding ─────────────────

  it('clearing stale binding prevents retry waste', () => {
    // Simulate: caller-a is bound to acct-1 for opus
    setStickyBinding('caller-a', 'acct-1', 'key-1', 'opus');
    assert.notEqual(getStickyBinding('caller-a', 'opus'), null);

    // Simulate fallback: acct-1 is unavailable, clear the binding
    clearStickyBinding('caller-a', 'opus');
    // Next lookup should miss (no retry waste)
    assert.equal(getStickyBinding('caller-a', 'opus'), null);

    // After success with acct-2, re-bind
    setStickyBinding('caller-a', 'acct-2', 'key-2', 'opus');
    const b = getStickyBinding('caller-a', 'opus');
    assert.deepEqual(b, { accountId: 'acct-2', apiKey: 'key-2' });
  });
});
