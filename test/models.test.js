import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, getModelInfo, getModelKeysByEnum, MODEL_TIER_ACCESS } from '../src/models.js';

describe('resolveModel', () => {
  it('resolves exact model names', () => {
    assert.equal(resolveModel('gpt-4o'), 'gpt-4o');
  });

  it('resolves case-insensitive aliases', () => {
    assert.equal(resolveModel('GPT-4O'), 'gpt-4o');
  });

  it('resolves Anthropic dated aliases', () => {
    const result = resolveModel('claude-3-5-sonnet-20240620');
    assert.equal(result, 'claude-3.5-sonnet');
  });

  it('resolves Cursor-friendly aliases without claude prefix', () => {
    const result = resolveModel('opus-4.6');
    assert.equal(result, 'claude-opus-4.6');
  });

  // Issue #68 — bare `claude-4.6` (no sonnet/opus split) used to fall through
  // to silent legacy fallback; the model would self-identify as "Claude 4.5"
  // because no model name was forwarded upstream. Default to sonnet.
  it('resolves bare claude-4.6 to sonnet variant', () => {
    assert.equal(resolveModel('claude-4.6'), 'claude-sonnet-4.6');
    assert.equal(resolveModel('claude-4.6-thinking'), 'claude-sonnet-4.6-thinking');
    assert.equal(resolveModel('claude-4.6-1m'), 'claude-sonnet-4.6-1m');
    assert.equal(resolveModel('claude-4.6-thinking-1m'), 'claude-sonnet-4.6-thinking-1m');
  });

  it('bare claude-4.6 resolves to a real catalog entry (not silent fallback)', () => {
    const info = getModelInfo(resolveModel('claude-4.6'));
    assert.ok(info, 'claude-4.6 must map to a known model');
    assert.equal(info.modelUid, 'claude-sonnet-4-6');
  });

  it('returns input unchanged for unknown models', () => {
    assert.equal(resolveModel('nonexistent-model-xyz'), 'nonexistent-model-xyz');
  });

  it('returns null for null/empty input', () => {
    assert.equal(resolveModel(null), null);
    assert.equal(resolveModel(''), null);
  });
});

describe('resolveModel Opus 4.7 / legacy alias coverage', () => {
  it('resolves Opus 4.7 aliases to canonical catalog keys', () => {
    assert.equal(resolveModel('claude-opus-4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('claude-opus-4.7-thinking'), 'claude-opus-4-7-medium-thinking');
    assert.equal(resolveModel('claude-opus-4.7-high-thinking'), 'claude-opus-4-7-high-thinking');
    assert.equal(resolveModel('claude-Opus-4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('CLAUDE-OPUS-4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('claude.opus.4.7'), 'claude.opus.4.7');
  });

  it('documents unsupported bare / separator variants explicitly', () => {
    assert.equal(resolveModel('claude_opus_4_7'), 'claude_opus_4_7');
    assert.equal(resolveModel('opus-4.7-xhigh'), 'opus-4.7-xhigh');
    assert.equal(resolveModel('4.7-medium'), '4.7-medium');
    assert.equal(resolveModel('opus-4.7-thinking'), 'opus-4.7-thinking');
  });
});

describe('reverse-lookup model info coverage', () => {
  it('resolves kimi-k2-thinking, glm-4.7-fast, and adaptive', () => {
    const modelKeys = ['kimi-k2-thinking', 'glm-4.7-fast', 'adaptive'];
    for (const raw of modelKeys) {
      const resolved = resolveModel(raw);
      const info = getModelInfo(resolved);
      assert.ok(info, `missing model info for ${raw}`);
      assert.equal(info.name, resolved, `info.name mismatch for ${raw}`);
    }
  });
});

describe('getModelInfo', () => {
  it('returns model info for known model', () => {
    const info = getModelInfo('gpt-4o');
    assert.ok(info);
    assert.ok(info.enumValue > 0 || info.modelUid);
  });

  it('returns null for unknown model', () => {
    assert.equal(getModelInfo('fake-model'), null);
  });
});

describe('getModelKeysByEnum', () => {
  it('returns keys for known enum', () => {
    const info = getModelInfo('gpt-4o');
    if (info?.enumValue) {
      const keys = getModelKeysByEnum(info.enumValue);
      assert.ok(keys.includes('gpt-4o'));
    }
  });

  it('returns empty array for unknown enum', () => {
    assert.deepEqual(getModelKeysByEnum(999999), []);
  });
});

describe('MODEL_TIER_ACCESS', () => {
  it('pro tier includes all models', () => {
    assert.ok(MODEL_TIER_ACCESS.pro.length > 100);
  });

  it('free tier is a small subset', () => {
    assert.ok(MODEL_TIER_ACCESS.free.length <= 5);
    assert.ok(MODEL_TIER_ACCESS.free.includes('gemini-2.5-flash'));
  });

  it('expired tier is empty', () => {
    assert.deepEqual(MODEL_TIER_ACCESS.expired, []);
  });
});

describe('deprecated model markers', () => {
  // Models the Windsurf upstream removed from Cascade. Requests for them
  // come back as "neither PlanModel nor RequestedModel specified" — we
  // catch that in handlers/chat.js with a 410 model_deprecated response.
  // If any of these loses its deprecated flag without the actual upstream
  // coming back, users will get the cryptic 502 again and reopen #8.
  const KNOWN_DEPRECATED = [
    'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5-mini',
    'deepseek-v3', 'deepseek-v3-2', 'deepseek-r1',
    'grok-3-mini', 'qwen-3',
  ];

  for (const key of KNOWN_DEPRECATED) {
    it(`${key} is flagged deprecated`, () => {
      const info = getModelInfo(key);
      assert.ok(info, `${key} missing from MODELS`);
      assert.equal(info.deprecated, true, `${key} lost its deprecated flag`);
    });
  }
});
