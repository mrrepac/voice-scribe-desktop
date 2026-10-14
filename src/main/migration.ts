import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './storage';

/**
 * 0.4.0 replaced the full Voice Scribe with the former Lite app. Runs only in
 * installed builds that carry the model, so nothing it removes is needed. Each
 * step runs once and leaves a marker file in userData.
 * - The full app's Whisper/GigaAM downloads and temporary audio are removed.
 *   History, the API key and other files stay on disk unused.
 * - Settings of a Voice Scribe Lite install are imported once, and the model it
 *   downloaded is removed; uninstalling Lite itself is left to the user. Unreadable
 *   Lite settings are skipped for good rather than retried on every start.
 */
export async function migrateFromOlderApps(userData: string, appData: string, storage: Storage): Promise<void> {
  const cleaned = path.join(userData, 'full-app-cleaned');
  if (!existsSync(cleaned)) {
    await Promise.all(['models', 'audio-temp'].map(name => rm(path.join(userData, name), { recursive: true, force: true })));
    await writeFile(cleaned, new Date().toISOString());
  }
  const lite = path.join(appData, 'Voice Scribe Lite');
  const marker = path.join(userData, 'lite-imported');
  if (existsSync(marker) || !existsSync(path.join(lite, 'settings.json'))) return;
  let settings: unknown;
  try { settings = JSON.parse(await readFile(path.join(lite, 'settings.json'), 'utf8')); }
  catch (error) {
    // A locked file may be readable next time; a corrupt one never will be.
    if (!(error instanceof SyntaxError)) throw error;
    console.warn('Voice Scribe Lite settings are not valid JSON; they were not imported.');
  }
  if (settings !== undefined) await storage.saveSettings(settings);
  await writeFile(marker, new Date().toISOString());
  await rm(path.join(lite, 'models'), { recursive: true, force: true });
}
