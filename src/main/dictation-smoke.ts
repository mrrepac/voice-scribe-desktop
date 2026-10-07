import type { BrowserWindow } from 'electron';
import { strict as assert } from 'node:assert';

/**
 * End-to-end dictation with Chromium's fake microphone, which plays
 * artifacts/fixture-ru.wav (see index.ts): record with the button, stop, then
 * re-transcribe the kept audio with GigaAM and undo. May download models.
 */
export async function dictationSmokeTest(win: BrowserWindow): Promise<{ first: string; again: string; note: string }> {
  return win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    const until = async (check, what, ms = 180000) => {
      const end = Date.now() + ms;
      while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + what); await new Promise(r => setTimeout(r, 100)); }
    };
    const phase = () => $('record-card').dataset.phase;
    document.querySelector('[data-view="dictation"]').click();
    $('record-button').click();
    await until(() => phase() === 'recording', 'recording');
    await new Promise(r => setTimeout(r, 8500));
    $('record-button').click();
    await until(() => phase() === 'idle' && $('result-text').value.trim(), 'first transcript');
    const first = $('result-text').value;
    if ($('retranscribe').hidden) throw new Error('Retranscribe is not offered after a dictation');
    $('retranscribe').click();
    const dialog = $('retranscribe-dialog');
    await until(() => dialog.open, 'retranscribe dialog');
    $('retranscribe-model').value = 'gigaam';
    dialog.close('start');
    await until(() => phase() === 'idle' && /GigaAM/.test($('result-note').textContent), 'retranscribed text');
    const again = $('result-text').value;
    const note = $('result-note').textContent;
    if ($('undo-proofread').hidden) throw new Error('The previous text cannot be restored');
    $('undo-proofread').click();
    if ($('result-text').value !== first) throw new Error('Undo did not restore the first transcript');
    await new Promise(r => setTimeout(r, 1000)); // history edits are saved after a short delay
    const saved = (await window.scribe.getHistory())[0];
    if (saved.text !== first) throw new Error('History does not hold the restored text');
    return { first, again, note };
  })()`).then((report: { first: string; again: string; note: string }) => {
    for (const text of [report.first, report.again]) assert.match(text.toLowerCase().replace(/ё/g, 'е'), /квартал/, text);
    return report;
  });
}

/**
 * An application profile through the settings UI, then a dictation that targets
 * a window of this process (electron.exe in development): the profile's language
 * must apply. Forcing English on Russian speech makes Whisper answer in Latin script.
 */
export async function profileSmokeTest(win: BrowserWindow, target: string): Promise<{ description: string; text: string }> {
  const send = (command: object) => win.webContents.send('command', command);
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view="settings"]').click();
    document.getElementById('profile-app').value = 'Electron';
    document.getElementById('profile-add-button').click();
    const card = document.querySelector('#profile-list .profile');
    if (!card || card.querySelector('strong').textContent !== 'electron.exe') throw new Error('Profile was not added');
    const language = card.querySelectorAll('select')[1];
    language.value = 'en';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const saved = (await window.scribe.getSettings()).profiles;
    if (saved.length !== 1 || saved[0].language !== 'en') throw new Error('Profile was not saved: ' + JSON.stringify(saved));
    document.querySelector('[data-view="dictation"]').click();
  })()`);
  send({ action: 'toggle', target });
  const description: string = await win.webContents.executeJavaScript(`(async () => {
    const end = Date.now() + 20000;
    while (document.getElementById('record-card').dataset.phase !== 'recording') { if (Date.now() > end) throw new Error('Recording did not start'); await new Promise(r => setTimeout(r, 50)); }
    return document.getElementById('record-description').textContent;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 8500));
  send({ action: 'toggle', target });
  const text: string = await win.webContents.executeJavaScript(`(async () => {
    const end = Date.now() + 180000;
    while (document.getElementById('record-card').dataset.phase !== 'idle') { if (Date.now() > end) throw new Error('No transcript'); await new Promise(r => setTimeout(r, 100)); }
    return document.getElementById('result-text').value;
  })()`);
  // Remove the profile through the UI so later smoke runs start clean.
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#profile-list .profile .danger').click();
    await new Promise(r => setTimeout(r, 600));
    if ((await window.scribe.getSettings()).profiles.length) throw new Error('Profile was not removed');
  })()`);
  assert.match(description, /Профиль: electron\.exe/u);
  assert.match(text, /[a-z]{3}/iu, `English text expected: ${text}`);
  assert.doesNotMatch(text, /[а-яё]{3}/iu, `English text expected: ${text}`);
  return { description, text };
}
