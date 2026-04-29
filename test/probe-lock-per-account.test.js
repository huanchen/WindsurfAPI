// Probe lock per-account de-duplication.
//
// The old `_probeInFlight = false/true` boolean serialized every probe
// across the whole process, and the dashboard handler turned the
// "skipped" result (null) into a 404 "Account not found" toast. Users
// triggering "probe all accounts" (e.g. via /v1/health-style scripts or
// just clicking around the UI) saw N-1 fake account-not-found errors
// every time. Smoke-tested on VPS 2026-04-29 against three accounts:
// only the first showed real probe data, the other two showed
// "Account not found" in the dashboard with full account state intact.
//
// Fix: per-account in-flight Map. A duplicate probe call on the same id
// returns the in-flight promise so the caller awaits the same result;
// concurrent probes on different ids run independently.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_JS = readFileSync(join(__dirname, '..', 'src/auth.js'), 'utf8');

describe('probe per-account lock (#follow-up)', () => {
  test('global _probeInFlight boolean is gone', () => {
    // The boolean was a single-line `let _probeInFlight = false;`.
    // Make sure no assignment to a literal boolean form remains.
    assert.ok(
      !/let _probeInFlight = (?:false|true)\b/.test(AUTH_JS),
      'global boolean lock must be removed in favor of per-account Map',
    );
  });

  test('probeAccount uses a per-id in-flight Map', () => {
    // Pin both the data structure and the de-dup branch.
    assert.match(AUTH_JS, /const _probeInFlight = new Map\(\)/,
      'expected `const _probeInFlight = new Map()` to back the per-account lock');
    const m = AUTH_JS.match(/export async function probeAccount\(id\)\s*\{([\s\S]+?)\n\}/);
    assert.ok(m, 'probeAccount(id) entry not found');
    const body = m[1];
    assert.match(body, /_probeInFlight\.get\(id\)/,
      'must check existing in-flight promise for the same id');
    assert.match(body, /if \(existing\) return existing/,
      'duplicate call on the same id must await the same promise (no double probe, no false null)');
    assert.match(body, /_probeInFlight\.set\(id,/,
      'must register the new promise in the map so concurrent callers can de-dup');
    assert.match(body, /_probeInFlight\.delete\(id\)/,
      'must clean up the entry when the probe finishes (in finally to handle errors)');
  });

  test('null return is reserved exclusively for "account not found"', () => {
    // The dashboard handler maps `null` -> 404 "Account not found", so
    // probeAccount must never return null for any other reason.
    const m = AUTH_JS.match(/export async function probeAccount\(id\)\s*\{([\s\S]+?)\n\}/);
    assert.ok(m);
    const body = m[1];
    // The only `return null` should be the `accounts.find(...) === undefined` branch.
    const nullReturns = (body.match(/return null/g) || []).length;
    assert.equal(nullReturns, 1,
      'probeAccount should have exactly one `return null` (the truly-not-found case)');
    assert.match(body, /if \(!account\) return null/,
      'the `return null` must guard the missing-account case');
  });
});
