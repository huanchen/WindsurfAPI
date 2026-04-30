// Audit-driven hardening (v2.0.42).
//
// Three classes of bugs surfaced by the codex audit after the LS
// file-busy + docker self-update work landed:
//
//   1. conversation-pool checkout deleted the entry BEFORE validating
//      callerKey, so a fingerprint collision from a different caller
//      would discard the rightful owner's cached cascade.
//   2. cacheKey hashed only the request body, no caller scope — two
//      tenants sending identical "hi" could read each other's cached
//      response.
//   3. runtime-config / proxy.json / model-access.json / stats.json
//      all wrote with bare writeFileSync(target, ...). A SIGTERM mid
//      docker stop could truncate the file; next startup parsed empty
//      JSON, logged a warning, fell back to defaults — silently losing
//      every saved setting. Factor an atomic-rename writer and use it
//      everywhere.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../src/fs-atomic.js';
import { cacheKey } from '../src/cache.js';
import { checkout, checkin, poolClear } from '../src/conversation-pool.js';

describe('writeJsonAtomic (audit fix #1: durable config writes)', () => {
  test('writes JSON to the target via tmp + rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-atomic-'));
    try {
      const target = join(dir, 'config.json');
      writeJsonAtomic(target, { hello: 'world', n: 1 });
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { hello: 'world', n: 1 });
      // The .tmp sibling must NOT exist after a successful write —
      // otherwise we'd leak garbage into DATA_DIR every save.
      assert.ok(!existsSync(`${target}.tmp`), '.tmp file should be removed after rename');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cleans up the .tmp file when stringify throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-atomic-'));
    try {
      const target = join(dir, 'config.json');
      // Pre-create the target so we can verify it stays untouched on
      // failure (the whole point of atomic-rename: a failed write
      // never corrupts existing data).
      writeJsonAtomic(target, { existing: true });
      // Circular ref forces JSON.stringify to throw.
      const circular = {}; circular.self = circular;
      assert.throws(() => writeJsonAtomic(target, circular));
      // Existing target must still be the previous payload.
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { existing: true });
      // No leaked .tmp after failure.
      const leftover = readdirSync(dir).filter(f => f.endsWith('.tmp'));
      assert.deepEqual(leftover, [], `expected no .tmp leftovers, got ${leftover.join(',')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overwrites an existing target byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-atomic-'));
    try {
      const target = join(dir, 'config.json');
      writeFileSync(target, '{"old": "garbage", "extra": "padding to be longer"}');
      writeJsonAtomic(target, { v: 2 });
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { v: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cacheKey (audit fix #2: cross-tenant cache leak)', () => {
  test('two callers sending the same body get DIFFERENT cache keys', () => {
    const body = {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const k1 = cacheKey(body, 'api:abc:user:alice');
    const k2 = cacheKey(body, 'api:def:user:bob');
    assert.notEqual(k1, k2,
      'identical body must produce different cache keys for different callers');
  });

  test('same caller + same body still produces a stable key (cache works)', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(cacheKey(body, 'api:abc'), cacheKey(body, 'api:abc'));
  });

  test('empty callerKey is permitted (test path) but distinct from any real scope', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const anon = cacheKey(body, '');
    const real = cacheKey(body, 'api:abc');
    assert.notEqual(anon, real);
  });

  test('cannot be tricked by a body field that mimics the scope prefix', () => {
    // The internal serialization is `<callerKey>\0<json>`. A caller
    // crafting `model: 'api:victim'` must NOT collide with another
    // caller's cache key.
    const k1 = cacheKey({ model: 'api:victim:user:bob', messages: [] }, 'api:attacker');
    const k2 = cacheKey({ model: '', messages: [] }, 'api:victim:user:bob');
    assert.notEqual(k1, k2);
  });
});

describe('conversation-pool checkout (audit fix #3: validate-before-delete)', () => {
  test('callerKey mismatch leaves the entry in place for the rightful owner', () => {
    poolClear();
    const fp = 'fp-shared-by-accident';
    const entry = {
      cascadeId: 'c-1', sessionId: 's-1', lsPort: 42100,
      apiKey: 'k-alice', stepOffset: 0, generatorOffset: 0,
      historyCoverage: null, createdAt: Date.now(), lastAccess: Date.now(),
    };
    checkin(fp, entry, 'caller-alice');

    // Bob walks in with the same fingerprint (rare but possible).
    const wrong = checkout(fp, 'caller-bob');
    assert.equal(wrong, null, 'wrong caller must miss');

    // Alice comes back. Her entry must STILL be there — the previous
    // bug was deleting on caller mismatch and stranding her.
    const right = checkout(fp, 'caller-alice');
    assert.ok(right, 'rightful owner must still find their entry after a wrong-caller miss');
    assert.equal(right.cascadeId, 'c-1');

    poolClear();
  });

  test('successful checkout still removes the entry (one-shot semantics intact)', () => {
    poolClear();
    const fp = 'fp-x';
    checkin(fp, {
      cascadeId: 'c-2', sessionId: 's-2', lsPort: 42100,
      apiKey: 'k', stepOffset: 0, generatorOffset: 0,
      historyCoverage: null, createdAt: Date.now(), lastAccess: Date.now(),
    }, 'caller-x');

    const first = checkout(fp, 'caller-x');
    assert.ok(first);
    const second = checkout(fp, 'caller-x');
    assert.equal(second, null, 'second checkout for same fp must miss — entry was consumed');

    poolClear();
  });

  test('expected.apiKey mismatch also leaves entry in place', () => {
    poolClear();
    const fp = 'fp-y';
    checkin(fp, {
      cascadeId: 'c-3', sessionId: 's-3', lsPort: 42100,
      apiKey: 'k-A', stepOffset: 0, generatorOffset: 0,
      historyCoverage: null, createdAt: Date.now(), lastAccess: Date.now(),
    }, 'caller-y');

    const wrongKey = checkout(fp, 'caller-y', { apiKey: 'k-B' });
    assert.equal(wrongKey, null);

    const rightKey = checkout(fp, 'caller-y', { apiKey: 'k-A' });
    assert.ok(rightKey, 'matching apiKey must succeed');
    assert.equal(rightKey.apiKey, 'k-A');

    poolClear();
  });
});

describe('atomic write call sites use writeJsonAtomic', () => {
  // Static check — the four files we ported must now import the
  // helper instead of writeFileSync. A future refactor that drops
  // the import without re-introducing tmp+rename should fail this
  // test rather than silently regress to the truncated-JSON bug.
  const __dirname = new URL('.', import.meta.url).pathname.replace(/^\//, '');
  const ROOT = join(__dirname, '..');
  const FILES = [
    'src/runtime-config.js',
    'src/dashboard/stats.js',
    'src/dashboard/proxy-config.js',
    'src/dashboard/model-access.js',
  ];
  for (const rel of FILES) {
    test(`${rel} uses writeJsonAtomic (no bare writeFileSync to its config target)`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      assert.match(src, /writeJsonAtomic/,
        `${rel} should import and use writeJsonAtomic`);
      // Bare writeFileSync calls are still allowed for non-config
      // paths (e.g. an export endpoint streaming a file), but the
      // simple `writeFileSync(FILE, ...)` shape we just removed must
      // not creep back in.
      assert.ok(!/writeFileSync\((?:STATS_FILE|FILE|PROXY_FILE|ACCESS_FILE)\b/.test(src),
        `${rel} still has a bare writeFileSync to its config constant`);
    });
  }
});
