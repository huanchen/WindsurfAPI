import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { configureBindHost, getAccountList, removeAccount } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';

const originalAllowPrivate = config.allowPrivateProxyHosts;
const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;

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
    if (typeof a.label === 'string' && a.label.startsWith('test-proxy-ordering-')) {
      removeAccount(a.id);
    }
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
