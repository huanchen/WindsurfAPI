import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('gRPC transport protocol default', () => {
  it('uses Connect transport when GRPC_PROTOCOL is unset', async () => {
    const previous = process.env.GRPC_PROTOCOL;
    delete process.env.GRPC_PROTOCOL;

    try {
      const grpc = await import('../src/grpc.js?transport-default');
      assert.equal(grpc._USE_CONNECT_FOR_TEST, true);
    } finally {
      if (previous == null) delete process.env.GRPC_PROTOCOL;
      else process.env.GRPC_PROTOCOL = previous;
    }
  });

  it('uses legacy gRPC transport when GRPC_PROTOCOL=grpc', async () => {
    const previous = process.env.GRPC_PROTOCOL;
    process.env.GRPC_PROTOCOL = 'grpc';

    try {
      const grpc = await import('../src/grpc.js?transport-legacy');
      assert.equal(grpc._USE_CONNECT_FOR_TEST, false);
    } finally {
      if (previous == null) delete process.env.GRPC_PROTOCOL;
      else process.env.GRPC_PROTOCOL = previous;
    }
  });
});
