/**
 * Request trace ID generator.
 *
 * Every inbound request gets a unique traceId that flows through all layers:
 *   HTTP → Router → Handler → Provider → Logger
 *
 * The traceId appears in:
 *   - Response headers (x-trace-id)
 *   - All log lines for the request
 *   - Error responses
 *   - SSE error events
 *
 * Format: `tr-<timestamp_base36>-<random_6char>`
 * This is sortable by time, unique, and compact.
 */

import { randomUUID } from 'crypto';

/**
 * Generate a new trace ID.
 * @returns {string} A unique, time-sortable trace ID
 */
export function generateTraceId() {
  const ts = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `tr-${ts}-${rand}`;
}

/**
 * Generate a request ID compatible with OpenAI format.
 * @returns {string}
 */
export function generateRequestId() {
  return 'req-' + randomUUID();
}

/**
 * Generate a message ID compatible with Anthropic format.
 * @returns {string}
 */
export function generateMessageId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}
