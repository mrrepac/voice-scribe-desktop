import type { BrowserWindow } from 'electron';
import { strict as assert } from 'node:assert';

/**
 * End-to-end file transcription: drops artifacts/fixture-ru.wav (copied to dist)
 * onto the window, as a user would from Explorer. May download the model.
 */
export async function fileSmokeTest(win: BrowserWindow): Promise<{ text: string; note: string; percents: number[] }> {
  const report: { text: string; note: string; percents: number[] } = await win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    const until = async (check, what, ms = 600000) => {
      const end = Date.now() + ms;
      while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + what); await new Promise(r => setTimeout(r, 100)); }
    };
    const phase = () => $('record-card').dataset.phase;
    const blob = await (await fetch('./fixture-ru.wav')).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'Совещание.wav', { type: blob.type }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    await until(() => phase() === 'file', 'file phase', 5000);
    const percents = [];
    const seen = setInterval(() => { const value = $('work-percent').textContent; if (value) percents.push(parseInt(value)); }, 50);
    await until(() => phase() !== 'file', 'transcript');
    clearInterval(seen);
    if (phase() !== 'idle') throw new Error('File transcription failed: ' + $('record-description').textContent);
    if ($('save-result').disabled) throw new Error('Saving is unavailable after a file transcription');
    return { text: $('result-text').value, note: $('result-note').textContent, percents };
  })()`);
  assert.match(report.text.toLowerCase().replace(/ё/g, 'е'), /квартал/, report.text);
  assert.match(report.note, /Совещание\.wav/, report.note);
  return report;
}
