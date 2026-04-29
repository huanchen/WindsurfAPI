import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isThinkingRequested, shouldUseCascadeReuse, shouldUseStrictCascadeReuse } from '../src/handlers/chat.js';

describe('shouldUseCascadeReuse', () => {
  it('allows reuse for normal Cascade chat turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: false, modelKey: 'claude-4.5-haiku' }), true);
  });

  it('keeps most tool-emulated turns out of reuse', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-4.5-haiku' }), false);
  });

  it('allows reuse for tool-emulated Opus 4.7 turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-7-medium' }), true);
  });

  it('can disable the Opus 4.7 tool reuse override', () => {
    assert.equal(shouldUseCascadeReuse({
      useCascade: true,
      emulateTools: true,
      modelKey: 'claude-opus-4-7-medium',
      allowToolReuse: false,
    }), false);
  });

  it('disables reuse outside Cascade', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: false, emulateTools: false, modelKey: 'claude-opus-4-7-medium' }), false);
  });

  // Regression: #59 widened the tool-emulated reuse override from 4.7-only
  // to 4.6/4.7. The matcher must accept both label conventions (dotted
  // `4.6` and dashed `4-6-medium`) and reject 4.5 / non-Opus models / the
  // not-Opus-4-x case that would otherwise look similar.
  it('allows tool-emulated reuse for Opus 4.6 (dotted)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4.6' }), true);
  });

  it('allows tool-emulated reuse for Opus 4.6 (dashed variant)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-6-medium' }), true);
  });

  it('allows tool-emulated reuse for Opus 4.6 thinking', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4.6-thinking' }), true);
  });

  it('allows tool-emulated reuse for Opus 4.7 1m', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-7-1m' }), true);
  });

  it('rejects Opus 4.5 (outside the widening)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4.5' }), false);
  });

  it('allows tool-emulated reuse for Sonnet 4.6 thinking (#93)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-sonnet-4-6-thinking' }), true);
  });

  it('can disable Sonnet 4.6 tool reuse with WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE=1', () => {
    const previous = process.env.WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE;
    process.env.WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE = '1';
    try {
      assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-sonnet-4-6-thinking' }), false);
    } finally {
      if (previous === undefined) {
        delete process.env.WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE;
      } else {
        process.env.WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE = previous;
      }
    }
  });

  it('rejects GPT-5 tool-emulated reuse', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'gpt-5' }), false);
  });
});

describe('shouldUseStrictCascadeReuse', () => {
  it('strictly binds tool-emulated Opus 4.7 reuse by default', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-opus-4-7-medium',
      strict: false,
      allowOpus47Strict: true,
    }), true);
  });

  it('strictly binds tool-emulated Opus 4.6 reuse (#59 widening)', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-opus-4.6',
      strict: false,
      allowOpus47Strict: true,
    }), true);
  });

  it('does not strictly bind other models unless the global flag is on', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-4.5-haiku',
      strict: false,
      allowOpus47Strict: true,
    }), false);
  });

  it('keeps Sonnet 4.6 out of Opus-only strict reuse', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-sonnet-4-6-thinking',
      strict: false,
      allowOpus47Strict: true,
    }), false);
  });
});

describe('isThinkingRequested', () => {
  it('treats explicit enabled type as a thinking request', () => {
    assert.equal(isThinkingRequested({ thinking: { type: 'enabled' } }), true);
  });

  // Real Claude Code 2.1.120 sonnet 4.6 traffic always sends adaptive.
  // The previous strict 'enabled' check missed every one of these and
  // silently routed thinking-capable requests to the non-thinking sibling.
  it('treats adaptive type as a thinking request', () => {
    assert.equal(isThinkingRequested({ thinking: { type: 'adaptive' } }), true);
  });

  it('treats unknown future thinking types as enabled (forward-compatible)', () => {
    assert.equal(isThinkingRequested({ thinking: { type: 'whatever_2027' } }), true);
  });

  it('respects an explicit disabled type', () => {
    assert.equal(isThinkingRequested({ thinking: { type: 'disabled' } }), false);
  });

  it('returns false when thinking object lacks a type', () => {
    assert.equal(isThinkingRequested({ thinking: {} }), false);
    assert.equal(isThinkingRequested({ thinking: { budget_tokens: 1024 } }), false);
  });

  it('treats reasoning_effort as a thinking request even without thinking object', () => {
    assert.equal(isThinkingRequested({ reasoning_effort: 'high' }), true);
    assert.equal(isThinkingRequested({ reasoning_effort: 'low' }), true);
  });

  it('returns false for empty or missing body', () => {
    assert.equal(isThinkingRequested({}), false);
    assert.equal(isThinkingRequested(null), false);
    assert.equal(isThinkingRequested(undefined), false);
  });
});
