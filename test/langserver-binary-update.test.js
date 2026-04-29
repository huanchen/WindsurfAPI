// Dashboard /langserver/binary + /langserver/update endpoints.
//
// Issues #7, #10, #49, #87 collectively asked for "how do I get / update
// the language_server_linux_x64 binary?" There's a working install-ls.sh
// shipped in the docker image but every user had to docker-exec into the
// container, run it, then bounce the LS pool by hand. The dashboard now
// exposes:
//
//   GET  /dashboard/api/langserver/binary  → current size/mtime/sha256
//   POST /dashboard/api/langserver/update  → run install-ls.sh + restart
//
// Static-validate both routes; the live install runs against GitHub
// releases and Exafunction so it's not safe to hit in unit tests.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_JS = readFileSync(join(__dirname, '..', 'src/dashboard/api.js'), 'utf8');
const LS_JS = readFileSync(join(__dirname, '..', 'src/langserver.js'), 'utf8');

describe('LS binary inspect endpoint (#7/#10/#49)', () => {
  test('GET /langserver/binary returns size + mtime + sha256 prefix', () => {
    const m = API_JS.match(/subpath === '\/langserver\/binary'[\s\S]+?\n  \}/);
    assert.ok(m, 'GET /langserver/binary route not found');
    const route = m[0];
    assert.match(route, /method === 'GET'/);
    assert.match(route, /sizeBytes:/);
    assert.match(route, /mtime:/);
    assert.match(route, /sha256:/);
    assert.match(route, /createHash\('sha256'\)/,
      'must hash via node:crypto, not shell out to sha256sum');
    assert.match(route, /\.slice\(0, 16\)/,
      'sha256 should be truncated to 16 hex chars (matches install-ls.sh log)');
  });
});

describe('LS binary update endpoint (#7/#10/#49/#87)', () => {
  test('POST /langserver/update spawns install-ls.sh', () => {
    const m = API_JS.match(/subpath === '\/langserver\/update'[\s\S]+?\n  \}/);
    assert.ok(m, 'POST /langserver/update route not found');
    const route = m[0];
    assert.match(route, /method === 'POST'/);
    assert.match(route, /spawn\b/);
    assert.match(route, /install-ls\.sh/);
    assert.match(route, /LS_INSTALL_PATH:\s*config\.lsBinaryPath/,
      'must point install-ls.sh at the configured binary path so the right file is overwritten');
  });

  test('rejects custom URLs from non-allowlisted hosts', () => {
    const m = API_JS.match(/subpath === '\/langserver\/update'[\s\S]+?\n  \}/);
    assert.ok(m);
    const route = m[0];
    // Defence-in-depth: dashboard auth gates the endpoint, but we also
    // refuse to feed an arbitrary URL into the install script. Without
    // this guard, an attacker who got past dashboard auth could write
    // arbitrary bytes to the LS binary and have node exec them.
    assert.match(route, /protocol !== 'https:'/,
      'must require https');
    assert.match(route, /allowedHosts/,
      'must consult an allowlist of hosts, not arbitrary URLs');
    assert.match(route, /github\.com/,
      'github.com must be in the allowlist (our releases live there)');
  });

  test('after install, every LS pool entry is restarted', () => {
    const m = API_JS.match(/subpath === '\/langserver\/update'[\s\S]+?\n  \}/);
    assert.ok(m);
    const route = m[0];
    assert.match(route, /_poolKeys/,
      'must enumerate all live LS pool keys (default + per-proxy entries)');
    assert.match(route, /restartLsForProxy/,
      'must call restartLsForProxy on each entry to swap the binary in flight');
  });

  test('langserver.js exports _poolKeys + getProxyByKey for the update endpoint', () => {
    assert.match(LS_JS, /export function _poolKeys\(\)/);
    assert.match(LS_JS, /export function getProxyByKey\(key\)/);
  });
});
