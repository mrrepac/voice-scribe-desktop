import test from 'node:test';
import assert from 'node:assert/strict';
import { planDownload, runAsr, runAsrTimed, setHost } from '../src/asr/engine';
import type { Loaded } from '../src/asr/engine';

function gpu(t: test.TestContext, f16: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{gpu:{requestAdapter:async () => ({features:new Set(f16 ? ['shader-f16'] : [])})}}});
  setHost({mobile:false,cache:null,crossOriginIsolated:false,ort:{mjsUrl:'https://scribe.local/ort.mjs',wasmUrl:'https://scribe.local/ort.wasm'}});
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis,'navigator',descriptor);
    else Reflect.deleteProperty(globalThis,'navigator');
  });
}

test('turbo reuses q4 files even when the GPU supports fp16', async t => {
  gpu(t,true);
  const plan = await planDownload('turbo','webgpu',() => {});
  assert.deepEqual(plan.files,['onnx/encoder_model_q4.onnx','onnx/decoder_model_merged_q4.onnx']);
});

test('auto selects the same q4 turbo plan while small still uses fp16', async t => {
  gpu(t,true);
  const auto = await planDownload('auto','auto',() => {});
  assert.equal(auto.model,'turbo');
  assert.equal(auto.files[0],'onnx/encoder_model_q4.onnx');
  const small = await planDownload('small','webgpu',() => {});
  assert.equal(small.files[0],'onnx/encoder_model_fp16.onnx');
});

test('turbo HQ uses an fp16 encoder only where the GPU supports it', async t => {
  gpu(t,true);
  const hq = await planDownload('turbo-hq','webgpu',() => {});
  assert.equal(hq.modelId,'onnx-community/whisper-large-v3-turbo');
  assert.deepEqual(hq.files,['onnx/encoder_model_fp16.onnx','onnx/decoder_model_merged_q4.onnx']);
});

test('turbo HQ without shader-f16 reuses the regular turbo files', async t => {
  gpu(t,false);
  const hq = await planDownload('turbo-hq','webgpu',() => {});
  assert.deepEqual(hq.files,['onnx/encoder_model_q4.onnx','onnx/decoder_model_merged_q4.onnx']);
});

test('turbo rejects CPU before downloading oversized weights', async t => {
  gpu(t,false);
  await assert.rejects(planDownload('turbo','wasm',() => {}),/MODEL_TOO_BIG_FOR_CPU/);
  await assert.rejects(planDownload('turbo-hq','wasm',() => {}),/MODEL_TOO_BIG_FOR_CPU/);
  const auto = await planDownload('auto','wasm',() => {});
  assert.equal(auto.model,'small');
  assert.deepEqual(auto.files,['onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx']);
});

type Pipeline = Loaded['asr'];
function mockPipeline(run: (...args: Parameters<Pipeline>) => ReturnType<Pipeline>, languages = ['ru']): Loaded {
  let detection = 0;
  const model = Object.assign(async () => {
    const language = languages[detection++] ?? languages[0];
    return { logits: { data: new Float32Array(language === 'en' ? [0, 0, 10] : [0, 10, 0]), dims: [1, 1, 3] } };
  }, { generation_config: { decoder_start_token_id: 0, lang_to_id: { '<|ru|>': 1, '<|en|>': 2 } } });
  return {
    key: 'test', device: 'wasm', model: 'tiny', f16: false, fellBack: false,
    asr: Object.assign(run, { tokenizer: {}, processor: async () => ({ input_features: {} }), model }),
  };
}

function audio(seconds: number, spans: [number, number][] = [[0, seconds]]): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * 16000));
  for (const [start, end] of spans) {
    for (let i = Math.round(start * 16000); i < Math.round(end * 16000); i++) pcm[i] = Math.sin(i / 12) * 0.2;
  }
  return pcm;
}

test('short timed files request real timestamps while plain dictation stays a string', async () => {
  const timestamps: boolean[] = [];
  const loaded = mockPipeline(async (_pcm, options) => {
    timestamps.push(options.return_timestamps);
    return { text: ' Привет.', chunks: [{ text: ' Привет.', timestamp: [0.1, 0.8] }] };
  });
  const opts = { language: 'ru', segment: true };
  assert.deepEqual(await runAsrTimed(loaded, audio(1), opts, () => {}), {
    text: 'Привет.', segments: [{ start: 0.1, end: 0.8, text: 'Привет.' }],
  });
  assert.equal(await runAsr(loaded, audio(1), opts, () => {}), 'Привет.');
  assert.deepEqual(timestamps, [true, false]);
});

test('timestamps restore leading silence relative to an input view, not its backing buffer', async () => {
  const backing = new Float32Array(4 * 16000 + 4800);
  const pcm = backing.subarray(4800);
  pcm.set(audio(4, [[2, 3]]));
  const loaded = mockPipeline(async (speech, options) => {
    assert.equal(speech.length / 16000, 1.6);
    assert.equal(options.return_timestamps, true);
    return { text: 'Слова.', chunks: [{ text: 'Слова.', timestamp: [0.3, 1.3] }] };
  });
  const result = await runAsrTimed(loaded, pcm, { language: 'ru' }, () => {});
  assert.deepEqual(result.segments, [{ start: 2, end: 3, text: 'Слова.' }]);
});

