import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText } from '../src/sanitize.js';
import {
  buildToolPreamble,
  buildToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto,
  buildSkinnyToolPreambleForProto,
  buildCompactToolPreambleForProto,
} from '../src/handlers/tool-emulation.js';

const tools = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
        },
      },
    },
  },
];

test('workspace redaction marker is explicit and not a natural ellipsis', () => {
  const marker = sanitizeText('/tmp/windsurf-workspace/src/index.js');
  assert.notEqual(marker, '…');
  assert.match(marker, /^(<[^<>]+>|\([^()]+\)|\[[^\[\]]+\])$/);
  assert.ok(marker.length < 16, `marker must stay short: got ${JSON.stringify(marker)}`);
});

test('all tool preamble builders tell the model the workspace path is hidden', () => {
  const outputs = [
    buildToolPreamble(tools),
    buildToolPreambleForProto(tools, 'auto', '- Working directory: <workspace>'),
    buildSchemaCompactToolPreambleForProto(tools, 'auto', '- Working directory: <workspace>'),
    buildSkinnyToolPreambleForProto(tools, 'auto', '- Working directory: <workspace>'),
    buildCompactToolPreambleForProto(tools, 'auto', '- Working directory: <workspace>'),
  ];

  for (const out of outputs) {
    // Hint must convey: workspace path is hidden, "<workspace>" is a
    // marker not a literal path. v2.0.36 (#98) made the wording explicit
    // so the model stops emitting `find <workspace>` style commands.
    assert.ok(
      /workspace path hidden/i.test(out),
      `missing hidden-workspace hint in preamble: ${out}`
    );
    assert.ok(
      /redaction marker/i.test(out),
      `preamble must call out that "<workspace>" is a redaction marker (#98 fix): ${out}`
    );
  }
});
