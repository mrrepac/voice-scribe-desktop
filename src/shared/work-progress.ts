/** Estimates only the current stage, using observed completed work. */
export class WorkProgress {
  private started = 0;
  private sampled = 0;
  private estimate?: number;
  percent?: number;

  reset(now: number): void {
    this.started = now;
    this.sampled = now;
    this.percent = undefined;
    this.estimate = undefined;
  }

  update(percent: number | undefined, now: number): void {
    if (percent === undefined || !Number.isFinite(percent)) return;
    const next = Math.max(0, Math.min(99, percent));
    if (this.percent !== undefined && next <= this.percent) return;
    this.percent = next;
    const elapsed = (now - this.started) / 1000;
    if (next > 0 && elapsed >= 5) {
      this.estimate = elapsed * (100 - next) / next;
      this.sampled = now;
    }
  }

  remaining(now: number): number | undefined {
    if (this.estimate === undefined) return undefined;
    const left = this.estimate - (now - this.sampled) / 1000;
    // A slow fragment must not leave a misleading zero-second countdown.
    return left > 0 ? Math.ceil(left) : undefined;
  }
}
