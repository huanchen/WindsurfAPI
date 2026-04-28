import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFields } from '../src/proto.js';

function metadataStrings(buf) {
  return Object.fromEntries(
    parseFields(buf)
      .filter(field => field.wireType === 2)
      .map(field => [field.field, field.value.toString('utf8')])
  );
}

describe('client fingerprint metadata', () => {
  it('uses the current Windsurf client version by default', async () => {
    const previous = process.env.WINDSURF_CLIENT_VERSION;
    delete process.env.WINDSURF_CLIENT_VERSION;

    try {
      const { buildMetadata } = await import('../src/windsurf.js?fingerprint-default');
      const metadata = metadataStrings(buildMetadata('apikey', undefined, 'sess'));

      assert.equal(metadata[2], '2.0.67');
      assert.equal(metadata[7], '2.0.67');
    } finally {
      if (previous == null) delete process.env.WINDSURF_CLIENT_VERSION;
      else process.env.WINDSURF_CLIENT_VERSION = previous;
    }
  });

  it('uses WINDSURF_CLIENT_VERSION when set before import', async () => {
    const previous = process.env.WINDSURF_CLIENT_VERSION;
    process.env.WINDSURF_CLIENT_VERSION = '9.9.9';

    try {
      const { buildMetadata } = await import('../src/windsurf.js?fingerprint-env');
      const metadata = metadataStrings(buildMetadata('apikey', undefined, 'sess'));

      assert.equal(metadata[2], '9.9.9');
      assert.equal(metadata[7], '9.9.9');
    } finally {
      if (previous == null) delete process.env.WINDSURF_CLIENT_VERSION;
      else process.env.WINDSURF_CLIENT_VERSION = previous;
    }
  });

  it('lets an explicit version override the default', async () => {
    const { buildMetadata } = await import('../src/windsurf.js?fingerprint-explicit');
    const metadata = metadataStrings(buildMetadata('apikey', '1.2.3', 'sess'));

    assert.equal(metadata[2], '1.2.3');
    assert.equal(metadata[7], '1.2.3');
  });
});
