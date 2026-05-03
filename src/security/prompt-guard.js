/**
 * Prompt Injection Guard.
 *
 * Detects and blocks prompt injection attempts in user messages without
 * interfering with normal development/coding questions.
 *
 * Three configurable modes:
 *   - strict:  block all detected injections
 *   - normal:  block high-confidence injections only (default)
 *   - off:     disabled (pass-through)
 *
 * Configure via PROMPT_GUARD_MODE env var.
 *
 * Design principles:
 *   - Never false-positive on normal coding questions
 *   - Focus on high-signal patterns: "ignore previous", "output system prompt"
 *   - Blocked requests return a standardized error, never crash
 *   - Logging records attempts without including the full injection payload
 */

import { log } from '../config.js';
import { redact } from '../core/log-redact.js';

// Guard mode from environment (default: normal)
const GUARD_MODE = (() => {
  const mode = (process.env.PROMPT_GUARD_MODE || 'normal').toLowerCase();
  if (['strict', 'normal', 'off'].includes(mode)) return mode;
  return 'normal';
})();

// High-confidence injection patterns — these almost never appear in
// legitimate developer requests. Each entry: [regex, label, severity].
// severity: 'high' = blocked in both strict+normal, 'medium' = strict only.
const PATTERNS = [
  // Direct instruction override
  [/ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?|constraints?)/i, 'instruction_override', 'high'],
  [/disregard\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|prompts?|rules?|directions?|guidelines?)/i, 'instruction_override', 'high'],
  [/forget\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|prompts?|rules?|programming)/i, 'instruction_override', 'high'],

  // System prompt extraction
  [/(?:output|print|show|display|reveal|repeat|echo|dump)\s+(?:your\s+)?(?:full\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|programming|configuration)/i, 'system_prompt_leak', 'high'],
  [/what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions?|rules?|initial\s+(?:prompt|instructions?))/i, 'system_prompt_leak', 'medium'],

  // Token/key extraction
  [/(?:output|print|show|display|reveal|leak|expose|dump)\s+(?:the\s+)?(?:api\s+)?(?:key|token|secret|password|credential|cookie|authorization|session)/i, 'credential_leak', 'high'],

  // Internal route manipulation
  [/(?:modify|change|alter|override|set)\s+(?:the\s+)?(?:internal\s+)?(?:routing?|proxy|upstream|backend|server)\s+(?:to|url|host|address)/i, 'route_manipulation', 'medium'],

  // Local file read attempts (not confused with coding "read file" requests)
  [/(?:read|cat|open|access|fetch)\s+(?:the\s+)?(?:contents?\s+of\s+)?(?:\/etc\/(?:passwd|shadow|hosts)|\/proc\/|~\/\.ssh|\.env\b|credentials\.json|\.aws\/)/i, 'sensitive_file_read', 'high'],

  // Role confusion — pretending to be system/developer
  [/\[SYSTEM\]\s*:/i, 'role_injection', 'medium'],
  [/^system\s*:\s*you\s+are\s+now/im, 'role_injection', 'high'],
  [/\benter\s+(?:developer|admin|root|sudo|maintenance)\s+mode\b/i, 'role_injection', 'medium'],
];

/**
 * Check a message for prompt injection patterns.
 *
 * @param {string} content - Message text to check
 * @returns {{ blocked: boolean, label: string, severity: string } | null}
 *   Returns null if no injection detected, or details if detected.
 */
export function detectInjection(content) {
  if (GUARD_MODE === 'off') return null;
  if (typeof content !== 'string' || !content) return null;

  // Only check against patterns — no ML, no external calls.
  for (const [pattern, label, severity] of PATTERNS) {
    if (GUARD_MODE === 'normal' && severity !== 'high') continue;

    if (pattern.test(content)) {
      return { blocked: true, label, severity };
    }
  }

  return null;
}

/**
 * Scan all messages in a request for injection attempts.
 * Only scans user and tool messages — system and assistant are trusted.
 *
 * @param {Array} messages - OpenAI-format messages array
 * @param {object} [opts] - Options
 * @param {string} [opts.traceId] - Request trace ID for logging
 * @returns {{ blocked: boolean, label?: string, messageIndex?: number }}
 */
export function scanMessages(messages, opts = {}) {
  if (GUARD_MODE === 'off') return { blocked: false };
  if (!Array.isArray(messages)) return { blocked: false };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // Only scan user and tool messages. System/assistant are internal.
    if (m?.role !== 'user' && m?.role !== 'tool') continue;

    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n')
        : '';

    const result = detectInjection(content);
    if (result) {
      // Log the detection with redacted content preview
      const preview = content.slice(0, 100).replace(/\n/g, ' ');
      log.warn(`PromptGuard[${opts.traceId || '?'}]: blocked ${result.label} (severity=${result.severity}) in message[${i}] role=${m.role} preview="${redact(preview)}…"`);

      return {
        blocked: true,
        label: result.label,
        messageIndex: i,
      };
    }
  }

  return { blocked: false };
}

/**
 * Get the current guard mode.
 * @returns {string} 'strict' | 'normal' | 'off'
 */
export function getGuardMode() {
  return GUARD_MODE;
}

/**
 * Create a standardized error response for blocked injections.
 *
 * @param {string} label - Injection type label
 * @param {string} [traceId] - Request trace ID
 * @returns {{ status: number, body: object }}
 */
export function injectionBlockedResponse(label, traceId) {
  return {
    status: 400,
    body: {
      error: {
        message: 'Request blocked: potentially unsafe content detected in the message. If this is a false positive, contact the proxy operator.',
        type: 'prompt_injection_blocked',
        code: 'prompt_injection_blocked',
        ...(traceId ? { trace_id: traceId } : {}),
      },
    },
  };
}
