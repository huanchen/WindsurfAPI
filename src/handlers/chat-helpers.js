/**
 * Chat completions helper functions.
 *
 * Extracted from chat.js for maintainability. Contains:
 *   - JSON extraction and stabilization
 *   - Model routing helpers (thinking, opus, reuse decisions)
 *   - Identity neutralization
 *   - Caller environment extraction
 *   - Tool preamble budget management
 *   - Usage body construction
 *   - Request logging utilities
 *   - Misc pure functions
 */

import { createHash, randomUUID } from 'crypto';
import { contentToString, isCascadeTransportError } from '../client.js';
import { resolveModel, getModelInfo } from '../models.js';
import { log } from '../config.js';
import { sanitizeText } from '../sanitize.js';
import {
  buildToolPreambleForProto, buildCompactToolPreambleForProto,
  buildSchemaCompactToolPreambleForProto, buildSkinnyToolPreambleForProto,
} from './tool-emulation.js';
import { getApiKey } from '../auth.js';

export const HEARTBEAT_MS = 15_000;
export const QUEUE_RETRY_MS = 1_000;
export const QUEUE_MAX_WAIT_MS = 30_000;

// Build the option bag the v2.0.25 semantic key needs. tools / tool_choice /
// preamble are baked into the digest so a tool schema change misses instead
// of silently resuming a cascade where the upstream model has the old tool
// signatures cached.
export function buildReuseOpts({ tools, toolChoice, toolPreamble, preambleTier, emulateTools, route }) {
  return {
    tools: Array.isArray(tools) ? tools : [],
    toolChoice: toolChoice ?? null,
    toolPreamble: toolPreamble || '',
    preambleTier: preambleTier || null,
    emulateTools: !!emulateTools,
    route: route || 'chat',
  };
}

// Build a synthetic assistant turn from the response we just produced so
// fingerprintAfter() reflects the post-turn server state. Without this, the
// next request from the same client (which carries [u1, ourA1, u2]) computes
// fpBefore over [u1, ourA1] but the stored fpAfter was over [u1] only — they
// no longer match and we silently miss the reuse we just set up.
export function appendAssistantTurn(messages, allText, toolCalls) {
  const m = { role: 'assistant', content: allText || '' };
  if (Array.isArray(toolCalls) && toolCalls.length) {
    m.tool_calls = toolCalls.map(tc => ({
      function: {
        name: tc?.name || tc?.function?.name || '',
        arguments: tc?.argumentsJson || tc?.arguments || tc?.function?.arguments || '{}',
      },
    }));
  }
  return [...(messages || []), m];
}

// Cap exponential backoff before falling over to the next account when
// upstream Cascade returns "internal error occurred". Without this a
// 9-account pool hammers the upstream within ~10s and every attempt
// sees the same transient — the OpenClaw real-scenario probe (#28)
// caught this as 11/20 failures even though the proxy itself is
// healthy. With backoff capped at 5s the Nth attempt sees a cooler
// upstream and has a meaningful chance of succeeding.
//   retry 0 → 500ms, 1 → 1s, 2 → 2s, 3 → 4s, ≥4 → 5s
export async function internalErrorBackoff(retryIdx) {
  const ms = Math.min(500 * Math.pow(2, retryIdx), 5000);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

export function upstreamTransientErrorMessage(model, triedCount, reason = 'internal_error') {
  const detail = reason === 'cascade_transport'
    ? 'Cascade/语言服务器 HTTP/2 流被取消'
    : 'internal_error';
  return `${model} 上游 Windsurf Cascade 服务瞬态故障：已在 ${triedCount} 个账号上重试都收到 ${detail}。这是上游或本地语言服务器会话的瞬时问题，建议 30-60 秒后重试；若连续出现，请重启语言服务器。`;
}

export function isUpstreamTransientError(err, isInternal = false) {
  return !!err && (isInternal || err.kind === 'transient_stall' || isCascadeTransportError(err));
}

export function shortHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

// v2.0.55 (audit M2): salvage parser will accept any
// `{"name":"X","arguments":{...}}` JSON it finds in model output. If a user
// message contains a prompt-injection payload (and a non-Claude model
// faithfully echoes it), the parser would emit a tool_call for a name the
// caller never declared — e.g. `Bash` when the request only offered
// `get_weather`. Filter every emitted call against the request-declared
// tools[] before handing it to the client.
//
// Empty tools[] (caller never offered any) → caller is requesting tool
// emulation but didn't declare a list; treat it as "no tools allowed" so
// rogue parser output never reaches the client. Callers using
// `tool_choice:'none'` already get filtered upstream.
export function filterToolCallsByAllowlist(toolCalls, tools) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return toolCalls || [];
  const allowed = new Set();
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const name = t?.function?.name || t?.name;
      if (typeof name === 'string' && name) allowed.add(name);
    }
  }
  if (!allowed.size) {
    // No declared tools but the parser emitted tool_calls — drop them all.
    // Surface once in logs so operators can spot prompt-injection attempts.
    const seenNames = [...new Set(toolCalls.map(tc => tc?.name).filter(Boolean))];
    if (seenNames.length) {
      log.warn(`ToolGuard: dropping ${toolCalls.length} tool_call(s) — request had no tools[] declared (names="${seenNames.join(',')}")`);
    }
    return [];
  }
  const filtered = [];
  const dropped = [];
  for (const tc of toolCalls) {
    if (tc?.name && allowed.has(tc.name)) filtered.push(tc);
    else if (tc?.name) dropped.push(tc.name);
  }
  if (dropped.length) {
    log.warn(`ToolGuard: dropping ${dropped.length} tool_call(s) not in declared tools[] (names="${[...new Set(dropped)].join(',')}", allowed="${[...allowed].join(',')}")`);
  }
  return filtered;
}

export function redactRequestLogText(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/(?:ant-api\d{2}|sk-ant-api\d{2})-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'jwt-***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi, '$1: ***')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***@***');
}

