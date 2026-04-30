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

  it('inherits allowlist entitlement from base to -thinking variant (#103)', async () => {
    // The dashboard UX shows base model names like `claude-sonnet-4.6`.
    // A user who allowlists that should not get a 403 the moment the
    // request resolves to the `-thinking` UID — they have no obvious
    // way to discover that variant exists, so the inheritance is the
    // expected behavior. (Pre-#103 fix: this returned `model_blocked`.)
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-sonnet-4.6']);

    const result = await handleChatCompletions(thinkingRequest());

    assert.notEqual(result.body?.error?.type, 'model_blocked',
      'allowlisting the base must auto-allow the -thinking sibling');
  });

  it('allows base+reasoning when the thinking sibling is allowlisted', async () => {
    setModelAccessMode('allowlist');
    setModelAccessList(['claude-sonnet-4.6-thinking']);

    const result = await handleChatCompletions(thinkingRequest());

    assert.notEqual(result.body?.error?.type, 'model_blocked');
  });
});
