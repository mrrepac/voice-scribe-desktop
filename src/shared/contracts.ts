import type { Hotkey } from './hotkeys';
export interface Settings {
  microphone: string; voiceCommands: boolean; replacements: string;
  silenceSeconds: number; sounds: boolean; warmup: boolean;
  startAtLogin: boolean; hotkey: Hotkey; restoreClipboard: boolean;
  /** Bare Enter during a dictation finishes it and sends the text with Enter. */
  enterFinishes: boolean;
  /** Programs (one executable per line) where Enter is always pressed after insertion. */
  enterApps: string;
}
export const DEFAULT_SETTINGS: Settings = {
  microphone: '', voiceCommands: false, replacements: '', silenceSeconds: 0,
  sounds: true, warmup: false, startAtLogin: false, hotkey: 'ctrl-space', restoreClipboard: false,
  enterFinishes: true, enterApps: '',
};
export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'preparing' | 'error';
export interface Status { phase: Phase; message: string; seconds?: number; level?: number; progress?: number; remainingSeconds?: number; }
export type Command =
  | { action: 'dictation-down'; target: string }
  | { action: 'dictation-up'; heldMs: number }
  | { action: 'dictation-abort' }
  | { action: 'toggle'; target?: string }
  | { action: 'cancel' | 'finish-enter' }
  /** The dictation shortcut plus Shift. There is no proofreading: it only finishes a running dictation. */
  | { action: 'proofread' }
  | { action: 'paste-last'; target: string }
  | { action: 'bridge-error'; message: string };
export interface Delivery { status: 'inserted' | 'clipboard-only'; reason?: string; entered?: boolean; restored?: boolean; }
export interface ScribeAPI {
  getUpdateState(): Promise<import('./updates').UpdateState>;
  checkForUpdates(): Promise<import('./updates').UpdateState>;
  downloadUpdate(): Promise<import('./updates').UpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(handler: (state: import('./updates').UpdateState) => void): () => void;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  deliver(text: string, target: string | null, enter: boolean): Promise<Delivery>;
  copy(text: string): Promise<void>;
  prepareGigaam(): Promise<void>;
  recognizeGigaam(pcm: Float32Array, timed: boolean): Promise<import('./transcript').Transcript>;
  cancelGigaam(): Promise<void>;
  onGigaamProgress(handler: (progress: import('./gigaam').GigaamProgress) => void): () => void;
  status(value: Status): void;
  hide(): void;
  onCommand(handler: (command: Command) => void): () => void;
  /** Executable of the window a dictation targets; null when unknown. */
  windowProcess(target: string): Promise<string | null>;
  getAppInfo(): Promise<{version: string; dataPath: string; nativeReady: boolean; modelBundled: boolean}>;
  /** Records the next key press system-wide; null when cancelled with Esc or timed out. */
  captureHotkey(): Promise<import('./hotkeys').CapturedKey | null>;
  cancelHotkeyCapture(): Promise<void>;
  getNativeHealth(): Promise<import('../main/native-recovery').NativeHealth>;
  restartNative(): Promise<void>;
  onNativeHealth(handler: (state: import('../main/native-recovery').NativeHealth)=>void): () => void;
}
declare global { interface Window { scribe: ScribeAPI; } }
