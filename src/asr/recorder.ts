// Adapted from Voice Scribe 0.4.1 by mrrepac (MIT).
export interface RecordingResult { blob: Blob; mime: string }
export interface TapOptions {
  onPcm(block: Float32Array): void;
  onUnavailable?(): void;
  moduleUrl?: () => Promise<string | null>;
}
export type RecorderState = "idle" | "starting" | "recording" | "stopping";

function pickMime(): string {
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}
export function mimeToExt(mime: string): string { return mime.includes("mp4") ? "m4a" : "webm"; }

export class Recorder {
  state: RecorderState = "idle";
  analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private tap: AudioWorkletNode | null = null;
  private flushDone: (() => void) | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private startedAt = 0;
  private generation = 0;
  private stopping: Promise<RecordingResult | null> | null = null;

  get durationSec(): number {
    return this.state === "idle" || this.state === "starting" ? 0 : Math.max(0, (performance.now() - this.startedAt) / 1000);
  }

  async start(deviceId?: string, tap?: TapOptions): Promise<void> {
    if (this.state !== "idle") throw new Error("RECORDING_ALREADY_STARTED");
    const generation = ++this.generation;
    const stale = () => generation !== this.generation;
    const abort = () => new DOMException("Запись отменена", "AbortError");
    this.state = "starting";
    const base: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
      } catch (error) {
        if (stale()) throw abort();
        // A removed selected microphone may fall back; denied permission does not.
        if (!deviceId || !["NotFoundError", "OverconstrainedError"].includes((error as Error)?.name)) throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      }
      if (stale()) {
        stream.getTracks().forEach(track => track.stop());
        throw abort();
      }
      this.stream = stream;
      this.chunks = [];
      const chunks = this.chunks;
      const mime = pickMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      this.recorder = recorder;
      this.mime = recorder.mimeType || mime || "audio/webm";
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      await this.setupAudio(stream, tap, generation);
      if (stale()) throw abort();
      this.startedAt = performance.now();
      this.state = "recording";
      recorder.start(500);
    } catch (error) {
      if (!stale()) this.cancel();
      throw error;
    }
  }

  stop(): Promise<RecordingResult | null> {
    if (this.stopping) return this.stopping;
    if (this.state === "starting") {
      this.cancel();
      return Promise.resolve(null);
    }
    const recorder = this.recorder;
    if (this.state === "idle" || !recorder) return Promise.resolve(null);
    const generation = this.generation;
    const chunks = this.chunks;
    const mime = this.mime;
    this.state = "stopping";
    const run = async (): Promise<RecordingResult | null> => {
      await this.flushTap();
      await new Promise<void>(resolve => {
        const timer = setTimeout(finish, 4000);
        function finish(): void { clearTimeout(timer); resolve(); }
        recorder.onstop = finish;
        recorder.onerror = finish;
        if (recorder.state === "inactive") finish();
        else {
          try { recorder.stop(); }
          catch { finish(); }
        }
      });
      if (generation !== this.generation) return null;
      this.release();
      this.state = "idle";
      this.recorder = null;
      this.chunks = [];
      const blob = new Blob(chunks, { type: mime });
      return blob.size ? { blob, mime } : null;
    };
    this.stopping = run().finally(() => {
      if (generation === this.generation) this.stopping = null;
    });
    return this.stopping;
  }

  cancel(): void {
    this.generation++;
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* tracks are still released below */ }
    }
    this.release();
    this.state = "idle";
    this.recorder = null;
    this.chunks = [];
    this.stopping = null;
  }

  private async setupAudio(stream: MediaStream, options: TapOptions | undefined, generation: number): Promise<void> {
    let context: AudioContext | null = null;
    try {
      context = new AudioContext(options ? { sampleRate: 16000 } : {});
      this.context = context;
      if (context.state === "suspended") await context.resume();
      if (generation !== this.generation) return;
      const source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      if (!options) return;
      if (context.sampleRate !== 16000) throw new Error("PCM_SAMPLE_RATE_UNSUPPORTED");
      const url = await options.moduleUrl?.() ?? new URL("./tap-worklet.js", window.location.href).href;
      await context.audioWorklet.addModule(url);
      if (generation !== this.generation) return;
      const tap = new AudioWorkletNode(context, "voice-scribe-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      tap.port.onmessage = ({ data }: MessageEvent<Float32Array | { flushed: boolean }>) => {
        if (generation !== this.generation) return;
        if (data instanceof Float32Array) {
          if (this.state === "recording" || this.state === "stopping") options.onPcm(data);
        } else if (data.flushed) this.flushDone?.();
      };
      source.connect(tap);
      this.tap = tap;
    } catch (error) {
      if (generation === this.generation) {
        console.warn("Voice Scribe: PCM tap or level meter unavailable", error);
        options?.onUnavailable?.();
      }
    } finally {
      if (generation !== this.generation && context && context.state !== "closed") void context.close();
    }
  }

  private flushTap(): Promise<void> {
    const tap = this.tap;
    if (!tap) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(finish, 350);
      const recorder = this;
      function finish(): void {
        clearTimeout(timer);
        recorder.flushDone = null;
        resolve();
      }
      this.flushDone = finish;
      tap.port.postMessage("flush");
    });
  }

  private release(): void {
    this.flushDone?.();
    this.tap?.port.close();
    this.tap?.disconnect();
    this.analyser?.disconnect();
    if (this.context && this.context.state !== "closed") void this.context.close();
    this.stream?.getTracks().forEach(track => track.stop());
    this.tap = null;
    this.analyser = null;
    this.context = null;
    this.stream = null;
  }
}