export function requestLogSummary(text, limit = 220) {
  const raw = String(text || '');
  if (process.env.DEBUG_REQUEST_BODIES === '1') {
    return `head="${redactRequestLogText(raw.slice(0, limit)).replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`;
  }
  return `len=${raw.length} hash=${shortHash(raw)}`;
}

export function chatStreamError(message, type = 'upstream_error', code = null) {
  return { error: { message: sanitizeText(message || 'Upstream stream error'), type, code } };
}

/**
 * Extract a clean JSON payload from a model response. Handles three common
 * shapes a non-constrained-decoding model produces when asked for JSON:
 *
 *   1. Fenced code block:   ```json\n{...}\n```
 *   2. Preamble + fence:    Here is the JSON:\n```\n{...}\n```
 *   3. Bare JSON with noise: Sure! {...} Let me know if ...
 *
 * Returns the raw (unparsed) JSON substring so the caller can serialize it
 * straight through. Falls back to the trimmed original text if nothing
 * parseable is found, matching what OpenAI's json_object mode does when the
 * model produces invalid JSON (the response still flows, parsing is the
 * caller's responsibility).
 */
export function extractJsonPayload(text) {
  if (!text) return text;
  // 1. Fenced code block — most common with Cascade
  const fence = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    const inner = fence[1].trim();
    try { JSON.parse(inner); return inner; } catch { /* fall through */ }
  }
  // 2. Scan for the first balanced {...} or [...] block that parses
  const trimmed = text.trim();
  for (let start = 0; start < trimmed.length; start++) {
    const ch = trimmed[start];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inStr) { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  return trimmed;
}

export function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => typeof p?.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  return '';
}

export function extractRequestedJsonKeys(messages) {
  if (!Array.isArray(messages)) return [];
  const text = latestRealUserText(messages) || '';
  if (!text) return [];
  const match = text.match(/\b(?:exact\s+)?keys\s+([A-Za-z_$][\w$-]*(?:\s*,\s*[A-Za-z_$][\w$-]*)*(?:\s+(?:and|&)\s+(?!no\b)[A-Za-z_$][\w$-]*)?)/i);
  if (!match) return [];
  return match[1]
    .replace(/\s+(?:and|&)\s+/gi, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function latestRealUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = textFromMessageContent(m.content);
    if (!text || /^\s*<tool_result\b/i.test(text)) continue;
    return text;
  }
  return '';
}

export function isExplicitJsonRequested(messages) {
  const text = latestRealUserText(messages);
  if (!text) return false;
  if (/\b(?:compact\s+)?JSON\b/i.test(text) && /\b(?:answer|respond|return|output|containing|with|only|valid)\b/i.test(text)) {
    return true;
  }
  if (/\bJSON\s+(?:object|only|format)\b/i.test(text)) return true;
  if (/\b(?:answer|respond|return|output)\s+only\s+(?:with\s+)?(?:valid\s+)?JSON\b/i.test(text)) return true;
  return false;
}

export function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function findDeepValue(obj, wanted) {
  if (!plainObject(obj) && !Array.isArray(obj)) return undefined;
  const wantedLower = wanted.toLowerCase();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.shift();
    if (plainObject(cur)) {
      for (const [k, v] of Object.entries(cur)) {
        if (k.toLowerCase() === wantedLower) return v;
        if (plainObject(v) || Array.isArray(v)) stack.push(v);
      }
    } else if (Array.isArray(cur)) {
      for (const v of cur) {
        if (plainObject(v) || Array.isArray(v)) stack.push(v);
      }
    }
  }
  return undefined;
}

export function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function collectToolFacts(messages) {
  const namesById = new Map();
  const facts = { byTool: {}, all: [] };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) namesById.set(tc.id, tc.function?.name || '');
    }
    if (m?.role !== 'tool') continue;
    const toolName = namesById.get(m.tool_call_id) || 'tool';
    const key = toolName.toLowerCase();
    const content = typeof m.content === 'string' ? m.content.trim() : JSON.stringify(m.content ?? '');
    const parsed = safeJsonParse(extractJsonPayload(content));
    const fact = { toolName, content, parsed };
    facts.all.push(fact);
    if (!facts.byTool[key]) facts.byTool[key] = [];
    facts.byTool[key].push(fact);
  }
  return facts;
}

export function valueFromToolFacts(key, facts) {
  const lower = key.toLowerCase();
  if (lower === 'versionsmatch' || lower === 'versionmatch') return undefined;
  const wantsRead = lower.startsWith('read') || lower.includes('read');
  const wantsBash = lower.startsWith('bash') || lower.includes('bash');
  const wantsVersion = lower.includes('version');
  const wantsName = lower.includes('name') || lower.includes('package');
  const candidates = wantsRead ? (facts.byTool.read || [])
    : wantsBash ? (facts.byTool.bash || [])
      : facts.all;

  if (wantsVersion) {
    for (const f of candidates) {
      if (plainObject(f.parsed)) {
        const v = findDeepValue(f.parsed, 'version');
        if (v !== undefined) return v;
      }
      const m = f.content.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
      if (m) return m[0];
    }
  }
  if (wantsName) {
    for (const f of candidates) {
      if (plainObject(f.parsed)) {
        const v = findDeepValue(f.parsed, 'name');
        if (v !== undefined) return v;
      }
    }
  }
  if (lower === 'ok') return true;
  return undefined;
}

export function stabilizeJsonPayload(text, messages) {
  const keys = extractRequestedJsonKeys(messages);
  if (!keys.length) return text;
  const cleaned = extractJsonPayload(text);
  const parsed = safeJsonParse(cleaned);
  if (!plainObject(parsed)) return cleaned;
  const existingKeys = Object.keys(parsed);
  if (existingKeys.length === keys.length && keys.every((k, i) => existingKeys[i] === k)) {
    return cleaned;
  }

  const facts = collectToolFacts(messages);
  const out = {};
  for (const key of keys) {
    let v = findDeepValue(parsed, key);
    if (v === undefined) v = valueFromToolFacts(key, facts);
    out[key] = v === undefined ? null : v;
  }
  for (const key of keys) {
    const lower = key.toLowerCase();
    if ((lower === 'versionsmatch' || lower === 'versionmatch') && out[key] == null) {
      const read = out.readVersion ?? out.read_version;
      const bash = out.bashVersion ?? out.bash_version;
      if (read != null && bash != null) out[key] = String(read).trim() === String(bash).trim();
    }
  }
  return JSON.stringify(out);
}

