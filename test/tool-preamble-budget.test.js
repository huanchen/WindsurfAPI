import test from 'node:test';
import assert from 'node:assert/strict';
import { applyToolPreambleBudget } from '../src/handlers/chat.js';

function makeTools(count, propCount = 18) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'function',
    function: {
      name: `mcp_tool_${i}`,
      description: `Verbose MCP tool ${i} description. `.repeat(20),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: propCount }, (_, j) => [`field_${j}`, {
            type: 'string',
            description: `Verbose field ${j} for tool ${i}. `.repeat(12),
            enum: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
          }])
        ),
        required: Array.from({ length: propCount }, (_, j) => `field_${j}`),
      },
    },
  }));
}

test('tool preamble budget compacts before enforcing hard cap (#70)', () => {
  const r = applyToolPreambleBudget(makeTools(56), 'auto', '', {
    softBytes: 24_000,
    hardBytes: 48_000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.compacted, true);
  assert.ok(r.fullBytes > r.hardBytes, `fixture should exceed hard cap before compaction, got ${r.fullBytes}`);
  assert.ok(r.finalBytes < r.hardBytes, `compacted payload should fit hard cap, got ${r.finalBytes}`);
  assert.ok(r.preamble.includes('mcp_tool_55'));
  assert.ok(!r.preamble.includes('field_0'), 'compact payload must omit schemas');
});

test('tool preamble budget rejects only when compact payload is still too large', () => {
  const r = applyToolPreambleBudget(makeTools(2000, 1), 'auto', '', {
    softBytes: 1_000,
    hardBytes: 1_500,
  });

  assert.equal(r.ok, false);
  assert.equal(r.compacted, true);
  assert.ok(r.finalBytes > r.hardBytes);
});
