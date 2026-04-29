#!/usr/bin/env node
/**
 * Regenerate the MODELS array embedded in docs/index.html from the canonical
 * src/models.js catalog so the GitHub Pages site never drifts.
 *
 * Run:  node scripts/gen-docs-models.js
 *       — writes back to docs/index.html in place
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../src/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsPath = path.join(__dirname, '..', 'docs', 'index.html');

const PROVIDER_ALIAS = { alibaba: 'qwen' };

function isThinking(id, info) {
  if (id.includes('thinking')) return true;
  if (info.modelUid && /THINKING|REASONING/.test(info.modelUid)) return true;
  return false;
}

const FREE_TIER_HINTS = new Set([
  'gemini-2.5-flash', 'gemini-3.0-flash-minimal', 'glm-4.7', 'swe-1.5-fast',
]);

function buildEntries() {
  const entries = [];
  for (const [id, info] of Object.entries(MODELS)) {
    if (info.deprecated) continue;
    const provider = PROVIDER_ALIAS[info.provider] || info.provider;
    const e = { k: id, p: provider, c: info.credit ?? 0 };
    if (isThinking(id, info)) e.thinking = 1;
    if (FREE_TIER_HINTS.has(id)) e.free = 1;
    entries.push(e);
  }
  return entries;
}

function formatEntry(e) {
  const parts = [`k:'${e.k}'`, `p:'${e.p}'`, `c:${e.c}`];
  if (e.thinking) parts.push('thinking:1');
  if (e.free) parts.push('free:1');
  return `    {${parts.join(',')}}`;
}

function buildArrayLiteral(entries) {
  return [
    '  const MODELS = [',
    entries.map(formatEntry).join(',\n') + ',',
    '  ];',
  ].join('\n');
}

const html = fs.readFileSync(docsPath, 'utf8');
const start = html.indexOf('const MODELS = [');
if (start === -1) {
  console.error('Could not find "const MODELS = [" anchor in docs/index.html');
  process.exit(1);
}
const endMarker = '\n  ];';
const end = html.indexOf(endMarker, start);
if (end === -1) {
  console.error('Could not find closing "];" for MODELS array');
  process.exit(1);
}
const before = html.slice(0, start - 2);
const after = html.slice(end + endMarker.length);
const entries = buildEntries();
const literal = buildArrayLiteral(entries);
const next = before + '\n' + literal + after;
fs.writeFileSync(docsPath, next, 'utf8');

const byProvider = entries.reduce((acc, e) => {
  acc[e.p] = (acc[e.p] || 0) + 1;
  return acc;
}, {});
console.log(`docs/index.html updated: ${entries.length} models`);
console.log('By provider:', byProvider);
console.log(`thinking: ${entries.filter(e => e.thinking).length}, free: ${entries.filter(e => e.free).length}`);
