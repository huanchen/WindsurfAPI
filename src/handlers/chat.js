/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions.
 * Routes to RawGetChatMessage (legacy) or Cascade (premium) based on model type.
 */

import { WindsurfClient, isCascadeTransportError } from '../client.js';
import { getApiKey, acquireAccountByKey, releaseAccount, getAccountAvailability, reportError, reportSuccess, markRateLimited, reportInternalError, updateCapability, getAccountList, isAllRateLimited, isAllTemporarilyUnavailable, refundReservation, looksLikeBanSignal, reportBanSignal, clearBanSignals, isModelBlockedByDrought, getDroughtSummary } from '../auth.js';
import { resolveModel, getModelInfo } from '../models.js';
import { getLsFor, ensureLs } from '../langserver.js';
import { config, log } from '../config.js';
import { recordRequest } from '../dashboard/stats.js';
import { markRequest as markQuietWindowRequest } from '../dashboard/quiet-window-updater.js';
import { isModelAllowed } from '../dashboard/model-access.js';
import { cacheKey, cacheGet, cacheSet } from '../cache.js';
import { isExperimentalEnabled } from '../runtime-config.js';
import { checkMessageRateLimit } from '../windsurf-api.js';
import { getEffectiveProxy } from '../dashboard/proxy-config.js';
import {
  fingerprintBefore, fingerprintAfter, checkout as poolCheckout, checkin as poolCheckin,
} from '../conversation-pool.js';
import {
  normalizeMessagesForCascade, ToolCallStreamParser, parseToolCallsFromText, stripToolMarkupFromText,
} from './tool-emulation.js';
import {
  shouldUseNativeBridge, canMapAllTools, partitionTools, buildReverseLookup,
  buildAdditionalStepsFromHistory, TOOL_MAP,
} from '../cascade-native-bridge.js';
import { sanitizeText, sanitizeToolCall, PathSanitizeStream } from '../sanitize.js';
import { registerSseController } from '../sse-registry.js';
import { generateTraceId } from '../core/trace.js';
import { scanMessages, injectionBlockedResponse } from '../security/prompt-guard.js';


import {
  HEARTBEAT_MS, QUEUE_RETRY_MS, QUEUE_MAX_WAIT_MS,
  buildReuseOpts, appendAssistantTurn, internalErrorBackoff,
  upstreamTransientErrorMessage,
  isUpstreamTransientError, filterToolCallsByAllowlist,
  redactRequestLogText, requestLogSummary, chatStreamError,
  extractJsonPayload,
  extractRequestedJsonKeys,
  isExplicitJsonRequested,
  stabilizeJsonPayload, applyJsonResponseHint,
  CASCADE_REUSE_STRICT, CASCADE_REUSE_STRICT_RETRY_MS,
  OPUS47_TOOL_EMULATED_REUSE, OPUS47_STRICT_REUSE,
  CASCADE_REUSE_ALLOW_SHARED_API_KEY,
  hasPerUserScope, isToolSensitiveOpusModel,
  isSonnet46ToolReuseDisabled, isSonnet46Model,
  isToolEmulatedReusableModel, isThinkingRequested,
  isOpus47ModelKey, isOpus47ThinkingAutoRouteEnabled,
  resolveEffectiveModelKey, shouldUseCascadeReuse,
  shouldFallbackThinkingToText, shouldForceCascadeReuse,
  shouldUseStrictCascadeReuse, hasMultimodalContent,
  strictReuseRetryMs, strictReuseMessage,
  recentUserText, repairToolCallArguments,
  rateLimitCooldownMs, genId,
  neutralizeCascadeIdentity, extractCallerEnvironment,
  cachedUsage, applyToolPreambleBudget,
  ttlHintFromCachePolicy, buildUsageBody, waitForAccount,
  mergeReasoningEffortIntoModel,
} from './chat-helpers.js';

// Re-export helper functions for backward compatibility.
// Tests and other modules import these from './handlers/chat.js'.
export {
  isUpstreamTransientError, filterToolCallsByAllowlist,
  redactRequestLogText, chatStreamError,
  extractRequestedJsonKeys,
  isExplicitJsonRequested, stabilizeJsonPayload, applyJsonResponseHint,
  isToolEmulatedReusableModel, isThinkingRequested,
  resolveEffectiveModelKey, shouldUseCascadeReuse,
  shouldFallbackThinkingToText, shouldUseStrictCascadeReuse,
  repairToolCallArguments, rateLimitCooldownMs,
  neutralizeCascadeIdentity, extractCallerEnvironment,
  applyToolPreambleBudget, mergeReasoningEffortIntoModel,
};


