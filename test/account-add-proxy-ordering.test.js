import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost, getAccountList, removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { getEffectiveProxy, removeProxy } from '../src/dashboard/proxy-config.js';

const originalAllowPrivate = config.allowPrivateProxyHosts;
const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const createdAccountIds = new Set();

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function snapshotAccountIds() {
  return getAccountList().map(a => a.id);
}

afterEach(() => {
  config.allowPrivateProxyHosts = originalAllowPrivate;
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('127.0.0.1');
  for (const a of getAccountList()) {
    if (typeof a.email === 'string' && a.email.startsWith('test-proxy-ordering-')) {
      removeAccount(a.id);
    }
  }
  for (const id of createdAccountIds) {
    removeProxy('account', id);
    createdAccountIds.delete(id);
  }
});

describe('POST /accounts proxy ordering (regression for PR #90 follow-up)', () => {
  it('does NOT create account when proxy format is invalid', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const before = snapshotAccountIds();
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      { api_key: `test-proxy-ordering-bad-${Date.now()}`, label: `test-proxy-ordering-bad-${Date.now()}`, proxy: 'not-a-valid-proxy-url' },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );
    const after = snapshotAccountIds();

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'ERR_PROXY_FORMAT_INVALID');
    assert.deepEqual(after, before, 'no account should be created when proxy format is invalid');
  });

  it('does NOT create account when proxy host is private and ALLOW_PRIVATE_PROXY_HOSTS is off', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    config.allowPrivateProxyHosts = false;
    configureBindHost('127.0.0.1');

    const before = snapshotAccountIds();
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      { api_key: `test-proxy-ordering-priv-${Date.now()}`, label: `test-proxy-ordering-priv-${Date.now()}`, proxy: 'http://192.168.1.100:8080' },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );
    const after = snapshotAccountIds();

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.ok(/PRIVATE|private|local/i.test(res.json().error || ''), `expected private-host error, got ${res.json().error}`);
    assert.deepEqual(after, before, 'no account should be created when private proxy is rejected');
  });

  it('creates account with valid public proxy and binds account-level proxy', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const before = snapshotAccountIds();
    const label = `test-proxy-ordering-public-${Date.now()}`;
    const key = `test-key-${Date.now()}`;
    const proxy = 'http://1.1.1.1:8080';
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      { api_key: key, label, proxy },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );
    const after = snapshotAccountIds();

    const body = res.json();
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(body.success, true);
    assert.equal(after.length, before.length + 1, 'should create exactly one account');
    const accountId = body.account.id;
    createdAccountIds.add(accountId);
    const proxyCfg = getEffectiveProxy(accountId);
    assert.deepEqual(proxyCfg, {
      type: 'http',
      host: '1.1.1.1',
      port: 8080,
      username: '',
      password: '',
    });
  });

  it('prefers api_key when api_key + token are both provided', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const label = `test-proxy-ordering-both-${Date.now()}`;
    const key = `test-key-both-${Date.now()}`;
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      {
        api_key: key,
        token: 'definitely-not-a-valid-token',
        label,
        proxy: 'http://1.1.1.1:8080',
      },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );

    const body = res.json();
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(body.success, true);
    assert.equal(body.account.method, 'api_key', 'api_key should win when both fields are present');
    createdAccountIds.add(body.account.id);
  });

  it('returns non-ERR_* proxy validation errors when host validation throws generic errors', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const before = snapshotAccountIds();
    const label = `test-proxy-ordering-non-err-${Date.now()}`;
    const key = `test-key-non-err-${Date.now()}`;
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      { api_key: key, label, proxy: 'http://does-not-exist.invalid:8080' },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );
    const after = snapshotAccountIds();
    const body = res.json();

    assert.equal(res.statusCode, 400);
    assert.ok(body.error && !/^ERR_/.test(body.error), `expected non-ERR_* error, got ${body.error}`);
    assert.deepEqual(after, before);
  });

  it('rejects request with no api_key/token before doing any work', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const before = snapshotAccountIds();
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      { proxy: 'http://example.com:8080', label: 'no-key' },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );
    const after = snapshotAccountIds();

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Provide api_key or token/);
    assert.deepEqual(after, before);
  });

  it('creates account with no proxy when none provided', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const before = snapshotAccountIds().length;
    const label = `test-proxy-ordering-noproxy-${Date.now()}`;
    const res = fakeRes();
    await handleDashboardApi(
      'POST',
      '/accounts',
      { api_key: `key-${label}`, label },
      { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res
    );
    const after = snapshotAccountIds().length;

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal(res.json().success, true);
    assert.equal(after, before + 1, 'exactly one account should be created');
  });
});