export function applyJsonResponseHint(messages, responseFormat) {
  // Inject ONLY a system message. Earlier versions also appended a long
  // "[You MUST respond with valid JSON only ...]" suffix to the latest
  // user turn's content, but that bled into the cascade reuse trajectory
  // upstream — every follow-up turn on the same conversation inherited
  // the JSON-only instruction even when the new turn never asked for
  // JSON, producing things like `{"reply":"你好"}` for a plain greeting
  // (#104). The system message is more authoritative for cascade routing
  // anyway, and is regenerated per request rather than persisted in the
  // conversation history, so it gets the work done without contaminating
  // the trajectory.
  let sysContent = 'Respond with valid JSON only. No markdown, no code fences, no explanation. Output must be parseable by JSON.parse(). Preserve the exact JSON field names requested by the user, and do not add extra fields when an exact key set is requested. If tool results contain the requested values, put only those values into JSON fields rather than describing them in prose or copying the full tool result.';
  if (responseFormat?.type === 'json_schema' && responseFormat?.json_schema?.schema) {
    sysContent += ' Conform to this JSON Schema:\n' + JSON.stringify(responseFormat.json_schema.schema);
  }
  return [{ role: 'system', content: sysContent }, ...(Array.isArray(messages) ? messages : [])];
}

export const CASCADE_REUSE_STRICT = process.env.CASCADE_REUSE_STRICT === '1';
export const CASCADE_REUSE_STRICT_RETRY_MS = (() => {
  const n = parseInt(process.env.CASCADE_REUSE_STRICT_RETRY_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
export const OPUS47_TOOL_EMULATED_REUSE = process.env.OPUS47_TOOL_EMULATED_REUSE !== '0';
export const OPUS47_STRICT_REUSE = process.env.OPUS47_STRICT_REUSE !== '0';
// HIGH-3: a shared API key with no per-user / per-session signal lets two
// concurrent end users behind the same proxy step on each other's cascade
// state. Default off; set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to opt back
// into the legacy permissive behavior (single-user proxies, internal use).
export const CASCADE_REUSE_ALLOW_SHARED_API_KEY = process.env.CASCADE_REUSE_ALLOW_SHARED_API_KEY === '1';

// True when callerKey has any per-user / per-session dimension beyond a
// bare API key (`api:<hash>`). Bare API-key callers without a user signal
// share state across concurrent requests — see HIGH-3 above.
export function hasPerUserScope(callerKey) {
  if (typeof callerKey !== 'string' || !callerKey) return false;
  if (callerKey.includes(':user:')) return true;
  // v2.0.37: apiKey-mode now appends `:client:<ip+ua>` when no body
  // user signal is present, so single-user self-hosted setups land on
  // a stable scope and cascade reuse works across turns. Match the
  // segment anywhere in the string (#93 follow-up zhangzhang-bit).
  if (callerKey.includes(':client:')) return true;
  if (callerKey.startsWith('session:') || callerKey.startsWith('client:')) return true;
  return false;
}

export function isToolSensitiveOpusModel(modelKey = '') {
  // Opus-class models share the same prompt-injection / Claude-Code-tools
  // sensitivity profile, regardless of whether the version label is dotted
  // (claude-opus-4.6) or dashed (claude-opus-4-7-high). #59 confirmed 4.6
  // hits the same multi-turn tool-context loss as 4.7, so the strict-reuse
  // and multimodal-tool-fallback gates apply to both.
  return /^claude-opus-4(?:[.-]6|[.-]7)(?:[-.]|$)/i.test(String(modelKey || ''));
}

export function isSonnet46ToolReuseDisabled() {
  return process.env.WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE === '1';
}

export function isSonnet46Model(modelKey = '') {
  return /^claude-sonnet-4(?:[.-]6)(?:[-.]|$)/i.test(String(modelKey || ''));
}

export function isToolEmulatedReusableModel(modelKey = '') {
  if (isToolSensitiveOpusModel(modelKey)) return true;
  return !isSonnet46ToolReuseDisabled() && isSonnet46Model(modelKey);
}

// Tool-emulated requests are normally kept out of cascade_id reuse because
// <tool_call>/<tool_result> bodies drift across turns. Opus 4.6 / 4.7 and
// Sonnet 4.6 + Claude Code are the exceptions: replaying the full
// prompt/tools/image history is worse than preserving the exact upstream
// cascade, so enable a narrow local path.
// thinking.type can be 'enabled' (Anthropic spec), 'adaptive' (what
// Claude Code 2.x sonnet defaults to), or any future variant — accept
// anything that isn't an explicit 'disabled' so the model still gets
// routed to the -thinking sibling. The previous strict 'enabled' check
// silently dropped every adaptive request to the non-thinking model.
export function isThinkingRequested(body) {
  const thinkingType = body?.thinking?.type;
  if (thinkingType && thinkingType !== 'disabled') return true;
  if (body?.reasoning_effort) return true;
  return false;
}

export function isOpus47ModelKey(modelKey) {
  return /^claude-opus-4-7(?:-|$)/i.test(String(modelKey || ''));
}

export function isOpus47ThinkingAutoRouteEnabled() {
  return process.env.WINDSURFAPI_OPUS47_THINKING_UIDS === '1';
}

export function resolveEffectiveModelKey(modelKey, wantThinking) {
  if (!wantThinking || !modelKey || modelKey.includes('thinking')) return modelKey;
  const thinkingModelKey = modelKey + '-thinking';
  if (!getModelInfo(thinkingModelKey)) return modelKey;
  if (isOpus47ModelKey(modelKey) && !isOpus47ThinkingAutoRouteEnabled()) {
    return modelKey;
  }
  return thinkingModelKey;
}

export function shouldUseCascadeReuse({ useCascade, emulateTools, modelKey, allowToolReuse = OPUS47_TOOL_EMULATED_REUSE }) {
  if (!useCascade) return false;
  if (!emulateTools) return true;
  return !!allowToolReuse && isToolEmulatedReusableModel(modelKey);
}

// Issue #86 follow-up (KLFDan0534): GLM 5.1 (and other non-reasoning models)
// silently produce nothing in claudecode/openclaw — claudecode shows the
// "thinking" indicator but the user sees no text and no thinking content.
//
// Root cause: cascade upstream sometimes packs the entire model response
// into `step.thinking` instead of `step.responseText`. client.js routes
// step.thinking → chunk.thinking → SSE `reasoning_content`. Claude Code
// (and many OpenAI-style clients) hide reasoning_content by default and
// only render `content` deltas. Result: visible silence.
//
// Fix: at stream end, for NON-reasoning models that produced ONLY thinking
// (no text, no tool_calls), promote the thinking buffer to a content delta.
// Reasoning models (caller asked for thinking, OR routing landed on a
// -thinking variant) keep the original split behaviour — those clients
// expect reasoning_content separately.
// `wantThinking` collapses the prior `body` arg — callers compute it via
// isThinkingRequested(body) at the entry point (handleChatCompletions),
// then thread the boolean through deps. The previous shape leaked a
// reference to `body` into streamResponse / nonStreamResponse where it
// wasn't in scope, ReferenceError'ing every stream finish (#93 follow-up
// reported by zhangzhang-bit).
export function shouldFallbackThinkingToText({ routingModelKey, wantThinking, accText, accThinking, hasToolCalls }) {
  if (hasToolCalls) return false;
  if (accText && accText.length) return false;
  if (!accThinking || !accThinking.length) return false;
  if (routingModelKey && /thinking/i.test(routingModelKey)) return false;
  if (wantThinking) return false;
  return true;
}

export function shouldForceCascadeReuse({ emulateTools, modelKey }) {
  return !!emulateTools && OPUS47_TOOL_EMULATED_REUSE && isToolEmulatedReusableModel(modelKey);
}

export function shouldUseStrictCascadeReuse({ emulateTools, modelKey, strict = CASCADE_REUSE_STRICT, allowOpus47Strict = OPUS47_STRICT_REUSE }) {
  return !!strict || (!!emulateTools && !!allowOpus47Strict && isToolSensitiveOpusModel(modelKey));
}

export function hasMultimodalContent(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => Array.isArray(m?.content) && m.content.some(p => {
    const type = String(p?.type || '').toLowerCase();
    return type === 'image' || type === 'image_url' || type === 'input_image'
      || type === 'document' || type === 'file' || type === 'input_file'
      || p?.source?.type === 'base64' || p?.image_url;
  }));
}

export function strictReuseRetryMs(availability) {
  return Math.max(1000, availability?.retryAfterMs || CASCADE_REUSE_STRICT_RETRY_MS);
}

export function strictReuseMessage(model, retryMs, reason = 'temporarily unavailable') {
  return `${model} 上下文复用绑定账号暂不可用（${reason}）。为避免切换账号导致上下文丢失，请 ${Math.ceil(retryMs / 1000)} 秒后重试`;
}

export function recentUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return contentToString(messages[i].content);
  }
  return '';
}

