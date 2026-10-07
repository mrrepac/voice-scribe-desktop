/** Downloaded model groups that can be listed and deleted in settings. */
export type ModelId = 'tiny' | 'base' | 'small' | 'turbo' | 'turbo-hq' | 'gigaam' | 'speakers';
export interface ModelEntry {
  /** 'legacy' is the Obsidian plugin's cache: read-only, never deleted here. */
  id: ModelId | 'legacy';
  name: string;
  bytes: number;
  removable: boolean;
}
