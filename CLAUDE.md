# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run all tests (Node.js built-in test runner, no npm deps)
npm test                           # = node --test test/*.test.js

# Run a single test file
node --test test/sticky-session.test.js

# Run tests matching a name pattern
node --test --test-name-pattern="shouldUseCascadeReuse" test/*.test.js

# Start the server
npm start                          # = node src/index.js

# Dev mode with auto-reload
npm run dev                        # = node --watch src/index.js

# Quick syntax check (no runtime imports)
node -c src/handlers/chat.js
```

There is no build step, linter, or type checker. Zero npm dependencies — everything uses Node.js builtins.

## Architecture

### Request flow

```
Client (OpenAI SDK / Claude Code / curl)
  → src/server.js            HTTP routing + auth + callerKey extraction
  → src/handlers/chat.js     POST /v1/chat/completions (OpenAI format)
    src/handlers/messages.js  POST /v1/messages (Anthropic format → converts to OpenAI → delegates to chat.js)
    src/handlers/responses.js POST /v1/responses (OpenAI Responses API → converts → delegates)
  → src/auth.js              Account pool selection (RPM balancing, sticky sessions, rate limit)
  → src/langserver.js        Spawn/manage local Windsurf Language Server binary
  → src/client.js            gRPC calls to LS: Legacy (RawGetChatMessage) or Cascade flow
  → src/grpc.js / proto.js   HTTP/2 framing + protobuf encoding (hand-rolled, no deps)
  → Windsurf cloud            server.self-serve.windsurf.com
```

### Key subsystems

**Account pool** (`src/auth.js`): Multi-account round-robin with per-account RPM windows, per-model cooldowns, quota-based sorting, in-flight balancing, ban detection, and sticky sessions. `getApiKey()` is the central selection function; `reportSuccess/reportError/markRateLimited` update state.

**Sticky sessions** (`src/account/sticky-session.js`): Binds `(callerKey, modelKey)` → accountId with TTL-based eviction. Integrated into `getApiKey()` (try bound account first) and `reportSuccess()` (create binding). Disabled by default (`STICKY_SESSION_ENABLED=0`).

**Conversation pool** (`src/conversation-pool.js`): Reuses upstream Cascade session IDs across turns to avoid replaying full message history. Keyed by semantic fingerprint of the message array. `fingerprintBefore/After`, `checkout/checkin`.

**Tool emulation** (`src/handlers/tool-emulation.js`): Cascade has no native tool-calling API. Tools are serialized into a text preamble the model follows, then `<tool_call>` markers are parsed back from the text stream. Multiple dialects (OpenAI JSON/XML, GLM, Kimi K2).

**Chat handler split**: `src/handlers/chat.js` contains `handleChatCompletions` + `nonStreamResponse` + `streamResponse`. Pure helper functions live in `src/handlers/chat-helpers.js`. Functions that were originally `export`-ed from `chat.js` are re-exported for backward compatibility so test imports don't break.

**Caller key** (`src/caller-key.js`): Derives per-user identity from API key + request body signals (`metadata.user_id`, `body.user`, `conversation_id`, session patterns). Used for cache scoping, conversation pool isolation, and sticky session binding.

**Identity neutralization** (`chat-helpers.js:neutralizeCascadeIdentity`): Rewrites "I am Cascade, made by Codeium" → "I am claude-opus-4-7, made by Anthropic" before returning to the client.

**Dashboard** (`src/dashboard/`): Web UI + REST API at `/dashboard/api/*` for account management, proxy config, model access control, and stats. Auth via `DASHBOARD_PASSWORD` with scrypt + brute-force lockout.

### Protocol stack

The proxy speaks **no** standard gRPC — it hand-rolls HTTP/2 frames with protobuf (`src/grpc.js` + `src/proto.js`). The Cascade flow is: `InitializePanelState` → `StartCascade` → `SendUserCascadeMessage` → poll `GetTrajectory` + `GetTrajectorySteps`. The legacy flow uses a single `RawGetChatMessage` streaming call.

### Test conventions

Tests use `node:test` + `node:assert/strict`. No test framework dependencies. Tests import functions directly from source modules — many test files import from `src/handlers/chat.js` which re-exports from `chat-helpers.js`. When adding new helpers to `chat-helpers.js`, add them to the re-export block in `chat.js` if external tests need them.

### Env var patterns

Configuration uses process.env read at module load time via IIFE:
```js
const VALUE = (() => {
  const n = parseInt(process.env.SOME_VAR || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT;
})();
```
This means env vars are frozen at import time, not hot-reloadable (except `runtime-config.js` which persists to JSON).

### Rate limit responses

429 responses include structured fields for programmatic consumption:
- HTTP header: `Retry-After: <seconds>`
- Body: `{ error: { message, type: "rate_limit_exceeded", retry_after_ms, reset_seconds } }`

### Language / i18n

User-facing error messages in `chat.js` and `auth.js` are in Chinese (zh-CN). Log messages mix English and Chinese. The dashboard UI has i18n support (`src/dashboard/i18n/`).
