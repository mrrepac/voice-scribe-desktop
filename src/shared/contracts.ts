import type { Hotkey } from './hotkeys';
export interface Settings {
  microphone: string; silenceSeconds: number; sounds: boolean;
  startAtLogin: boolean; hotkey: Hotkey;
}
export const DEFAULT_SETTINGS: Settings = {
  microphone: '', silenceSeconds: 0, sounds: true, startAtLogin: false, hotkey: 'ctrl-space',
};
/** 'file': an audio or video file is transcribed in the window; no dictation keys are involved. */
export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'preparing' | 'file' | 'error';
export interface Status {
  phase: Phase; message: string; seconds?: number; level?: number; progress?: number;
  /** The dictation will be inserted into a window (not only copied to the clipboard). */
  targeted?: boolean;
}
export type Command =
  | { action: 'dictation-down'; target: string }
  | { action: 'dictation-up'; heldMs: number }
  | { action: 'dictation-abort' }
  | { action: 'toggle'; target?: string }
  | { action: 'cancel' | 'finish-enter' }
  /** The dictation shortcut plus Shift: finishes a running dictation. */
  | { action: 'finish' }
  | { action: 'paste-last'; target: string }
  | { action: 'bridge-error'; message: string };
export interface Delivery { status: 'inserted' | 'clipboard-only'; reason?: string; entered?: boolean; }
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
  /** Asks where to save the text as UTF-8; the chosen file name, or null when cancelled. */
  saveText(text: string, name: string): Promise<string | null>;
  prepareGigaam(): Promise<void>;
  recognizeGigaam(pcm: Float32Array, timed: boolean): Promise<import('./transcript').Transcript>;
  cancelGigaam(): Promise<void>;
  onGigaamProgress(handler: (progress: import('./gigaam').GigaamProgress) => void): () => void;
  status(value: Status): void;
  hide(): void;
  onCommand(handler: (command: Command) => void): () => void;
  getAppInfo(): Promise<{version: string; dataPath: string; nativeReady: boolean; modelBundled: boolean}>;
  /** Records the next key press system-wide; null when cancelled with Esc or timed out. */
  captureHotkey(): Promise<import('./hotkeys').CapturedKey | null>;
  cancelHotkeyCapture(): Promise<void>;
  getNativeHealth(): Promise<import('../main/native-recovery').NativeHealth>;
  restartNative(): Promise<void>;
  onNativeHealth(handler: (state: import('../main/native-recovery').NativeHealth)=>void): () => void;
}
declare global { interface Window { scribe: ScribeAPI; } }
