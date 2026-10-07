import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cuesFromTokens } from '../src/shared/token-cues';
import { splitAtPauses, WINDOW_SECONDS } from '../src/shared/quiet-cut';
import { Recognizer } from '../src/renderer/recognizer';
import type { AsrClient } from '../src/asr/client';

// Real GigaAM v3 output for the start of a recording (pieces and start times).
// A lone ' ' piece starts a word, as in the model's ' ', 'след', 'ую'...
const tokens = [' С','е','го','д','ня',' мы',' ','п','ла','н','.',' П','ер','вая',' за','да','ча','.'];
const times = [0.16,0.24,0.32,0.44,0.48,0.64,1.2,1.32,1.44,1.56,3.72,4.36,4.44,4.6,4.84,5,5.16,5.5];

test('GigaAM tokens become sentence cues whose texts rebuild the transcript', () => {
  const { text, segments } = cuesFromTokens(tokens, times, 10, 30);
  assert.deepEqual(segments.map(segment => segment.text), ['Сегодня мы план.', 'Первая задача.']);
  assert.equal(text, 'Сегодня мы план. Первая задача.');
  // Offsets move cues to the file timeline; a sentence ends shortly after its last token.
  assert.equal(segments[0].start, 10.16);
  assert.ok(Math.abs(segments[0].end - 14.12) < 1e-9);
  assert.equal(segments[1].start, 14.36);
  assert.ok(segments.every(segment => segment.end > segment.start));
});

test('long pauses and long sentences split cues only at word starts', () => {
  const pause = cuesFromTokens([' один',' два',' три'], [0, 0.3, 2], 0, 30);
  assert.deepEqual(pause.segments.map(segment => segment.text), ['один два', 'три']);
  assert.ok(Math.abs(pause.segments[0].end - 0.7) < 1e-9);
  const words = Array.from({ length: 30 }, (_, i) => ' слово');
  const long = cuesFromTokens(words, words.map((_, i) => i * 0.5), 0, 30);
  assert.ok(long.segments.length >= 2);
  assert.ok(long.segments.every(segment => segment.end - segment.start <= 10.5));
  assert.equal(long.text.split(' ').length, 30);
});

test('cues stay inside the chunk and malformed tokens are skipped', () => {
  const { segments } = cuesFromTokens([' край', ' мусор'], [29.9, Number.NaN], 0, 30);
  assert.equal(segments.length, 1);
  assert.ok(segments[0].end <= 30);
  assert.deepEqual(cuesFromTokens([], [], 0, 30), { text: '', segments: [] });
});

test('audio is split into pause-aligned windows that cover every sample once', () => {
  const rate = 16000;
  const pcm = new Float32Array(75 * rate).map((_, i) => 0.2 * Math.sin(i / 5));
  pcm.fill(0, 27 * rate, 27.5 * rate);
  const parts = splitAtPauses(pcm);
  assert.ok(parts.every(part => part.pcm.length <= WINDOW_SECONDS * rate));
  assert.ok(parts[0].pcm.length > 27 * rate && parts[0].pcm.length < 27.5 * rate);
  let covered = 0;
  for (const part of parts) { assert.equal(part.offset, covered); covered += part.pcm.length; }
  assert.equal(covered, pcm.length);
});

test('the recognizer routes GigaAM to the bridge and Whisper to the worker client', async () => {
  const calls: string[] = [];
  let progress: ((value: { pct: number }) => void) | undefined;
  const bridge = {
    prepareGigaam: async () => { calls.push('giga-prepare'); progress?.({ pct: 40 }); },
    recognizeGigaam: async (_pcm: Float32Array, timed: boolean) => { calls.push(`giga-${timed}`); return { text: 'Привет.', segments: [] }; },
    cancelGigaam: async () => { calls.push('giga-cancel'); },
    onGigaamProgress: (handler: (value: { pct: number }) => void) => { progress = handler; return () => {}; },
  };
  const whisper = {
    prepare: async () => { calls.push('whisper-prepare'); return { model: 'small', device: 'wasm', f16: false, fellBack: false }; },
    transcribe: async () => { calls.push('whisper-run'); return 'hello'; },
    transcribeTimed: async () => ({ text: '', segments: [] }),
    cancel: () => calls.push('whisper-cancel'),
    destroy: () => {},
  } as unknown as AsrClient;
  const recognizer = new Recognizer(bridge, whisper);
  const speech = new Float32Array(16000).map((_, i) => 0.3 * Math.sin(i / 4));
  const giga = { model: 'gigaam', device: 'auto', language: 'en', language2: '' } as const;
  const seen: unknown[] = [];
  assert.deepEqual(await recognizer.prepare(giga, value => seen.push(value)), { model: 'gigaam', device: 'wasm', f16: false, fellBack: false });
  assert.deepEqual(seen, [{ stage: 'model' }, { stage: 'model', pct: 40, dl: true }]);
  assert.equal(await recognizer.transcribe(speech, giga), 'Привет.');
  assert.deepEqual(await recognizer.transcribeTimed(speech, giga), { text: 'Привет.', segments: [] });
  // Silence never reaches the model, as with Whisper.
  assert.equal(await recognizer.transcribe(new Float32Array(16000), giga), '');
  assert.equal(await recognizer.transcribe(speech, { ...giga, model: 'small' }), 'hello');
  recognizer.cancel();
  assert.deepEqual(calls, ['giga-prepare', 'giga-false', 'giga-true', 'whisper-run', 'whisper-cancel', 'giga-cancel']);
});

test('Auto picks GigaAM for Russian only and can be kept on Whisper', async () => {
  const used: string[] = [];
  const bridge = {
    prepareGigaam: async () => {}, cancelGigaam: async () => {}, onGigaamProgress: () => () => {},
    recognizeGigaam: async () => { used.push('gigaam'); return { text: 'Привет.', segments: [] }; },
  };
  const whisper = { transcribe: async (_pcm: Float32Array, options: { model: string }) => { used.push(options.model); return 'hello'; } } as unknown as AsrClient;
  const recognizer = new Recognizer(bridge, whisper);
  const speech = new Float32Array(16000).map((_, i) => 0.3 * Math.sin(i / 4));
  const auto = { model: 'auto', device: 'auto', language: 'ru', language2: '' } as const;
  for (const options of [auto, { ...auto, language2: 'ru' }, { ...auto, language: 'en' }, { ...auto, language: 'auto' }, { ...auto, language2: 'en' }, { ...auto, model: 'small' }, { ...auto, autoGigaam: false }] as const)
    await recognizer.transcribe(speech, options);
  assert.deepEqual(used, ['gigaam', 'gigaam', 'auto', 'auto', 'auto', 'small', 'auto']);
});
