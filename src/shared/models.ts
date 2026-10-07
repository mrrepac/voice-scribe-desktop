import type { Model, Settings } from './contracts';

/** "Авто" means GigaAM for Russian-only speech and the Whisper size that suits this PC otherwise. */
export function effectiveModel(value: Pick<Settings, 'model' | 'language' | 'language2'>): Model {
  return value.model === 'auto' && value.language === 'ru' && (!value.language2 || value.language2 === 'ru') ? 'gigaam' : value.model;
}

/** Downloaded model groups that can be listed and deleted in settings. */
export type ModelId = 'tiny' | 'base' | 'small' | 'turbo' | 'turbo-hq' | 'gigaam' | 'speakers';
export interface ModelEntry {
  /** 'legacy' is the Obsidian plugin's cache: read-only, never deleted here. */
  id: ModelId | 'legacy';
  name: string;
  bytes: number;
  removable: boolean;
}
