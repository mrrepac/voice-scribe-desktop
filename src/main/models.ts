import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ModelEntry, ModelId } from '../shared/models';

const WHISPER = 'huggingface.co_onnx-community_whisper-';
/** Turbo HQ only adds this file; its decoder and configuration come from Turbo. */
const TURBO_HQ_FILE = `${WHISPER}large-v3-turbo_resolve_main_onnx_encoder_model_fp16.onnx`;

const NAMES: Record<ModelId, string> = {
  tiny: 'Whisper Tiny', base: 'Whisper Base', small: 'Whisper Small', turbo: 'Whisper Turbo',
  'turbo-hq': 'Whisper Turbo HQ · fp16-энкодер', gigaam: 'GigaAM v3', speakers: 'Определение ораторов',
};
const ORDER = Object.keys(NAMES) as ModelId[];

/** Which model a file in the Whisper cache directory belongs to (temporary files included). */
export function whisperModelOf(name: string): ModelId | null {
  if (name.startsWith(TURBO_HQ_FILE)) return 'turbo-hq';
  const match = /^huggingface\.co_onnx-community_whisper-(tiny|base|small|large-v3-turbo)_/.exec(name);
  if (!match) return null;
  return match[1] === 'large-v3-turbo' ? 'turbo' : match[1] as ModelId;
}

async function files(directory: string): Promise<{ file: string; size: number }[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const result: { file: string; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    result.push({ file, size: (await stat(file)).size });
  }
  return result;
}

/**
 * Models in the application's own data directory. The Obsidian plugin's cache is
 * read but never changed, so it is reported as one read-only entry.
 */
export class ModelStore {
  constructor(private modelsRoot: string, private legacyRoot?: string) {}

  private async owned(): Promise<Map<ModelId, string[]>> {
    const groups = new Map<ModelId, string[]>();
    const add = (id: ModelId, file: string) => groups.set(id, [...groups.get(id) ?? [], file]);
    for (const { file } of await files(this.modelsRoot)) {
      const id = whisperModelOf(path.basename(file));
      if (id) add(id, file);
    }
    for (const id of ['gigaam', 'speakers'] as const) {
      for (const { file } of await files(this.directoryOf(id))) add(id, file);
    }
    return groups;
  }

  private directoryOf(id: 'gigaam' | 'speakers'): string {
    return path.join(this.modelsRoot, id === 'gigaam' ? 'gigaam-v3-punct' : 'speakers');
  }

  async list(): Promise<ModelEntry[]> {
    const groups = await this.owned();
    const entries: ModelEntry[] = [];
    for (const id of ORDER) {
      const list = groups.get(id);
      if (!list?.length) continue;
      let bytes = 0;
      for (const file of list) bytes += (await stat(file)).size;
      entries.push({ id, name: NAMES[id], bytes, removable: true });
    }
    if (this.legacyRoot) {
      const legacy = (await files(this.legacyRoot)).filter(({ file }) => whisperModelOf(path.basename(file)));
      if (legacy.length) entries.push({ id: 'legacy', name: 'Кэш плагина Obsidian', bytes: legacy.reduce((sum, { size }) => sum + size, 0), removable: false });
    }
    return entries;
  }

  /** Deletes one model's files; anything still needed is downloaded again on next use. */
  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !ORDER.includes(id as ModelId)) throw new Error('Неизвестная модель');
    for (const file of (await this.owned()).get(id as ModelId) ?? []) await rm(file, { force: true });
  }
}
