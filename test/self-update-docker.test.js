import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { configureBindHost } from '../src/auth.js';
import { handleDashboardApi, runGit, setGitExecFileForTest } from '../src/dashboard/api.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
let tempDir = null;

afterEach(() => {
  setGitExecFileForTest(null);
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir() {
  tempDir = mkdtempSync(join(tmpdir(), 'windsurfapi-self-update-'));
  return tempDir;
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

describe('Docker self-update unavailable state', () => {
  it('maps missing git binary to ERR_SELF_UPDATE_UNAVAILABLE', async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, '.git'));
    setGitExecFileForTest((file, args, opts, cb) => {
      const err = new Error('spawn git ENOENT');
      err.code = 'ENOENT';
      cb(err, '', '');
    });

    await assert.rejects(
      () => runGit(['status'], { cwd }),
      {
        code: 'ERR_SELF_UPDATE_UNAVAILABLE',
        reason: 'docker',
        message: 'ERR_SELF_UPDATE_UNAVAILABLE',
      }
    );
  });

  it('maps missing git metadata to ERR_SELF_UPDATE_UNAVAILABLE without spawning git', async () => {
    const cwd = makeTempDir();
    let called = false;
    setGitExecFileForTest((file, args, opts, cb) => {
      called = true;
      cb(null, '', '');
    });

    await assert.rejects(
      () => runGit(['status'], { cwd }),
      {
        code: 'ERR_SELF_UPDATE_UNAVAILABLE',
        reason: 'docker',
        message: 'ERR_SELF_UPDATE_UNAVAILABLE',
      }
    );
    assert.equal(called, false);
  });

  it('returns 200 available:false from /self-update/check when git is unavailable', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    setGitExecFileForTest((file, args, opts, cb) => {
      const err = new Error('spawn git ENOENT');
      err.code = 'ENOENT';
      cb(err, '', '');
    });

    const res = fakeRes();
    await handleDashboardApi('GET', '/self-update/check', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      ok: false,
      available: false,
      reason: 'docker',
      error: 'ERR_SELF_UPDATE_UNAVAILABLE',
    });
  });
});
