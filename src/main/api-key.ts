import { safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { apiBase } from '../shared/providers';

export class ApiKeyStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private get file(): string { return path.join(this.root, 'api-key.enc'); }
  private async read(): Promise<Record<string,string> | string> {
    try {
      const decrypted = safeStorage.decryptString(await readFile(this.file));
      if (!decrypted.startsWith('{')) return decrypted;
      return JSON.parse(decrypted);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Не удалось прочитать API-ключ. Сохраните его заново.'); }
  }
  private async write(keys: Record<string,string>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранение ключа недоступно.');
    await mkdir(this.root,{recursive:true});
    await writeFile(this.file+'.tmp',safeStorage.encryptString(JSON.stringify(keys)));
    await rename(this.file+'.tmp',this.file);
  }
  migrate(base: string): Promise<void> {
    const run = this.queue.then(async()=>{
      const keys=await this.read();
      if (typeof keys==='string') await this.write({[apiBase(base)]:keys});
    });
    this.queue=run.catch(()=>{});
    return run;
  }
  async get(base: string): Promise<string> {
    await this.migrate(base);
    await this.queue;
    const keys=await this.read();
    return typeof keys==='string' ? '' : keys[apiBase(base)] || '';
  }
  async has(base: string): Promise<boolean> { return Boolean(await this.get(base)); }
  save(key: string, base: string): Promise<void> {
    const run = this.queue.then(async () => {
      const scope=apiBase(base);
      const old=await this.read();
      const keys=typeof old==='string' ? {[scope]:old} : old;
      if(key) keys[scope]=key; else delete keys[scope];
      if (!Object.keys(keys).length) { await rm(this.file,{force:true}); return; }
      await this.write(keys);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