test('long-file chunks retain the merged Whisper offsets and original silence offset', async () => {
  const loaded = mockPipeline(async (_pcm, options) => {
    assert.equal(options.chunk_length_s, 30);
    assert.equal(options.stride_length_s, 5);
    assert.equal(options.return_timestamps, true);
    return { text: 'Начало. Конец.', chunks: [
      { text: 'Начало.', timestamp: [0.3, 4.3] },
      { text: 'Конец.', timestamp: [39.3, 40.3] },
    ] };
  });
  const result = await runAsrTimed(loaded, audio(44, [[2, 42]]), { language: 'ru' }, () => {});
  assert.deepEqual(result.segments, [
    { start: 2, end: 6, text: 'Начало.' },
    { start: 41, end: 42, text: 'Конец.' },
  ]);
});

test('long-file progress counts completed overlapping windows across timestamp resets', async () => {
  const percentages: number[] = [];
  const loaded = mockPipeline(async (_pcm, options) => {
    const streamer = options.streamer as { end(): void; on_chunk_start?: (seconds: number) => void };
    for (let i = 0; i < 3; i++) {
      streamer.on_chunk_start?.(0);
      streamer.on_chunk_start?.(25);
      streamer.end();
    }
    return { text: 'Готово.' };
  });
  await runAsrTimed(loaded, audio(65), { language: 'ru' }, progress => {
    if (progress.stage === 'run' && progress.pct !== undefined) percentages.push(progress.pct);
  });
  assert.deepEqual(percentages, [0, 33, 66, 99]);
});

test('mixed-language phrases retain each pause and segment offset', async () => {
  const seen: string[] = [];
  const loaded = mockPipeline(async (_pcm, options) => {
    seen.push(options.language!);
    assert.equal(options.return_timestamps, true);
    const text = options.language === 'ru' ? 'Привет.' : 'Hello.';
    return { text, chunks: [{ text, timestamp: [0.28, 1.28] }] };
  }, ['ru', 'en']);
  const result = await runAsrTimed(loaded, audio(7, [[2, 3], [5, 6]]), { language: 'ru', language2: 'en' }, () => {});
  assert.deepEqual(seen, ['ru', 'en']);
  assert.deepEqual(result, { text: 'Привет. Hello.', segments: [
    { start: 2, end: 3, text: 'Привет.' },
    { start: 5, end: 6, text: 'Hello.' },
  ] });
});

test('null ends use the next start or audio end; malformed cues are omitted or clamped', async () => {
  const loaded = mockPipeline(async () => ({ text: 'Первый. Второй. Последний.', chunks: [
    { text: '', timestamp: [null, null] },
    { text: 'Первый.', timestamp: [-0.2, null] },
    { text: 'Второй.', timestamp: [1, 100] },
    { text: 'Последний.', timestamp: [2, null] },
    { text: '', timestamp: [NaN, Infinity] },
    { text: '', timestamp: [20, 21] },
  ] }));
  const result = await runAsrTimed(loaded, audio(3), { language: 'ru', segment: true }, () => {});
  assert.deepEqual(result.segments, [
    { start: 0, end: 1, text: 'Первый.' },
    { start: 1, end: 2, text: 'Второй.' },
    { start: 2, end: 3, text: 'Последний.' },
  ]);
});

test('missing chunks preserve text without fabricating subtitle timings', async () => {
  const loaded = mockPipeline(async () => ({ text: 'Текст без времени.' }));
  assert.deepEqual(await runAsrTimed(loaded, audio(3), { language: 'ru', segment: true }, () => {}), {
    text: 'Текст без времени.', segments: [],
  });
});

test('incomplete or invalid timings preserve every word as plain text', async () => {
  const text = 'Начало. Пропущенные слова.';
  for (const chunks of [
    [{ text: 'Начало.', timestamp: [0, 1] as [number, number] }],
    [{ text: 'Начало.', timestamp: [0, 1] as [number, number] }, { text: 'Пропущенные слова.', timestamp: [null, 2] as [null, number] }],
  ]) {
    const loaded = mockPipeline(async () => ({ text, chunks }));
    assert.deepEqual(await runAsrTimed(loaded, audio(3), { language: 'ru', segment: true }, () => {}), { text, segments: [] });
  }
});

test('one mixed-language phrase without timings disables incomplete subtitle export', async () => {
  const loaded = mockPipeline(async (_pcm, options) => options.language === 'ru'
    ? { text: 'Привет.', chunks: [{ text: 'Привет.', timestamp: [0.28, 1.28] }] }
    : { text: 'Hello.' }, ['ru', 'en']);
  const result = await runAsrTimed(loaded, audio(7, [[2, 3], [5, 6]]), { language: 'ru', language2: 'en' }, () => {});
  assert.deepEqual(result, { text: 'Привет. Hello.', segments: [] });
});

test('silence and cancellation leave no partial timestamps', async () => {
  let calls = 0;
  let cancelled = false;
  const loaded = mockPipeline(async () => {
    calls++;
    cancelled = true;
    return { text: 'Текст.', chunks: [{ text: 'Текст.', timestamp: [0, 1] }] };
  });
  const opts = { language: 'ru', segment: true };
  const empty = { text: '', segments: [] };
  assert.deepEqual(await runAsrTimed(loaded, new Float32Array(16000), opts, () => {}), empty);
  assert.equal(calls, 0);
  assert.deepEqual(await runAsrTimed(loaded, audio(1), opts, () => {}, () => cancelled), empty);
  assert.equal(calls, 1);
});
