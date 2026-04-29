import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function makeWorkspace({ includeHuggingFaceModel = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'wa-gen-docs-'));
  const srcDir = join(workspace, 'src');
  const docsDir = join(workspace, 'docs');
  const scriptsDir = join(workspace, 'scripts');
  const dashboardDir = join(srcDir, 'dashboard');

  mkdirSync(srcDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(dashboardDir, { recursive: true });

  copyFileSync(join(ROOT, 'package.json'), join(workspace, 'package.json'));
  copyFileSync(join(ROOT, 'src/models.js'), join(srcDir, 'models.js'));
  copyFileSync(join(ROOT, 'scripts/gen-docs-models.js'), join(scriptsDir, 'gen-docs-models.js'));
  copyFileSync(join(ROOT, 'docs/index.html'), join(docsDir, 'index.html'));

  if (!includeHuggingFaceModel) {
    return workspace;
  }

  const modelsPath = join(srcDir, 'models.js');
  let source = readFileSync(modelsPath, 'utf8');
  const marker = source.indexOf('// Build reverse lookup');
  if (marker < 0) {
    throw new Error('unexpected models.js structure: missing // Build reverse lookup marker');
  }

  const objectEndMatch = source.match(/\r?\n\};\r?\n\r?\n\/\/ Build reverse lookup/);
  const objectEnd = objectEndMatch ? objectEndMatch.index : -1;
  if (objectEnd < 0) {
    throw new Error('unexpected models.js structure: missing end of MODELS object');
  }

  const patch = "\n  'model-huggingface-custom': { name: 'model-huggingface-custom', provider: 'huggingface', enumValue: 999999, modelUid: 'model-huggingface-custom', credit: 1 },\n";
  source = `${source.slice(0, objectEnd + 1)}${patch}${source.slice(objectEnd + 1)}`;
  writeFileSync(modelsPath, source, 'utf8');

  return workspace;
}

function runGenerator(workspace) {
  const result = spawnSync(process.execPath, ['scripts/gen-docs-models.js'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 20000,
  });
  return result;
}

function parseModels(htmlText) {
  const start = htmlText.indexOf('const MODELS = [');
  assert.ok(start >= 0, 'MODELS array anchor not found');

  const open = htmlText.indexOf('[', start);
  const close = htmlText.indexOf('  ];', start);
  assert.ok(close > open, 'MODELS array end marker not found');

  const literal = htmlText.slice(open, close + 3);
  const models = new Function(`return ${literal}`)();
  assert.ok(Array.isArray(models), 'MODELS should be an array');
  return models;
}

function readDocsHtml(workspace) {
  return readFileSync(join(workspace, 'docs', 'index.html'), 'utf8');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

describe('scripts/gen-docs-models.js', () => {
  it('regenerates a parseable MODELS block and keeps HTML shape', () => {
    const workspace = makeWorkspace();
    try {
      const result = runGenerator(workspace);
      assert.equal(result.status, 0, `generator exit: ${result.status}, stderr=${result.stderr}`);
      const html = readDocsHtml(workspace);
      const models = parseModels(html);

      assert.ok(html.includes('<html'), 'generated docs should include html root');
      assert.ok(html.includes('</html>'), 'generated docs should include html close tag');
      assert.equal(typeof html, 'string');
      assert.ok(models.length >= 100, `expected at least 100 models, got ${models.length}`);
      assert.ok(models.every(model => model?.k && model?.p && typeof model.c === 'number'));
      assert.ok(models.some(model => model.k === 'adaptive'));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('is idempotent when run repeatedly on the same input', () => {
    const workspace = makeWorkspace();
    try {
      const first = runGenerator(workspace);
      assert.equal(first.status, 0, `first run failed: ${first.stderr}`);
      const firstHtml = readDocsHtml(workspace);

      const second = runGenerator(workspace);
      assert.equal(second.status, 0, `second run failed: ${second.stderr}`);
      const secondHtml = readDocsHtml(workspace);

      assert.equal(sha256(firstHtml), sha256(secondHtml), 'generator output changed between runs');
      assert.deepEqual(parseModels(firstHtml), parseModels(secondHtml));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('supports unknown provider values when models are merged in', () => {
    const workspace = makeWorkspace({ includeHuggingFaceModel: true });
    try {
      const result = runGenerator(workspace);
      assert.equal(result.status, 0, `generator failed on unknown provider: ${result.stderr}`);
      const html = readDocsHtml(workspace);
      const models = parseModels(html);
      assert.ok(models.some(model => model.k === 'model-huggingface-custom' && model.p === 'huggingface'));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
