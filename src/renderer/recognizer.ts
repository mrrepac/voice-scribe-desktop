import { AsrClient, type LoadedInfo, type ModelOptions, type ProgressFn, type TranscribeOptions } from '../asr/client';
import { trimSilence } from '../shared/clean';
import type { ScribeAPI, Settings } from '../shared/contracts';
import type { Transcript } from '../shared/transcript';
import { effectiveModel } from '../shared/models';

/** autoGigaam: false keeps "Авто" on Whisper even for Russian (to compare with GigaAM). */
export interface RecognizerOptions extends Pick<Settings, 'model' | 'device' | 'language' | 'language2'> { segment?: boolean; autoGigaam?: boolean }
export interface EngineInfo extends Omit<LoadedInfo, 'model'> { model: Settings['model'] }
type GigaamBridge = Pick<ScribeAPI, 'prepareGigaam' | 'recognizeGigaam' | 'cancelGigaam' | 'onGigaamProgress'>;

const resolve = (options: RecognizerOptions): RecognizerOptions => options.autoGigaam === false ? options : { ...options, model: effectiveModel(options) };

const GIGAAM_INFO: EngineInfo = { model: 'gigaam', device: 'wasm', f16: false, fellBack: false };

/**
 * One recognition API for the interface: Whisper in a browser worker, or GigaAM
 * (Russian only, language settings are ignored) in a Node process behind IPC.
 */
export class Recognizer {
  private progress: ProgressFn | null = null;
  constructor(private api: GigaamBridge, private whisper = new AsrClient()) {
    api.onGigaamProgress(({ pct }) => this.progress?.({ stage: 'model', pct, dl: true }));
  }

  prepare(options: RecognizerOptions, progress: ProgressFn = () => {}): Promise<EngineInfo> {
    options = resolve(options);
    if (options.model !== 'gigaam') return this.whisper.prepare(options as ModelOptions, progress);
    this.progress = progress;
    progress({ stage: 'model' });
    return this.api.prepareGigaam().then(() => GIGAAM_INFO);
  }

  transcribe(pcm: Float32Array, options: RecognizerOptions, progress: ProgressFn = () => {}): Promise<string> {
    options = resolve(options);
    if (options.model !== 'gigaam') return this.whisper.transcribe(pcm, options as TranscribeOptions, progress);
    return this.gigaam(pcm, false, progress).then(result => result.text);
  }

  /** Timings refer to the original PCM, including any leading silence. */
  transcribeTimed(pcm: Float32Array, options: RecognizerOptions, progress: ProgressFn = () => {}): Promise<Transcript> {
    options = resolve(options);
    if (options.model !== 'gigaam') return this.whisper.transcribeTimed(pcm, options as TranscribeOptions, progress);
    return this.gigaam(pcm, true, progress);
  }

  cancel(): void {
    this.whisper.cancel();
    void this.api.cancelGigaam().catch(() => {});
  }

  destroy(): void {
    this.whisper.destroy();
    void this.api.cancelGigaam().catch(() => {});
  }

  private async gigaam(pcm: Float32Array, timed: boolean, progress: ProgressFn): Promise<Transcript> {
    // Same rule as Whisper: silence never reaches the model.
    if (!trimSilence(pcm)) return { text: '', segments: [] };
    this.progress = progress;
    progress({ stage: 'run' });
    return this.api.recognizeGigaam(pcm, timed);
  }
}
