import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../src/main/storage';
import { migrateFromOlderApps } from '../src/main/migration';

test('full app leftovers are removed and Lite settings are imported once', async () => {
  const base = await mkdtemp(path.resolve('.test-build/migration-'));
  try {
    const userData = path.join(base, 'Voice Scribe'), lite = path.join(base, 'Voice Scribe Lite');
    await mkdir(path.join(userData, 'models', 'whisper'), { recursive: true });
    await mkdir(path.join(userData, 'audio-temp'), { recursive: true });
    await mkdir(path.join(lite, 'models', 'gigaam-v3-punct'), { recursive: true });
    await writeFile(path.join(userData, 'history.json'), '[]');
    await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ hotkey: 'win-alt', llmEnabled: true }));
    await writeFile(path.join(lite, 'settings.json'), JSON.stringify({ hotkey: 'key:120', enterApps: 'telegram.exe' }));
    const storage = new Storage(userData);
    await migrateFromOlderApps(userData, base, storage);
    assert.equal(existsSync(path.join(userData, 'models')), false);
    assert.equal(existsSync(path.join(userData, 'audio-temp')), false);
    assert.equal(existsSync(path.join(userData, 'history.json')), true, 'history stays on disk');
    assert.equal(existsSync(path.join(lite, 'models')), false, 'Lite model removed');
    let settings = await storage.settings();
    assert.equal(settings.hotkey, 'key:120');
    assert.equal(settings.enterApps, 'telegram.exe');

    await storage.saveSettings({ ...settings, hotkey: 'insert' });
    await migrateFromOlderApps(userData, base, storage);
    settings = await storage.settings();
    assert.equal(settings.hotkey, 'insert', 'Lite settings are not imported again');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('without Lite the full app settings are kept', async () => {
  const base = await mkdtemp(path.resolve('.test-build/migration-'));
  try {
    const userData = path.join(base, 'Voice Scribe');
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ hotkey: 'win-alt', sounds: false }));
    const storage = new Storage(userData);
    await migrateFromOlderApps(userData, base, storage);
    const settings = await storage.settings();
    assert.equal(settings.hotkey, 'win-alt');
    assert.equal(settings.sounds, false);
  } finally { await rm(base, { recursive: true, force: true }); }
});
