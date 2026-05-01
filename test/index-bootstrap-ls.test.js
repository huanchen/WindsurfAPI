import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBootstrapDefaultLs } from '../src/index.js';

describe('shouldBootstrapDefaultLs', () => {
  it('boots the default LS when no global proxy is configured', () => {
    assert.equal(shouldBootstrapDefaultLs(null), true);
    assert.equal(shouldBootstrapDefaultLs({}), true);
  });

  it('skips the default LS when a global proxy is configured', () => {
    assert.equal(shouldBootstrapDefaultLs({
      type: 'http',
      host: '127.0.0.1',
      port: 7891,
    }), false);
  });
});
