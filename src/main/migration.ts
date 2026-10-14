import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './storage';

/**
 * 0.4.0 replaced the full Voice Scribe with the former Lite app. Runs only in
 * installed builds that carry the model, so nothing it removes is needed.
 * - The full app's Whisper/GigaAM downloads and temporary audio are removed.
 *   History, the API key and other files stay on disk unused.
 * - Settings of a Voice Scribe Lite install are imported once, and the model it
 *   downloaded is removed; uninstalling Lite itself is left to the user.
 */
export async function migrateFromOlderApps(userData: string, appData: string, storage: Storage): Promise<void> {
  await Promise.all(['models', 'audio-temp'].map(name => rm(path.join(userData, name), { recursive: true, force: true })));
  const lite = path.join(appData, 'Voice Scribe Lite');
  const marker = path.join(userData, 'lite-imported');
  if (existsSync(marker) || !existsSync(path.join(lite, 'settings.json'))) return;
  await storage.saveSettings(JSON.parse(await readFile(path.join(lite, 'settings.json'), 'utf8')));
  await writeFile(marker, new Date().toISOString());
  await rm(path.join(lite, 'models'), { recursive: true, force: true });
}
