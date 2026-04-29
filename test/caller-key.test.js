import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callerKeyFromRequest, extractBodyCallerSubKey, hasCallerScope } from '../src/caller-key.js';

function fakeReq({ headers = {}, ip = '127.0.0.1' } = {}) {
  return { headers, socket: { remoteAddress: ip } };
}

describe('extractBodyCallerSubKey (v2.0.25 HIGH-3)', () => {
  it('returns empty for body with no user signal', () => {
    assert.equal(extractBodyCallerSubKey({}), '');
    assert.equal(extractBodyCallerSubKey(null), '');
    assert.equal(extractBodyCallerSubKey({ messages: [], model: 'm' }), '');
  });

  it('returns a digest when body.user is present (OpenAI chat convention)', () => {
    const k = extractBodyCallerSubKey({ user: 'alice@example.com' });
    assert.ok(k && k.length === 16);
  });

  it('different users yield different digests', () => {
    const a = extractBodyCallerSubKey({ user: 'alice' });
    const b = extractBodyCallerSubKey({ user: 'bob' });
    assert.notEqual(a, b);
  });

  it('uses Responses-style previous_response_id when no user', () => {
    const k = extractBodyCallerSubKey({ previous_response_id: 'resp_abc123' });
    assert.ok(k && k.length === 16);
  });

  it('does NOT inspect metadata.user_id (handled by messages.js parser)', () => {
    // metadata.user_id is the Anthropic Claude Code device id field; the
    // /v1/messages handler has a specialized parser for its JSON-encoded
    // shape and appends `:user:` itself. Two-handler stamping would
    // double-prefix the callerKey, so caller-key.js stays out of it.
    assert.equal(extractBodyCallerSubKey({ metadata: { user_id: '{"device_id":"abc"}' } }), '');
  });
});

describe('callerKeyFromRequest with body', () => {
  it('appends :user:<digest> when body has a user signal', () => {
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', { user: 'alice' });
    assert.match(k, /^api:[a-f0-9]+:user:[a-f0-9]{16}$/);
  });

  it('falls back to :client:<ip+ua-digest> when body has no user signal', () => {
    // v2.0.37 (#93 follow-up): bare apiKey + no body user used to drop
    // straight to "shared API key, no per-user scope" and disable
    // cascade reuse. Now we synthesize a stable per-physical-client
    // subkey from IP + UA so single-user self-hosted setups can reuse.
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', {});
    assert.match(k, /^api:[a-f0-9]+:client:[a-f0-9]{16}$/);
  });

  it('two end-users on same shared API key get different keys', () => {
    const ka = callerKeyFromRequest(fakeReq(), 'shared-key', { user: 'alice' });
    const kb = callerKeyFromRequest(fakeReq(), 'shared-key', { user: 'bob' });
    assert.notEqual(ka, kb);
  });

  it('two physical clients on same apiKey land on different subkeys via IP+UA', () => {
    // The v2.0.37 fallback must not collapse distinct clients into one
    // pool — that would re-introduce the cross-user cascade bleed
    // v2.0.25 originally guarded against.
    const ka = callerKeyFromRequest(
      fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    const kb = callerKeyFromRequest(
      fakeReq({ ip: '5.6.7.8', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    assert.notEqual(ka, kb);
    assert.match(ka, /^api:[a-f0-9]+:client:[a-f0-9]{16}$/);
  });

  it('same physical client across turns lands on the same subkey (reuse precondition)', () => {
    // The whole point of the v2.0.37 fallback: stable identity across
    // requests so the cascade pool actually finds the prior entry.
    const ka = callerKeyFromRequest(
      fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    const kb = callerKeyFromRequest(
      fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    assert.equal(ka, kb);
  });

  it('omits :client: when no IP and no UA are extractable', () => {
    // Defensive: if both IP and UA are empty strings the fallback
    // produces no useful identity so we fall back to the bare apiKey.
    const k = callerKeyFromRequest({ headers: {} }, 'sk-test-key', {});
    assert.match(k, /^api:[a-f0-9]+$/);
  });

  it('falls back to header session id when no API key', () => {
    const k = callerKeyFromRequest(fakeReq({ headers: { 'x-session-id': 'sess-xyz' } }));
    assert.match(k, /^session:[a-f0-9]+$/);
  });

  it('falls back to ip+ua when nothing else available', () => {
    const k = callerKeyFromRequest(fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'Mozilla/X' } }));
    assert.match(k, /^client:[a-f0-9]+$/);
  });
});

describe('hasCallerScope', () => {
  it('true for callerKey containing :user:', () => {
    assert.equal(hasCallerScope('api:abc:user:xyz'), true);
  });

  it('true for callerKey containing :client: anywhere (v2.0.37 fallback)', () => {
    // apiKey-mode now appends `:client:<ip+ua-hash>` — scope check
    // must recognize the segment anywhere, not just as a prefix.
    assert.equal(hasCallerScope('api:abc:client:xyz'), true);
  });

  it('true for session: prefix', () => {
    assert.equal(hasCallerScope('session:abc'), true);
  });

  it('true for client: prefix', () => {
    assert.equal(hasCallerScope('client:abc'), true);
  });

  it('false for bare api: without any subkey', () => {
    // Should never happen in practice now (callerKeyFromRequest
    // always tries to add a :client: or :user: subkey) but if some
    // path fabricates a bare key, scope is still rejected.
    assert.equal(hasCallerScope('api:abc'), false);
  });

  it('true when body carries a user signal even if callerKey is bare', () => {
    assert.equal(hasCallerScope('api:abc', null, { user: 'alice' }), true);
  });
});
