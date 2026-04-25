import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleResponses } from '../../src/handlers/responses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function makeFakeRealRes() {
  const listeners = new Map();
  return {
    chunks: [],
    writableEnded: false,
    headersSent: false,
    writeHead() {
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      if (this.writableEnded) return this;
      this.writableEnded = true;
      for (const cb of listeners.get('close') || []) cb();
      return this;
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

function summarizeData(data) {
  const summary = {
    keys: Object.keys(data),
  };

  for (const key of ['output_index', 'content_index', 'summary_index', 'status']) {
    if (key in data) summary[key] = data[key];
  }

  if (data.item) {
    summary.item = {
      type: data.item.type,
      status: data.item.status,
      content_length: data.item.content?.length,
      summary_length: data.item.summary?.length,
    };
  }

  if (data.response) {
    summary.response = {
      id: data.response.id,
      status: data.response.status,
      output: data.response.output?.map(item => ({ type: item.type, status: item.status })),
    };
    if (data.response.usage) summary.response.usage = data.response.usage;
    if (data.response.error) summary.response.error = data.response.error;
  }

  if (data.part) summary.part = { type: data.part.type };
  if (data.output) summary.output = data.output.map(item => ({ type: item.type, status: item.status }));
  if (data.usage) summary.usage = data.usage;
  if ('delta' in data) summary.delta = data.delta;
  if ('text' in data) summary.text = data.text;

  return summary;
}

function parseCapturedSse(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .filter(frame => !frame.startsWith(':'))
    .map(frame => {
      const lines = frame.split('\n');
      const event = lines.find(line => line.startsWith('event: '))?.slice(7);
      const dataLine = lines.find(line => line.startsWith('data: '));
      const data = JSON.parse(dataLine?.slice(6) || '{}');
      return {
        event,
        type: data.type,
        sequence_number: data.sequence_number,
        summary: summarizeData(data),
      };
    });
}

function makeCacheHitChatMock(cached) {
  return async function handleChatCompletionsMock(body) {
    assert.equal(body.stream, true);

    return {
      stream: true,
      headers: { 'Content-Type': 'text/event-stream' },
      status: 200,
      async handler(res) {
        const id = 'chatcmpl_cache_hit';
        const created = 123;
        const model = body.model;
        const usage = { prompt_tokens: 1, completion_tokens: cached.text ? 2 : 0, total_tokens: cached.text ? 3 : 1 };
        const send = chunk => res.write(chatChunk(chunk));

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
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage });
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
      },
    };
  };
}

async function captureSequence(cached, filename) {
  const result = await handleResponses(
    { stream: true, model: 'gpt-5.4-xhigh', input: 'hi' },
    { handleChatCompletions: makeCacheHitChatMock(cached) },
  );

  assert.equal(result.status, 200);
  assert.equal(result.stream, true);

  const realRes = makeFakeRealRes();
  await result.handler(realRes);

  const sequence = parseCapturedSse(realRes.chunks);
  await writeFile(join(__dirname, filename), `${JSON.stringify(sequence, null, 2)}\n`, 'utf8');

  assert.equal(sequence[0]?.type, 'response.created');
  assert.match(sequence[0]?.summary.response?.id || '', /^resp_[a-f0-9]{24}$/);
  assert.equal(sequence[1]?.type, 'response.in_progress');
  assert.match(sequence[1]?.summary.response?.id || '', /^resp_[a-f0-9]{24}$/);
  assert.equal(sequence.at(-1)?.type, 'response.completed');
  assert.match(sequence.at(-1)?.summary.response?.id || '', /^resp_[a-f0-9]{24}$/);
  assert.deepEqual(sequence.at(-1)?.summary.response?.usage, {
    input_tokens: 1,
    output_tokens: cached.text ? 2 : 0,
    total_tokens: cached.text ? 3 : 1,
  });
  assert.equal(sequence.at(-1)?.summary.response?.status, 'completed');
  sequence.forEach((event, index) => {
    assert.equal(Number.isInteger(event.sequence_number), true);
    assert.equal(event.sequence_number, index);
  });

  return sequence;
}

describe('Responses cache HIT stream sequence research', () => {
  it('captures text-only cache HIT stream events', async () => {
    await captureSequence({ text: 'cached answer' }, 'responses-cache-hit-seq-A.json');
  });

  it('captures thinking plus text cache HIT stream events', async () => {
    await captureSequence({ thinking: 'cached thinking', text: 'cached answer' }, 'responses-cache-hit-seq-B.json');
  });
});
