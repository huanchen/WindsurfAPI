/**
 * Unified Error Normalizer.
 *
 * Translates internal and upstream errors into a consistent structure
 * compatible with both OpenAI and Anthropic client expectations.
 *
 * Goals:
 *   - Never expose upstream raw errors, HTML, stack traces, or tokens
 *   - Provide machine-readable error codes
 *   - Include traceId for debugging
 *   - Support both OpenAI and Anthropic error shapes
 */

// Standard error codes — machine-readable, documented, stable.
export const ErrorCode = {
  INVALID_REQUEST: 'invalid_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_ERROR: 'upstream_error',
  TIMEOUT: 'timeout',
  ACCOUNT_UNAVAILABLE: 'account_unavailable',
  POOL_EXHAUSTED: 'pool_exhausted',
  PROMPT_INJECTION_BLOCKED: 'prompt_injection_blocked',
  SESSION_ERROR: 'session_error',
  MODEL_NOT_FOUND: 'model_not_found',
  MODEL_DEPRECATED: 'model_deprecated',
  MODEL_BLOCKED: 'model_blocked',
  DROUGHT_MODE: 'drought_mode',
  INTERNAL_ERROR: 'internal_error',
  BODY_TOO_LARGE: 'body_too_large',
  TOOL_PREAMBLE_TOO_LARGE: 'tool_preamble_too_large',
};

// Map HTTP status codes to default error codes
const STATUS_TO_CODE = {
  400: ErrorCode.INVALID_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  408: ErrorCode.TIMEOUT,
  410: ErrorCode.MODEL_DEPRECATED,
  413: ErrorCode.BODY_TOO_LARGE,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL_ERROR,
  502: ErrorCode.UPSTREAM_ERROR,
  503: ErrorCode.ACCOUNT_UNAVAILABLE,
  504: ErrorCode.TIMEOUT,
};

/**
 * Sanitize an error message to prevent leaking sensitive info.
 * Strips API keys, tokens, cookies, internal paths, and stack traces.
 *
 * @param {string} message - Raw error message
 * @returns {string} Sanitized message
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== 'string') return 'Unknown error';
  return message
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/(?:ant-api\d{2}|sk-ant-api\d{2})-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'jwt-***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(cookie|set-cookie|authorization)\s*:\s*[^\n\r]+/gi, '$1: ***')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***@***')
    // Strip stack traces
    .replace(/\n\s+at\s+.+/g, '')
    // Strip internal paths
    .replace(/\/opt\/[^\s"'`]+/g, '<internal>')
    .replace(/[A-Z]:\\[^\s"'`]+/gi, '<internal>')
    .trim();
}

/**
 * Create a normalized error response in OpenAI format.
 *
 * @param {object} opts - Error options
 * @param {number} opts.status - HTTP status code
 * @param {string} opts.message - Human-readable message
 * @param {string} [opts.code] - Machine-readable error code
 * @param {string} [opts.type] - Error type (OpenAI convention)
 * @param {string} [opts.param] - Parameter that caused the error
 * @param {string} [opts.traceId] - Request trace ID
 * @param {object} [opts.headers] - Additional response headers
 * @returns {{ status: number, body: object, headers?: object }}
 */
export function normalizeError(opts) {
  const status = opts.status || 500;
  const code = opts.code || STATUS_TO_CODE[status] || ErrorCode.INTERNAL_ERROR;
  const type = opts.type || code;
  const message = sanitizeErrorMessage(opts.message || 'An error occurred');

  const body = {
    error: {
      message,
      type,
      code,
      ...(opts.param ? { param: opts.param } : {}),
      ...(opts.traceId ? { trace_id: opts.traceId } : {}),
    },
  };

  const result = { status, body };
  if (opts.headers) result.headers = opts.headers;
  return result;
}

/**
 * Create a normalized error response in Anthropic format.
 *
 * @param {object} opts - Same as normalizeError
 * @returns {{ status: number, body: object }}
 */
export function normalizeAnthropicError(opts) {
  const status = opts.status || 500;
  const type = opts.type || STATUS_TO_CODE[status] || 'api_error';
  const message = sanitizeErrorMessage(opts.message || 'An error occurred');

  return {
    status,
    body: {
      type: 'error',
      error: {
        type,
        message,
        ...(opts.traceId ? { trace_id: opts.traceId } : {}),
      },
    },
  };
}

/**
 * Create an SSE-compatible error chunk for streaming responses.
 *
 * @param {string} message - Error message
 * @param {string} [type='upstream_error'] - Error type
 * @param {string} [traceId] - Trace ID
 * @returns {object} Error chunk suitable for SSE data payload
 */
export function sseErrorChunk(message, type = 'upstream_error', traceId = null) {
  return {
    error: {
      message: sanitizeErrorMessage(message || 'Upstream stream error'),
      type,
      ...(traceId ? { trace_id: traceId } : {}),
    },
  };
}

/**
 * Classify an upstream error into a normalized error code.
 * Prevents raw upstream errors from reaching clients.
 *
 * @param {Error|object} err - The upstream error
 * @param {number} [upstreamStatus] - HTTP status from upstream
 * @returns {{ code: string, status: number, message: string }}
 */
export function classifyUpstreamError(err, upstreamStatus = 0) {
  const msg = String(err?.message || err || '');
  const status = upstreamStatus || err?.statusCode || err?.status || 502;

  // Rate limit
  if (status === 429 || /rate.?limit|too many requests/i.test(msg)) {
    return { code: ErrorCode.RATE_LIMITED, status: 429, message: 'Rate limited by upstream provider. Please retry later.' };
  }

  // Auth
  if (status === 401 || /unauthorized|invalid.*(?:key|token|credential)/i.test(msg)) {
    return { code: ErrorCode.UNAUTHORIZED, status: 401, message: 'Upstream authentication failed.' };
  }

  // Forbidden / banned
  if (status === 403 || /forbidden|banned|suspended|blocked/i.test(msg)) {
    return { code: ErrorCode.FORBIDDEN, status: 403, message: 'Access denied by upstream provider.' };
  }

  // Timeout
  if (/timeout|timed?\s*out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) {
    return { code: ErrorCode.TIMEOUT, status: 504, message: 'Upstream request timed out.' };
  }

  // Connection / transport
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ERR_HTTP2|stream closed|session closed/i.test(msg)) {
    return { code: ErrorCode.UPSTREAM_ERROR, status: 502, message: 'Upstream connection error. The service may be temporarily unavailable.' };
  }

  // Generic upstream
  return {
    code: ErrorCode.UPSTREAM_ERROR,
    status: status >= 400 ? status : 502,
    message: 'An upstream error occurred. Please try again.',
  };
}
