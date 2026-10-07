// Included only in smoke-test builds. invoke via import('./smoke.js').
import { AsrClient, decodeAudioTo16kMono } from './client';
import type { ModelOptions, ProgressInfo, DownloadPlan, LoadedInfo } from './client';
import type { Transcript } from '../shared/transcript';

export async function runAsrSmoke(options: ModelOptions & { prepare?: boolean; audio?: ArrayBuffer; timeoutMs?: number; timestamps?: boolean }) {
  const client = new AsrClient();
  const progress: ProgressInfo[] = [];
  let stage = 'plan';
  let plan: DownloadPlan | null = null;
  let loaded: LoadedInfo | null = null;
  let text: string | null = null;
  let transcript: Transcript | null = null;
  let leadingSilenceSec = 0;
  let cacheCheck: 'not-needed' | 'unavailable' | 'ready' | 'missing' = 'not-needed';
  let missingFiles: string[] = [];
  const startedAt = performance.now();
  const report = (value: ProgressInfo) => {
    progress.push(value);
    if (progress.length > 256) progress.shift();
    console.log('ASR_SMOKE', JSON.stringify(value));
  };
  const run = async () => {
    plan = await client.plan(options, report);
    if (options.prepare || options.audio) {
      stage = 'cache';
      const cacheHas = (window.scribe as unknown as { cacheHas?: (key: string) => Promise<boolean> }).cacheHas;
      if (cacheHas) {
        const files = [...plan.files, 'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
        const prefix = `https://huggingface.co/${plan.modelId}/resolve/main/`;
        const cached = await Promise.all(files.map(file => cacheHas(prefix + file)));
        missingFiles = files.filter((_file, index) => !cached[index]);
        cacheCheck = missingFiles.length ? 'missing' : 'ready';
        if (missingFiles.length) throw new Error(`SMOKE_CACHE_MISS: ${missingFiles.join(', ')}`);
      } else {
        cacheCheck = 'unavailable';
      }
      stage = 'prepare';
      loaded = await client.prepare(options, report);
    }
    if (options.audio) {
      stage = 'decode';
      let pcm = await decodeAudioTo16kMono(options.audio);
      stage = 'transcribe';
      if (options.timestamps !== false) {
        // An offset check against real Whisper output catches accidental loss
        // of leading silence in the file -> worker -> timestamp path.
        leadingSilenceSec = 2;
        const padded = new Float32Array(pcm.length + leadingSilenceSec * 16000);
        padded.set(pcm, leadingSilenceSec * 16000);
        pcm = padded;
        transcript = await client.transcribeTimed(pcm, { ...options, language: 'auto' }, report);
        text = transcript.text;
        if (text.trim() && !transcript.segments.length) throw new Error('SMOKE_NO_TIMESTAMPS');
        if (transcript.segments.some(segment => segment.start < leadingSilenceSec - 0.35)) {
          throw new Error('SMOKE_TIMESTAMP_OFFSET');
        }
      } else {
        text = await client.transcribe(pcm, { ...options, language: 'auto' }, report);
      }
      if (!text.trim()) throw new Error('SMOKE_NO_TRANSCRIPT');
    }
    stage = 'done';
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`SMOKE_TIMEOUT: ${stage}`);
      error.name = 'TimeoutError';
      reject(error);
      client.cancel();
    }, Math.max(1000, Math.min(options.timeoutMs ?? 120_000, 300_000)));
  });
  try {
    await Promise.race([run(), deadline]);
    return { ok: true, stage, plan, loaded, text, transcript, leadingSilenceSec, cacheCheck, missingFiles, elapsedMs: Math.round(performance.now() - startedAt), progress };
  } catch (error) {
    return {
      ok: false, stage, plan, loaded, text, transcript, leadingSilenceSec, cacheCheck, missingFiles,
      elapsedMs: Math.round(performance.now() - startedAt), progress,
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    if (timer) clearTimeout(timer);
    client.destroy();
  }
}
