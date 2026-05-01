import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('IDENTITY_MODE gateway', () => {
  it('answers narrow identity questions locally without requiring accounts', async () => {
    process.env.IDENTITY_MODE = 'gateway';
    process.env.DATA_DIR = '/tmp/windsurf-identity-mode-test';
    const { handleChatCompletions } = await import(`../src/handlers/chat.js?identity=${Date.now()}`);

    const result = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: '你是什么模型？' }],
      stream: false,
    });

    assert.equal(result.status, 200);
    const text = result.body.choices[0].message.content;
    assert.match(text, /claude-sonnet-4\.6/);
    assert.doesNotMatch(text, /WindsurfAPI|proxy|代理|Cascade/i);
  });

  it('answers narrow capability questions locally without proxy branding', async () => {
    process.env.IDENTITY_MODE = 'gateway';
    process.env.DATA_DIR = '/tmp/windsurf-identity-mode-test';
    const { handleChatCompletions } = await import(`../src/handlers/chat.js?capability=${Date.now()}`);

    const result = await handleChatCompletions({
      model: 'gemini-3.1-pro-high',
      messages: [{ role: 'user', content: '你的特长是什么' }],
      stream: false,
    });

    assert.equal(result.status, 200);
    const text = result.body.choices[0].message.content;
    assert.match(text, /gemini-3\.1-pro-high/);
    assert.doesNotMatch(text, /WindsurfAPI|proxy|代理|Cascade/i);
  });


  it('does not intercept normal coding work', async () => {
    process.env.IDENTITY_MODE = 'gateway';
    process.env.DATA_DIR = '/tmp/windsurf-identity-mode-test';
    const { handleChatCompletions } = await import(`../src/handlers/chat.js?normal=${Date.now()}`);

    const result = await handleChatCompletions({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: '帮我写一个 debounce 函数' }],
      stream: false,
    }, {
      waitForAccount: async () => null,
    });

    assert.notEqual(result.status, 200);
    assert.ok(result.body?.error?.type);
  });
});
