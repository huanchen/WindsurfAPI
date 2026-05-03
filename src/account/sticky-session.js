/**
 * Sticky Session Manager.
 *
 * Binds a caller (identified by callerKey + modelKey) to a specific account
 * so that multi-turn conversations stay on the same upstream account. This
 * prevents context loss when the conversation pool reuses a cascade_id that
 * is only valid on the originating account.
 *
 * Design (CLIProxyAPI alignment):
 *   - (callerKey, modelKey) → accountId binding with configurable TTL
 *   - Model dimension prevents cross-model collision: the same session
 *     using opus and sonnet can be bound to different accounts
 *   - Binding is created when a successful response is returned
 *   - On next request, getApiKey checks the binding first
 *   - If the bound account is unavailable (rate limited, etc.),
 *     the stale binding is immediately cleared so retries don't
 *     keep hitting the same unavailable account
 *   - Bindings are cleared on session reset or TTL expiry
 *   - The binding table is in-memory only (no persistence needed)
 *
 * Configure via env:
 *   STICKY_SESSION_ENABLED=1     — enable (default: 0)
 *   STICKY_SESSION_TTL_MS=1800000 — binding TTL (default: 30 min)
 *   STICKY_SESSION_MAX=10000     — max bindings (default: 10000)
 */

const ENABLED = process.env.STICKY_SESSION_ENABLED === '1';

const TTL_MS = (() => {
  const n = parseInt(process.env.STICKY_SESSION_TTL_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();

const MAX_BINDINGS = (() => {
  const n = parseInt(process.env.STICKY_SESSION_MAX || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10000;
})();

// Map<bindingKey, { accountId, apiKey, createdAt, lastAccess }>
// bindingKey = callerKey + '\0' + modelKey
const _bindings = new Map();
const _stats = { hits: 0, misses: 0, creates: 0, expires: 0, evictions: 0, fallbacks: 0 };

/**
 * Build the internal map key from caller + model dimensions.
 * CLIProxyAPI uses `provider::sessionID::model`; we use `callerKey\0modelKey`.
 */
function bindingKey(callerKey, modelKey) {
  return callerKey + '\0' + (modelKey || '*');
}

/**
 * Check if sticky sessions are enabled.
 * @returns {boolean}
 */
export function isStickyEnabled() {
  return ENABLED;
}

/**
 * Look up the bound account for a caller + model pair.
 *
 * @param {string} callerKey - Caller identity key
 * @param {string} [modelKey] - Model being requested
 * @returns {{ accountId: string, apiKey: string } | null}
 */
export function getStickyBinding(callerKey, modelKey = '') {
  if (!ENABLED || !callerKey) return null;

  const key = bindingKey(callerKey, modelKey);
  const binding = _bindings.get(key);
  if (!binding) {
    _stats.misses++;
    return null;
  }

  const now = Date.now();
  if (now - binding.lastAccess > TTL_MS) {
    _bindings.delete(key);
    _stats.expires++;
    _stats.misses++;
    return null;
  }

  // Refresh access time
  binding.lastAccess = now;
  _stats.hits++;
  return { accountId: binding.accountId, apiKey: binding.apiKey };
}

/**
 * Create or update a sticky binding for a caller + model pair.
 *
 * @param {string} callerKey - Caller identity key
 * @param {string} accountId - Account ID to bind to
 * @param {string} apiKey - Account API key
 * @param {string} [modelKey] - Model being requested
 */
export function setStickyBinding(callerKey, accountId, apiKey, modelKey = '') {
  if (!ENABLED || !callerKey || !accountId) return;

  const key = bindingKey(callerKey, modelKey);
  const now = Date.now();
  const existing = _bindings.get(key);

  if (existing) {
    // Update existing binding
    existing.accountId = accountId;
    existing.apiKey = apiKey;
    existing.lastAccess = now;
  } else {
    // Create new binding
    _bindings.set(key, {
      accountId,
      apiKey,
      createdAt: now,
      lastAccess: now,
    });
    _stats.creates++;

    // Evict oldest bindings if over capacity
    if (_bindings.size > MAX_BINDINGS) {
      prune(now);
    }
  }
}

/**
 * Remove a sticky binding (e.g., on session reset or stale fallback).
 *
 * @param {string} callerKey - Caller identity key
 * @param {string} [modelKey] - Model key; if omitted clears all models for this caller
 * @returns {boolean} True if a binding was removed
 */
export function clearStickyBinding(callerKey, modelKey) {
  if (!callerKey) return false;
  // If modelKey is provided, clear only that specific binding.
  // If not, clear all bindings for this callerKey (all model variants).
  if (modelKey !== undefined) {
    return _bindings.delete(bindingKey(callerKey, modelKey));
  }
  let removed = false;
  const prefix = callerKey + '\0';
  for (const key of _bindings.keys()) {
    if (key.startsWith(prefix)) {
      _bindings.delete(key);
      removed = true;
    }
  }
  return removed;
}

/**
 * Remove all bindings for a specific account (e.g., when account is removed
 * or enters cooldown).
 *
 * @param {string} accountId - Account ID
 * @returns {number} Number of bindings removed
 */
export function clearBindingsForAccount(accountId) {
  if (!accountId) return 0;
  let removed = 0;
  for (const [key, binding] of _bindings) {
    if (binding.accountId === accountId) {
      _bindings.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Record a fallback event (sticky account was unavailable, used another).
 */
export function recordStickyFallback() {
  _stats.fallbacks++;
}

/**
 * Get sticky session statistics.
 * @returns {object}
 */
export function stickyStats() {
  const total = _stats.hits + _stats.misses;
  return {
    enabled: ENABLED,
    bindings: _bindings.size,
    maxBindings: MAX_BINDINGS,
    ttlMs: TTL_MS,
    ...(_stats),
    hitRate: total > 0 ? ((_stats.hits / total) * 100).toFixed(1) : '0.0',
  };
}

/**
 * Prune expired and excess bindings.
 */
function prune(now = Date.now()) {
  // First pass: remove expired
  for (const [key, binding] of _bindings) {
    if (now - binding.lastAccess > TTL_MS) {
      _bindings.delete(key);
      _stats.expires++;
    }
  }

  // Second pass: if still over capacity, evict oldest
  if (_bindings.size > MAX_BINDINGS) {
    const sorted = [..._bindings.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const toDrop = sorted.length - MAX_BINDINGS;
    for (let i = 0; i < toDrop; i++) {
      _bindings.delete(sorted[i][0]);
      _stats.evictions++;
    }
  }
}

// Background prune every 5 minutes
setInterval(() => prune(), 5 * 60 * 1000).unref();
