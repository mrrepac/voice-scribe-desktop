import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, stat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { quietCut, WINDOW_SECONDS } from '../shared/quiet-cut';
export { quietCut };

const RATE = 16000;
export const MAX_AUDIO_SECONDS = 7200;
/** One recognition window: each chunk is decoded in a single pass, without overlapping strides. */
export const AUDIO_CHUNK_SECONDS = WINDOW_SECONDS;
export interface AudioFile { id: string; name: string; }
type Entry = { source: string; preparing?: boolean; directory?: string; pcm?: string; samples?: number };

/** Disk-backed decoding: the renderer receives at most one Whisper window of mono PCM. */
export class AudioImport {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, ChildProcess>();
  constructor(private executable: string, private temporaryRoot: string) {}
  async cleanupAbandoned(): Promise<void> {
    await mkdir(this.temporaryRoot,{recursive:true});
    for (const entry of await readdir(this.temporaryRoot,{withFileTypes:true})) {
      if (entry.isDirectory() && /^import-[a-zA-Z0-9]+$/.test(entry.name)) await rm(path.join(this.temporaryRoot,entry.name),{recursive:true,force:true});
    }
  }

  async select(source: string): Promise<AudioFile> {
    if (!path.isAbsolute(source) || !/\.(wav|mp3|m4a|ogg|flac|webm|mp4|aac|mov|mkv|avi|m4v|opus)$/i.test(source)) throw new Error('Выберите аудио или видео');
    const info = await stat(source);
    if (!info.isFile() || info.size > 250 * 1024 * 1024) throw new Error('Файл больше 250 МБ или недоступен. Разделите запись на части.');
    if (this.entries.size >= 4) throw new Error('Завершите текущий импорт');
    const id = randomUUID();
    this.entries.set(id, { source });
    return { id, name: path.basename(source) };
  }

  async prepare(id: string): Promise<{ samples: number; duration: number }> {
    const entry = this.get(id);
    if (entry.preparing) throw new Error('Аудиофайл уже обрабатывается');
    entry.preparing = true;
    await mkdir(this.temporaryRoot, { recursive: true });
    const directory = await mkdtemp(path.join(this.temporaryRoot, 'import-'));
    if (this.entries.get(id) !== entry) { await rm(directory,{recursive:true,force:true}); throw new Error('Импорт отменён'); }
    entry.directory = directory;
    entry.pcm = path.join(directory, 'audio.f32');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', entry.source,
          '-map', '0:a:0', '-vn', '-t', String(MAX_AUDIO_SECONDS + 1), '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', '-y', entry.pcm!],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        this.jobs.set(id, child);
        let diagnostic = '';
        child.stderr?.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-4000); });
        const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
        child.once('error', error => { clearTimeout(timer); this.jobs.delete(id); reject(error); });
        child.once('close', code => {
          clearTimeout(timer); this.jobs.delete(id);
          if (this.entries.get(id) !== entry) reject(new Error('Импорт отменён'));
          else if (code !== 0) reject(new Error(diagnostic.includes('No space left') ? 'Недостаточно места для временного аудиофайла' : 'Не удалось прочитать звуковую дорожку. Проверьте файл или попробуйте WAV.'));
          else resolve();
        });
      });
      entry.samples = Math.floor((await stat(entry.pcm)).size / 4);
      if (!entry.samples) throw new Error('Звуковая дорожка пуста');
      if (entry.samples > MAX_AUDIO_SECONDS * RATE) throw new Error('Запись длиннее двух часов. Разделите её на части.');
      return { samples: entry.samples, duration: entry.samples / RATE };
    } catch (error) { await this.release(id); throw error; }
  }

  async chunk(id: string, offset: number): Promise<Float32Array> {
    const entry = this.get(id);
    if (!entry.pcm || !entry.samples || !Number.isInteger(offset) || offset < 0 || offset >= entry.samples) throw new Error('Некорректный фрагмент аудио');
    const count = Math.min(AUDIO_CHUNK_SECONDS * RATE, entry.samples - offset);
    const pcm = new Float32Array(count);
    const file = await open(entry.pcm, 'r');
    try {
      let read = 0;
      const bytes = new Uint8Array(pcm.buffer);
      while (read < bytes.length) {
        const next = await file.read(bytes, read, bytes.length - read, offset * 4 + read);
        if (!next.bytesRead) throw new Error('Временный аудиофайл прочитан не полностью');
        read += next.bytesRead;
      }
    } finally { await file.close(); }
    return offset + count < entry.samples ? pcm.slice(0, quietCut(pcm)) : pcm;
  }

  pcmPath(id: string): string {
    const entry = this.get(id);
    if (!entry.samples || !entry.pcm) throw new Error('Аудиофайл ещё не подготовлен');
    return entry.pcm;
  }

  async release(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    const child = this.jobs.get(id);
    if (child) await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); });
    if (entry?.directory) await rm(entry.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  async cancelAll(): Promise<void> { await Promise.all([...this.entries.keys()].map(id => this.release(id))); }
  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Импорт уже завершён или отменён');
    return entry;
  }
}

