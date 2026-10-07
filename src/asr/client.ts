import { trimSilence } from "../shared/clean";
import type { DevicePref, DownloadPlan, ModelPref, ProgressFn } from "./engine";
import type { FromWorker, LoadedInfo, ToWorker } from "./protocol";
import type { Transcript } from "../shared/transcript";

export type { LoadedInfo } from "./protocol";
export type { ProgressInfo, ProgressFn, ModelPref, DevicePref, DownloadPlan } from "./engine";
export interface ModelOptions { model: ModelPref; device: DevicePref }
export interface TranscribeOptions extends ModelOptions {
  language: string;
  language2?: string;
  segment?: boolean;
}
export interface CacheBridge {
  cacheGet(key: string): Promise<ArrayBuffer | null>;
  cachePut(key: string, buffer: ArrayBuffer): Promise<void>;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  progress: ProgressFn;
}
const cancelled = () => new DOMException("Распознавание отменено", "AbortError");

/** The only renderer-facing recognition API. All heavy work stays in a worker. */
export class AsrClient {
  private worker: Worker | null = null;
  private booting: Promise<Worker> | null = null;
  private rejectBoot: ((error: Error) => void) | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private generation = 0;
  private destroyed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private bridge: CacheBridge;
  private workerUrl: URL;

  constructor(bridge?: CacheBridge, workerUrl?: URL) {
    this.bridge = bridge ?? (window as unknown as { scribe: CacheBridge }).scribe;
    this.workerUrl = workerUrl ?? new URL("./asr-worker.js", window.location.href);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const run = this.queue.then(() => {
      if (this.destroyed || generation !== this.generation) throw cancelled();
      return operation();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  plan(options: ModelOptions, progress: ProgressFn = () => {}): Promise<DownloadPlan> {
    return this.enqueue(async () => {
      const worker = await this.ensureWorker();
      return this.request(worker, id => ({ t: "plan", id, pref: options.model, devicePref: options.device }), progress);
    });
  }

  prepare(options: ModelOptions, progress: ProgressFn = () => {}): Promise<LoadedInfo> {
    return this.enqueue(() => this.load(options, progress));
  }

  private async load(options: ModelOptions, progress: ProgressFn): Promise<LoadedInfo> {
    const worker = await this.ensureWorker();
    return this.request(worker, id => ({ t: "load", id, pref: options.model, devicePref: options.device }), progress);
  }

  /** Input remains owned by the caller, so it can still be saved or retried. */
  transcribe(pcm: Float32Array, options: TranscribeOptions, progress: ProgressFn = () => {}): Promise<string> {
    return this.transcribeRequest(pcm, options, progress, "run", "");
  }

  /** Timings refer to the original PCM, including any leading silence. */
  transcribeTimed(pcm: Float32Array, options: TranscribeOptions, progress: ProgressFn = () => {}): Promise<Transcript> {
    return this.transcribeRequest(pcm, options, progress, "run-timed", { text: "", segments: [] });
  }

  private transcribeRequest<T extends string | Transcript>(
    pcm: Float32Array, options: TranscribeOptions, progress: ProgressFn, kind: "run" | "run-timed", empty: T
  ): Promise<T> {
    return this.enqueue(async () => {
      if (!trimSilence(pcm)) return empty;
      const generation = this.generation;
      await this.load(options, progress);
      if (generation !== this.generation || !this.worker) throw cancelled();
      const copy = new Float32Array(pcm);
      return this.request<T>(this.worker, id => ({
        t: kind, id, pcm: copy, language: options.language || "auto",
        language2: options.language2 ?? "", segment: options.segment ?? false,
      }), progress, [copy.buffer]);
    });
  }

  /** Termination also stops model download and short-segment inference immediately. */
  cancel(): void {
    this.generation++;
    this.stopWorker(cancelled());
    this.queue = Promise.resolve();
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
  }

  private stopWorker(error: Error): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
    this.rejectBoot?.(error);
    this.rejectBoot = null;
    this.worker?.terminate();
    this.worker = null;
    this.booting = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private ensureWorker(): Promise<Worker> {
    if (this.booting) return this.booting;
    if (this.worker) return Promise.resolve(this.worker);
    if (this.destroyed) return Promise.reject(cancelled());
    if (!this.bridge) return Promise.reject(new Error("CACHE_BRIDGE_UNAVAILABLE"));
    const worker = new Worker(this.workerUrl, { type: "module", name: "voice-scribe-asr" });
    this.worker = worker;
    this.booting = new Promise((resolve, reject) => {
      this.rejectBoot = reject;
      this.bootTimer = setTimeout(() => this.stopWorker(new Error("WORKER_START_TIMEOUT")), 20_000);
      worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
        if (worker !== this.worker) return;
        if (data.t === "ready") {
          if (this.bootTimer) clearTimeout(this.bootTimer);
          this.bootTimer = null;
          this.rejectBoot = null;
          resolve(worker);
        } else this.onMessage(worker, data);
      };
      worker.onerror = event => {
        if (worker === this.worker) this.stopWorker(new Error(event.message || "WORKER_CRASHED"));
      };
      worker.onmessageerror = () => {
        if (worker === this.worker) this.stopWorker(new Error("WORKER_MESSAGE_FAILED"));
      };
    });
    return this.booting;
  }

  private onMessage(worker: Worker, message: Exclude<FromWorker, { t: "ready" }>): void {
    if (message.t === "cache-get" || message.t === "cache-put") {
      void this.replyCache(worker, message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.t === "progress") {
      pending.progress(message.p);
      return;
    }
    this.pending.delete(message.id);
    if (message.t === "error") pending.reject(new Error(message.message));
    else if (message.t === "loaded") pending.resolve(message.info);
    else if (message.t === "plan") pending.resolve(message.plan);
    else if (message.t === "transcript") pending.resolve(message.transcript);
    else pending.resolve(message.text);
  }

  private async replyCache(worker: Worker, message: Extract<FromWorker, { t: "cache-get" | "cache-put" }>): Promise<void> {
    let buf: ArrayBuffer | null = null;
    let error: string | undefined;
    try {
      if (message.t === "cache-get") buf = await this.bridge.cacheGet(message.key);
      else await this.bridge.cachePut(message.key, message.buf);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (worker !== this.worker) return;
    worker.postMessage({ t: "cache-reply", id: message.id, buf, error } satisfies ToWorker, buf ? [buf] : []);
  }

  private request<T>(worker: Worker, message: (id: number) => ToWorker, progress: ProgressFn, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject, progress });
      try { worker.postMessage(message(id), transfer); }
      catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

/** Chromium-supported audio formats -> mono PCM at Whisper's 16 kHz. */
export async function decodeAudioTo16kMono(buffer: ArrayBuffer): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await context.decodeAudioData(buffer);
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    return mono;
  } finally {
    await context.close();
  }
}
