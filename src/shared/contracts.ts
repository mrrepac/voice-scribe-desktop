import type { TranscriptDetails, TranscriptSegment, SubtitleFormat } from './transcript';
import type { SpeakerTurn, SpeakerProgress } from './speakers';
import type { RememberedCorrection } from './corrections';
export type Model = 'auto' | 'tiny' | 'base' | 'small' | 'turbo';
export type Device = 'auto' | 'wasm' | 'webgpu';
export interface Settings {
  llmEnabled: boolean; llmBaseUrl: string; llmModel: string;
  model: Model; device: Device; language: string; language2: string;
  microphone: string; voiceCommands: boolean; replacements: string;
  silenceSeconds: number; live: boolean; sounds: boolean; warmup: boolean;
  startAtLogin: boolean; diarization: boolean;
  historyLimit: number;
}
export const DEFAULT_SETTINGS: Settings = {
  llmEnabled: false, llmBaseUrl: 'https://api.openai.com/v1', llmModel: '',
  model: 'auto', device: 'auto', language: 'ru', language2: '', microphone: '',
  voiceCommands: false, replacements: '', silenceSeconds: 0, live: false,
  sounds: true, warmup: false, startAtLogin: false, diarization: true,
  historyLimit: 100,
};
export interface HistoryItem extends TranscriptDetails { id: string; text: string; createdAt: string; source: 'dictation' | 'file'; pinned?: boolean; }
export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'preparing' | 'error';
export interface Status { phase: Phase; message: string; seconds?: number; level?: number; progress?: number; remainingSeconds?: number; }
export type Command =
  | { action: 'dictation-down'; target: string }
  | { action: 'dictation-up'; heldMs: number }
  | { action: 'toggle'; target?: string }
  | { action: 'cancel' | 'finish-enter' | 'show-history' }
  | { action: 'proofread'; mode?: import('./proofread').ProofreadMode }
  | { action: 'paste-last'; target: string }
  | { action: 'bridge-error'; message: string };
export interface Delivery { status: 'inserted' | 'clipboard-only'; reason?: string; entered?: boolean; }
export interface ScribeAPI {
  getUpdateState(): Promise<import('./updates').UpdateState>;
  checkForUpdates(): Promise<import('./updates').UpdateState>;
  downloadUpdate(): Promise<import('./updates').UpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(handler: (state: import('./updates').UpdateState) => void): () => void;
  listModels(): Promise<string[]>;
  proofread(text: string, mode?: import('./proofread').ProofreadMode): Promise<import('./proofread').ProofreadResult>;
  proofreadBatch(batch: import('./proofread-batch').ProofreadBatch): Promise<import('./proofread-batch').ProofreadCueResult[]>;
  cancelProofread(): Promise<void>;
  saveApiKey(key: string): Promise<void>;
  hasApiKey(): Promise<boolean>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  rememberCorrection(from: string, to: string): Promise<RememberedCorrection>;
  getHistory(): Promise<HistoryItem[]>;
  addHistory(text: string, source: 'dictation' | 'file', details?: TranscriptDetails): Promise<HistoryItem>;
  updateHistory(id: string, text: string, details?: TranscriptDetails): Promise<HistoryItem>;
  clearHistory(keepPinned?: boolean): Promise<void>;
  pinHistory(id: string, pinned: boolean): Promise<void>;
  exportHistory(): Promise<boolean>;
  deliver(text: string, target: string | null, enter: boolean): Promise<Delivery>;
  copy(text: string): Promise<void>;
  saveText(text: string): Promise<boolean>;
  saveSubtitles(segments: TranscriptSegment[], format: SubtitleFormat, name?: string): Promise<boolean>;
  diarize(pcm: Float32Array, speakerCount?: number): Promise<SpeakerTurn[]>;
  cancelDiarization(): Promise<void>;
  onDiarizationProgress(handler: (progress: SpeakerProgress) => void): () => void;
  pickAudio(): Promise<import('../main/audio-import').AudioFile | null>;
  droppedAudio(file: File): Promise<import('../main/audio-import').AudioFile>;
  prepareAudio(id: string): Promise<{samples: number; duration: number}>;
  audioChunk(id: string, offset: number, limit?: number): Promise<Float32Array>;
  releaseAudio(id: string): Promise<void>;
  cancelAudio(): Promise<void>;
  diarizeAudio(id: string, speakerCount?: number): Promise<SpeakerTurn[]>;
  status(value: Status): void;
  hide(): void;
  onCommand(handler: (command: Command) => void): () => void;
  cacheGet(key: string): Promise<ArrayBuffer | null>;
  cacheHas(key: string): Promise<boolean>;
  cachePut(key: string, data: ArrayBuffer): Promise<void>;
  getAppInfo(): Promise<{version: string; dataPath: string; nativeReady: boolean}>;
  getNativeHealth(): Promise<import('../main/native-recovery').NativeHealth>;
  restartNative(): Promise<void>;
  onNativeHealth(handler: (state: import('../main/native-recovery').NativeHealth)=>void): () => void;
}
declare global { interface Window { scribe: ScribeAPI; } }
