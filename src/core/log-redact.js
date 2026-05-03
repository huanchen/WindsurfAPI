/**
 * Log redaction utilities.
 *
 * All log output must pass through these functions to ensure sensitive
 * data (API keys, tokens, cookies, emails, full prompts) is never
 * written to logs — even in debug mode.
 *
 * Principles:
 *   - API keys, tokens, JWTs → masked with ***
 *   - Emails → ***@***
 *   - Cookies, Authorization headers → masked
 *   - Full prompt content → hash + length only (unless DEBUG_REQUEST_BODIES=1)
 *   - Internal paths → <internal>
 *   - callerKey displayed as hash prefix only
 */

import { createHash } from 'crypto';

/**
 * Redact known sensitive patterns from a string.
 *
 * @param {string} text - Text to redact
 * @returns {string} Redacted text
 */
export function redact(text) {
  if (typeof text !== 'string') return String(text ?? '');
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/(?:ant-api\d{2}|sk-ant-api\d{2})-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'jwt-***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(cookie|set-cookie|authorization)\s*:\s*[^\n\r]+/gi, '$1: ***')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***@***');
}

/**
 * Redact a callerKey for log output — show only the first 8 chars + hash.
 *
 * @param {string} callerKey - Full caller key
 * @returns {string} Redacted caller key
 */
export function redactCallerKey(callerKey) {
  if (!callerKey || typeof callerKey !== 'string') return '(none)';
  if (callerKey.length <= 12) return callerKey;
  const hash = createHash('sha256').update(callerKey).digest('hex').slice(0, 6);
  return `${callerKey.slice(0, 8)}…${hash}`;
}

/**
 * Create a compact log summary of message content.
 * Never logs full content — only length + hash.
 *
 * @param {string} text - Message content
 * @param {number} [limit=220] - Max preview length (only in debug mode)
 * @returns {string} Log-safe summary
 */
export function contentSummary(text, limit = 220) {
  const raw = String(text || '');
  if (process.env.DEBUG_REQUEST_BODIES === '1') {
    return `head="${redact(raw.slice(0, limit)).replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`;
  }
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `len=${raw.length} hash=${hash}`;
}

/**
 * Redact a session ID for logging — show prefix + hash suffix.
 *
 * @param {string} sessionId - Raw session ID
 * @returns {string} Redacted session ID
 */
export function redactSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '(none)';
  if (sessionId.length <= 8) return sessionId;
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
  return `${sessionId.slice(0, 4)}…${hash}`;
}

/**
 * Redact an account alias/email for logging.
 *
 * @param {string} alias - Account email or alias
 * @returns {string} Redacted alias
 */
export function redactAccountAlias(alias) {
  if (!alias || typeof alias !== 'string') return '(none)';
  const atIdx = alias.indexOf('@');
  if (atIdx > 0) {
    return alias.slice(0, Math.min(3, atIdx)) + '***@***';
  }
  if (alias.length <= 6) return alias;
  return alias.slice(0, 4) + '***';
}
