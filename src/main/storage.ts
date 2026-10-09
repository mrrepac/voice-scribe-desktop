import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings, type HistoryItem } from '../shared/contracts';
import { normalizeSegments } from '../shared/transcript';
import { upsertReplacement, type RememberedCorrection } from '../shared/corrections';
import { isHotkey } from '../shared/hotkeys';
import { validateProfiles } from '../shared/profiles';

const audioPathOf = (value: unknown) => typeof value === 'string' && value.length <= 1000 && path.isAbsolute(value) ? { audioPath: value } : {};

function transcriptDetails(value: unknown): Pick<HistoryItem, 'segments'|'name'> {
  if (!value || typeof value !== 'object') return {};
  const raw=value as Record<string,unknown>;
  const segments=normalizeSegments(raw.segments);
  const name=typeof raw.name==='string' ? raw.name.slice(0,300) : '';
  return { ...(segments.length ? {segments} : {}), ...(name ? {name} : {}) };
}

export function validateSettings(raw: unknown): Settings {
  const v = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const s = {...DEFAULT_SETTINGS};
  if (typeof v.llmEnabled === 'boolean') s.llmEnabled = v.llmEnabled;
  if (typeof v.llmBaseUrl === 'string') s.llmBaseUrl = v.llmBaseUrl.trim().slice(0,2000);
  if (typeof v.llmModel === 'string') s.llmModel = v.llmModel.trim().slice(0,300);
  if (['auto','tiny','base','small','turbo','turbo-hq','gigaam'].includes(String(v.model))) s.model = v.model as Settings['model'];
  if (['auto','wasm','webgpu'].includes(String(v.device))) s.device = v.device as Settings['device'];
  for (const k of ['language','language2','microphone','replacements'] as const) if (typeof v[k] === 'string') s[k] = v[k].slice(0, k === 'replacements' ? 50000 : 300);
  for (const k of ['voiceCommands','live','sounds','warmup','startAtLogin','diarization','restoreClipboard'] as const) if (typeof v[k] === 'boolean') s[k] = v[k];
  if (typeof v.silenceSeconds === 'number' && Number.isFinite(v.silenceSeconds)) s.silenceSeconds = v.silenceSeconds === 0 ? 0 : Math.min(8, Math.max(2,v.silenceSeconds));
  if (isHotkey(v.hotkey)) s.hotkey = v.hotkey;
  if (typeof v.historyLimit === 'number' && Number.isInteger(v.historyLimit)) s.historyLimit = Math.min(5000,Math.max(100,v.historyLimit));
  s.profiles = validateProfiles(v.profiles);
  return s;
}
export function cacheFilename(key: string): string {
  const u = new URL(key);
  if (u.protocol !== 'https:' || u.hostname !== 'huggingface.co' || u.search || u.hash || !/^\/onnx-community\/whisper-(tiny|base|small|large-v3-turbo)\/resolve\/(main|[0-9a-f]{40})\/[a-zA-Z0-9_./-]+$/.test(u.pathname)) throw new Error('Invalid model cache key');
  return key.replace(/^https?:\/\//,'').replace(/[^a-zA-Z0-9._-]+/g,'_');
}
export class Storage {
  private queue: Promise<unknown> = Promise.resolve();
  private reads = new Map<string, Promise<unknown>>();
  // Last validated on-disk text per document, reused as the next backup without re-reading.
  private known = new Map<string, string>();
  constructor(readonly root: string, private legacyModels?: string, private recovered: (message: string) => void = () => {}) {}
  async settings(): Promise<Settings> { return validateSettings(await this.read('settings.json', {})); }
  async saveSettings(value: unknown): Promise<Settings> { const s=validateSettings(value); await this.write('settings.json',s); return s; }
  async rememberCorrection(from: string, to: string): Promise<RememberedCorrection> {
    let correction: RememberedCorrection | undefined;
    await this.serial(async()=>{
      const settings=await this.settings();
      correction=upsertReplacement(settings.replacements,from,to);
      await this.atomic('settings.json',{...settings,replacements:correction.replacements});
    });
    return correction!;
  }
  async history(): Promise<HistoryItem[]> {
    const data=await this.read('history.json',[]);
    return Array.isArray(data) ? data.filter((x):x is HistoryItem=> !!x && typeof x.text==='string' && typeof x.id==='string' && typeof x.createdAt==='string').map(x=>({id:x.id,text:x.text,createdAt:x.createdAt,source:x.source==='file'?'file':'dictation',...(x.pinned===true?{pinned:true}:{}),...(x.source==='file'?{...transcriptDetails(x),...audioPathOf(x.audioPath)}:{})})) : [];
  }
  /** audioPath comes from the main process (an import's source), never from renderer details. */
  async addHistory(text: string, source: 'dictation'|'file', details?: unknown, audioPath?: string): Promise<HistoryItem> {
    const item: HistoryItem={id:randomUUID(),text,source,createdAt:new Date().toISOString(),...(source==='file'?{...transcriptDetails(details),...audioPathOf(audioPath)}:{})};
    await this.serial(async()=> {
      const old=await this.history();const {historyLimit}=await this.settings();
      let ordinary=0;
      await this.atomic('history.json',[item,...old].filter(entry=>entry.pinned || ++ordinary<=historyLimit));
    });
    return item;
  }
  clearHistory(keepPinned=false): Promise<void> { return this.serial(async () => {
    await mkdir(this.root,{recursive:true});
    const items=await this.history();
    const retained=keepPinned ? items.filter(item=>item.pinned) : [];
    // An explicitly cleared history must not reappear during recovery.
    await this.replace('history.json.bak', JSON.stringify(retained,null,2));
    await this.replace('history.json', JSON.stringify(retained,null,2));
  }); }
  pinHistory(id:string,pinned:boolean):Promise<void> {return this.serial(async()=>{
    const items=await this.history();const item=items.find(item=>item.id===id);
    if(!item)throw new Error('Запись больше не найдена в истории');
    if(pinned)item.pinned=true;else delete item.pinned;
    await this.atomic('history.json',items);
  });}
  async updateHistory(id: string, text: string, details?: unknown): Promise<HistoryItem> {
    let updated: HistoryItem | undefined;
    await this.serial(async()=>{
      const items=await this.history();
      const index=items.findIndex(item=>item.id===id);
      if(index<0)throw new Error('Запись больше не найдена в истории');
      const old=items[index];
      updated={id:old.id,createdAt:old.createdAt,source:old.source,text,...(old.pinned?{pinned:true}:{}),...(old.source==='file'?{...transcriptDetails(details),...audioPathOf(old.audioPath)}:{})};
      items[index]=updated;
      await this.atomic('history.json',items);
    });
    return updated!;
  }
  /** Model files are streamed to the worker from disk instead of being copied through IPC. */
  async cacheFile(key: string): Promise<{file: string; size: number}|null> {
    const name=cacheFilename(key);
    for(const root of [path.join(this.root,'models'),this.legacyModels]) {
      if(!root)continue;
      const file=path.join(root,name);
      try{const {size}=await stat(file);if(size>0)return {file,size};}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    }
    return null;
  }
  async cacheHas(key: string):Promise<boolean> { return (await this.cacheFile(key))!==null; }
  async cachePut(key: string,data: ArrayBuffer):Promise<void> {
    const name=cacheFilename(key);
    const dir=path.join(this.root,'models'); await mkdir(dir,{recursive:true});
    const temp=path.join(dir,`${name}.${randomUUID()}.tmp`);
    await writeFile(temp,Buffer.from(data)); await rename(temp,path.join(dir,name));
  }
  private async read(name:string,fallback:unknown):Promise<unknown> {
    const pending = this.reads.get(name);
    if (pending) return pending;
    const run = this.readRecovering(name, fallback);
    this.reads.set(name, run);
    try { return await run; } finally { this.reads.delete(name); }
  }
  private parse(name: string, text: string): unknown {
    const value: unknown = JSON.parse(text);
    if (name === 'history.json' ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Invalid storage document');
    if (name === 'history.json' && (value as unknown[]).some(item=>!item || typeof item!=='object' || typeof (item as HistoryItem).id!=='string' || typeof (item as HistoryItem).text!=='string' || typeof (item as HistoryItem).createdAt!=='string')) throw new SyntaxError('Invalid history entry');
    return value;
  }
  private async readRecovering(name: string, fallback: unknown): Promise<unknown> {
    let original: string | undefined;
    try {
      original = await readFile(path.join(this.root, name), 'utf8');
      const value = this.parse(name, original);
      this.known.set(name, original);
      return value;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let backup: string;
    let value: unknown;
    try {
      backup = await readFile(path.join(this.root, name + '.bak'), 'utf8');
      value = this.parse(name, backup);
    } catch (error) {
      if (original === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw new Error(`Не удалось восстановить ${name}. Исходные файлы сохранены в ${this.root}. Сохранение остановлено, чтобы не потерять данные.`);
    }
    if (original !== undefined) await writeFile(path.join(this.root, `${name}.${randomUUID()}.corrupt`), original, 'utf8');
    await this.replace(name, backup);
    this.recovered(`${name} восстановлен из резервной копии. Последние изменения могли не сохраниться. Повреждённый оригинал, если он был, сохранён в ${this.root}.`);
    return value;
  }
  private serial<T>(run:()=>Promise<T>):Promise<T> { const next=this.queue.then(run,run); this.queue=next.catch(()=>{}); return next; }
  private write(name:string,value:unknown):Promise<void> { return this.serial(()=>this.atomic(name,value)); }
  private async atomic(name:string,value:unknown):Promise<void> {
    await mkdir(this.root,{recursive:true});
    const previous = this.known.get(name) ?? this.serialize(name, await this.read(name, value));
    await this.replace(name + '.bak', previous);
    await this.replace(name, this.serialize(name, value));
  }
  // History can hold many long transcripts; indentation alone adds megabytes to every save.
  private serialize(name: string, value: unknown): string {
    return name === 'history.json' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }
  private async replace(name: string, text: string): Promise<void> {
    const file = path.join(this.root, name);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
    this.known.set(name, text);
  }
}
