/**
 * Local response cache for chat completions.
 *
 * Cascade/Windsurf upstream does not expose Anthropic-style prompt caching,
 * so we add an in-memory, exact-match cache keyed on the normalized request
 * body. This only helps with duplicate requests (Claude Code retries, parallel
 * identical calls), not prefix-caching.
 *
 * v2.1 enhancements (CLIPROXYAPI alignment):
 *   - Cache key includes provider, route, and config hash dimensions
 *   - Configurable TTL via CACHE_TTL_MS env var
 *   - Cache can be disabled via CACHE_ENABLED=0
 *   - Cache hit/miss logged in debug mode
 *   - Stream responses are never cached (only complete non-stream responses)
 */

import { createHash } from 'crypto';
import { log } from './config.js';

// Configurable TTL — default 5 minutes, override with CACHE_TTL_MS env var.
const TTL_MS = (() => {
  const n = parseInt(process.env.CACHE_TTL_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();

const MAX_ENTRIES = (() => {
  const n = parseInt(process.env.CACHE_MAX_ENTRIES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();

// Global cache enable/disable switch. Default ON.
const CACHE_ENABLED = process.env.CACHE_ENABLED !== '0';

// Debug mode — log cache hit/miss details
const CACHE_DEBUG = process.env.CACHE_DEBUG === '1';

// Map preserves insertion order → we evict the oldest when over capacity.
const _store = new Map();
const _stats = { hits: 0, misses: 0, stores: 0, evictions: 0, disabled: 0 };

function digestBase64Data(data = '', mime = '') {
  const compact = String(data).replace(/\s/g, '');
  const bytes = Math.floor(compact.length * 3 / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0);
  const hash = createHash('sha256').update(compact).digest('hex').slice(0, 32);
  return `[base64:${String(mime || 'application/octet-stream').toLowerCase()}:sha256=${hash}:bytes=${Math.max(0, bytes)}]`;
}

function normalizeDataUrl(url) {
  const clean = String(url || '').replace(/\s/g, '');
  const m = clean.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/i);
  if (!m) return url;
  return `data:${m[1].toLowerCase()};base64,${digestBase64Data(m[2], m[1])}`;
}

function normalizeBinary(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map(p => {
      if (p.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:'))
        return { ...p, image_url: { ...p.image_url, url: normalizeDataUrl(p.image_url.url) } };
      if (p.type === 'image' && p.source?.type === 'base64')
        return { ...p, source: { ...p.source, data: digestBase64Data(p.source.data, p.source.media_type) } };
      if ((p.type === 'file' || p.type === 'input_file') && typeof p.file?.file_data === 'string' && p.file.file_data.startsWith('data:'))
        return { ...p, file: { ...p.file, file_data: normalizeDataUrl(p.file.file_data) } };
      return p;
    })};
  });
}

/**
 * Normalize the request body for cache key generation.
 * Includes all dimensions that affect the response.
 */
function normalize(body) {
  return {
    model: body.model || '',
    messages: normalizeBinary(body.messages || []),
    tools: body.tools || null,
    tool_choice: body.tool_choice || null,
    response_format: body.response_format || null,
    reasoning_effort: body.reasoning_effort ?? null,
    thinking: body.thinking || null,
    stream_options: body.stream_options || null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    max_tokens: body.max_tokens ?? null,
  };
}

/**
 * Build a cache key for a chat request.
 *
 * The key now includes ALL dimensions that could affect the response:
 *   - callerKey: per-user/session scope (prevents cross-user pollution)
 *   - provider: from model info (prevents cross-provider collision)
 *   - route: chat/messages/responses (different API shapes)
 *   - request body: model, messages, tools, params
 *
 * @param {object} body - Request body
 * @param {string} [callerKey=''] - Caller identity key
 * @param {object} [opts={}] - Additional key dimensions
 * @param {string} [opts.provider] - Model provider (anthropic, openai, etc.)
 * @param {string} [opts.route] - API route (chat, messages, responses)
 * @returns {string} SHA-256 hex cache key
 */
export function cacheKey(body, callerKey = '', opts = {}) {
  const scope = String(callerKey || '');
  const provider = String(opts.provider || '');
  const route = String(opts.route || 'chat');
  const json = JSON.stringify(normalize(body));
  return createHash('sha256')
    .update(scope)
    .update('\0')
    .update(provider)
    .update('\0')
    .update(route)
    .update('\0')
    .update(json)
    .digest('hex');
}

export function cacheGet(key) {
  if (!CACHE_ENABLED) { _stats.disabled++; return null; }
  const entry = _store.get(key);
  if (!entry) {
    _stats.misses++;
    if (CACHE_DEBUG) log.debug(`Cache MISS key=${key.slice(0, 16)}…`);
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    _store.delete(key);
    _stats.misses++;
    if (CACHE_DEBUG) log.debug(`Cache EXPIRED key=${key.slice(0, 16)}…`);
    return null;
  }
  // Refresh LRU position
  _store.delete(key);
  _store.set(key, entry);
  _stats.hits++;
  if (CACHE_DEBUG) log.debug(`Cache HIT key=${key.slice(0, 16)}… age=${Math.round((Date.now() - (entry.expiresAt - TTL_MS)) / 1000)}s`);
  return entry.value;
}

export function cacheSet(key, value) {
  if (!CACHE_ENABLED) return;
  // Don't cache empty or partial results
  if (!value || (!value.text && !(value.chunks && value.chunks.length))) return;
  _store.set(key, { value, expiresAt: Date.now() + TTL_MS });
  _stats.stores++;
  if (CACHE_DEBUG) log.debug(`Cache SET key=${key.slice(0, 16)}… ttl=${Math.round(TTL_MS / 1000)}s`);
  while (_store.size > MAX_ENTRIES) {
    const oldest = _store.keys().next().value;
    _store.delete(oldest);
    _stats.evictions++;
  }
}

export function cacheStats() {
  const total = _stats.hits + _stats.misses;
  return {
    enabled: CACHE_ENABLED,
    size: _store.size,
    maxSize: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits: _stats.hits,
    misses: _stats.misses,
    stores: _stats.stores,
    evictions: _stats.evictions,
    disabled: _stats.disabled,
    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

export function cacheClear() {
  _store.clear();
  _stats.hits = 0; _stats.misses = 0; _stats.stores = 0; _stats.evictions = 0; _stats.disabled = 0;
  log.info('Response cache cleared');
}

