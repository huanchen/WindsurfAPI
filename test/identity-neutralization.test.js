import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeCascadeIdentity, IdentityNeutralizeStream } from '../src/handlers/chat.js';

// Cascade's planner system prompt teaches the upstream model to refer to
// itself as "Cascade", to claim it was "made by Codeium" or "by Windsurf",
// and to talk about "Cascade's workspace". Claude Code (and any caller
// expecting Anthropic-equivalent output) must not see those leaks.
//
// neutralizeCascadeIdentity rewrites the most common Cascade-isms back to
// the requested model identity. Patterns are deliberately conservative:
// only obvious self-reference is rewritten — generic mentions of the word
// "cascade" in user code or technical prose are left alone.

describe('neutralizeCascadeIdentity', () => {
  const model = 'claude-opus-4-7';

  it('rewrites first-person identity claims', () => {
    assert.equal(
      neutralizeCascadeIdentity('I am Cascade and I will help.', model),
      `I am ${model} and I will help.`
    );
    assert.equal(
      neutralizeCascadeIdentity("I'm Cascade, ready to help.", model),
      `I'm ${model}, ready to help.`
    );
    assert.equal(
      neutralizeCascadeIdentity('Hi! my name is Cascade.', model),
      `Hi! my name is ${model}.`
    );
    assert.equal(
      neutralizeCascadeIdentity('你好，我是 Cascade，基于 Anthropic 的模型。', model),
      `你好，我是 ${model}，基于 Anthropic 的模型。`
    );
  });

  it('rewrites third-person self-reference', () => {
    assert.equal(
      neutralizeCascadeIdentity('Cascade is an AI coding assistant built by Windsurf.', model),
      `${model} is an AI assistant built by Anthropic.`
    );
    assert.equal(
      neutralizeCascadeIdentity('As Cascade, I will check that.', model),
      `As ${model}, I will check that.`
    );
    assert.equal(
      neutralizeCascadeIdentity('Acting as Cascade, I will check that.', model),
      `As ${model}, I will check that.`
    );
  });

  it('rewrites provider attribution variants', () => {
    assert.equal(
      neutralizeCascadeIdentity('I was developed by Codeium.', model),
      'I was developed by Anthropic.'
    );
    assert.equal(
      neutralizeCascadeIdentity('I was created by Windsurf.', model),
      'I was created by Anthropic.'
    );
    assert.equal(
      neutralizeCascadeIdentity('I was built by Windsurf.', model),
      'I was built by Anthropic.'
    );
    assert.equal(
      neutralizeCascadeIdentity("Codeium's Cascade can help with that.", model),
      `${model} can help with that.`
    );
    assert.equal(
      neutralizeCascadeIdentity('Windsurf Cascade is here.', model),
      `${model} is here.`
    );
  });

  it('rewrites Cascade workspace narration', () => {
    assert.equal(
      neutralizeCascadeIdentity("Let me check Cascade's workspace.", model),
      'Let me check the workspace.'
    );
    assert.equal(
      neutralizeCascadeIdentity('I will use the Cascade workspace.', model),
      'I will use the workspace.'
    );
  });

  it('rewrites Claude 4.5 self-identification for a requested Claude 4.6 model', () => {
    assert.equal(
      neutralizeCascadeIdentity('你好！我是 Claude Sonnet 4.5（claude-sonnet-4-5），由 Anthropic 开发。', 'claude-sonnet-4-6'),
      '你好！我是 claude-sonnet-4-6（claude-sonnet-4-6），由 Anthropic 开发。'
    );
    assert.equal(
      neutralizeCascadeIdentity("I'm Claude Sonnet 4.5 model.", 'claude-sonnet-4.6'),
      "I'm claude-sonnet-4.6."
    );
  });

  it('does not rewrite unrelated Claude version comparisons', () => {
    const text = 'Claude Sonnet 4.5 and Claude Sonnet 4.6 have different routing IDs.';
    assert.equal(neutralizeCascadeIdentity(text, 'claude-sonnet-4-6'), text);
  });

  it('rewrites identity text split across streaming chunks', () => {
    const stream = new IdentityNeutralizeStream('claude-sonnet-4-6', 48);
    const out = [
      stream.feed('你好！我是 Claude Son'),
      stream.feed('net 4.5（claude-sonnet-4-5），由 Anthropic 开发。后续内容继续输出。'),
      stream.flush(),
    ].join('');
    assert.equal(out, '你好！我是 claude-sonnet-4-6（claude-sonnet-4-6），由 Anthropic 开发。后续内容继续输出。');
  });

  it('leaves unrelated text unchanged', () => {
    const text = 'The waterfall flows down a cascade of rocks.';
    assert.equal(neutralizeCascadeIdentity(text, model), text);
  });

  it('returns text unchanged when modelName has no known provider mapping', () => {
    const text = 'I am Cascade.';
    assert.equal(neutralizeCascadeIdentity(text, 'mystery-model'), text);
  });

  it('returns falsy inputs unchanged', () => {
    assert.equal(neutralizeCascadeIdentity('', model), '');
    assert.equal(neutralizeCascadeIdentity(null, model), null);
    assert.equal(neutralizeCascadeIdentity('I am Cascade.', null), 'I am Cascade.');
  });
});
