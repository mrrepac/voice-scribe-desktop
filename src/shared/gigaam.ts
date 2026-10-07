import type { Transcript } from './transcript';

/** Messages between the main process and the GigaAM worker process. */
export type GigaamRequest =
  | { type: 'prepare'; id: number; modelDirectory: string }
  | { type: 'recognize'; id: number; modelDirectory: string; pcm: Float32Array; timed: boolean };

export type GigaamReply =
  | { type: 'progress'; id: number; pct: number }
  | { type: 'ready'; id: number }
  | { type: 'result'; id: number; transcript: Transcript }
  | { type: 'error'; id: number; message: string };

/** Download progress forwarded to the renderer while the model is fetched. */
export interface GigaamProgress { pct: number }
