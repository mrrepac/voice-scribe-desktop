// Standalone browser worker. No Electron, Node, filesystem, or UI access.
import { getPipeline, noteCacheMiss, planDownload, runAsr, runAsrTimed, setHost } from "./engine";
import type { CacheLike, Loaded, ProgressInfo } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";
import { whisperCacheKey } from "../shared/whisper";

declare const self: {
  location: Location;
  crossOriginIsolated: boolean;
  postMessage(data: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

let cacheSequence = 0;
const cacheRequests = new Map<number, {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}>();
let activeId = 0;
let current: Loaded | null = null;

function storeInCache(key: string, buf: ArrayBuffer): Promise<void> {
  const id = ++cacheSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cacheRequests.delete(id);
      reject(new Error("MODEL_CACHE_TIMEOUT"));
    }, 120_000);
    cacheRequests.set(id, { resolve, reject, timer });
    self.postMessage({ t: "cache-put", id, key, buf }, [buf]);
  });
}

const keyOf = (request: string | { url?: string }) => {
  const url = typeof request === "string" ? request : request.url;
  return url && whisperCacheKey(url);
};
const diskCache: CacheLike = {
  async match(request) {
    const key = keyOf(request);
    // Transformers probes /models/... before its remote URL even when local
    // models are disabled. That lookup cannot exist in our URL-keyed cache.
    if (!key?.startsWith("https://huggingface.co/")) return undefined;
    // The app protocol streams the file from disk; a 404 means it is not downloaded yet.
    const response = await fetch(new URL(`./model-cache/${encodeURIComponent(key)}`, self.location.href));
    if (response.status === 404) {
      noteCacheMiss(key);
      return undefined;
    }
    if (!response.ok) throw new Error(`MODEL_CACHE_READ_FAILED ${response.status}`);
    return response;
  },
  async put(request, response) {
    const key = keyOf(request);
    if (!key) return;
    try {
      await storeInCache(key, await response.arrayBuffer());
    } catch (error) {
      // Recognition may continue, but never imply that the next start is offline.
      self.postMessage({ t: "progress", id: activeId, p: { stage: "model", note: "cache-write-failed" } });
      console.warn("Voice Scribe: model cache write failed", error);
    }
  },
};

setHost({
  mobile: false,
  cache: diskCache,
  crossOriginIsolated: self.crossOriginIsolated,
  ort: {
    mjsUrl: new URL("./ort/ort-wasm-simd-threaded.jsep.mjs", self.location.href).href,
    wasmUrl: new URL("./ort/ort-wasm-simd-threaded.jsep.wasm", self.location.href).href,
  },
});

const progressFor = (id: number) => (p: ProgressInfo) => self.postMessage({ t: "progress", id, p });

async function handle(msg: Exclude<ToWorker, { t: "cache-reply" }>): Promise<void> {
  activeId = msg.id;
  const onProgress = progressFor(msg.id);
  switch (msg.t) {
    case "plan":
      self.postMessage({ t: "plan", id: msg.id, plan: await planDownload(msg.pref, msg.devicePref, onProgress) });
      break;
    case "load":
      current = await getPipeline(msg.pref, msg.devicePref, onProgress);
      self.postMessage({ t: "loaded", id: msg.id, info: {
        model: current.model, device: current.device, f16: current.f16, fellBack: current.fellBack,
      } });
      break;
    case "run":
      if (!current) throw new Error("NO_PIPELINE");
      self.postMessage({ t: "text", id: msg.id, text: await runAsr(current, msg.pcm, msg, onProgress) });
      break;
    case "run-timed":
      if (!current) throw new Error("NO_PIPELINE");
      self.postMessage({ t: "transcript", id: msg.id, transcript: await runAsrTimed(current, msg.pcm, msg, onProgress) });
      break;
  }
}

// Serial inference avoids overlapping GPU sessions. Cache replies must bypass
// this queue, because a model load is waiting for them.
let queue: Promise<void> = Promise.resolve();
self.onmessage = ({ data: msg }) => {
  if (msg.t === "cache-reply") {
    const request = cacheRequests.get(msg.id);
    if (!request) return;
    cacheRequests.delete(msg.id);
    clearTimeout(request.timer);
    if (msg.error) request.reject(new Error(msg.error));
    else request.resolve();
    return;
  }
  queue = queue.then(() => handle(msg)).catch((error: unknown) => {
    self.postMessage({ t: "error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
  });
};
self.postMessage({ t: "ready", crossOriginIsolated: self.crossOriginIsolated });
