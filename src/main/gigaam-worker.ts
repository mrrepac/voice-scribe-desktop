// GigaAM v3 (Sber, MIT) via sherpa-onnx in a separate Node process. The model
// stays loaded between requests; the service kills the process to cancel.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { splitAtPauses } from '../shared/quiet-cut';
import { cuesFromTokens } from '../shared/token-cues';
import type { Transcript } from '../shared/transcript';
import type { GigaamRequest, GigaamReply } from '../shared/gigaam';

const REPO = 'csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16';
const REVISION = 'a6039be7cee829a9044a69ac0ebaf1c191217c97';
const FILES = [
  { name: 'encoder.int8.onnx', size: 224570820, sha: '369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf' },
  { name: 'decoder.onnx', size: 4600132, sha: '38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4' },
  { name: 'joiner.onnx', size: 2712896, sha: '602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c' },
  { name: 'tokens.txt', size: 13354, sha: '39abae20e692998290c574e606f11a9edef2902a1995463fcff63d1490cf22b7' },
];
const TOTAL = FILES.reduce((sum, file) => sum + file.size, 0);
/** Hugging Face often drops long downloads mid-file; each retry resumes with a Range request. */
const ATTEMPTS = 30;
const RATE = 16000;

interface Result { text: string; tokens: string[]; timestamps: number[] }
interface Recognizer {
  createStream(): { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): Result;
}

const send = (message: GigaamReply) => process.send?.(message);
const sizeOf = (file: string) => stat(file).then(info => info.size, () => 0);

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function download(directory: string, id: number): Promise<void> {
  await mkdir(directory, { recursive: true });
  const ready = await Promise.all(FILES.map(async file => await sizeOf(path.join(directory, file.name)) === file.size));
  if (ready.every(Boolean)) return;
  let done = FILES.reduce((sum, file, index) => sum + (ready[index] ? file.size : 0), 0);
  let reportedAt = 0;
  const report = (force = false) => {
    if (!force && Date.now() - reportedAt < 250) return;
    reportedAt = Date.now();
    send({ type: 'progress', id, pct: Math.min(99, Math.floor(done / TOTAL * 100)) });
  };
  report(true);
  for (const [index, file] of FILES.entries()) {
    if (ready[index]) continue;
    const target = path.join(directory, file.name);
    const partial = target + '.part';
    let have = await sizeOf(partial);
    if (have > file.size) { await rm(partial, { force: true }); have = 0; }
    done += have;
    for (let attempt = 1; have < file.size; attempt++) {
      try {
        const response = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${file.name}`, {
          headers: have ? { Range: `bytes=${have}-` } : {}, signal: AbortSignal.timeout(600_000),
        });
        // A server that ignores Range restarts the file; never append a full body to a partial one.
        if (have && response.status !== 206) { done -= have; have = 0; }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const out = createWriteStream(partial, { flags: have ? 'a' : 'w' });
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            if (have + chunk.length > file.size) throw new Error('Некорректный размер модели GigaAM');
            if (!out.write(chunk)) await once(out, 'drain');
            have += chunk.length;
            done += chunk.length;
            report();
          }
        } finally {
          out.end();
          await once(out, 'close');
        }
      } catch (error) {
        // Resume from what actually reached the disk.
        const actual = await sizeOf(partial);
        done += actual - have;
        have = actual;
        if (attempt >= ATTEMPTS) throw new Error(`Не удалось загрузить модель GigaAM: ${error instanceof Error ? error.message : error}`);
        await new Promise(resolve => setTimeout(resolve, Math.min(10_000, 1000 * attempt)));
      }
    }
    if (await sha256(partial) !== file.sha) {
      await rm(partial, { force: true });
      throw new Error('Модель GigaAM загружена с ошибкой. Повторите попытку.');
    }
    await rename(partial, target);
  }
  report(true);
}

let recognizer: Recognizer | null = null;

async function load(directory: string, id: number): Promise<Recognizer> {
  if (recognizer) return recognizer;
  await download(directory, id);
  const { OfflineRecognizer } = require('sherpa-onnx-node') as { OfflineRecognizer: new (config: unknown) => Recognizer };
  // More threads than four were slower on a 170 s recording (5.3 s vs 4.4 s).
  const threads = Math.max(1, Math.min(4, os.availableParallelism() - 1));
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 64 },
    modelConfig: {
      transducer: { encoder: path.join(directory, 'encoder.int8.onnx'), decoder: path.join(directory, 'decoder.onnx'), joiner: path.join(directory, 'joiner.onnx') },
      tokens: path.join(directory, 'tokens.txt'), modelType: 'nemo_transducer', numThreads: threads, provider: 'cpu',
    },
  });
  return recognizer;
}

/** Longer input drops words, so audio is decoded in pause-aligned windows of up to 30 s. */
function recognize(engine: Recognizer, pcm: Float32Array, timed: boolean): Transcript {
  const texts: string[] = [];
  const segments: Transcript['segments'] = [];
  for (const part of splitAtPauses(pcm)) {
    const stream = engine.createStream();
    stream.acceptWaveform({ samples: part.pcm, sampleRate: RATE });
    engine.decode(stream);
    const result = engine.getResult(stream);
    if (!timed) { texts.push(result.text.trim()); continue; }
    const cues = cuesFromTokens(result.tokens ?? [], result.timestamps ?? [], part.offset / RATE, part.pcm.length / RATE);
    texts.push(cues.text);
    segments.push(...cues.segments);
  }
  return { text: texts.filter(Boolean).join(' '), segments };
}

let queue: Promise<void> = Promise.resolve();
process.on('message', (message: GigaamRequest) => {
  queue = queue.then(async () => {
    try {
      const engine = await load(message.modelDirectory, message.id);
      if (message.type === 'prepare') { send({ type: 'ready', id: message.id }); return; }
      const pcm = message.pcm;
      if (!(pcm instanceof Float32Array) || pcm.length > RATE * 7200) throw new Error('Некорректный фрагмент аудио');
      send({ type: 'result', id: message.id, transcript: recognize(engine, pcm, message.timed) });
    } catch (error) {
      send({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
  });
});
