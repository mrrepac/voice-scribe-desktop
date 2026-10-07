import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyProfile, findProfile, normalizeApp, validateProfiles } from '../src/shared/profiles';
import { DEFAULT_SETTINGS } from '../src/shared/contracts';
import { validateSettings } from '../src/main/storage';

test('application names are normalized to a lowercase executable', () => {
  assert.equal(normalizeApp('C:\\Users\\me\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe'), 'telegram.exe');
  assert.equal(normalizeApp(' Code '), 'code.exe');
  assert.equal(normalizeApp('notepad.EXE'), 'notepad.exe');
  assert.equal(normalizeApp(''), '');
  assert.equal(normalizeApp('bad|name'), '');
});

test('a profile overrides only what it sets and never keeps a second language', () => {
  const profiles = validateProfiles([{ app: 'Telegram.exe', model: 'gigaam', language: '', enter: true, proofread: false }, { app: 'code', model: '', language: 'en', enter: false, proofread: true }]);
  const settings = { ...DEFAULT_SETTINGS, model: 'turbo' as const, language: 'ru', language2: 'en' };
  const telegram = findProfile(profiles, 'telegram.exe');
  assert.equal(telegram?.enter, true);
  assert.deepEqual([applyProfile(settings, telegram).model, applyProfile(settings, telegram).language, applyProfile(settings, telegram).language2], ['gigaam', 'ru', 'en']);
  const code = applyProfile(settings, findProfile(profiles, 'Code.exe'));
  assert.deepEqual([code.model, code.language, code.language2], ['turbo', 'en', '']);
  assert.equal(findProfile(profiles, 'chrome.exe'), null);
  assert.equal(findProfile(profiles, null), null);
  assert.equal(applyProfile(settings, null), settings);
});

test('stored profiles are validated: unknown values dropped, duplicates and junk removed', () => {
  assert.deepEqual(validateProfiles([
    { app: 'Slack.exe', model: 'huge', language: 'русский', enter: 'yes', proofread: true },
    { app: 'slack', model: 'small' },
    { app: '' }, null, 'telegram.exe',
  ]), [{ app: 'slack.exe', model: '', language: '', enter: false, proofread: true }]);
  assert.deepEqual(validateProfiles('nope'), []);
  assert.equal(validateProfiles(Array.from({ length: 80 }, (_, i) => ({ app: `app${i}` }))).length, 50);
  assert.deepEqual(validateSettings({ profiles: [{ app: 'Word', language: 'en' }] }).profiles, [{ app: 'word.exe', model: '', language: 'en', enter: false, proofread: false }]);
  assert.deepEqual(validateSettings({}).profiles, []);
});
