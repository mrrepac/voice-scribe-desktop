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
