import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../shared/contracts';
import { isHotkey } from '../shared/hotkeys';

export function validateSettings(raw: unknown): Settings {
  const v = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const s = {...DEFAULT_SETTINGS};
  if (typeof v.microphone === 'string') s.microphone = v.microphone.slice(0, 300);
  for (const k of ['sounds','startAtLogin'] as const) if (typeof v[k] === 'boolean') s[k] = v[k];
  if (typeof v.silenceSeconds === 'number' && Number.isFinite(v.silenceSeconds)) s.silenceSeconds = v.silenceSeconds === 0 ? 0 : Math.min(8, Math.max(2,v.silenceSeconds));
  if (isHotkey(v.hotkey)) s.hotkey = v.hotkey;
  return s;
}
/** Settings are the only document; a backup copy recovers it after a crash mid-write. */
export class Storage {
  private queue: Promise<unknown> = Promise.resolve();
  private reading: Promise<unknown> | null = null;
  // Last validated on-disk text, reused as the next backup without re-reading.
  private known: string | undefined;
  constructor(readonly root: string, private recovered: (message: string) => void = () => {}) {}
  async settings(): Promise<Settings> { return validateSettings(await this.read()); }
  saveSettings(value: unknown): Promise<Settings> {
    const s=validateSettings(value);
    return this.serial(()=>this.atomic(s)).then(()=>s);
  }
  private async read(): Promise<unknown> {
    if (this.reading) return this.reading;
    this.reading = this.readRecovering();
    try { return await this.reading; } finally { this.reading = null; }
  }
  private parse(text: string): unknown {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Invalid storage document');
    return value;
  }
  private async readRecovering(): Promise<unknown> {
    const name = 'settings.json';
    let original: string | undefined;
    try {
      original = await readFile(path.join(this.root, name), 'utf8');
      const value = this.parse(original);
      this.known = original;
      return value;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let backup: string;
    let value: unknown;
    try {
      backup = await readFile(path.join(this.root, name + '.bak'), 'utf8');
      value = this.parse(backup);
    } catch (error) {
      if (original === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`Не удалось восстановить ${name}. Исходные файлы сохранены в ${this.root}. Сохранение остановлено, чтобы не потерять данные.`);
    }
    if (original !== undefined) await writeFile(path.join(this.root, `${name}.${randomUUID()}.corrupt`), original, 'utf8');
    await this.replace(name, backup);
    this.known = backup;
    this.recovered(`${name} восстановлен из резервной копии. Последние изменения могли не сохраниться. Повреждённый оригинал, если он был, сохранён в ${this.root}.`);
    return value;
  }
  private serial<T>(run:()=>Promise<T>):Promise<T> { const next=this.queue.then(run,run); this.queue=next.catch(()=>{}); return next; }
  private async atomic(value:Settings):Promise<void> {
    await mkdir(this.root,{recursive:true});
    const previous = this.known ?? JSON.stringify(await this.read(), null, 2);
    const next = JSON.stringify(value, null, 2);
    await this.replace('settings.json.bak', previous);
    await this.replace('settings.json', next);
    this.known = next;
  }
  private async replace(name: string, text: string): Promise<void> {
    const file = path.join(this.root, name);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, text, 'utf8');
    // Antivirus and indexing services briefly lock files on Windows; retry before failing.
    for (let attempt = 1; ; attempt++) {
      try { await rename(temp, file); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50 * attempt));
      }
    }
  }
}
