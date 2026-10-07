export type UpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  message: string;
  version?: string;
  percent?: number;
}
