import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactProxyUrl, buildLanguageServerEnv } from '../src/langserver.js';

describe('redactProxyUrl', () => {
  it('redacts credentials from proxy URLs', () => {
    assert.equal(redactProxyUrl('http://user:secret@example.com:8080'), 'example.com:8080 (auth=true)');
  });

  it('shows host and port for unauthenticated proxies', () => {
    assert.equal(redactProxyUrl({ host: 'proxy.example.com', port: 1080 }), 'proxy.example.com:1080');
  });
});

describe('buildLanguageServerEnv', () => {
  it('keeps allowlisted vars and drops unrelated process env', () => {
    const env = buildLanguageServerEnv({
      HOME: '/home/dev',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'leak-me',
      GITHUB_TOKEN: 'leak-me-too',
    });
    assert.equal(env.HOME, '/home/dev');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.LANG, 'en_US.UTF-8');
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in env));
    assert.ok(!('GITHUB_TOKEN' in env));
  });

  it('applies proxy override across both HTTP and HTTPS forms', () => {
    const env = buildLanguageServerEnv(
      { HOME: '/home/dev', HTTP_PROXY: 'http://stale:8080' },
      { proxyUrl: 'http://fresh.example.com:9999' }
    );
    assert.equal(env.HTTP_PROXY, 'http://fresh.example.com:9999');
    assert.equal(env.HTTPS_PROXY, 'http://fresh.example.com:9999');
    assert.equal(env.http_proxy, 'http://fresh.example.com:9999');
    assert.equal(env.https_proxy, 'http://fresh.example.com:9999');
  });

  it('falls back to /root for HOME only when source has none', () => {
    const env = buildLanguageServerEnv({ PATH: '/usr/bin' });
    assert.equal(env.HOME, '/root');
  });

  it('preserves SSL trust env vars so hardened hosts still verify upstream', () => {
    const env = buildLanguageServerEnv({
      HOME: '/home/dev',
      SSL_CERT_FILE: '/etc/ssl/certs/ca-bundle.crt',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
    });
    assert.equal(env.SSL_CERT_FILE, '/etc/ssl/certs/ca-bundle.crt');
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/extra.pem');
  });
});

