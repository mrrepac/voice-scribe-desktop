/** Keeps press-to-talk and tap-to-toggle separate, including microphone startup. */
export class DictationGesture {
  private pressed = false;
  private startedSession: number | null = null;

  down(phase: string, session: number): 'start' | 'stop' | 'none' {
    if (this.pressed) return 'none';
    this.pressed = true;
    if (phase === 'idle' || phase === 'error') {
      this.startedSession = session;
      return 'start';
    }
    this.startedSession = null;
    return phase === 'recording' || phase === 'starting' ? 'stop' : 'none';
  }

  up(heldMs: number, session: number): boolean {
    const stop = this.pressed && this.startedSession === session && heldMs >= 350;
    this.pressed = false;
    this.startedSession = null;
    return stop;
  }

  /** The press turned out to be another shortcut; true if it had started this session. */
  abort(session: number): boolean {
    const started = this.pressed && this.startedSession === session;
    this.reset();
    return started;
  }

  reset(): void { this.pressed = false; this.startedSession = null; }
}
