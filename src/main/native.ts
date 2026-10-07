import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class NativeBridge extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  ready = false;

  start(exe: string): void {
    this.stop();
    const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    this.startupTimer = setTimeout(() => {
      this.fail(new Error('Служба горячих клавиш не запустилась. Перезапустите Voice Scribe.'), child);
    }, 7000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (this.process !== child) return;
      let msg: any;
      try { msg = JSON.parse(line); }
      catch {
        this.fail(new Error('Не удалось прочитать ответ службы горячих клавиш.'), child);
        return;
      }
      if (!msg || typeof msg !== 'object') {
        this.fail(new Error('Некорректный ответ службы горячих клавиш.'), child);
        return;
      }
      if (typeof msg.id === 'number') {
        const request = this.pending.get(msg.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(msg.id);
          if (msg.ok) request.resolve(msg);
          else request.reject(new Error(msg.error || 'Native helper error'));
        }
      } else if (msg.event === 'ready') {
        if (msg.protocol !== 1) {
          this.fail(new Error('Несовместимая версия службы горячих клавиш.'), child);
          return;
        }
        this.clearStartupTimer();
        this.ready = true;
        this.emit('ready');
      } else if (msg.event === 'hotkey') {
        this.emit('hotkey', msg);
      } else if (msg.event === 'error') {
        this.fail(new Error(msg.message || msg.error || 'Windows helper error'), child);
      }
    });
    // A failed write also emits a stream error, separately from the child error.
    child.stdin.on('error', error => this.fail(error, child));
    child.stdout.on('error', error => this.fail(error, child));
    child.stderr.on('error', error => this.fail(error, child));
    child.stderr.on('data', data => console.error('[native]', String(data)));
    child.on('error', error => this.fail(error, child));
    child.on('exit', () => {
      lines.close();
      this.fail(new Error('Служба горячих клавиш остановилась. Перезапустите Voice Scribe.'), child);
    });
  }

  request(command: string, args: Record<string, unknown> = {}): Promise<any> {
    const child = this.process;
    if (!child || !this.ready || child.stdin.destroyed) {
      return Promise.reject(new Error('Служба горячих клавиш пока недоступна.'));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A wedged helper must not continue intercepting global shortcuts.
        this.fail(new Error('Windows helper timeout'), child);
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ ...args, id, command }) + '\n', error => {
          if (error) this.fail(error, child);
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)), child);
      }
    });
  }

  stop(): void {
    const child = this.process;
    // Detach first so the expected error/exit callbacks cannot emit failures.
    this.process = null;
    this.ready = false;
    this.clearStartupTimer();
    this.rejectPending(new Error('Windows helper stopped'));
    child?.kill();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    this.process = null;
    this.ready = false;
    this.clearStartupTimer();
    this.rejectPending(error);
    child.kill();
    this.emit('failure', error.message);
  }
}
