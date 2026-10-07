import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings, type HistoryItem } from '../shared/contracts';
import { normalizeSegments } from '../shared/transcript';
import { upsertReplacement, type RememberedCorrection } from '../shared/corrections';

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
  if (['auto','tiny','base','small','turbo'].includes(String(v.model))) s.model = v.model as Settings['model'];
  if (['auto','wasm','webgpu'].includes(String(v.device))) s.device = v.device as Settings['device'];
  for (const k of ['language','language2','microphone','replacements'] as const) if (typeof v[k] === 'string') s[k] = v[k].slice(0, k === 'replacements' ? 50000 : 300);
  for (const k of ['voiceCommands','live','sounds','warmup','startAtLogin','diarization'] as const) if (typeof v[k] === 'boolean') s[k] = v[k];
  if (typeof v.silenceSeconds === 'number' && Number.isFinite(v.silenceSeconds)) s.silenceSeconds = v.silenceSeconds === 0 ? 0 : Math.min(8, Math.max(2,v.silenceSeconds));
  return s;
}
export function cacheFilename(key: string): string {
  const u = new URL(key);
  if (u.protocol !== 'https:' || u.hostname !== 'huggingface.co' || u.search || u.hash || !/^\/onnx-community\/whisper-(tiny|base|small|large-v3-turbo)\/resolve\/main\/[a-zA-Z0-9_./-]+$/.test(u.pathname)) throw new Error('Invalid model cache key');
  return key.replace(/^https?:\/\//,'').replace(/[^a-zA-Z0-9._-]+/g,'_');
}
export class Storage {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, private legacyModels?: string) {}
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
    return Array.isArray(data) ? data.filter((x):x is HistoryItem=> !!x && typeof x.text==='string' && typeof x.id==='string' && typeof x.createdAt==='string').slice(0,100).map(x=>({id:x.id,text:x.text,createdAt:x.createdAt,source:x.source==='file'?'file':'dictation',...(x.source==='file'?transcriptDetails(x):{})})) : [];
  }
  async addHistory(text: string, source: 'dictation'|'file', details?: unknown): Promise<HistoryItem> {
    const item: HistoryItem={id:randomUUID(),text,source,createdAt:new Date().toISOString(),...(source==='file'?transcriptDetails(details):{})};
    await this.serial(async()=> { const old=await this.history(); await this.atomic('history.json',[item,...old].slice(0,100)); });
    return item;
  }
  clearHistory(): Promise<void> { return this.write('history.json',[]); }
  async updateHistory(id: string, text: string, details?: unknown): Promise<HistoryItem> {
    let updated: HistoryItem | undefined;
    await this.serial(async()=>{
      const items=await this.history();
      const index=items.findIndex(item=>item.id===id);
      if(index<0)throw new Error('Запись больше не найдена в истории');
      const old=items[index];
      updated={id:old.id,createdAt:old.createdAt,source:old.source,text,...(old.source==='file'?transcriptDetails(details):{})};
      items[index]=updated;
      await this.atomic('history.json',items);
    });
    return updated!;
  }
  async cacheGet(key: string): Promise<Buffer|null> {
    const name=cacheFilename(key);
    for(const root of [path.join(this.root,'models'),this.legacyModels]) {
      if(!root) continue;
      try { const data=await readFile(path.join(root,name)); if(data.length) return data; } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    }
    return null;
  }
  async cacheHas(key: string):Promise<boolean> {
    const name=cacheFilename(key);
    for(const root of [path.join(this.root,'models'),this.legacyModels]) {
      if(!root)continue;
      try{if((await stat(path.join(root,name))).size>0)return true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    }
    return false;
  }
  async cachePut(key: string,data: ArrayBuffer):Promise<void> {
    const name=cacheFilename(key);
    const dir=path.join(this.root,'models'); await mkdir(dir,{recursive:true});
    const temp=path.join(dir,`${name}.${randomUUID()}.tmp`);
    await writeFile(temp,Buffer.from(data)); await rename(temp,path.join(dir,name));
  }
  private async read(name:string,fallback:unknown):Promise<unknown> {
    try { return JSON.parse(await readFile(path.join(this.root,name),'utf8')); }
    catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT' || e instanceof SyntaxError) return fallback; throw e; }
  }
  private serial<T>(run:()=>Promise<T>):Promise<T> { const next=this.queue.then(run,run); this.queue=next.catch(()=>{}); return next; }
  private write(name:string,value:unknown):Promise<void> { return this.serial(()=>this.atomic(name,value)); }
  private async atomic(name:string,value:unknown):Promise<void> {
    await mkdir(this.root,{recursive:true}); const file=path.join(this.root,name); const temp=`${file}.tmp`;
    await writeFile(temp,JSON.stringify(value,null,2),'utf8'); await rename(temp,file);
  }
}
