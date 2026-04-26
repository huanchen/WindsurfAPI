import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { migrateReplicaAccountsTo } from '../src/auth.js';

// Issue #67 — `accounts.json` used to live under per-replica `dataDir`
// (replica-${HOSTNAME}/), so each docker-compose upgrade orphaned the
// previous run's accounts. The migration helper unions all
// `replica-*/accounts.json` files under the shared dir and writes them
// to the shared path on startup.

const silentLogger = { warn() {}, error() {}, info() {} };

describe('migrateReplicaAccountsTo (issue #67)', () => {
  let tmp;
  let accountsFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wfapi-mig-'));
    accountsFile = join(tmp, 'accounts.json');
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('skips when no replica-* subdir exists', () => {
    const r = migrateReplicaAccountsTo({ sharedDir: tmp, accountsFile, logger: silentLogger });
    assert.equal(r.migrated, 0);
    assert.equal(r.skipped, true);
    assert.equal(existsSync(accountsFile), false);
  });

  it('skips when shared accounts.json already exists', () => {
    mkdirSync(join(tmp, 'replica-h1'));
    writeFileSync(join(tmp, 'replica-h1', 'accounts.json'), JSON.stringify([
      { apiKey: 'k1', email: 'a@b.com' },
    ]));
    writeFileSync(accountsFile, '[]');
    const r = migrateReplicaAccountsTo({ sharedDir: tmp, accountsFile, logger: silentLogger });
    assert.equal(r.migrated, 0);
    assert.equal(r.skipped, true);
    assert.equal(readFileSync(accountsFile, 'utf-8'), '[]');
  });

  it('migrates accounts from a single replica-*/accounts.json', () => {
    mkdirSync(join(tmp, 'replica-h1'));
    writeFileSync(join(tmp, 'replica-h1', 'accounts.json'), JSON.stringify([
      { apiKey: 'k1', email: 'a@b.com', method: 'api_key' },
      { apiKey: 'k2', email: 'b@b.com', method: 'api_key' },
    ]));

    const r = migrateReplicaAccountsTo({ sharedDir: tmp, accountsFile, logger: silentLogger });
    assert.equal(r.migrated, 2);
    assert.equal(r.scanned, 1);
    assert.equal(r.skipped, false);
    const out = JSON.parse(readFileSync(accountsFile, 'utf-8'));
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(a => a.apiKey).sort(), ['k1', 'k2']);
  });

  it('unions multiple replica-* subdirs and dedupes by apiKey', () => {
    for (const host of ['h1', 'h2', 'h3']) mkdirSync(join(tmp, `replica-${host}`));
    writeFileSync(join(tmp, 'replica-h1', 'accounts.json'), JSON.stringify([
      { apiKey: 'k1', email: 'a@b.com' },
      { apiKey: 'k2', email: 'b@b.com' },
    ]));
    writeFileSync(join(tmp, 'replica-h2', 'accounts.json'), JSON.stringify([
      { apiKey: 'k2', email: 'b-second@b.com' }, // duplicate apiKey, should be ignored
      { apiKey: 'k3', email: 'c@b.com' },
    ]));
    writeFileSync(join(tmp, 'replica-h3', 'accounts.json'), JSON.stringify([
      { apiKey: 'k4', email: 'd@b.com' },
    ]));

    const r = migrateReplicaAccountsTo({ sharedDir: tmp, accountsFile, logger: silentLogger });
    assert.equal(r.migrated, 4);
    assert.equal(r.scanned, 3);
    const out = JSON.parse(readFileSync(accountsFile, 'utf-8'));
    assert.equal(out.length, 4);
    assert.deepEqual(out.map(a => a.apiKey).sort(), ['k1', 'k2', 'k3', 'k4']);
    // First-seen wins on duplicate apiKey
    assert.equal(out.find(a => a.apiKey === 'k2').email, 'b@b.com');
  });

  it('tolerates a corrupt replica-*/accounts.json without aborting other replicas', () => {
    mkdirSync(join(tmp, 'replica-bad'));
    mkdirSync(join(tmp, 'replica-good'));
    writeFileSync(join(tmp, 'replica-bad', 'accounts.json'), '{not json');
    writeFileSync(join(tmp, 'replica-good', 'accounts.json'), JSON.stringify([
      { apiKey: 'k1', email: 'a@b.com' },
    ]));

    const r = migrateReplicaAccountsTo({ sharedDir: tmp, accountsFile, logger: silentLogger });
    assert.equal(r.migrated, 1);
    assert.equal(r.scanned, 2);
    const out = JSON.parse(readFileSync(accountsFile, 'utf-8'));
    assert.equal(out.length, 1);
    assert.equal(out[0].apiKey, 'k1');
  });

  it('skips replica-* subdirs that have no accounts.json', () => {
    mkdirSync(join(tmp, 'replica-empty'));
    mkdirSync(join(tmp, 'replica-with-data'));
    writeFileSync(join(tmp, 'replica-with-data', 'accounts.json'), JSON.stringify([
      { apiKey: 'k1', email: 'a@b.com' },
    ]));

    const r = migrateReplicaAccountsTo({ sharedDir: tmp, accountsFile, logger: silentLogger });
    assert.equal(r.migrated, 1);
    assert.equal(r.scanned, 1);
  });

  it('does nothing when sharedDir does not exist', () => {
    const r = migrateReplicaAccountsTo({
      sharedDir: join(tmp, 'does-not-exist'),
      accountsFile,
      logger: silentLogger,
    });
    assert.equal(r.migrated, 0);
    assert.equal(r.skipped, true);
  });
});
