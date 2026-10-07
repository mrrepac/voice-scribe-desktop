import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { SpeakerTurn } from '../shared/speakers';

const models = [
  { name: 'segmentation.onnx', repo: 'sherpa-onnx-pyannote-segmentation-3-0', revision: '9403a6902bb58e3d5ae8c7e77c3422de279db2e0', file: 'model.onnx', size: 5992913, sha: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079' },
  // TitaNet Large: CAM++ VoxCeleb failed to separate a male and a female voice on a Russian podcast.
  { name: 'embedding.onnx', repo: 'speaker-embedding-models', revision: '0743f301363dec56491a490f6d6cbc9d67f9a3bf', file: 'nemo_en_titanet_large.onnx', size: 101405493, sha: 'd51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77' },
];
const report = (message: string) => process.send?.({ type: 'progress', message });
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function prepare(directory: string): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  for (const [index, model] of models.entries()) {
    const file = path.join(directory, model.name);
    files.push(file);
    const cached = await readFile(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (cached?.length === model.size && hash(cached) === model.sha) continue;
    report(`Загружаем модель ораторов ${index + 1}/2 · 0%`);
    const response = await fetch(`https://huggingface.co/csukuangfj/${model.repo}/resolve/${model.revision}/${model.file}`, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Не удалось загрузить модель ораторов (HTTP ${response.status})`);
    const parts: Uint8Array[] = [];
    let size = 0;
    let reportedAt = 0;
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.length;
      if (size > model.size) throw new Error('Некорректный размер модели ораторов');
      parts.push(chunk);
      if (Date.now() - reportedAt > 250) {
        report(`Загружаем модель ораторов ${index + 1}/2 · ${Math.round(size / model.size * 100)}%`);
        reportedAt = Date.now();
      }
    }
    const data = Buffer.concat(parts);
    if (data.length !== model.size || hash(data) !== model.sha) throw new Error('Модель ораторов загружена не полностью. Повторите попытку.');
    const temp = file + '.tmp';
    try { await writeFile(temp, data); await rename(temp, file); }
    finally { await rm(temp, { force: true }); }
  }
  return files;
}

process.once('message', async (message: { pcm?: Float32Array; pcmPath?: string; modelDirectory: string; speakerCount?: number }) => {
  try {
    const bytes = message.pcmPath ? await readFile(message.pcmPath) : undefined;
    const pcm = bytes ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) : message.pcm;
    if (!pcm?.length || pcm.length > 16000 * 7200 || pcm.some(x=>!Number.isFinite(x))) throw new Error('Некорректная звуковая дорожка');
    const [segmentation, embedding] = await prepare(message.modelDirectory);
    report('Определяем ораторов · это может занять несколько минут');
    const { OfflineSpeakerDiarization } = require('sherpa-onnx-node') as {
      OfflineSpeakerDiarization: new (config: unknown) => { sampleRate: number; process(pcm: Float32Array): SpeakerTurn[] };
    };
    // Inference scales almost linearly with cores; keep one free for the interface.
    const threads = Math.max(2, Math.min(16, os.availableParallelism() - 1));
    const engine = new OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: segmentation }, numThreads: threads, provider: 'cpu' },
      embedding: { model: embedding, numThreads: threads, provider: 'cpu' },
      // Tuned for TitaNet: 0.7–0.9 found two speakers, 0.5 split them into six.
      clustering: { numClusters: message.speakerCount ?? -1, threshold: 0.8 },
      minDurationOn: 0.2, minDurationOff: 0.5,
    });
    if (engine.sampleRate !== 16000) throw new Error('Неподдерживаемая частота модели ораторов');
    const turns = engine.process(pcm);
    process.send?.({ type: 'result', turns }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
  }
});
