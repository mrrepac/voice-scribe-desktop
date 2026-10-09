import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const LIMIT = 1024 * 1024;

/**
 * Installed builds have no console, so warnings and errors are mirrored into
 * logs/main.log. At 1 MB the file becomes main.old.log and a new one starts.
 * Callers log failures and diagnostics only, never transcripts or API keys.
 */
export class Log {
  readonly file: string;
  private size = 0;
  constructor(readonly directory: string) {
    this.file = path.join(directory, 'main.log');
    try { mkdirSync(directory, { recursive: true }); this.size = statSync(this.file).size; } catch {}
  }
  write(level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]): void {
    try {
      const line = `${new Date().toISOString()} ${level} ${format(...args).replace(/\r?\n/g, '\n    ')}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.size && this.size + bytes > LIMIT) { renameSync(this.file, path.join(this.directory, 'main.old.log')); this.size = 0; }
      appendFileSync(this.file, line);
      this.size += bytes;
    } catch {
      // Logging must never break dictation; a locked or full disk only loses the line.
    }
  }
  /** Keeps console output and also records console.warn/console.error and uncaught exceptions. */
  captureConsole(): void {
    for (const [method, level] of [['warn', 'WARN'], ['error', 'ERROR']] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => { original(...args); this.write(level, ...args); };
    }
    process.on('uncaughtExceptionMonitor', (error, origin) => this.write('ERROR', origin, error));
  }
}
