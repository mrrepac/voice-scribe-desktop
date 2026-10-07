import { fork, type ChildProcess } from 'node:child_process';
import type { Transcript } from '../shared/transcript';
import type { GigaamProgress, GigaamReply, GigaamRequest } from '../shared/gigaam';

interface Pending {
  resolve(value: Transcript | null): void;
  reject(error: Error): void;
  progress(value: GigaamProgress): void;
}
type Request = { type: 'prepare' } | { type: 'recognize'; pcm: Float32Array; timed: boolean };

/**
 * GigaAM runs in a long-lived Node process: loading the model takes ~0.6 s, too
 * long to repeat for every dictation. Cancelling kills the process (decoding is
 * synchronous native code); the next request starts a fresh one.
 */
export class GigaamService {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  constructor(private script: string, private modelDirectory: string) {}

  prepare(progress: (value: GigaamProgress) => void): Promise<void> {
    return this.request({ type: 'prepare' }, progress).then(() => {});
  }

  recognize(pcm: Float32Array, timed: boolean, progress: (value: GigaamProgress) => void): Promise<Transcript> {
    if (!(pcm instanceof Float32Array) || pcm.length > 16000 * 7200) return Promise.reject(new Error('Некорректный фрагмент аудио'));
    return this.request({ type: 'recognize', pcm, timed }, progress) as Promise<Transcript>;
  }

  /** Stops current work and frees the model's memory. */
  cancel(): void { this.stop(new Error('Распознавание отменено')); }

  private request(body: Request, progress: (value: GigaamProgress) => void): Promise<Transcript | null> {
    const child = this.ensureChild();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      child.send({ ...body, id, modelDirectory: this.modelDirectory } satisfies GigaamRequest, error => {
        if (error && this.pending.delete(id)) reject(error);
      });
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    const child = fork(this.script, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    // Drain diagnostics without retaining audio/model data or unbounded logs.
    child.stderr?.on('data', () => {});
    child.on('error', error => { if (this.child === child) this.stop(error); });
    child.on('exit', () => { if (this.child === child) this.stop(new Error('Процесс GigaAM завершился. Повторите попытку.')); });
    child.on('message', (message: GigaamReply) => {
      if (this.child !== child) return;
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      if (message.type === 'progress') { pending.progress({ pct: message.pct }); return; }
      this.pending.delete(message.id);
      if (message.type === 'error') pending.reject(new Error(message.message));
      else pending.resolve(message.type === 'result' ? message.transcript : null);
    });
    return child;
  }

  private stop(error: Error): void {
    const child = this.child;
    this.child = null;
    child?.kill();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
