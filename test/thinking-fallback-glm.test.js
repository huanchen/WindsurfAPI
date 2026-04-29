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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFallbackThinkingToText } from '../src/handlers/chat.js';

describe('shouldFallbackThinkingToText', () => {
  it('promotes thinking → content when GLM 5.1 produced only thinking', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: { messages: [] },
      accText: '',
      accThinking: 'I think the answer is 42.',
      hasToolCalls: false,
    }), true);
  });

  it('does NOT promote when content was emitted normally', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: { messages: [] },
      accText: 'The answer is 42.',
      accThinking: 'I was thinking about this...',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when there was nothing at all (genuine empty)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: { messages: [] },
      accText: '',
      accThinking: '',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when tool calls were emitted (no text expected)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: { messages: [] },
      accText: '',
      accThinking: 'planning the tool call',
      hasToolCalls: true,
    }), false);
  });

  it('does NOT promote when caller explicitly requested thinking via reasoning_effort', () => {
    // reasoning client expects reasoning_content separately; don't double-emit
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: { reasoning_effort: 'high', messages: [] },
      accText: '',
      accThinking: 'reasoning content',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when caller explicitly requested thinking via Anthropic spec', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'claude-sonnet-4.6',
      body: { thinking: { type: 'enabled' }, messages: [] },
      accText: '',
      accThinking: 'reasoning content',
      hasToolCalls: false,
    }), false);
  });

  it('does NOT promote when routingModelKey already lands on a -thinking variant', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'claude-sonnet-4.6-thinking',
      body: null,
      accText: '',
      accThinking: 'reasoning content',
      hasToolCalls: false,
    }), false);
  });

  it('promotes for kimi-k2-thinking — wait no, "thinking" in name should block', () => {
    // kimi-k2-thinking is itself a reasoning model; its reasoning content
    // is intentionally separate. Don't auto-promote.
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'kimi-k2-thinking',
      body: null,
      accText: '',
      accThinking: 'reasoning',
      hasToolCalls: false,
    }), false);
  });

  it('promotes for kimi-k2 (non-thinking variant)', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'kimi-k2',
      body: null,
      accText: '',
      accThinking: 'unexpected thinking content from upstream',
      hasToolCalls: false,
    }), true);
  });

  it('handles missing body gracefully', () => {
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: undefined,
      accText: '',
      accThinking: 'content',
      hasToolCalls: false,
    }), true);
  });

  it('handles thinking.type === disabled (caller explicitly opted out)', () => {
    // Client said no thinking; promote anything that came back as thinking
    // since the client wasn't expecting reasoning_content at all.
    assert.equal(shouldFallbackThinkingToText({
      routingModelKey: 'glm-5.1',
      body: { thinking: { type: 'disabled' }, messages: [] },
      accText: '',
      accThinking: 'unexpected reasoning',
      hasToolCalls: false,
    }), true);
  });
});