export function shellUnquote(text) {
  const s = String(text || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === '\'' && s.at(-1) === '\''))) {
    return s.slice(1, -1);
  }
  return s;
}

export function trimCommandSentence(text) {
  const s = String(text || '').trim();
  let quote = '';
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote) { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '.' && /\s/.test(s[i + 1] || '')) return s.slice(0, i).trim();
  }
  return s.replace(/[.。]\s*$/, '').trim();
}

export function extractRequestedBashCommands(text) {
  const src = String(text || '');
  const out = [];
  const patterns = [
    /(?:command|run|execute)\s+(?:exactly\s+)?(?::\s*)?`([^`]+)`/gi,
    /(?:command|run|execute)\s+(?:exactly\s+)?(?::\s*)?([^\n]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const candidate = shellUnquote(trimCommandSentence(m[1])).trim();
      if (candidate && /\s/.test(candidate)) out.push(candidate);
    }
  }
  return [...new Set(out)];
}

export function repairToolCallArguments(tc, messages) {
  if (!tc || String(tc.name || '').toLowerCase() !== 'bash' || typeof tc.argumentsJson !== 'string') return tc;
  let args;
  try { args = JSON.parse(tc.argumentsJson); } catch { return tc; }
  if (!args || typeof args.command !== 'string') return tc;
  const current = args.command.trim();
  if (!current) return tc;
  for (const requested of extractRequestedBashCommands(recentUserText(messages))) {
    if (requested.length > current.length && requested.startsWith(current)) {
      return { ...tc, argumentsJson: JSON.stringify({ ...args, command: requested }) };
    }
  }
  return tc;
}

export function rateLimitCooldownMs(message = '') {
  const reset = String(message || '').match(/resets?\s+in\s*:?\s*((?:(?:\d+)\s*[hms]\s*)+)/i);
  if (reset) {
    let total = 0;
    for (const part of reset[1].matchAll(/(\d+)\s*([hms])/gi)) {
      const n = Number(part[1]);
      const unit = part[2].toLowerCase();
      if (unit === 'h') total += n * 60 * 60 * 1000;
      else if (unit === 'm') total += n * 60 * 1000;
      else total += n * 1000;
    }
    if (total > 0) return total;
  }
  const m = String(message || '').match(/(?:retry (?:after|in)|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('h')) return n * 60 * 60 * 1000;
    if (unit.startsWith('m')) return n * 60 * 1000;
    return n * 1000;
  }
  if (/about an hour|in an hour|try again in.*hour/i.test(message)) return 60 * 60 * 1000;
  return 60 * 1000;
}

export function genId() {
  return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 29);
}

export const MODEL_PROVIDERS = {
  claude: 'Anthropic', gpt: 'OpenAI', gemini: 'Google', deepseek: 'DeepSeek',
  grok: 'xAI', qwen: 'Alibaba', kimi: 'Moonshot', glm: 'Zhipu', swe: 'Windsurf',
  o3: 'OpenAI', o4: 'OpenAI',
};

export function neutralizeCascadeIdentity(text, modelName) {
  if (!text || !modelName) return text;
  const provider = MODEL_PROVIDERS[Object.keys(MODEL_PROVIDERS).find(k => modelName.toLowerCase().startsWith(k)) || ''];
  if (!provider) return text;
  let out = text
    // First-person identity claims
    .replace(/\bI am Cascade\b/gi, `I am ${modelName}`)
    .replace(/\bI'm Cascade\b/gi, `I'm ${modelName}`)
    .replace(/\bmy name is Cascade\b/gi, `my name is ${modelName}`)
    .replace(/我是\s*Cascade\b/gi, `我是 ${modelName}`)
    .replace(/我(?:叫|的名字是|的名称是)\s*Cascade\b/gi, `我是 ${modelName}`)
    // Third-person self-reference common in Cascade prose
    .replace(/\bCascade, an AI coding assistant\b/gi, `${modelName}, an AI assistant`)
    .replace(/\bCascade is an? (?:AI )?(?:coding )?assistant\b/gi, `${modelName} is an AI assistant`)
    .replace(/\b(?:As|Acting as) Cascade\b/g, `As ${modelName}`)
    // Provider attribution
    .replace(/\bCascade, made by (?:Codeium|Windsurf)\b/gi, `${modelName}, made by ${provider}`)
    .replace(/\b(?:Codeium|Windsurf)(?:['’]s)? Cascade\b/g, modelName)
    .replace(/\bdeveloped by (?:Codeium|Windsurf)\b/gi, `developed by ${provider}`)
    .replace(/\bcreated by (?:Codeium|Windsurf)\b/gi, `created by ${provider}`)
    .replace(/\bbuilt by (?:Codeium|Windsurf)\b/gi, `built by ${provider}`)
    // Cascade-flavoured workspace narration. The model regularly says things
    // like "Cascade's workspace at /tmp/windsurf-workspace" — sanitizeText
    // already scrubs the path; this strips the lingering "Cascade's" /
    // "the Cascade" prefix so the sentence reads naturally. The leading
    // "the " is consumed by the same regex so we don't end up with the
    // double-article artefact ("the the workspace").
    .replace(/\b(?:the )?Cascade(?:['’]s)? workspace\b/gi, 'the workspace');
  const claudeFamily = String(modelName).toLowerCase().match(/^claude[-.](sonnet|opus|haiku)/)?.[1];
  if (claudeFamily) {
    const familyTitle = claudeFamily[0].toUpperCase() + claudeFamily.slice(1);
    const wrongIdentity = new RegExp(
      `((?:I\\s+am|I'm|I’m|my\\s+model\\s+is|this\\s+model\\s+is|you\\s+are\\s+talking\\s+to|我是|我叫|我的模型是|当前模型是)\\s+(?:Anthropic(?:'s| 的)?\\s*)?)(?:Claude\\s+)?(?:${familyTitle}\\s*4[.-]?5|4[.-]?5\\s*${familyTitle}|claude-${claudeFamily}-4[.-]?5|claude-4\\.5-${claudeFamily})(?:\\s+model)?`,
      'gi'
    );
    out = out
      .replace(wrongIdentity, `$1${modelName}`)
      .replace(
        new RegExp(`([（(]\\s*)(?:claude-${claudeFamily}-4[.-]?5|claude-4\\.5-${claudeFamily}|Claude\\s+${familyTitle}\\s*4[.-]?5)(\\s*[）)])`, 'gi'),
        `$1${modelName}$2`
      );
  }
  return out;
}

export class IdentityNeutralizeStream {
  constructor(modelName, holdChars = 128) {
    this.modelName = modelName;
    this.holdChars = Math.max(32, holdChars);
    this.buf = '';
  }

  feed(text) {
    if (!text) return '';
    this.buf = neutralizeCascadeIdentity(this.buf + text, this.modelName);
    if (this.buf.length <= this.holdChars) return '';
    const emitLen = this.buf.length - this.holdChars;
    const out = this.buf.slice(0, emitLen);
    this.buf = this.buf.slice(emitLen);
    return out;
  }

  flush() {
    if (!this.buf) return '';
    const out = neutralizeCascadeIdentity(this.buf, this.modelName);
    this.buf = '';
    return out;
  }
}

/**
 * Lift authoritative environment facts from the caller's request so they
 * can be re-emitted into the proto-level tool_calling_section override.
 *
 * Why this exists: Claude Code (and most Anthropic-format clients) put
 * working-directory / git / platform info in an `<env>` block inside the
 * system prompt or a `<system-reminder>` user block. That information IS
 * forwarded to Cascade (client.js prepends sysText to the user text), but
 * Cascade's own planner system prompt is structurally more authoritative
 * to the upstream model than user-message text — and Cascade's prompt
 * tells the model "your workspace is /tmp/windsurf-workspace". Result:
 * Opus issues LS / Read against /tmp/windsurf-workspace instead of the
 * user's real cwd, and confidently narrates the contents of an empty
 * scratch dir back as if it were the user's project.
 *
 * Lifting cwd into tool_calling_section gives it equal authority weight
 * inside the model's mental model, and the surrounding wording in
 * buildToolPreambleForProto explicitly tells the model to prefer THIS
 * environment over any prior workspace assumption.
 *
 * Parser is intentionally lenient: it scans every message's text content
 * (string or content-block array) and pulls out the standard Claude Code
 * `<env>` keys. If nothing is found, returns '' and the override gets no
 * environment block (existing behaviour preserved).
 */
export function extractCallerEnvironment(messages) {
  if (!Array.isArray(messages)) return '';
  const seen = new Set();
  const out = [];

  // Match the cwd phrasing every Anthropic-format client we have seen in
  // the wild emits, while staying narrow enough that prose mentions like
  // "the working directory in the docs" don't trip it. Two formats matter:
  //
  //   (a) Canonical `<env>` key/value block (older Claude Code, opencode,
  //       Cline): `Working directory: /path` on its own line. Must allow
  //       a leading `<env>` tag, optional `-`/`*` bullet prefix, and `:`
  //       or `=` separator.
  //
  //   (b) Claude Code 2.1+ prose system prompt: `…and the current working
  //       directory is /path.`  No newline anchor, no separator, the path
  //       just trails the phrase. (Confirmed via the env-NOT-lifted probe
  //       diagnostic against Claude Code v2.1.114.)
  //
  // The capture group is locked to `[/~]…` so we only grab actual-looking
  // paths — "the working directory you choose" or similar abstract prose
  // never has a `/` or `~` in the captured slot and is rejected.
  const PATH_TAIL = `(?:[\\/~]|[A-Za-z]:\\\\)[^\\s\`'"<>\\n.,;)]+`;
  // Adjective slot for "Working directory" — Claude Code 2.x uses
  // "Primary working directory: D:\..." instead of the canonical
  // "Working directory: ...". Other clients use "Current" / "Initial" /
  // "Default" / "Active" / "Project" similarly. Optional, matched
  // case-insensitively. (#106 / #107 follow-up: the user's 26 KB Claude
  // Code system prompt mentions "current working directory" mid-prose
  // first, then later has the actual `- Primary working directory: D:\...`
  // bullet — old regex only allowed the canonical key so the bullet
  // never matched and env never lifted.)
  const ADJ = `(?:Primary|Current|Initial|Default|Active|Project|My)\\s+`;
  const PATTERNS = [
    ['cwd', new RegExp(
      // Form (a): line-anchored key/value, optional adjective prefix
      `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:${ADJ})?(?:Working\\s+directory|cwd|<cwd>)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
      // Form (b): prose "current working directory is /path" (adjacent path)
      `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?`,
      'gi'
    ), (v) => `- Working directory: ${v}`],
    // Git repo: accept "Is directory a git repo" (Claude Code <2.x) AND
    // "Is a git repository" / "Is git repo" (Claude Code 2.x).
    ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is(?:\s+(?:directory\s+)?(?:a\s+)?)git\s+repo(?:sitory)?\s*[:=]\s*([^\n<]+)/i, (v) => `- Is the directory a git repo: ${v}`],
    ['platform', /(?:^|\n)\s*(?:[-*]\s+)?Platform\s*[:=]\s*([^\n<]+)/i, (v) => `- Platform: ${v}`],
    ['os', /(?:^|\n)\s*(?:[-*]\s+)?OS\s+[Vv]ersion\s*[:=]\s*([^\n<]+)/i, (v) => `- OS version: ${v}`],
  ];

  for (const m of messages) {
    if (!m) continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;

    for (const [key, re, fmt] of PATTERNS) {
      if (seen.has(key)) continue;
      // For the cwd pattern (global flag), iterate matches and pick the
      // first one that actually has a non-empty captured path. The earlier
      // matches in a long system prompt may be prose mentions like
      // "...and the current working directory." with no adjacent path
      // because the path lives in a later bullet — we must not stop at
      // the first textual hit.
      if (re.global) {
        for (const match of content.matchAll(re)) {
          const value = (match[1] || match[2] || '').trim();
          if (!value || /[\x00-\x1f]/.test(value) || value === '<workspace>') continue;
          seen.add(key);
          out.push(fmt(value));
          break;
        }
      } else {
        const match = content.match(re);
        if (!match) continue;
        const value = (match[1] || match[2] || '').trim();
        if (!value || /[\x00-\x1f]/.test(value) || value === '<workspace>') continue;
        seen.add(key);
        out.push(fmt(value));
      }
    }
    if (seen.size === PATTERNS.length) break;
  }

  // Only emit an environment block if we actually have the cwd. Platform /
  // OS / git status without cwd are useless for the original goal (tell
  // the model where to run tools) AND adding them anyway makes the
  // tool_calling_section preamble look like a system prompt with no
  // real signal — which trips Opus 4.7's injection guard, observed live
  // when Claude Code v2.1.114 (which does NOT include cwd in its system
  // prompt) caused us to emit an env block containing only Platform +
  // OS Version, and Opus refused with "the message I received is a
  // system prompt for Claude Code along with truncated tool output".
  // Sticking to the rule "no cwd → no block" both removes the noise and
  // lets the model learn cwd via its own `pwd` tool call (which already
  // works on every Anthropic-format client we have tested).
  if (!seen.has('cwd')) {
    // #100 (yunduobaba) fallback — when the canonical extractors miss
    // the cwd (some Claude Code forks / OpenCode variants don't emit
    // a `<env>` block at all), scan the head of the first real user
    // message for a bare absolute path. The user's prompt
    //   "C:\Users\renfei\Downloads\WindsurfAPI-master 分析下这个项目"
    // makes their intended workspace obvious — without this, cascade's
    // built-in /tmp/windsurf-workspace prior wins and the model invents
    // a JSON apology about Linux not being able to read Windows paths.
    const cwd = scanUserMessageForBareCwd(messages);
    if (cwd) return `- Working directory: ${cwd}`;

    // #107 (zhangzhang-bit) fallback — the system prompt was 26 KB and
    // referenced "current working directory" mid-prose with no adjacent
    // path. The actual path was buried somewhere else as a bullet. The
    // canonical regex now allows adjective prefixes ("Primary working
    // directory") which covers the common Claude Code 2.x case, but
    // some custom clients put the cwd on its own bullet with no key at
    // all (just `- D:\Project\foo`). Scan all system messages for a
    // standalone bullet/list line whose value is a single absolute path.
    const bulletCwd = scanForBulletCwdInSystem(messages);
    if (bulletCwd) return `- Working directory: ${bulletCwd}`;
    return '';
  }
  return out.join('\n');
}

// Last-resort cwd scan: walk every system message and look for a line
// like `  - D:\Project\foo` or `* /home/dev/proj` whose only content is
// a single absolute-looking path. This catches the case where a custom
// agent prompt enumerates environment facts in a bulleted list but
// uses no explicit "Working directory:" key. Restricted to system role
// to avoid grabbing a path the user mentioned in passing later in chat.
export function scanForBulletCwdInSystem(messages) {
  if (!Array.isArray(messages)) return '';
  const FILE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|pyc|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|html?|css|scss|sass|less|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|flac|ogg|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|csv|tsv|sql|db|sqlite|log|lock|map|min\.js|min\.css)$/i;
  const BULLET = /^[\s]*[-*•]\s+`?((?:[A-Za-z]:[\\/]|\/[A-Za-z]|~[\\/])[^\s`'"<>\n]+)`?\s*$/m;
  for (const m of messages) {
    if (m?.role !== 'system') continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;
    // matchAll requires the regex to be global; build a fresh global copy.
    const re = new RegExp(BULLET.source, 'gm');
    for (const match of content.matchAll(re)) {
      const cand = match[1];
      if (!cand || cand.length < 5) continue;
      if (FILE_EXT.test(cand)) continue;
      if (cand === '<workspace>') continue;
      return cand;
    }
  }
  return '';
}

// Bare-path fallback for extractCallerEnvironment. Looks at the FIRST
// user-role message only (so a path appearing inside an assistant or
// tool reply later in the conversation doesn't override the original
// intent), takes the leading 200 chars (paths users care about appear
// near the top of a prompt, not buried mid-sentence), and matches one
// of three explicit absolute-path shapes:
//
//   - Windows  C:\... or C:/...
//   - Unix     /home/..., /Users/..., /var/..., etc.
//   - Tilde    ~/projects/...
//
// The path-tail charset is restricted to ASCII filesystem characters
// (alnum, `_`, `-`, `.`, `/`, `\`) so a CJK character or whitespace
// terminates the match cleanly — matters for prompts where the path is
// glued straight to Chinese text without a space ("C:\foo分析这个").
//
// File-extension reject: a path ending in a common file extension is
// almost certainly the user pointing at a single file, not the cwd.
// We could try dirname() it but the heuristic is shaky enough that we
// rather miss than mis-attribute.
export function scanUserMessageForBareCwd(messages) {
  if (!Array.isArray(messages)) return '';
  const FILE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|pyc|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|html?|css|scss|sass|less|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|flac|ogg|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|csv|tsv|sql|db|sqlite|log|lock|map|min\.js|min\.css)$/i;
  // Reject content that is `<text> followed by <path>`. We anchor at ^ so the
  // path must be the first non-trivial token after some leading punctuation /
  // whitespace. After stripping wrappers like <system-reminder> the user's
  // real prompt usually starts cleanly with the path.
  const PATH_AT_HEAD = /^[\s,;:.，。、；：　"'`(\[]*((?:[A-Za-z]:[\\/]|\/[A-Za-z]|~[\\/])[A-Za-z0-9._\\/-]+)/;

  const tryMatch = (text) => {
    const match = text.match(PATH_AT_HEAD);
    if (!match) return '';
    const cand = match[1];
    if (cand.length < 5) return '';
    if (FILE_EXT.test(cand)) return '';
    return cand;
  };

  for (const m of messages) {
    if (m?.role !== 'user') continue;
    let content;
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n');
    else continue;
    if (!content) continue;

    // Pass 1: head of the raw message. Cheapest path; covers vanilla CLIs
    // that don't wrap user input in any preamble.
    const direct = tryMatch(content.slice(0, 300));
    if (direct) return direct;

    // Pass 2 (#100 follow-up, yunduobaba): Claude Code's hooks inject one or
    // more `<system-reminder>...</system-reminder>` blocks at the very top of
    // every user message — frequently 1–5 KB before the user's actual text.
    // That pushes the bare path past the 300-char head and pass 1 misses,
    // even though the path is still the first thing the user typed. Strip
    // those wrappers and try again with a slightly bigger window (the prose
    // that follows tends to be longer than the raw input).
    if (!/<system-reminder\b/i.test(content)) continue;
    const stripped = content.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>\s*/gi, '');
    const wrapped = tryMatch(stripped.slice(0, 500));
    if (wrapped) return wrapped;
  }
  return '';
}

// Rough token estimate (~4 chars/token). Used only to populate the
// OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` field so
// upstream billing/dashboards (new-api) can recognise our local cache hits.
export function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const p of m.content) if (typeof p?.text === 'string') chars += p.text.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export function cachedUsage(messages, completionText) {
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil((completionText || '').length / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: prompt },
    completion_tokens_details: { reasoning_tokens: 0 },
    cached: true,
  };
}

export function applyToolPreambleBudget(tools, toolChoice, callerEnv = '', opts = {}) {
  const modelKey = opts.modelKey || null;
  const provider = opts.provider || null;
  const route = opts.route || null;
  const softBytes = opts.softBytes ?? parseInt(process.env.TOOL_PREAMBLE_SOFT_BYTES || '24000', 10);
  const hardBytes = opts.hardBytes ?? parseInt(process.env.TOOL_PREAMBLE_HARD_BYTES || '48000', 10);
  const tiers = [
    { tier: 'full', build: buildToolPreambleForProto },
    { tier: 'schema-compact', build: buildSchemaCompactToolPreambleForProto },
    { tier: 'skinny', build: buildSkinnyToolPreambleForProto },
    { tier: 'names-only', build: buildCompactToolPreambleForProto },
  ];
  const full = tiers[0].build(tools || [], toolChoice, callerEnv, modelKey, provider, route);
  if (!full) {
    return { ok: true, preamble: '', fullBytes: 0, finalBytes: 0, compacted: false, tier: 'empty', softBytes, hardBytes };
  }
  const fullBytes = Buffer.byteLength(full, 'utf8');

  // Walk the tiers from largest to smallest; pick the first one that fits
  // under the soft cap. If none fit (extreme tool counts), fall through to
  // names-only and let the hard-cap check decide whether to reject.
  let chosen = { tier: 'full', preamble: full, bytes: fullBytes };
  for (const t of tiers) {
    const text = t.tier === 'full' ? full : t.build(tools || [], toolChoice, callerEnv, modelKey, provider, route);
    const bytes = Buffer.byteLength(text, 'utf8');
    chosen = { tier: t.tier, preamble: text, bytes };
    if (bytes <= softBytes) break;
  }

  const compacted = chosen.tier !== 'full';
  if (chosen.bytes > hardBytes) {
    return { ok: false, preamble: chosen.preamble, fullBytes, finalBytes: chosen.bytes, compacted, tier: chosen.tier, softBytes, hardBytes };
  }
  return { ok: true, preamble: chosen.preamble, fullBytes, finalBytes: chosen.bytes, compacted, tier: chosen.tier, softBytes, hardBytes };
}

/**
 * Build an OpenAI-shaped `usage` object, preferring server-reported token
 * counts from Cascade's CortexStepMetadata.model_usage when available, and
 * falling back to the local chars/4 estimate otherwise. Keeps the same shape
 * in both branches so downstream billing doesn't have to care which source
 * produced the numbers.
 *
 * The Cascade backend reports usage as {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens}. We map them onto the OpenAI shape:
 *   prompt_tokens     = inputTokens + cacheReadTokens + cacheWriteTokens
 *                       (total input tokens the model processed, whether fresh,
 *                       cache-read, or cache-written — matches the OpenAI
 *                       convention where prompt_tokens is the grand total)
 *   completion_tokens = outputTokens
 *   prompt_tokens_details.cached_tokens       = cacheReadTokens
 *   cache_creation_input_tokens (Anthropic ext) = cacheWriteTokens
 */
// Anthropic prompt-caching ttl='1h' markers should keep the cascade
// pool entry alive past its 30-minute default. 90 minutes = 1h cache
// window + 30 min slack so the next turn comfortably falls inside the
// extended TTL. 5m markers (the spec default) need no hint — the
// pool's default already covers them.
export function ttlHintFromCachePolicy(cachePolicy) {
  if (!cachePolicy?.has1h) return undefined;
  return 90 * 60 * 1000;
}

export function buildUsageBody(serverUsage, messages, completionText, thinkingText = '', cachePolicy = null) {
  if (serverUsage && (serverUsage.inputTokens || serverUsage.outputTokens)) {
    const inputTokens = serverUsage.inputTokens || 0;
    const outputTokens = serverUsage.outputTokens || 0;
    const cacheRead = serverUsage.cacheReadTokens || 0;
    const cacheWrite = serverUsage.cacheWriteTokens || 0;
    const promptTotal = inputTokens + cacheRead + cacheWrite;
    // Anthropic prompt-caching split: when the client tagged any block
    // with ttl='1h' the creation tokens go to ephemeral_1h, otherwise to
    // ephemeral_5m. Cascade doesn't separate the pools so we can't
    // attribute byte-for-byte; this is the binary "any 1h?" routing
    // Anthropic's own API documents and matches what real clients see
    // when they use a single TTL per request (which is the common case).
    const cacheCreationSplit = {
      ephemeral_5m_input_tokens: cachePolicy?.has1h ? 0 : cacheWrite,
      ephemeral_1h_input_tokens: cachePolicy?.has1h ? cacheWrite : 0,
    };
    return {
      prompt_tokens: promptTotal,
      completion_tokens: outputTokens,
      total_tokens: promptTotal + outputTokens,
      input_tokens: promptTotal,
      output_tokens: outputTokens,
      prompt_tokens_details: { cached_tokens: cacheRead },
      completion_tokens_details: { reasoning_tokens: 0 },
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      cache_creation: cacheCreationSplit,
    };
  }
  const prompt = estimateTokens(messages);
  const completion = Math.max(1, Math.ceil(((completionText || '').length + (thinkingText || '').length) / 4));
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

// Wait until getApiKey returns a non-null account, or until maxWaitMs expires.
// Used when every account has momentarily exhausted its RPM budget so the
// client is queued instead of getting a 503.
export async function waitForAccount(tried, signal, maxWaitMs = QUEUE_MAX_WAIT_MS, modelKey = null, callerKey = '') {
  const deadline = Date.now() + maxWaitMs;
  let acct = getApiKey(tried, modelKey, callerKey);
  while (!acct) {
    if (signal?.aborted) return null;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, QUEUE_RETRY_MS));
    acct = getApiKey(tried, modelKey, callerKey);
  }
  return acct;
}

// v2.0.66 (#115): codex CLI 0.128 sends `model="gpt-5.5"` together with a
// separate `reasoning: {effort:"xhigh"}` (or top-level `reasoning_effort`)
// field. Windsurf's catalog exposes per-effort variants as distinct model
// ids — `gpt-5.5-xhigh`, `gpt-5.5-high`, `gpt-5.5-medium`, etc — and the
// bare `gpt-5.5` alias resolves to `gpt-5.5-medium`. Without merging the
// two fields, the user's `xhigh` knob is silently dropped (zhqsuo's #115
// followup: log shows `model=gpt-5.5-medium reasoning=xhigh`).
//
// Merge logic: if reqModel has no effort suffix already AND
// `${reqModel}-${effort}` resolves to a known model in the catalog, swap.
// Anything else (unknown model, no effort, effort already in name)
// returns reqModel unchanged.
export function mergeReasoningEffortIntoModel(reqModel, body) {
  if (!reqModel || typeof reqModel !== 'string') return reqModel;
  const effort = String(
    body?.reasoning_effort
    || body?.reasoning?.effort
    || ''
  ).toLowerCase().trim();
  if (!effort) return reqModel;
  const VALID = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);
  if (!VALID.has(effort)) return reqModel;
  // Already has an effort suffix — don't double-stamp.
  for (const e of VALID) {
    if (reqModel.toLowerCase().endsWith('-' + e)) return reqModel;
  }
  // Try the merged form. resolveModel returns the model key if it exists,
  // unchanged input otherwise; getModelInfo returns null for unknown models.
  // Both checks together guard against accidentally inventing a model that
  // doesn't exist in the catalog.
  const merged = `${reqModel}-${effort === 'minimal' ? 'none' : effort}`;
  const resolved = resolveModel(merged);
  if (resolved && getModelInfo(resolved)) return merged;
  return reqModel;
}