export async function handleChatCompletions(body, context = {}) {
  const reqId = context.traceId || generateTraceId();
  // v2.0.67 (#112): feed the quiet-window auto-updater. Cheap (one
  // timestamp push); covers /v1/chat/completions, /v1/messages and
  // /v1/responses since both messages.js and responses.js go through
  // handleChatCompletions.
  markQuietWindowRequest();
  const {
    stream = false,
    max_tokens,
    tools,
    tool_choice,
    response_format,
  } = body;
  // v2.0.66: merge reasoning_effort into the model id BEFORE alias
  // resolution so `gpt-5.5 + reasoning.effort=xhigh` resolves to
  // `gpt-5.5-xhigh`, not the medium-tier default.
  const reqModel = mergeReasoningEffortIntoModel(body.model, body);
  let messages = body.messages;
  const callerKey = context.callerKey || body.__callerKey || '';
  const cachePolicy = body.__cachePolicy || null;
  const checkMessageRateLimitFn = context.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = context.waitForAccount || waitForAccount;

  // Probe diagnostics: dump compact request shape for every call, plus a
  // tail of the last user turn. Keeps us able to see how third-party
  // verifiers (hvoy.ai) actually probe PDF / JSON / thinking capabilities
  // without exposing full conversation content.
  try {
    const contentTypes = new Set();
    let lastUserText = '';
    for (const m of (messages || [])) {
      if (typeof m?.content === 'string') contentTypes.add('string');
      else if (Array.isArray(m.content)) for (const p of m.content) contentTypes.add(p?.type || typeof p);
      if (m?.role === 'user') {
        const c = m.content;
        lastUserText = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text || '').join(' ') : '';
      }
    }
    log.info(`Probe[${reqId}]: model=${reqModel} stream=${!!stream} rf=${response_format?.type || 'none'} tools=${Array.isArray(tools) ? tools.length : 0} reasoning=${body.reasoning_effort || body.thinking?.type || 'none'} ctypes=[${[...contentTypes].join(',')}] turns=${messages?.length || 0} lastUser=${requestLogSummary(lastUserText, 140)}`);
    // Also dump first-user / system content so we can see preambles.
    for (let mi = 0; mi < Math.min((messages || []).length, 3); mi++) {
      const m = messages[mi];
      const c = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(p => p?.type === 'text' ? p.text : `[${p?.type}]`).join('|') : '';
      log.info(`Probe[${reqId}] msg[${mi}] role=${m?.role} ${requestLogSummary(c)}`);
    }
  } catch {}

  // Prompt Injection guard — scan user/tool messages for injection patterns.
  // Runs BEFORE any message processing to reject malicious payloads early.
  {
    const injection = scanMessages(messages, { traceId: reqId });
    if (injection.blocked) {
      return injectionBlockedResponse(injection.label, reqId);
    }
  }

  // Reject pathologically empty user turns. Without this, an empty
  // `user.content` slips through and the model answers against the
  // system prompt as if it were the user's prompt, producing nonsense
  // output (caught by the OpenClaw human-scenario probe — scenario #14).
  // Match OpenAI's behaviour: 400 invalid_request_error.
  {
    const lastUser = (messages || []).filter(m => m?.role === 'user').pop();
    if (lastUser) {
      const c = lastUser.content;
      let trimmedBytes = 0;
      if (typeof c === 'string') trimmedBytes = c.trim().length;
      else if (Array.isArray(c)) trimmedBytes = c.reduce((n, p) => {
        if (typeof p?.text === 'string') return n + p.text.trim().length;
        // Non-text parts (image_url / input_audio / file / etc.) count as
        // non-empty content — only pure-text empties trigger the 400.
        if (p && typeof p === 'object' && p.type && p.type !== 'text') return n + 1;
        return n;
      }, 0);
      if (trimmedBytes === 0) {
        return {
          status: 400,
          body: {
            error: {
              message: 'The last user message has empty content. Provide a non-empty user prompt.',
              type: 'invalid_request_error',
              param: 'messages',
            },
          },
        };
      }
    }
  }

  // Heavy clients (OpenClaw 24KB, opencode + omo, Cline with full tool
  // catalog) ship system prompts that approach Cascade's ~30KB panel-
  // state ceiling. When that happens upstream intermittently returns
  // `internal error occurred` or invalidates panel state. Surface the
  // size in logs so intermittent failures can be correlated with caller
  // payload rather than chased as proxy bugs.
  {
    const sysBytes = (messages || []).filter(m => m?.role === 'system').reduce((n, m) => {
      const c = m?.content;
      return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
    }, 0);
    if (sysBytes >= 8000) {
      log.warn(`Probe[${reqId}]: large system prompt ${Math.round(sysBytes/1024)}KB — heavy clients (OpenClaw / Cline / opencode) may hit upstream panel-state retries above ~30KB`);
    }
  }

  const explicitJson = isExplicitJsonRequested(messages);
  const wantJson = response_format?.type === 'json_object' || response_format?.type === 'json_schema' || explicitJson;
  if (wantJson) {
    messages = applyJsonResponseHint(messages, response_format);
  }

  const modelKey = resolveModel(reqModel || config.defaultModel);
  const wantThinking = isThinkingRequested(body);
  const effectiveModelKey = resolveEffectiveModelKey(modelKey, wantThinking);
  if (effectiveModelKey !== modelKey) {
    log.info(`Chat[${reqId}]: routed ${modelKey} -> ${effectiveModelKey} (wantThinking=${wantThinking})`);
  } else if (wantThinking && isOpus47ModelKey(modelKey) && getModelInfo(modelKey + '-thinking') && !isOpus47ThinkingAutoRouteEnabled()) {
    log.warn(`Chat[${reqId}]: Opus 4.7 thinking auto-route disabled; using base model ${modelKey}. Upstream LS rejects ${modelKey}-thinking as model not found. Set WINDSURFAPI_OPUS47_THINKING_UIDS=1 only after upstream registers it.`);
  }
  const routingModelKey = effectiveModelKey;
  const modelInfo = getModelInfo(effectiveModelKey) || getModelInfo(modelKey);
  // Reject unknown models. Without this, chat.js used to fall through to
  // legacy rawGetChatMessage with modelEnum=0 and modelUid=null, which
  // upstream silently routed to a default model. Callers saw "I'm Claude 4.5"
  // when they asked for `claude-4.6` (issue #68), or got blank responses for
  // typos. Fail fast with the same shape OpenAI uses.
  if (!modelInfo) {
    return {
      status: 400,
      body: {
        error: {
          message: `Unsupported model: ${reqModel || config.defaultModel}`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      },
    };
  }
  // Return the user's original model name in response.model / response headers
  // so external test harnesses (e.g. hvoy.ai "model signature" check) see
  // exactly what they sent, not a Windsurf-internal alias like
  // `claude-opus-4-7-medium`. Fall back to the canonical name if the request
  // omitted model.
  const displayModel = reqModel || modelInfo?.name || config.defaultModel;
  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  // Cascade requires either a valid modelUid (string) or a recognized modelEnum.
  // Legacy RawGetChatMessage is deprecated (returns empty on current LS).
  // Models with only an old enum and no UID may fail with "neither PlanModel
  // nor RequestedModel" — those models were removed from Windsurf upstream.
  const useCascade = !!(modelUid || modelEnum);

  // Tool-call emulation: if the client passed OpenAI-style tools[], we rewrite
  // tool-result turns into synthetic user text and inject the tool protocol
  // at the system-prompt level via CascadeConversationalPlannerConfig's
  // tool_calling_section (SectionOverrideConfig, OVERRIDE mode). This is far
  // more reliable than user-message-level injection because NO_TOOL mode's
  // baked-in system prompt tells the model "you have no tools" — which
  // overpowers user-message preambles. The section override replaces that
  // section directly so the model sees our emulated tool definitions as
  // authoritative system instructions.
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const hasToolHistory = Array.isArray(messages) && messages.some(m => m?.role === 'tool' || (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
  const emulateTools = useCascade && (hasTools || hasToolHistory);

  // v2.0.66 (#115) — partition-mode native tool bridge.
  //
  // Splits caller's tools[] into:
  //   mapped:    have a TOOL_MAP entry → cascade native trajectory steps
  //              (DEFAULT planner_mode + tool_allowlist + additional_steps[9])
  //   unmapped:  no mapping → existing NO_TOOL emulation toolPreamble
  //              (additional_instructions_section)
  //
  // Both subsets coexist in the same request — when codex CLI 0.128 sends
  // 11 tools and only `shell_command` maps, the planner runs DEFAULT mode
  // with shell_command enabled while update_plan / apply_patch / etc stay
  // on the emulation path. See src/cascade-native-bridge.js for the
  // partition / canMap / shouldUseNativeBridge gate.
  //
  // v2.0.65 used canMapAllTools (all-or-nothing) which never fired for
  // codex CLI in production — the gate is now partitionTools().hasAny.
  const toolPartition = hasTools ? partitionTools(tools) : { mapped: [], unmapped: tools || [], hasAny: false };
  const nativeBridgeOn = useCascade && hasTools && shouldUseNativeBridge(tools, {
    modelKey: routingModelKey,
    provider: modelInfo?.provider || null,
    route: body.__route || 'chat',
  });
  const nativeAdditionalSteps = nativeBridgeOn
    ? buildAdditionalStepsFromHistory(messages || [])
    : [];
  const nativeAllowlist = nativeBridgeOn
    ? Array.from(new Set(toolPartition.mapped
        .map(t => TOOL_MAP[t?.function?.name]?.kind)
        .filter(Boolean)))
    : [];
  // Tools we ship to the emulation toolPreamble: the unmapped subset when
  // bridge is on, or the full tools[] when bridge is off (legacy behaviour).
  const emulationTools = nativeBridgeOn ? toolPartition.unmapped : (tools || []);
  const nativeCallerTools = nativeBridgeOn ? toolPartition.mapped : [];
  if (nativeBridgeOn) {
    const mappedNames = toolPartition.mapped.map(t => t?.function?.name).join(',') || '(none)';
    const unmappedNames = toolPartition.unmapped.map(t => t?.function?.name).join(',') || '(none)';
    log.info(`Chat[${reqId}]: native bridge ON — model=${routingModelKey} mapped=[${mappedNames}] unmapped=[${unmappedNames}] allowlist=${nativeAllowlist.join(',')} additional_steps=${nativeAdditionalSteps.length}`);
  }
  // Build proto-level preamble (goes into tool_calling_section override).
  // Also inject into the last user message as fallback — some models in
  // NO_TOOL mode ignore the SectionOverride entirely and refuse to call
  // tools unless they see the definitions in the conversation itself. (#22)
  // Lift the caller's environment hints (cwd, git status, platform) into
  // the proto-level system slot so Cascade's authoritative planner system
  // prompt can no longer override them with /tmp/windsurf-workspace
  // priors. See extractCallerEnvironment() above for the parser.
  const callerEnv = emulateTools ? extractCallerEnvironment(messages) : '';
  let toolPreamble = '';
  let preambleTier = null;
  // Payload budget for the proto-level tool preamble. The upstream LS
  // panel state caps total request size at ~30KB; the preamble alone can
  // approach that with 30+ tools (Claude Code, opencode, Cline). Past the
  // soft cap we drop full schemas and ship names-only — the model still
  // knows what tools exist and how to invoke them, just not parameter
  // shapes. Only the actual payload after fallback is compared with the
  // hard cap; v2.0.9 rejected on the full-schema size before compacting,
  // which broke real opencode / Claude Code setups with 30-50 MCP tools.
  if (emulateTools) {
    // v2.0.66: when partition-mode native bridge is on, emulation only
    // describes the *unmapped* tools. Mapped tools are delivered via
    // cascade native trajectory steps and would only confuse the planner
    // if they also appeared in the toolPreamble emulation block.
    const budgetTools = emulationTools.length ? emulationTools : (tools || []);
    const budget = applyToolPreambleBudget(budgetTools, tool_choice, callerEnv, {
      modelKey: routingModelKey,
      provider: modelInfo?.provider || null,
      // v2.0.62 (#115) — pass route so GPT-family + Codex/Responses
      // route picks the gpt_native dialect (bare-JSON anti-refusal).
      route: body.__route || 'chat',
    });
    preambleTier = budget.tier;
    if (budget.compacted) {
      log.warn(`Probe[${reqId}]: toolPreamble ${Math.round(budget.fullBytes / 1024)}KB exceeds soft cap ${Math.round(budget.softBytes / 1024)}KB; using ${budget.tier} tier (${Math.round(budget.finalBytes / 1024)}KB, ${budgetTools.length} tools)`);
    }
    if (!budget.ok) {
      log.warn(`Probe[${reqId}]: toolPreamble ${Math.round(budget.finalBytes / 1024)}KB exceeds hard cap ${Math.round(budget.hardBytes / 1024)}KB after ${budget.tier} tier; rejecting (${budgetTools.length} tools)`);
      return {
        status: 400,
        body: {
          error: {
            message: `Tool definitions are too large (${Math.round(budget.finalBytes / 1024)}KB > ${Math.round(budget.hardBytes / 1024)}KB after ${budget.tier} compaction). Reduce the number of tools or shorten tool names.`,
            type: 'invalid_request_error',
            param: 'tools',
            code: 'tool_preamble_too_large',
          },
        },
      };
    }
    toolPreamble = budget.preamble;
  }
  // Diagnostic: surface whether environment lifting actually fired so a real
  // request log immediately tells us if Claude Code 2.x changed `<env>` block
  // wording, or if the extraction guard rejected a valid hint. Cheap to log,
  // and the alternative is a 200-char Probe head that hides the env block.
  if (emulateTools) {
    if (callerEnv) {
      const compact = callerEnv.replace(/\s+/g, ' ').slice(0, 200);
      log.info(`Chat[${reqId}]: env lifted into tool_calling_section: ${compact}`);
    } else {
      // Hunt for env-shaped substrings so we can see WHY the extractor
      // missed (e.g. Claude Code put cwd in a freeform paragraph instead
      // of the canonical `Working directory: …` line).
      let probe = '';
      for (const m of (messages || [])) {
        const c = typeof m?.content === 'string' ? m.content
          : Array.isArray(m?.content) ? m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n')
          : '';
        const hit = c.match(/[^.\n]{0,40}(?:working directory|cwd|<env>|<cwd>)[^.\n]{0,80}/i);
        if (hit) { probe = hit[0].replace(/\s+/g, ' ').slice(0, 160); break; }
      }
      log.info(`Chat[${reqId}]: env NOT lifted (extractor returned empty)${probe ? '; nearest env-shaped substring in messages: ' + probe : '; no env-shaped substring found in any message'}`);
    }
  }
  const disableUserToolFallback = emulateTools && isToolSensitiveOpusModel(routingModelKey) && hasMultimodalContent(messages);
  if (disableUserToolFallback) {
    log.info(`Chat[${reqId}]: disabled user-message tool fallback for Opus 4.x multimodal turn`);
  }
  // Native bridge mutates the message list differently from emulation:
  // tool_result turns become additional_steps[9] entries on the proto, not
  // synthetic <tool_result> user turns in the conversation text. We strip
  // those tool messages and assistant tool_calls entries from the cascade
  // message list so the planner only sees real human / assistant text plus
  // its trajectory inheritance — duplicate context would confuse it.
  let cascadeMessages;
  if (nativeBridgeOn) {
    cascadeMessages = (messages || []).filter(m => {
      if (m?.role === 'tool') return false;
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length && !m.content) return false;
      return true;
    });
  } else if (emulateTools) {
    cascadeMessages = normalizeMessagesForCascade(messages, tools, {
      injectUserPreamble: !disableUserToolFallback,
      modelKey: routingModelKey,
      provider: modelInfo?.provider || null,
      route: body.__route || 'chat',
    });
  } else {
    cascadeMessages = [...messages];
  }
  // Bundle the v2.0.65 native bridge handles into one opts object so we
  // can thread it through nonStreamResponse / streamResponse / cascadeChat
  // without growing every signature by 3+ params.
  const nativeOpts = nativeBridgeOn ? {
    enabled: true,
    allowlist: nativeAllowlist,
    additionalSteps: nativeAdditionalSteps,
    callerLookup: buildReverseLookup(nativeCallerTools),
    callerTools: nativeCallerTools,
  } : null;

  // Note: previous versions injected (a) a CJK language-following hint into
  // the last user message and (b) a per-provider identity system prompt
  // ("You are Claude Opus...") when the experimental modelIdentityPrompt
  // toggle was on. Both were removed per issue #48 — users reported unwanted
  // system prompt residue even after turning the toggle off, and the CJK
  // hint surfaced as an English `[IMPORTANT...]` line appended to their own
  // message. Cascade's own communication_section (proto field 13) already
  // handles identity neutrally; response-side neutralizeCascadeIdentity
  // still rewrites stray "I am Cascade" leaks without touching inputs.

  // Deprecated models were dropped from Windsurf upstream; their Cascade
  // request returns a cryptic "neither PlanModel nor RequestedModel
  // specified" 502 that callers mis-diagnose as a transient failure and
  // retry forever. Surface it as a clean 410 + model_deprecated so the
  // caller knows to switch models. Baseline probe (scripts/probes/
  // tool-emission-probe.mjs) hit this on gpt-4o-mini ×3 variants × 5
  // samples = 15/15 upstream_error; 9 models are currently flagged
  // deprecated in src/models.js.
  if (modelInfo?.deprecated) {
    return {
      status: 410,
      body: {
        error: {
          message: `模型 ${displayModel} 已被 Windsurf 上游废弃，不再可用。建议切换到当前可用模型（如 gemini-2.5-flash、claude-haiku-4-5、claude-sonnet-4-6）。`,
          type: 'model_deprecated',
        },
      },
    };
  }

  // v2.0.58 — drought mode + premium model gate. When every active
  // account is below the weekly threshold AND the operator has the
  // restriction enabled (default ON, toggleable from dashboard or env
  // DROUGHT_RESTRICT_PREMIUM=0), refuse premium models with a clean
  // 503 + retry-after instead of letting the request burn its way to
  // an upstream rate-limit. Free-tier models (gemini-2.5-flash etc.)
  // still go through.
  if (isModelBlockedByDrought(routingModelKey)) {
    const summary = getDroughtSummary();
    const freeList = (summary.freeTierModels || []).slice(0, 4).join(', ') || 'gemini-2.5-flash';
    const retryAfterSec = Math.max(60, Math.min(60 * 60 * 24, 60 * 30)); // hint 30 min by default
    log.warn(`Chat[drought]: blocking premium model ${routingModelKey} (lowestWeekly=${summary.lowestWeeklyPercent}%, ${summary.knownAccounts}/${summary.activeAccounts} accounts known)`);
    return {
      status: 503,
      headers: { 'Retry-After': String(retryAfterSec) },
      body: {
        error: {
          message: `账号池处于配额低水位（drought mode）：所有账号本周配额都低于 ${summary.threshold}%，已暂时屏蔽 premium 模型 ${displayModel}。请改用免费层模型（${freeList}…），或等周配额重置。可在 Dashboard 实验性面板关闭 droughtRestrictPremium 强制下发（会消耗最后一点配额）。`,
          type: 'drought_mode',
          drought: {
            lowestWeeklyPercent: summary.lowestWeeklyPercent,
            lowestDailyPercent: summary.lowestDailyPercent,
            threshold: summary.threshold,
            activeAccounts: summary.activeAccounts,
            allowedModels: summary.freeTierModels,
          },
        },
      },
    };
  }

  // Global model access control (allowlist / blocklist from dashboard)
  const access = isModelAllowed(routingModelKey);
  if (!access.allowed) {
    return { status: 403, body: { error: { message: access.reason, type: 'model_blocked' } } };
  }

  // Per-account model routing preflight: if NO active account has this
  // model in its tier ∩ available list, fail fast instead of looping
  // through every account trying to find one. This surfaces tier
  // entitlement and blocklist errors as a clean 403 rather than a 30s
  // queue timeout → pool_exhausted.
  //
  // QQ-group 2026-04-30 follow-up: if the only ineligibility is that a
  // freshly-added account hasn't been probed yet (userStatusLastFetched=0),
  // the unknown tier is now optimistic (= pro catalog) so this branch
  // shouldn't fire for that case. If we DO end up here with un-probed
  // accounts, surface a different message hinting at probe-pending state
  // rather than the misleading "model not entitled" — that error shaped
  // user reports of "获取不到模型" / "添加账号后不能调用".
  const accounts = getAccountList();
  const anyEligible = accounts.some(a =>
    a.status === 'active' && (a.availableModels || []).includes(routingModelKey)
  );
  if (!anyEligible) {
    const hasUnprobedActive = accounts.some(a => a.status === 'active' && !a.userStatusLastFetched);
    return {
      status: 403,
      body: {
        error: {
          message: hasUnprobedActive
            ? `模型 ${displayModel} 暂不可用：账号刚添加还未完成 tier 检测，请稍候 10-30 秒后重试，或在 dashboard 手动点 Probe`
            : `模型 ${displayModel} 在当前账号池中不可用（未订阅或已被封禁）`,
          type: hasUnprobedActive ? 'probe_pending' : 'model_not_entitled',
        },
      },
    };
  }

  const chatId = genId();
  const created = Math.floor(Date.now() / 1000);
  const ckey = cacheKey(body, callerKey);

  if (stream) {
    return streamResponse(
      chatId,
      created,
      displayModel,
      routingModelKey,
      modelInfo?.provider || null,
      messages,
      cascadeMessages,
      modelEnum,
      modelUid,
      useCascade,
      ckey,
      emulateTools,
      toolPreamble,
      reqId,
      wantJson,
      callerKey,
      {
      checkMessageRateLimit: checkMessageRateLimitFn,
      waitForAccount: waitForAccountFn,
      cachePolicy,
      wantThinking,
      fpOpts: buildReuseOpts({ tools, toolChoice: tool_choice, toolPreamble, preambleTier, emulateTools, route: body.__route || 'chat' }),
      tools,
      route: body.__route || 'chat',
      nativeOpts,
    });
  }

  // ── Local response cache (exact body match) ─────────────
  const cached = cacheGet(ckey);
  if (cached) {
    log.info(`Chat: cache HIT model=${displayModel} flow=non-stream`);
    recordRequest(displayModel, true, 0, null);
    const message = { role: 'assistant', content: cached.text || null };
    if (cached.thinking) message.reasoning_content = cached.thinking;
    return {
      status: 200,
      body: {
        id: chatId, object: 'chat.completion', created, model: displayModel,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: cachedUsage(messages, cached.text),
      },
    };
  }

  // ── Cascade conversation pool (experimental) ──
  // If the client is continuing a prior conversation and we still hold the
  // cascade_id from last turn, pin this request to that exact (account, LS)
  // pair so the Windsurf backend serves from its hot per-cascade context
  // instead of replaying the whole history.
  //
  // Conversation reuse lets Cascade keep server-side context across turns.
  const sharedApiKeyNoScope = !hasPerUserScope(callerKey) && !CASCADE_REUSE_ALLOW_SHARED_API_KEY;
  if (sharedApiKeyNoScope) {
    log.info(`Chat[${reqId}]: cascade reuse disabled — shared API key with no per-user dimension (set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to override)`);
  }
  const reuseEnabled = !sharedApiKeyNoScope
    && shouldUseCascadeReuse({ useCascade, emulateTools, modelKey: routingModelKey })
    && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey: routingModelKey }));
  const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey: routingModelKey });
  const fpOpts = buildReuseOpts({ tools, toolChoice: tool_choice, toolPreamble, preambleTier: preambleTier || null, emulateTools, route: body.__route || 'chat' });
  const fpBefore = reuseEnabled ? fingerprintBefore(messages, routingModelKey, callerKey, fpOpts) : null;
  let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey) : null;
  let checkedOutReuseEntry = reuseEntry;
  // v2.0.25 HIGH-2: a SendUserCascadeMessage that hit "cascade not found"
  // marks the entry dead — any restore path further down must drop it
  // instead of putting a known-dead cascadeId back in the pool.
  let reuseEntryDead = false;
  if (reuseEntry) log.info(`Chat[${reqId}]: reuse HIT cascade=${reuseEntry.cascadeId.slice(0, 8)} model=${displayModel}`);

  // Non-stream: retry with a different account on model-not-available errors
  const tried = [];
  let lastErr = null;
  // Count upstream_internal_error hits separately from rate_limit / model
  // errors. When >0 we add backoff between attempts (give upstream a
  // breather), and when ALL attempts hit it we surface a clean
  // upstream_transient_error instead of the misleading "rate limit"
  // message the all-accounts-exhausted branch would otherwise produce.
  let internalCount = 0;
  // Dynamic: try every active account in the pool (capped at 10) so a
  // large pool with many rate-limited accounts can still fall through
  // to a free one. Was hardcoded 3 — in pools bigger than 3 with the
  // first accounts rate-limited, healthy accounts were never reached
  // even though they would have worked (issue #5).
  const maxAttempts = Math.min(10, Math.max(3, getAccountList().filter(a => a.status === 'active').length));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let acct = null;
    if (reuseEntry && attempt === 0) {
      acct = acquireAccountByKey(reuseEntry.apiKey, routingModelKey);
      if (!acct) {
        // Owning account busy — wait up to 5s for it instead of immediately
        // giving up. Dropping reuse means falling back to text-blob history
        // which loses context on most models.
        for (let w = 0; w < 10 && !acct; w++) {
          await new Promise(r => setTimeout(r, 500));
          acct = acquireAccountByKey(reuseEntry.apiKey, routingModelKey);
        }
        if (!acct) {
          log.info(`Chat[${reqId}]: reuse MISS — owning account not available after 5s wait`);
          if (strictReuse && checkedOutReuseEntry && fpBefore) {
            const availability = getAccountAvailability(checkedOutReuseEntry.apiKey, routingModelKey);
            const retryAfterMs = strictReuseRetryMs(availability);
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
            log.info(`Chat[${reqId}]: strict reuse preserved cascade; owner unavailable reason=${availability.reason}`);
            return {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
              body: {
                error: {
                  message: strictReuseMessage(displayModel, retryAfterMs, availability.reason),
                  type: 'rate_limit_exceeded',
                  retry_after_ms: retryAfterMs,
                },
              },
            };
          }
          reuseEntry = null;
        }
      }
    }
    if (!acct) {
      acct = await waitForAccountFn(tried, null, QUEUE_MAX_WAIT_MS, routingModelKey, callerKey);
      if (!acct) {
        // Same diagnostic-error fix as the stream path — surface real reason
        // for the queue timeout (rate limit / no entitlement / upstream stall)
        // so the client gets a useful message instead of falling through to
        // a generic pool_exhausted error from the bottom of this function.
        if (!lastErr) {
          const tempUnavail = isAllTemporarilyUnavailable(routingModelKey);
          const rateLimited = isAllRateLimited(routingModelKey);
          const is429 = tempUnavail.allUnavailable || rateLimited.allLimited;
          const retryMs = tempUnavail.allUnavailable ? tempUnavail.retryAfterMs
            : rateLimited.allLimited ? rateLimited.retryAfterMs
            : QUEUE_MAX_WAIT_MS;
          const retrySeconds = Math.ceil(retryMs / 1000);
          const reason = tempUnavail.allUnavailable
            ? `所有可用账号暂时不可用，请 ${retrySeconds} 秒后重试`
            : rateLimited.allLimited
            ? `所有可用账号均已达速率限制，请 ${retrySeconds} 秒后重试`
            : `${Math.ceil(QUEUE_MAX_WAIT_MS / 1000)} 秒内没有账号变为可用 — 账号可能被速率限制或对当前模型无权限`;
          lastErr = {
            status: is429 ? 429 : 503,
            headers: is429 ? { 'Retry-After': String(retrySeconds) } : undefined,
            body: { error: {
              message: `${displayModel} 账号队列超时: ${reason}`,
              type: is429 ? 'rate_limit_exceeded' : 'pool_exhausted',
              retry_after_ms: retryMs,
              reset_seconds: retrySeconds,
            } },
          };
        }
        break;
      }
    }
    tried.push(acct.apiKey);

    try {
    // Pre-flight rate limit check (experimental): ask server.codeium.com if
    // this account still has message capacity before burning an LS round trip.
    if (isExperimentalEnabled('preflightRateLimit')) {
      try {
        const px = getEffectiveProxy(acct.id) || null;
        const rl = await checkMessageRateLimitFn(acct.apiKey, px);
        if (!rl.hasCapacity) {
          log.warn(`Preflight: ${acct.email} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
          refundReservation(acct.apiKey, acct.reservationTimestamp);
          if (Number.isFinite(rl.retryAfterMs) && rl.retryAfterMs > 0) {
            markRateLimited(acct.apiKey, rl.retryAfterMs, routingModelKey);
          }
          if (!reuseEntryDead && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
            const availability = getAccountAvailability(acct.apiKey, routingModelKey);
            const retryAfterMs = strictReuseRetryMs(availability);
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
            log.info(`Chat[${reqId}]: strict reuse preserved cascade after preflight rate limit`);
            return {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
              body: {
                error: {
                  message: strictReuseMessage(displayModel, retryAfterMs, availability.reason),
                  type: 'rate_limit_exceeded',
                  retry_after_ms: retryAfterMs,
                },
              },
            };
          }
          continue;
        }
      } catch (e) {
        log.debug(`Preflight check failed for ${acct.email}: ${e.message}`);
        // Fail open — proceed with the request
      }
    }

    await ensureLs(acct.proxy);
    const ls = getLsFor(acct.proxy);
    if (!ls) { lastErr = { status: 503, body: { error: { message: 'No LS instance available', type: 'ls_unavailable' } } }; break; }
    // Cascade pins cascade_id to a specific LS port too; if the LS it was
    // born on has been replaced, the cascade_id is dead.
    if (reuseEntry && reuseEntry.lsPort !== ls.port) {
      log.info(`Chat[${reqId}]: reuse MISS — LS port changed`);
      checkedOutReuseEntry = null;
      reuseEntry = null;
    }
    const _msgChars = (messages || []).reduce((n, m) => {
      const c = m?.content;
      return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
    }, 0);
    log.info(`Chat[${reqId}]: model=${displayModel} flow=${useCascade ? 'cascade' : 'legacy'} attempt=${attempt + 1} account=${acct.email} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgChars}${reuseEntry ? ' reuse=1' : ''}${emulateTools ? ' tools=emu' : ''}`);
    const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
    const result = await nonStreamResponse(
      client, chatId, created, displayModel, routingModelKey, messages, cascadeMessages, modelEnum, modelUid,
      useCascade, acct.apiKey, ckey,
      reuseEnabled ? { reuseEntry, lsPort: ls.port, apiKey: acct.apiKey, callerKey, cachePolicy, fpOpts } : null,
      modelInfo?.provider || null,
      emulateTools, toolPreamble, wantJson, cachePolicy, wantThinking, tools, body.__route || 'chat',
      nativeOpts,
    );
    if (result.status === 200) return result;
    reuseEntry = null; // don't try to reuse on the retry
    if (result.reuseEntryInvalid) reuseEntryDead = true;
    // #101: same upstream-timeout invalidation as the stream path —
    // see the matching catch block in streamResponse for the full
    // rationale (cascade trajectory left half-broken, next reuse hits
    // it and the model "loses" the prior conversation).
    const _resultMsg = String(result.body?.error?.message || '');
    if (/context deadline exceeded|context cancellation while reading body|client\.timeout/i.test(_resultMsg)) {
      reuseEntryDead = true;
    }
    lastErr = result;
    const errType = result.body?.error?.type;
    // v2.0.61 (#113): policy_blocked → don't rotate accounts, return
    // immediately. The model refused the request, swapping accounts
    // gives the same refusal but burns more quota.
    if (errType === 'policy_blocked') return result;
    // Rate limit: this account is done for this model, try the next one
    if (errType === 'rate_limit_exceeded') {
      if (!reuseEntryDead && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
        const availability = getAccountAvailability(acct.apiKey, routingModelKey);
        const retryAfterMs = strictReuseRetryMs(availability);
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
        log.info(`Chat[${reqId}]: strict reuse preserved cascade after rate limit`);
        return {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
          body: {
            error: {
              message: strictReuseMessage(displayModel, retryAfterMs, availability.reason),
              type: 'rate_limit_exceeded',
              retry_after_ms: retryAfterMs,
            },
          },
        };
      }
      log.warn(`Account ${acct.email} rate-limited on ${displayModel}, trying next account`);
      continue;
    }
    // Cascade transient 错误通常是上游或本地 LS 短暂抖动，先退避再切账号，避免连续打爆同一热窗口。
    if (errType === 'upstream_internal_error' || errType === 'upstream_transient_error') {
      internalCount++;
      const backoffMs = await internalErrorBackoff(internalCount - 1);
      log.warn(`Chat[${reqId}]: ${acct.email} upstream transient error, waited ${backoffMs}ms before next account`);
      continue;
    }
    // Model not available on this account (permission_denied, etc.)
    if (errType === 'model_not_available') {
      log.warn(`Account ${acct.email} cannot serve ${displayModel}, trying next account`);
      continue;
    }
    break; // other errors (502, transport) — don't retry
    } finally {
      // Pair every successful getApiKey/acquireAccountByKey with a release
      // so the in-flight-count based balancer in auth.js (issue #37) stays
      // accurate across success, retry, and abort paths.
      if (acct) releaseAccount(acct.apiKey);
    }
  }
  // 所有账号都遇到 Cascade transient 时，账号轮换已经无法修复；返回明确错误，避免误报成限流或模型不可用。
  if (internalCount > 0 && tried.length > 0 && internalCount >= tried.length) {
    if (!reuseEntryDead && checkedOutReuseEntry && fpBefore) {
      poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
      log.info(`Chat[${reqId}]: restored checked-out cascade after all-internal-error chain`);
    }
    const lastIsTransport = isCascadeTransportError(lastErr);
    log.error(`Chat[${reqId}]: ${tried.length}/${tried.length} accounts hit upstream transient error — surfacing upstream_transient_error`);
    return {
      status: 502,
      body: { error: { message: upstreamTransientErrorMessage(displayModel, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error'), type: 'upstream_transient_error' } },
    };
  }
  // If all accounts exhausted, check if it's because they're all rate-limited
  const temporaryUnavailable = isAllTemporarilyUnavailable(routingModelKey);
  if (temporaryUnavailable.allUnavailable) {
    if (!reuseEntryDead && checkedOutReuseEntry && fpBefore) {
      poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
      log.info(`Chat[${reqId}]: restored checked-out cascade after temporary unavailability`);
    }
    const retryAfterSec = Math.ceil(temporaryUnavailable.retryAfterMs / 1000);
    return {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
      body: {
        error: {
          message: `${displayModel} 所有账号暂时不可用，请 ${retryAfterSec} 秒后重试`,
          type: 'rate_limit_exceeded',
          retry_after_ms: temporaryUnavailable.retryAfterMs,
        },
      },
    };
  }
  if (!lastErr || lastErr.status === 429) {
    const rl = isAllRateLimited(routingModelKey);
    if (rl.allLimited) {
      if (checkedOutReuseEntry && fpBefore) {
        poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
        log.info(`Chat[${reqId}]: restored checked-out cascade after rate limit`);
      }
      const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
      return { status: 429, headers: { 'Retry-After': String(retryAfterSec) }, body: { error: { message: `${displayModel} 所有账号均已达速率限制，请 ${retryAfterSec} 秒后重试`, type: 'rate_limit_exceeded', retry_after_ms: rl.retryAfterMs } } };
    }
  }
  if (!reuseEntryDead && checkedOutReuseEntry && fpBefore) {
    poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
    log.info(`Chat[${reqId}]: restored checked-out cascade after failed request`);
  } else if (reuseEntryDead) {
    log.info(`Chat[${reqId}]: reuse entry was invalidated (cascade not_found upstream); not restoring to pool`);
  }
  return lastErr || { status: 503, body: { error: { message: 'No active accounts available', type: 'pool_exhausted' } } };
}

async function nonStreamResponse(client, id, created, model, modelKey, messages, cascadeMessages, modelEnum, modelUid, useCascade, apiKey, ckey, poolCtx, provider, emulateTools, toolPreamble, wantJson = false, cachePolicy = null, wantThinking = false, tools = [], route = 'chat', nativeOpts = null) {
  const startTime = Date.now();
  const nativeBridgeOn = !!nativeOpts?.enabled;
  try {
    let allText = '';
    let allThinking = '';
    let cascadeMeta = null;
    let toolCalls = [];
    // Server-reported token usage from CortexStepMetadata.model_usage, summed
    // across all trajectory steps. Preferred over the chars/4 estimate when
    // present so downstream billing (new-api, etc.) sees real Cascade numbers.
    let serverUsage = null;

    if (useCascade) {
      const chunks = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
        reuseEntry: poolCtx?.reuseEntry || null,
        toolPreamble: nativeBridgeOn ? '' : toolPreamble,
        displayModel: model,
        nativeMode: nativeBridgeOn,
        nativeAllowlist: nativeOpts?.allowlist || null,
        additionalSteps: nativeOpts?.additionalSteps || null,
      });
      for (const c of chunks) {
        if (c.text) allText += c.text;
        if (c.thinking) allThinking += c.thinking;
      }
      cascadeMeta = {
        cascadeId: chunks.cascadeId,
        sessionId: chunks.sessionId,
        stepOffset: chunks.stepOffset,
        generatorOffset: chunks.generatorOffset,
      };
      serverUsage = chunks.usage || null;
      if (nativeBridgeOn) {
        // v2.0.65: planner-native trajectory steps come back via
        // chunks.toolCalls with `cascade_native: true`. Translate each
        // back into the caller's OpenAI tool name + the schema the caller
        // declared. Steps without a caller mapping are dropped — they
        // can't be safely surfaced (caller wouldn't know how to execute).
        const lookup = nativeOpts?.callerLookup || new Map();
        const nativeCalls = [];
        for (const raw of (chunks.toolCalls || [])) {
          if (!raw?.cascade_native) continue;
          const candidates = lookup.get(raw.name) || [];
          const callerName = candidates[0];
          if (!callerName) continue;
          const reverseFn = TOOL_MAP[callerName]?.reverse;
          let cascadeArgs;
          try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { cascadeArgs = {}; }
          let openaiArgs;
          try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
          catch { openaiArgs = cascadeArgs; }
          nativeCalls.push({
            id: raw.id || `call_${nativeCalls.length}_${Date.now().toString(36)}`,
            name: callerName,
            argumentsJson: JSON.stringify(openaiArgs ?? {}),
          });
        }
        toolCalls = filterToolCallsByAllowlist(nativeCalls, tools);
        // Strip any tool-call markup that may have leaked into text — the
        // planner sometimes narrates "I'm going to look at X" alongside
        // emitting the cascade step, and the caller doesn't want that
        // noise.
        allText = stripToolMarkupFromText(allText);
        if (toolCalls.length === 0 && (chunks.toolCalls || []).length > 0) {
          log.info(`Chat[non-stream]: nativeBridge=true received ${chunks.toolCalls.length} cascade tool calls but none mapped to caller tools (kinds=${chunks.toolCalls.map(tc => tc.name).join(',')})`);
        }
      } else if (emulateTools) {
        // Capture pre-parse text once for diagnostic logging — useful when
        // non-Claude models emit a tool call in a format the parser missed.
        // Sample only the first 240 chars to keep logs sane.
        const rawTextHead = allText.slice(0, 240).replace(/\s+/g, ' ');
        const parsed = parseToolCallsFromText(allText, {
          modelKey,
          provider,
          // v2.0.62 (#115) — route lets the parser pick the gpt_native
          // dialect when responses.js routed here for a GPT-family model.
          route,
        });
        allText = parsed.text;
        // v2.0.55 audit M2: drop tool_calls whose name isn't in the
        // request-declared tools[] (salvage parser otherwise lets
        // prompt-injection payloads emit calls for tools the caller
        // never offered, e.g. `Bash` when only `get_weather` is declared).
        toolCalls = filterToolCallsByAllowlist(parsed.toolCalls, tools);
        // Diagnostic: emulation was active and the model returned text but no
        // recognized tool call. Surface tool-shaped substrings so we can see
        // whether the model emitted an unsupported format (markdown-fenced
        // JSON, OpenAI native function_call, natural-language "I'll call X")
        // vs simply ignored the prompt and answered conversationally. Used to
        // diagnose "tool_use never appears" reports — issue #109 sub2api E2E.
        if (toolCalls.length === 0 && allText) {
          const markers = [];
          if (/<tool_call/i.test(allText)) markers.push('xml_tag');
          if (/```\s*(?:json|tool_call)/i.test(allText)) markers.push('fenced_json');
          if (/"function"\s*:|"tool_calls"\s*:|"function_call"\s*:/.test(allText)) markers.push('openai_native');
          if (/\{\s*"name"\s*:\s*"[a-zA-Z0-9_-]+"\s*,\s*"arguments"/.test(allText)) markers.push('bare_json');
          if (/^\s*(?:I'?ll|I will|Let me|I'?m going to)\s+(?:call|use|invoke|run)/im.test(allText)) markers.push('natural_lang');
          log.info(`Chat[non-stream]: emulateTools=true but parser found 0 tool_calls (model=${modelKey} provider=${provider}); markers=${markers.join(',') || 'none'}; head="${rawTextHead}"`);
        }
      } else {
        allText = stripToolMarkupFromText(allText);
      }
      // Built-in Cascade tool calls (chunks.toolCalls — edit_file, view_file,
      // list_directory, run_command, etc.) are intentionally DROPPED in
      // emulation/legacy paths. Their argumentsJson and result fields may
      // reference server-internal paths like /tmp/windsurf-workspace/config.yaml
      // and must never be exposed to an API caller. The native bridge path
      // above is the ONLY surface that surfaces these — and it sanitises
      // each tool call's args via reverse mapping before emitting.
    } else {
      const chunks = await client.rawGetChatMessage(messages, modelEnum, modelUid);
      for (const c of chunks) {
        if (c.text) allText += c.text;
      }
    }

    // Scrub server-internal filesystem paths from everything we're about to
    // return. See src/sanitize.js for the patterns and rationale.
    allText = sanitizeText(allText);
    allText = neutralizeCascadeIdentity(allText, model);
    if (wantJson && allText) {
      allText = stabilizeJsonPayload(allText, messages);
    }
    allThinking = sanitizeText(allThinking);
    if (toolCalls.length) {
      toolCalls = toolCalls.map(tc => sanitizeToolCall(repairToolCallArguments(tc, messages)));
    }
    // GLM5.1 silence fallback (#86 follow-up KLFDan0534) — non-stream path.
    // Same logic as streamResponse: if a non-reasoning model produced ONLY
    // thinking content (and no tool_calls), promote thinking to text so the
    // OpenAI-compatible client renders it as `content`, not `reasoning_content`.
    if (shouldFallbackThinkingToText({
      routingModelKey: modelKey,
      wantThinking,
      accText: allText,
      accThinking: allThinking,
      hasToolCalls: toolCalls.length > 0,
    })) {
      log.info(`Chat[non-stream]: thinking-only response from non-reasoning model ${modelKey}; promoting ${allThinking.length}c thinking → content`);
      allText = allThinking;
      allThinking = '';
    }

    // Check the cascade back into the pool under the *post-turn* fingerprint
    // so the next request in the same conversation can resume it.
    if (poolCtx && cascadeMeta?.cascadeId && (allText || toolCalls.length)) {
      const turnComplete = appendAssistantTurn(messages, allText, toolCalls);
      const fpAfter = fingerprintAfter(turnComplete, modelKey, poolCtx.callerKey || '', poolCtx.fpOpts);
      const ttlHint = ttlHintFromCachePolicy(poolCtx.cachePolicy);
      // Explicit 0 (not undefined) clears any inherited 1h hint when the
      // current request didn't ask for it (MED-2). ttlHintFromCachePolicy
      // returns undefined for "no opinion"; pass 0 when we know the user
      // wants the default TTL.
      poolCheckin(fpAfter, {
        cascadeId: cascadeMeta.cascadeId,
        sessionId: cascadeMeta.sessionId,
        lsPort: poolCtx.lsPort,
        lsGeneration: cascadeMeta.lsGeneration || poolCtx.lsGeneration,
        apiKey: poolCtx.apiKey,
        stepOffset: Number.isFinite(cascadeMeta.stepOffset) ? cascadeMeta.stepOffset : poolCtx.reuseEntry?.stepOffset,
        generatorOffset: Number.isFinite(cascadeMeta.generatorOffset) ? cascadeMeta.generatorOffset : poolCtx.reuseEntry?.generatorOffset,
        historyCoverage: cascadeMeta.historyCoverage || poolCtx.reuseEntry?.historyCoverage || null,
        createdAt: poolCtx.reuseEntry?.createdAt,
      }, poolCtx.callerKey || '', ttlHint === undefined ? 0 : ttlHint);
    }

    reportSuccess(apiKey, poolCtx?.callerKey || '', modelKey);
    updateCapability(apiKey, modelKey, true, 'success');
    recordRequest(model, true, Date.now() - startTime, apiKey);

    // Store in cache for next identical request. Skip caching tool_call
    // responses — they're inherently contextual and the cache doesn't
    // preserve the tool_calls array, so a cache hit would return a
    // content-only response with finish_reason:stop, breaking tool flow.
    if (ckey && !toolCalls.length) cacheSet(ckey, { text: allText, thinking: allThinking });

    const message = { role: 'assistant', content: allText || null };
    if (allThinking) message.reasoning_content = allThinking;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${i}_${Date.now().toString(36)}`,
        type: 'function',
        function: {
          name: tc.name || 'unknown',
          arguments: tc.argumentsJson || tc.arguments || '{}',
        },
      }));
      // OpenAI convention: content is null when finish_reason is tool_calls.
      // In text emulation the model often emits an inline answer alongside the
      // <tool_call> block (e.g., hallucinated weather data). Set content to
      // null so clients that check `content !== null` behave correctly and the
      // caller waits for the real tool result rather than showing hallucinated
      // data.
      message.content = null;
    }

    // Prefer server-reported usage; fall back to chars/4 estimate only when
    // the trajectory didn't include a ModelUsageStats field. cachePolicy is
    // threaded through as its own parameter rather than via poolCtx so that
    // non-reuse requests with `cache_control: { ttl: '1h' }` still attribute
    // their tokens to ephemeral_1h_input_tokens correctly (see #82, #83).
    const usage = buildUsageBody(serverUsage, messages, allText, allThinking, cachePolicy);
    const finishReason = toolCalls.length ? 'tool_calls' : 'stop';
    return {
      status: 200,
      body: {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      },
    };
  } catch (err) {
    // Only count true auth failures against the account. Workspace/cascade/model
    // errors and transport issues shouldn't disable the key.
    const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
    const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
    const isInternal = /internal error occurred.*error id/i.test(err.message);
    const isTransport = isCascadeTransportError(err);
    const isTransient = isUpstreamTransientError(err, isInternal);
    // v2.0.61 (#113): Anthropic / OpenAI content-policy / verification
    // challenges are NOT transient — rotating accounts won't help and
    // wastes quota. Detect and short-circuit with a clean 451 + clear
    // error so clients stop the retry loop. Patterns are conservative:
    // we only catch unambiguous policy markers, not generic "content
    // moderation" warnings (which can be retried on a different model).
    const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(err.message);
    if (isAuthFail) reportError(apiKey);
    if (isRateLimit) { markRateLimited(apiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
    if (isInternal) { reportInternalError(apiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
    if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
    if (isPolicyBlocked) { err.isPolicyBlocked = true; err.isModelError = true; err.kind = 'policy_blocked'; }
    // v2.0.56: ban-shaped error → reportBanSignal handles the 2-strike
    // promotion to status='banned'. Skip when also a rate-limit so we
    // don't conflate "out of quota" with "account dead".
    if (!isRateLimit && looksLikeBanSignal(err.message)) {
      reportBanSignal(apiKey, err.message);
      err.isModelError = true; err.kind ||= 'auth_error';
    }
    if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
      updateCapability(apiKey, modelKey, false, 'model_error');
    }
    recordRequest(model, false, Date.now() - startTime, apiKey);
    log.error('Chat error:', err.message);
    // v2.0.61 — policy block surfaces as 451 Unavailable For Legal Reasons,
    // which is exactly the semantic clients need (the model refuses the
    // request itself, no retry will help).
    if (isPolicyBlocked) {
      return {
        status: 451,
        body: {
          error: {
            message: `请求被上游 policy 拦截 (${model})。这不是账号问题 — 切账号也救不回来；请改 prompt 或换模型再试。原始上游消息：${err.message.slice(0, 200)}`,
            type: 'policy_blocked',
          },
        },
      };
    }
    // Rate limits → 429 with Retry-After; model errors → 403; others → 502
    if (isRateLimit) {
      const rl = isAllRateLimited(modelKey);
      const retryMs = rl.retryAfterMs || 60000;
      return {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(retryMs / 1000)) },
        body: { error: { message: `${model} 已达速率限制，请稍后重试`, type: 'rate_limit_exceeded', retry_after_ms: retryMs } },
      };
    }
    // LS crash on oversized payload — gRPC surfaces this as "pending stream
    // has been canceled" within a second. Give the user an actionable hint.
    const isStreamCanceled = /pending stream has been canceled|panel state|ECONNRESET/i.test(err.message);
    if (isStreamCanceled) {
      const chars = (messages || []).reduce((n, m) => {
        const c = m?.content;
        return n + (typeof c === 'string' ? c.length :
          Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
      }, 0);
      if (chars > 500_000) {
        return {
          status: 413,
          body: { error: {
            message: `请求过大（${Math.round(chars / 1024)}KB 输入）导致语言服务器中断。请尝试：1) 分块发送；2) 先用摘要/summarization 预处理 PDF；3) 减少历史轮数`,
            type: 'payload_too_large',
          } },
        };
      }
    }
    return {
      status: isTransient ? 502 : (err.isModelError ? 403 : 502),
      reuseEntryInvalid: !!err.reuseEntryInvalid,
      body: { error: {
        message: isTransient
          ? upstreamTransientErrorMessage(model, 1, isTransport ? 'cascade_transport' : 'internal_error')
          : sanitizeText(err.message),
        type: isTransient ? 'upstream_transient_error' : (err.isModelError ? 'model_not_available' : 'upstream_error'),
      } },
    };
  }
}

function streamResponse(id, created, model, modelKey, provider, messages, cascadeMessages, modelEnum, modelUid, useCascade, ckey, emulateTools, toolPreamble, reqId, wantJson = false, callerKey = '', deps = {}) {
  const checkMessageRateLimitFn = deps.checkMessageRateLimit || checkMessageRateLimit;
  const waitForAccountFn = deps.waitForAccount || waitForAccount;
  // Cache policy threads through deps because streamResponse is a top-level
  // helper, not a closure. Without this, lines that compute TTL hints or
  // attribute usage to ephemeral_5m_input_tokens / ephemeral_1h_input_tokens
  // throw a ReferenceError mid-stream — the exact failure surface reported
  // in issues #82 and #83.
  const cachePolicy = deps.cachePolicy || null;
  const fpOpts = deps.fpOpts || { route: 'chat' };
  // v2.0.55 audit M2: stream parser also needs the request-declared
  // tools[] to filter out tool_calls whose name isn't on the allowlist.
  // Same threat model as nonStreamResponse — prompt-injection content
  // can drive a non-Claude model to emit `<tool_call>{"name":"Bash"}…`
  // even when the caller only declared `get_weather`.
  const declaredTools = Array.isArray(deps.tools) ? deps.tools : [];
  // v2.0.65 (#115) — native tool bridge handles. Stream path consumes the
  // same shape as nonStreamResponse: `{enabled, allowlist, additionalSteps,
  // callerLookup, callerTools}`. When enabled, stream emits cascade-native
  // trajectory steps directly as OpenAI tool_call deltas (the planner is in
  // DEFAULT mode and proposes view_file / run_command / grep_search_v2 / find
  // / list_dir as first-class steps, not as <tool_call> markup in text).
  const nativeOpts = deps.nativeOpts || null;
  const nativeBridgeOn = !!nativeOpts?.enabled;
  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      // no-store (not no-cache) so middlebox aggregators like sub2api (#97)
      // don't priority-cache SSE chunks and replay them for fresh requests.
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(res) {
      const abortController = new AbortController();
      let unregisterSse = () => {};
      res.on('close', () => {
        if (!res.writableEnded) {
          log.info('Client disconnected mid-stream, aborting upstream');
          abortController.abort();
        }
      });
      const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      unregisterSse = registerSseController({
        abort(reason) {
          send(chatStreamError(reason || 'server shutting down', 'server_error', 'server_shutdown'));
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          abortController.abort(reason);
        },
      });

      // SSE heartbeat: keep the TCP/HTTP connection alive through any silent
      // period (LS warmup, Cascade "thinking", queue wait). `:` prefix is a
      // comment line per the SSE spec — clients ignore it, intermediaries see
      // bytes flowing, idle timers get reset.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      const stopHeartbeat = () => clearInterval(heartbeat);
      res.on('close', stopHeartbeat);

      // ── Cache hit: replay stored response as a fake stream ──
      const cached = cacheGet(ckey);
      if (cached) {
        log.info(`Chat: cache HIT model=${model} flow=stream`);
        recordRequest(model, true, 0, null);
        try {
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (cached.thinking) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { reasoning_content: cached.thinking }, finish_reason: null }] });
          }
          if (cached.text) {
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: cached.text }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [], usage: cachedUsage(messages, cached.text) });
          if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        } finally {
          unregisterSse();
          stopHeartbeat();
        }
        return;
      }

      const startTime = Date.now();
      const tried = [];
      let hadSuccess = false;
      let rolePrinted = false;
      let currentApiKey = null;
      let lastErr = null;
      // Same purpose as nonStreamResponse's internalCount: track upstream
      // internal_error hits across attempts so we can (a) back off
      // between accounts and (b) surface upstream_transient_error when
      // every attempt hit it.
      let streamInternalCount = 0;
      // Dynamic: try every active account in the pool (capped at 10) so a
  // large pool with many rate-limited accounts can still fall through
  // to a free one. Was hardcoded 3 — in pools bigger than 3 with the
  // first accounts rate-limited, healthy accounts were never reached
  // even though they would have worked (issue #5).
  const maxAttempts = Math.min(10, Math.max(3, getAccountList().filter(a => a.status === 'active').length));

      // Accumulate chunks so we can cache a successful response at the end.
      let accText = '';
      let accThinking = '';

      // Cascade conversation pool (stream path). Opus 4.7 tool-emulated
      // requests opt in even when the global experiment toggle is off, because
      // replaying full Claude Code history is what triggers context blowups.
      const sharedApiKeyNoScopeStream = !hasPerUserScope(callerKey) && !CASCADE_REUSE_ALLOW_SHARED_API_KEY;
      const reuseEnabled = !sharedApiKeyNoScopeStream
        && shouldUseCascadeReuse({ useCascade, emulateTools, modelKey })
        && (isExperimentalEnabled('cascadeConversationReuse') || shouldForceCascadeReuse({ emulateTools, modelKey }));
      const strictReuse = shouldUseStrictCascadeReuse({ emulateTools, modelKey });
      const fpBefore = reuseEnabled ? fingerprintBefore(messages, modelKey, callerKey, fpOpts) : null;
      let reuseEntry = reuseEnabled ? poolCheckout(fpBefore, callerKey) : null;
      let checkedOutReuseEntry = reuseEntry;
      // v2.0.25 HIGH-2: same dead-entry signal as the non-stream path.
      let reuseEntryDead = false;
      if (reuseEntry) log.info(`Chat: cascade reuse HIT cascadeId=${reuseEntry.cascadeId.slice(0, 8)}… stream model=${model}`);

      // Strip <tool_call>/<tool_result> blocks in Cascade mode.
      // In emulation mode, parsed calls are emitted as OpenAI tool_calls.
      // In non-emulation mode, blocks are silently stripped (defense-in-depth
      // against Cascade's system prompt inducing tool markup).
      //
      // These are re-created at the start of each retry attempt (before the
      // first chunk is consumed) so stale buffers from a failed attempt —
      // e.g. a half-read `<tool_call>` tag — can't corrupt the next
      // account's stream. `let` bindings so the retry loop below can
      // reassign.
      let toolParser = useCascade ? new ToolCallStreamParser({
        parseBareJson: emulateTools,
        parseToolCode: emulateTools,
        modelKey,
        provider,
        route: deps?.route || 'chat',
      }) : null;
      const collectedToolCalls = [];

      // Streaming path sanitizers. Every text/thinking delta flows through a
      // PathSanitizeStream before leaving the server so /tmp/windsurf-workspace,
      // /opt/windsurf and /root/WindsurfAPI literals can never slip out even
      // if a path straddles a chunk boundary. See src/sanitize.js.
      let pathStreamText = new PathSanitizeStream();
      let pathStreamThinking = new PathSanitizeStream();

      const emitContent = (clean) => {
        if (!clean) return;
        accText += clean;
        // When response_format=json_object/json_schema is set, buffer text
        // instead of streaming it out. We can't safely fence-strip in the
        // middle of a stream (fence might straddle a chunk, and we'd need
        // lookahead). On finish we'll emit one clean JSON payload.
        if (wantJson) return;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: clean }, finish_reason: null }] });
      };
      const emitThinking = (clean) => {
        if (!clean) return;
        accThinking += clean;
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: clean }, finish_reason: null }] });
      };

      const emitToolCallDelta = (tc, idx) => {
        send({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {
            tool_calls: [{
              index: idx,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: sanitizeText(tc.argumentsJson || '{}') },
            }],
          }, finish_reason: null }] });
      };

      const onChunk = (chunk) => {
        if (!rolePrinted) {
          rolePrinted = true;
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        }
        hadSuccess = true;

        if (chunk.text) {
          // Pipeline for text deltas:
          //   raw chunk  →  ToolCallStreamParser (strip <tool_call> blocks)
          //              →  PathSanitizeStream   (scrub server paths)
          //              →  client
          let safeText = chunk.text;
          if (toolParser) {
            const parsed = toolParser.feed(chunk.text);
            safeText = parsed.text;
            if (Array.isArray(parsed.items) && parsed.items.length) {
              for (const item of parsed.items) {
                if (item.type === 'text') {
                  emitContent(pathStreamText.feed(item.text));
                  continue;
                }
                if (emulateTools) {
                  // v2.0.55 audit M2: filter against declaredTools allowlist
                  // before emitting. Empty list → block everything (caller
                  // didn't declare any tools).
                  const filtered = filterToolCallsByAllowlist([item.toolCall], declaredTools);
                  if (!filtered.length) continue;
                  const tc = sanitizeToolCall(repairToolCallArguments(filtered[0], messages));
                  const idx = collectedToolCalls.length;
                  collectedToolCalls.push(tc);
                  emitToolCallDelta(tc, idx);
                }
              }
              safeText = '';
            } else {
              // Only emit tool_call deltas when emulating — otherwise the
              // parsed calls came from Cascade's built-in tools and are
              // silently discarded. Sanitize server-internal paths out of
              // the emulated call's input too (issue #38) — otherwise Claude
              // Code tries to Read the sandbox path and fails.
              const filteredCalls = emulateTools
                ? filterToolCallsByAllowlist(parsed.toolCalls, declaredTools)
                : [];
              for (const rawTc of filteredCalls) {
                const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
            }
          }
          if (safeText) emitContent(pathStreamText.feed(safeText));
        }
        if (chunk.thinking) {
          emitThinking(pathStreamThinking.feed(chunk.thinking));
        }
      };

      try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (abortController.signal.aborted) return;
          // Rebuild per-attempt stream state so a prior failure's residue
          // (partial <tool_call>, half-scrubbed path) can't leak into the
          // retry. Skip on attempt 0 — already fresh. hadSuccess=true
          // means we already emitted content so no retry happens anyway.
          if (attempt > 0 && !hadSuccess) {
            if (useCascade) {
              toolParser = new ToolCallStreamParser({
                parseBareJson: emulateTools,
                parseToolCode: emulateTools,
                modelKey,
                provider,
                route: deps?.route || 'chat',
              });
            }
            pathStreamText = new PathSanitizeStream();
            pathStreamThinking = new PathSanitizeStream();
          }
          let acct = null;
          if (reuseEntry && attempt === 0) {
            acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
            if (!acct) {
              for (let w = 0; w < 10 && !acct && !abortController.signal.aborted; w++) {
                await new Promise(r => setTimeout(r, 500));
                acct = acquireAccountByKey(reuseEntry.apiKey, modelKey);
              }
              if (!acct) {
                log.info(`Chat[${reqId}]: reuse MISS — owning account not available after 5s wait`);
                if (strictReuse && checkedOutReuseEntry && fpBefore) {
                  const availability = getAccountAvailability(checkedOutReuseEntry.apiKey, modelKey);
                  const retryAfterMs = strictReuseRetryMs(availability);
                  lastErr = Object.assign(
                    new Error(strictReuseMessage(model, retryAfterMs, availability.reason)),
                    { type: 'rate_limit_exceeded' }
                  );
                  log.info(`Chat[${reqId}]: strict reuse preserved cascade; owner unavailable reason=${availability.reason}`);
                  break;
                }
                reuseEntry = null;
              }
            }
          }
          if (!acct) {
            acct = await waitForAccountFn(tried, abortController.signal, QUEUE_MAX_WAIT_MS, modelKey, callerKey);
            if (!acct) {
              // Without an explicit lastErr here, the final retry-failed log
              // ends up printing an empty message and the SSE error event
              // surfaces as a 30s silent stall to the client — issue #77 from
              // zhangzhang-bit. Diagnose what kept the queue empty so the
              // operator sees the real cause (rate limit / no entitlement /
              // upstream stall) instead of guessing.
              if (!lastErr) {
                const tempUnavail = isAllTemporarilyUnavailable(modelKey);
                const rateLimited = isAllRateLimited(modelKey);
                const is429 = tempUnavail.allUnavailable || rateLimited.allLimited;
                const retryMs = tempUnavail.allUnavailable ? tempUnavail.retryAfterMs
                  : rateLimited.allLimited ? rateLimited.retryAfterMs
                  : QUEUE_MAX_WAIT_MS;
                const retrySeconds = Math.ceil(retryMs / 1000);
                const reason = tempUnavail.allUnavailable
                  ? `所有可用账号暂时不可用，请 ${retrySeconds} 秒后重试`
                  : rateLimited.allLimited
                  ? `所有可用账号均已达速率限制，请 ${retrySeconds} 秒后重试`
                  : `${Math.ceil(QUEUE_MAX_WAIT_MS / 1000)} 秒内没有账号变为可用 — 账号可能被速率限制或对当前模型无权限`;
                lastErr = Object.assign(
                  new Error(`${model} 账号队列超时: ${reason}`),
                  { type: is429 ? 'rate_limit_exceeded' : 'pool_exhausted', retry_after_ms: retryMs, reset_seconds: retrySeconds }
                );
              }
              break;
            }
          }
          tried.push(acct.apiKey);
          currentApiKey = acct.apiKey;

          try {
          // Pre-flight rate limit check (experimental)
          if (isExperimentalEnabled('preflightRateLimit')) {
            try {
              const px = getEffectiveProxy(acct.id) || null;
              const rl = await checkMessageRateLimitFn(acct.apiKey, px);
              if (!rl.hasCapacity) {
                log.warn(`Preflight: ${acct.email} has no capacity (remaining=${rl.messagesRemaining}), skipping`);
                refundReservation(acct.apiKey, acct.reservationTimestamp);
                if (Number.isFinite(rl.retryAfterMs) && rl.retryAfterMs > 0) {
                  markRateLimited(acct.apiKey, rl.retryAfterMs, modelKey);
                }
                if (!reuseEntryDead && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === acct.apiKey) {
                  const availability = getAccountAvailability(acct.apiKey, modelKey);
                  const retryAfterMs = strictReuseRetryMs(availability);
                  lastErr = Object.assign(
                    new Error(strictReuseMessage(model, retryAfterMs, availability.reason)),
                    { type: 'rate_limit_exceeded' }
                  );
                  log.info(`Chat[${reqId}]: strict reuse preserved cascade after preflight rate limit`);
                  break;
                }
                continue;
              }
            } catch (e) {
              log.debug(`Preflight check failed for ${acct.email}: ${e.message}`);
            }
          }

          try { await ensureLs(acct.proxy); } catch (e) { lastErr = e; break; }
          const ls = getLsFor(acct.proxy);
          if (!ls) { lastErr = new Error('No LS instance available'); break; }
          if (reuseEntry && reuseEntry.lsPort !== ls.port) {
            log.info(`Chat[${reqId}]: reuse MISS — LS port changed`);
            checkedOutReuseEntry = null;
            reuseEntry = null;
          }
          const _msgCharsStream = (messages || []).reduce((n, m) => {
            const c = m?.content;
            return n + (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((k, p) => k + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
          }, 0);
          log.info(`Chat: model=${model} flow=${useCascade ? 'cascade' : 'legacy'} stream=true attempt=${attempt + 1} account=${acct.email} ls=${ls.port} turns=${(messages||[]).length} chars=${_msgCharsStream}${reuseEntry ? ' reuse=1' : ''}`);
          const client = new WindsurfClient(acct.apiKey, ls.port, ls.csrfToken);
          let cascadeResult = null;
          try {
            if (useCascade) {
              cascadeResult = await client.cascadeChat(cascadeMessages, modelEnum, modelUid, {
                onChunk, signal: abortController.signal, reuseEntry,
                toolPreamble: nativeBridgeOn ? '' : toolPreamble,
                displayModel: model,
                nativeMode: nativeBridgeOn,
                nativeAllowlist: nativeOpts?.allowlist || null,
                additionalSteps: nativeOpts?.additionalSteps || null,
              });
            } else {
              await client.rawGetChatMessage(messages, modelEnum, modelUid, { onChunk });
            }
            // Flush order matters:
            //   1. ToolCallStreamParser tail → may produce more text deltas
            //      (e.g., a dangling <tool_call> that never closed falls
            //      through as literal text)
            //   2. PathSanitizeStream tail (text) → scrubs anything the tool
            //      parser held back AND anything we were holding ourselves
            //   3. PathSanitizeStream tail (thinking)
            if (toolParser) {
              const tail = toolParser.flush();
              if (tail.text) emitContent(pathStreamText.feed(tail.text));
              // M2 allowlist on the tail flush as well — stream end can
              // still emit tail tool_calls and they need the same filter.
              const filteredTail = emulateTools
                ? filterToolCallsByAllowlist(tail.toolCalls, declaredTools)
                : [];
              for (const rawTc of filteredTail) {
                const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
              // Diagnostic: same as nonStreamResponse but for the SSE path —
              // surface why no tool_calls came out when emulation was active.
              // See nonStreamResponse for marker rationale (#109 sub2api E2E).
              if (emulateTools && collectedToolCalls.length === 0 && accText) {
                const head = accText.slice(0, 240).replace(/\s+/g, ' ');
                const markers = [];
                if (/<tool_call/i.test(accText)) markers.push('xml_tag');
                if (/```\s*(?:json|tool_call)/i.test(accText)) markers.push('fenced_json');
                if (/"function"\s*:|"tool_calls"\s*:|"function_call"\s*:/.test(accText)) markers.push('openai_native');
                if (/\{\s*"name"\s*:\s*"[a-zA-Z0-9_-]+"\s*,\s*"arguments"/.test(accText)) markers.push('bare_json');
                if (/^\s*(?:I'?ll|I will|Let me|I'?m going to)\s+(?:call|use|invoke|run)/im.test(accText)) markers.push('natural_lang');
                log.info(`Chat[stream]: emulateTools=true but parser found 0 tool_calls (model=${modelKey} provider=${provider}); markers=${markers.join(',') || 'none'}; head="${head}"`);
              }
            }
            emitContent(pathStreamText.flush());
            emitThinking(pathStreamThinking.flush());

            // v2.0.65 native bridge: cascade trajectory steps come back on
            // cascadeResult.toolCalls with cascade_native:true. Translate
            // each into the caller's OpenAI tool name + reverse-mapped
            // args, allowlist-filter, then emit as tool_call deltas. We do
            // this at the tail (after pathStreamText flush) rather than
            // mid-stream because cascadeChat doesn't expose per-step
            // callbacks for native steps yet — clients see one batched
            // tool_calls turn instead of fully-streamed deltas. That's a
            // known gap; trades streaming-grain for shipping a working
            // bridge first.
            if (nativeBridgeOn && cascadeResult?.toolCalls?.length) {
              const lookup = nativeOpts?.callerLookup || new Map();
              const nativeRaw = [];
              for (const raw of cascadeResult.toolCalls) {
                if (!raw?.cascade_native) continue;
                const candidates = lookup.get(raw.name) || [];
                const callerName = candidates[0];
                if (!callerName) continue;
                const reverseFn = TOOL_MAP[callerName]?.reverse;
                let cascadeArgs;
                try { cascadeArgs = JSON.parse(raw.argumentsJson || '{}'); } catch { cascadeArgs = {}; }
                let openaiArgs;
                try { openaiArgs = reverseFn ? reverseFn(cascadeArgs) : cascadeArgs; }
                catch { openaiArgs = cascadeArgs; }
                nativeRaw.push({
                  id: raw.id || `call_${nativeRaw.length}_${Date.now().toString(36)}`,
                  name: callerName,
                  argumentsJson: JSON.stringify(openaiArgs ?? {}),
                });
              }
              const filteredNative = filterToolCallsByAllowlist(nativeRaw, declaredTools);
              for (const rawTc of filteredNative) {
                const tc = sanitizeToolCall(repairToolCallArguments(rawTc, messages));
                const idx = collectedToolCalls.length;
                collectedToolCalls.push(tc);
                emitToolCallDelta(tc, idx);
              }
              if (filteredNative.length === 0 && cascadeResult.toolCalls.some(tc => tc.cascade_native)) {
                log.info(`Chat[stream]: nativeBridge=true received cascade tool calls but none mapped to caller tools (kinds=${cascadeResult.toolCalls.filter(tc => tc.cascade_native).map(tc => tc.name).join(',')})`);
              }
            }
            // Pool check-in on success (cascade only)
            if (reuseEnabled && cascadeResult?.cascadeId && (accText || collectedToolCalls.length)) {
              const turnComplete = appendAssistantTurn(messages, accText, collectedToolCalls);
              const fpAfter = fingerprintAfter(turnComplete, modelKey, callerKey, fpOpts);
              const ttlHint = ttlHintFromCachePolicy(cachePolicy);
              poolCheckin(fpAfter, {
                cascadeId: cascadeResult.cascadeId,
                sessionId: cascadeResult.sessionId,
                lsPort: ls.port,
                lsGeneration: cascadeResult.lsGeneration || ls.generation,
                apiKey: currentApiKey,
                stepOffset: Number.isFinite(cascadeResult.stepOffset) ? cascadeResult.stepOffset : reuseEntry?.stepOffset,
                generatorOffset: Number.isFinite(cascadeResult.generatorOffset) ? cascadeResult.generatorOffset : reuseEntry?.generatorOffset,
                historyCoverage: cascadeResult.historyCoverage || reuseEntry?.historyCoverage || null,
                createdAt: reuseEntry?.createdAt,
              }, callerKey, ttlHint === undefined ? 0 : ttlHint);
            }
            // success
            if (hadSuccess) reportSuccess(currentApiKey, callerKey, modelKey);
            updateCapability(currentApiKey, modelKey, true, 'success');
            recordRequest(model, true, Date.now() - startTime, currentApiKey);
            if (!rolePrinted) {
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
            }
            // For response_format=json_* we buffered all content — flush one
            // clean JSON payload now. extractJsonPayload strips fences and
            // any preamble text, returning raw parseable JSON (or the
            // trimmed original when nothing parses).
            if (wantJson && accText) {
              const cleaned = stabilizeJsonPayload(accText, messages);
              if (cleaned) {
                send({ id, object: 'chat.completion.chunk', created, model,
                  choices: [{ index: 0, delta: { content: cleaned }, finish_reason: null }] });
                accText = cleaned;
              }
            }
            // GLM5.1 silence fallback (#86 follow-up KLFDan0534) — see
            // shouldFallbackThinkingToText comment for rationale.
            // Inside streamResponse the routing key arrives as the
            // `modelKey` param (caller passes routingModelKey there);
            // wantThinking comes through deps because body isn't in
            // scope here (#93 follow-up zhangzhang-bit).
            if (shouldFallbackThinkingToText({
              routingModelKey: modelKey,
              wantThinking: deps.wantThinking,
              accText,
              accThinking,
              hasToolCalls: collectedToolCalls.length > 0,
            })) {
              log.info(`Chat[${reqId}]: thinking-only stream from non-reasoning model ${modelKey}; promoting ${accThinking.length}c thinking → content`);
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta: { content: accThinking }, finish_reason: null }] });
              accText = accThinking;
              accThinking = '';
            }
            const finalReason = collectedToolCalls.length ? 'tool_calls' : 'stop';
            // OpenAI spec: the finish_reason chunk carries NO usage, then a
            // separate terminal chunk has empty choices[] + usage
            // (stream_options.include_usage convention). Emitting usage on
            // both made some clients double-count billing. Drop the first.
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: {}, finish_reason: finalReason }] });
            {
              const usage = buildUsageBody(cascadeResult?.usage || null, messages, accText, accThinking, cachePolicy);
              send({ id, object: 'chat.completion.chunk', created, model,
                choices: [], usage });
            }
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
            if (ckey && !collectedToolCalls.length && (accText || accThinking)) {
              cacheSet(ckey, { text: accText, thinking: accThinking });
            }
            return;
          } catch (err) {
            lastErr = err;
            reuseEntry = null; // don't try to reuse on retry
            // v2.0.25 HIGH-2: client.js marks the error when it tried to
            // recover from a "cascade not found" but couldn't. The entry
            // we held is dead — never restore it on the way out.
            if (err.reuseEntryInvalid) reuseEntryDead = true;
            // #101 (nalayahfowlkest-ship-it): when the upstream model
            // provider times out mid-stream ("context deadline exceeded"
            // / "Client.Timeout or context cancellation while reading
            // body"), the cascade trajectory is left in an inconsistent
            // state — the assistant never finished, but the prior
            // tool_result is still in there. Restoring this cascade to
            // the pool causes the NEXT request to reuse a half-broken
            // trajectory, and the model only sees the trailing tool
            // result with no earlier user prompts ("I can see the
            // content from a previous tool call ... but I don't have
            // the earlier conversation context").
            if (/context deadline exceeded|context cancellation while reading body|client\.timeout/i.test(err.message || '')) {
              reuseEntryDead = true;
            }
            const isAuthFail = /unauthenticated|invalid api key|invalid_grant|permission_denied.*account/i.test(err.message);
            const isRateLimit = /rate limit|rate_limit|too many requests|quota/i.test(err.message);
            const isInternal = /internal error occurred.*error id/i.test(err.message);
            const isTransport = isCascadeTransportError(err);
            const isTransient = isUpstreamTransientError(err, isInternal);
            // v2.0.61 (#113) — same policy detection as nonStreamResponse.
            const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(err.message);
            if (isAuthFail) reportError(currentApiKey);
            if (isRateLimit) { markRateLimited(currentApiKey, rateLimitCooldownMs(err.message), modelKey); err.isRateLimit = true; err.isModelError = true; err.kind ||= 'model_error'; }
            if (isInternal) { reportInternalError(currentApiKey); err.isModelError = true; err.kind ||= 'transient_stall'; }
            if (isPolicyBlocked) { err.isPolicyBlocked = true; err.isModelError = true; err.kind = 'policy_blocked'; }
            if (isTransport) { err.isModelError = true; err.kind ||= 'transient_stall'; }
            // v2.0.56 stream-path ban detection — same 2-strike logic as
            // non-stream. See nonStreamResponse for rationale.
            if (!isRateLimit && looksLikeBanSignal(err.message)) {
              reportBanSignal(currentApiKey, err.message);
              err.isModelError = true; err.kind ||= 'auth_error';
            }
            if (err.isModelError && err.kind !== 'transient_stall' && !isRateLimit && !isInternal) {
              updateCapability(currentApiKey, modelKey, false, 'model_error');
            }
            if (isRateLimit && strictReuse && checkedOutReuseEntry && fpBefore && checkedOutReuseEntry.apiKey === currentApiKey) {
              log.info(`Chat[${reqId}]: strict reuse preserved cascade after rate limit`);
              break;
            }
            // v2.0.61 (#113): policy refusal isn't account-bound, drop
            // out of the retry loop immediately and let the SSE error
            // path emit a 451-style chunk to the client.
            if (isPolicyBlocked) {
              log.warn(`Chat[${reqId}] stream: policy_blocked on ${currentApiKey?.slice(0, 12)}..., not retrying`);
              break;
            }
            // Retry only if nothing has been streamed yet AND it's a retryable error
            if (!hadSuccess && (err.isModelError || isRateLimit)) {
              const tag = isRateLimit ? 'rate_limit' : isTransient ? 'upstream_transient' : 'model_error';
              if (isTransient) {
                streamInternalCount++;
                const backoffMs = await internalErrorBackoff(streamInternalCount - 1);
                log.warn(`Chat[${reqId}] stream: ${acct.email} upstream transient error (${isTransport ? 'cascade_transport' : 'internal_error'}), waited ${backoffMs}ms before next account`);
              } else {
                log.warn(`Account ${acct.email} failed (${tag}) on ${model}, trying next`);
              }
              continue;
            }
            break;
          }
          } finally {
            // Pair every successful getApiKey/acquireAccountByKey with a
            // release so the in-flight balancer in auth.js (issue #37)
            // stays accurate through stream success, retry, and abort.
            if (acct) releaseAccount(acct.apiKey);
          }
        }

        // All attempts failed
        log.error('Stream error after retries:', lastErr?.message || String(lastErr || 'account queue timed out without an error object'));
        recordRequest(model, false, Date.now() - startTime, currentApiKey);
        try {
          const temporaryUnavailable = isAllTemporarilyUnavailable(modelKey);
          const rl = isAllRateLimited(modelKey);
          const allInternal = streamInternalCount > 0 && tried.length > 0 && streamInternalCount >= tried.length;
          // 优先暴露 upstream_transient，避免把 Cascade transport 抖动误报成账号限流。
          const lastIsTransport = isCascadeTransportError(lastErr);
          const errMsg = allInternal
            ? upstreamTransientErrorMessage(model, tried.length, lastIsTransport ? 'cascade_transport' : 'internal_error')
            : temporaryUnavailable.allUnavailable
            ? `${model} 所有账号暂时不可用，请 ${Math.ceil(temporaryUnavailable.retryAfterMs / 1000)} 秒后重试`
            : rl.allLimited
            ? `${model} 所有账号均已达速率限制，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试`
            : sanitizeText(lastErr?.message || 'no accounts');
          if (allInternal) {
            log.error(`Chat[${reqId}] stream: ${tried.length}/${tried.length} accounts hit upstream transient error — surfacing upstream_transient_error`);
          }
          if (!hadSuccess && !reuseEntryDead && checkedOutReuseEntry && fpBefore) {
            poolCheckin(fpBefore, checkedOutReuseEntry, callerKey, ttlHintFromCachePolicy(cachePolicy));
            log.info(`Chat[${reqId}]: restored checked-out cascade after failed stream`);
          } else if (!hadSuccess && reuseEntryDead) {
            log.info(`Chat[${reqId}]: stream reuse entry was invalidated (cascade not_found upstream); not restoring to pool`);
          }

          if (hadSuccess) {
            // We already streamed real assistant content. Injecting
            // "[Error: ...]" as a content delta here would corrupt the
            // assistant message (clients display it verbatim as model
            // output). Close cleanly with a plain stop — the caller saw
            // whatever partial content we produced. Error details only
            // go to the server log.
            const errType = allInternal
              ? 'upstream_transient_error'
              : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
                ? 'rate_limit_exceeded'
                : 'upstream_error';
            send(chatStreamError(errMsg, errType));
            log.warn(`Stream: partial response delivered then failed (${errMsg})`);
          } else {
            const errType = allInternal
              ? 'upstream_transient_error'
              : (temporaryUnavailable.allUnavailable || lastErr?.type === 'rate_limit_exceeded')
                ? 'rate_limit_exceeded'
                : 'upstream_error';
            send(chatStreamError(errMsg, errType));
          }
          res.write('data: [DONE]\n\n');
        } catch {}
        if (!res.writableEnded) res.end();
      } finally {
        unregisterSse();
        stopHeartbeat();
      }
    },
  };
}
