import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatCompletions, resolveEffectiveModelKey } from '../src/handlers/chat.js';
import { getModelInfo, resolveModel } from '../src/models.js';
import {
  getModelAccessConfig,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';

const originalAccess = getModelAccessConfig();

after(() => {
  setModelAccessMode(originalAccess.mode);
  setModelAccessList(originalAccess.list);
});

function thinkingRequest() {
  return {
    model: 'claude-sonnet-4.6',
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: `routing regression ${Date.now()}` }],
  };
}

describe('thinking sibling routing', () => {
  it('does not auto-route Opus 4.7 thinking requests to the rejected thinking UID', () => {
    const modelKey = resolveModel('claude-opus-4-7');
    const effective = resolveEffectiveModelKey(modelKey, true);

    assert.equal(effective, 'claude-opus-4-7-medium');
    assert.notEqual(getModelInfo(effective)?.modelUid, 'claude-opus-4-7-medium-thinking');
  });

  it('checks model access against the effective thinking model', async () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-sonnet-4.6']);

    const result = await handleChatCompletions(thinkingRequest());

    assert.equal(result.status, 403);
    assert.equal(result.body?.error?.type, 'model_blocked');
    assert.match(result.body?.error?.message || '', /claude-sonnet-4\.6-thinking/);
  });

  it('allows base+reasoning when the thinking sibling is allowlisted', async () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-sonnet-4.6-thinking']);

    const result = await handleChatCompletions(thinkingRequest());

    assert.equal(result.status, 403);
    assert.notEqual(result.body?.error?.type, 'model_blocked');
  });
});
