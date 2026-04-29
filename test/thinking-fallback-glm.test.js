// Issue #86 follow-up KLFDan0534: GLM 5.1 in claudecode/openclaw silently
// produces nothing — claudecode shows "thinking" indicator but user sees no
// text and no thinking content. Root cause: cascade upstream packs the GLM
// response into step.thinking, which client.js routes to chunk.thinking,
// which proxy emits as `reasoning_content` SSE — claudecode hides that and
// only renders `content`.
//
// Fix (chat.js shouldFallbackThinkingToText): for non-reasoning models that
// produced ONLY thinking (no text, no tool_calls), promote the thinking
// buffer to a content delta at stream end so the client renders it.
//
// v2.0.36: signature changed from `body` to `wantThinking` (bool computed
// once at handleChatCompletions where body IS in scope). Inside
// streamResponse / nonStreamResponse `body` was never in scope, so the
// previous shape ReferenceError'd on every stream finish (#93 follow-up).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFallbackThinkingToText } from '../src/handlers/chat.js';

describe('shouldFallbackThinkingToText', () => {
  it('promotes thinking → content when GLM 5.1 produced only thinking', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      wantThinking: false,
      accText: '',
      accThinking: 'I think the answer is 42.',
      hasToolCalls: false,
    }), true);
  });

  it('does NOT promote when content was emitted normally', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      wantThinking: false,
      accText: 'The answer is 42.',
      accThinking: 'I was thinking about this...',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when there was nothing at all (genuine empty)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      wantThinking: false,
      accText: '',
      accThinking: '',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when tool calls were emitted (no text expected)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      wantThinking: false,
      accText: '',
      accThinking: 'planning the tool call',
      hasToolCalls: true,
    }), false);
  });

  it('does NOT promote when caller explicitly requested thinking (wantThinking=true)', () => {
    // reasoning client expects reasoning_content separately; don't double-emit
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      wantThinking: true,
      accText: '',
      accThinking: 'reasoning content',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when routingModelKey already lands on a -thinking variant', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'claude-sonnet-4.6-thinking',
      wantThinking: false,
      accText: '',
      accThinking: 'reasoning content',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote for kimi-k2-thinking — name match blocks regardless of wantThinking', () => {
    // kimi-k2-thinking is itself a reasoning model; its reasoning content
    // is intentionally separate. Don't auto-promote.
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'kimi-k2-thinking',
      wantThinking: false,
      accText: '',
      accThinking: 'reasoning',
      hasToolCalls: false,
    }), false);
  });

  it('promotes for kimi-k2 (non-thinking variant)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'kimi-k2',
      wantThinking: false,
      accText: '',
      accThinking: 'unexpected thinking content from upstream',
      hasToolCalls: false,
    }), true);
  });

  it('treats missing wantThinking as falsy (default behavior)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      // wantThinking omitted
      accText: '',
      accThinking: 'content',
      hasToolCalls: false,
    }), true);
  });

  it('signature has no `body` param — guards against #93 ReferenceError regression', () => {
    // The function's destructured args must not include `body`. The earlier
    // shape leaked a `body` reference into streamResponse/nonStreamResponse
    // scope (where body wasn't defined), throwing ReferenceError on every
    // stream finish. Snapshot the signature to lock the new shape.
    const src = shouldFallbackThinkingToText.toString();
    const match = src.match(/^function\s+\w+\s*\(\s*\{([^}]+)\}/);
    assert.ok(match, 'expected function with destructured object arg');
    const args = match[1];
    assert.ok(!/\bbody\b/.test(args), `signature must not include 'body' (got: ${args.trim()})`);
    assert.ok(/\bwantThinking\b/.test(args), `signature must include 'wantThinking' (got: ${args.trim()})`);
  });
});
