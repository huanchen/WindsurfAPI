import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  getCandidateStateDbPaths,
  getCodeiumConfigPath,
  isLoopbackAddress,
  extractFromCodeiumConfig,
} from '../src/dashboard/local-windsurf.js';

describe('isLoopbackAddress', () => {
  it('accepts IPv4 loopback', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.0.0.5'), true);
    assert.equal(isLoopbackAddress('127.255.255.254'), true);
  });

  it('accepts IPv6 loopback variants', () => {
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::FFFF:127.0.0.1'), true);
  });

  it('rejects all public and private LAN addresses', () => {
    assert.equal(isLoopbackAddress('192.168.1.1'), false);
    assert.equal(isLoopbackAddress('10.0.0.1'), false);
    assert.equal(isLoopbackAddress('8.8.8.8'), false);
    assert.equal(isLoopbackAddress('::ffff:8.8.8.8'), false);
    assert.equal(isLoopbackAddress('fe80::1'), false);
    assert.equal(isLoopbackAddress(''), false);
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });

  it('rejects spoofed addresses that look like 127 but are not', () => {
    assert.equal(isLoopbackAddress('1.27.0.0.1'), false);
    assert.equal(isLoopbackAddress('127.0.0'), false);
    assert.equal(isLoopbackAddress('127.0.0.1.evil.com'), false);
  });
});

describe('getCandidateStateDbPaths', () => {
  it('returns at least one path for the current OS', () => {
    const paths = getCandidateStateDbPaths();
    assert.ok(Array.isArray(paths) && paths.length >= 1);
    for (const p of paths) {
      assert.ok(p.endsWith(path.join('User', 'globalStorage', 'state.vscdb')), `expected state.vscdb suffix, got ${p}`);
    }
  });

  it('includes both Windsurf and Windsurf Next flavors', () => {
    const paths = getCandidateStateDbPaths();
    const joined = paths.join('|');
    assert.ok(joined.includes('Windsurf'), 'should include base Windsurf path');
    assert.ok(joined.includes('Windsurf - Next') || joined.includes('Windsurf-Next'), 'should include Windsurf Next flavor');
  });

  it('uses platform-appropriate base directories', () => {
    const paths = getCandidateStateDbPaths();
    if (process.platform === 'darwin') {
      assert.ok(paths.some(p => p.includes('Library/Application Support')), 'macOS path should include Library/Application Support');
    } else if (process.platform === 'win32') {
      assert.ok(paths.some(p => p.toLowerCase().includes('appdata')), 'Windows path should include AppData');
    } else {
      assert.ok(paths.some(p => p.includes('.config') || p.includes('XDG')), 'Linux path should respect XDG_CONFIG_HOME / .config');
    }
  });
});

describe('getCodeiumConfigPath', () => {
  it('returns ~/.codeium/config.json by default', () => {
    const original = process.env.XDG_DATA_HOME;
    delete process.env.XDG_DATA_HOME;
    try {
      const p = getCodeiumConfigPath();
      assert.equal(p, path.join(os.homedir(), '.codeium', 'config.json'));
    } finally {
      if (original !== undefined) process.env.XDG_DATA_HOME = original;
    }
  });

  it('respects XDG_DATA_HOME when set', () => {
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/custom/xdg/data';
    try {
      const p = getCodeiumConfigPath();
      assert.equal(p, path.join('/custom/xdg/data', '.codeium', 'config.json'));
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});

describe('extractFromCodeiumConfig (no file)', () => {
  it('returns ok:false reason:not_found when file is absent', async () => {
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = '/nonexistent/path/that/does/not/exist';
    try {
      const r = await extractFromCodeiumConfig();
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not_found');
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});

describe('extractFromStateDb (fixture)', { skip: await sqliteUnavailable() }, () => {
  it('extracts windsurfAuthStatus and session entries from a fixture DB', async () => {
    const { extractFromStateDb } = await import('../src/dashboard/local-windsurf.js');
    const fixturePath = await buildFixtureDb();
    const r = await extractFromStateDb(fixturePath);
    assert.equal(r.ok, true);
    assert.ok(r.accounts.length >= 2, `expected at least 2 accounts, got ${r.accounts.length}`);

    const primary = r.accounts.find(a => a.email === 'fixture@example.com');
    assert.ok(primary, 'primary account from windsurfAuthStatus must be present');
    assert.equal(primary.apiKey, 'sk-ws-01-fixturekey1234567890abcdef');
    assert.equal(primary.apiKeyMasked.includes('sk-ws-01'), true);
    assert.equal(primary.apiKeyMasked.includes('cdef'), true);
    assert.ok(!primary.apiKeyMasked.includes('fixturekey'), 'masked key must not leak middle chars');

    const session = r.accounts.find(a => a.email === 'second@example.com');
    assert.ok(session, 'session-array account must be present');
    assert.equal(session.apiKey, 'sk-ws-02-secondkey0987654321');
  });

  it('skips unrelated rows and returns deduped accounts', async () => {
    const { extractFromStateDb } = await import('../src/dashboard/local-windsurf.js');
    const fixturePath = await buildFixtureDb();
    const r = await extractFromStateDb(fixturePath);
    assert.equal(r.ok, true);
    const keys = r.accounts.map(a => a.apiKey);
    const unique = new Set(keys);
    assert.equal(keys.length, unique.size, 'no duplicate apiKey across sources');
  });
});

async function sqliteUnavailable() {
  try {
    await import('node:sqlite');
    return false;
  } catch {
    return true;
  }
}

async function buildFixtureDb() {
  const sqlite = await import('node:sqlite');
  const fsMod = await import('node:fs');
  const fixturePath = path.join(os.tmpdir(), `fixture-windsurf-state-${process.pid}-${Date.now()}.vscdb`);
  try { fsMod.unlinkSync(fixturePath); } catch {}
  const db = new sqlite.DatabaseSync(fixturePath);
  db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)');
  const stmt = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  stmt.run('windsurfAuthStatus', JSON.stringify({
    apiKey: 'sk-ws-01-fixturekey1234567890abcdef',
    email: 'fixture@example.com',
    name: 'Fixture User',
    apiServerUrl: 'https://server.codeium.com',
  }));
  stmt.run('codeium.windsurf-windsurf_auth.sessions', JSON.stringify([{
    accessToken: 'sk-ws-02-secondkey0987654321',
    account: { email: 'second@example.com', name: 'Second' },
  }]));
  stmt.run('something-else', 'unrelated value');
  db.close();
  return fixturePath;
}
