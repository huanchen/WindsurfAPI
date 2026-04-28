import { createHash } from 'crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

// Extract a per-user / per-session signal from the request body so two
// different end users sharing one API key get different conversation pool
// scopes. v2.0.25 HIGH-3: chat & responses now look at body.user /
// conversation / previous_response_id / metadata.{conversation_id,session_id}.
//
// metadata.user_id is INTENTIONALLY NOT inspected here — handlers/messages.js
// has a specialized parser for it (Claude Code's JSON-encoded
// {device_id, session_id, account_uuid} shape) and appends its own
// `:user:<digest>` to keep the two extraction paths from double-stamping
// the same callerKey.
//
// The returned subkey is appended to the API-key callerKey so reuse stays
// pinned to (apiKey, user/session). Returns '' when no usable signal.
export function extractBodyCallerSubKey(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [
    typeof body.user === 'string' ? body.user : '',
    typeof body?.metadata?.conversation_id === 'string' ? body.metadata.conversation_id : '',
    typeof body.conversation === 'string' ? body.conversation : '',
    typeof body.previous_response_id === 'string' ? body.previous_response_id : '',
    typeof body?.metadata?.session_id === 'string' ? body.metadata.session_id : '',
  ].filter(Boolean);
  if (!candidates.length) return '';
  return sha256Hex(candidates.join('|')).slice(0, 16);
}

export function callerKeyFromRequest(req, apiKey = '', body = null) {
  const bodySubKey = body ? extractBodyCallerSubKey(body) : '';
  if (apiKey) {
    const base = `api:${sha256Hex(apiKey).slice(0, 32)}`;
    return bodySubKey ? `${base}:user:${bodySubKey}` : base;
  }
  const sessionId = req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id'] || '';
  if (sessionId) {
    const base = `session:${sha256Hex(sessionId).slice(0, 32)}`;
    return bodySubKey ? `${base}:user:${bodySubKey}` : base;
  }
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  const base = `client:${sha256Hex(`${ip}\0${ua}`).slice(0, 32)}`;
  return bodySubKey ? `${base}:user:${bodySubKey}` : base;
}

// Returns true if we have any per-user signal beyond the bare API key.
// chat.js consults this to decide whether to allow conversation reuse for a
// shared API key with no user dimension — pre-v2.0.25 we did, which let two
// concurrent end users on the same proxy key share each other's cascade
// state. Now defaults to off; set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to
// restore the legacy permissive behavior.
export function hasCallerScope(callerKey, req, body) {
  if (typeof callerKey === 'string') {
    if (callerKey.includes(':user:')) return true;
    if (callerKey.startsWith('session:') || callerKey.startsWith('client:')) return true;
  }
  if (body && extractBodyCallerSubKey(body)) return true;
  if (req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id']) return true;
  return false;
}
