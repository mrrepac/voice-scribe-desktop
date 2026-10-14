import type { BrowserWindow } from 'electron';
import { strict as assert } from 'node:assert';

/**
 * End-to-end dictation with Chromium's fake microphone, which plays
 * artifacts/fixture-ru.wav (see index.ts): record with the button and stop.
 * May download the model.
 */
export async function dictationSmokeTest(win: BrowserWindow): Promise<{ text: string; note: string; tops: Record<string, number> }> {
  const report: { text: string; note: string; tops: Record<string, number> } = await win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    const until = async (check, what, ms = 600000) => {
      const end = Date.now() + ms;
      while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + what); await new Promise(r => setTimeout(r, 100)); }
    };
    const phase = () => $('record-card').dataset.phase;
    // The text field must not move while the activity line changes between phases.
    const tops = {};
    const seen = setInterval(() => { tops[phase()] = Math.round($('result-text').getBoundingClientRect().top); }, 20);
    $('record-button').click();
    await until(() => phase() === 'recording', 'recording', 20000);
    await new Promise(r => setTimeout(r, 8500));
    $('record-button').click();
    await until(() => phase() === 'idle' && $('result-text').value.trim(), 'transcript');
    clearInterval(seen);
    return { text: $('result-text').value, note: $('result-note').textContent, tops };
  })()`);
  assert.equal(new Set(Object.values(report.tops)).size, 1, `text field moved: ${JSON.stringify(report.tops)}`);
  assert.match(report.text.toLowerCase().replace(/ё/g, 'е'), /квартал/, report.text);
  return report;
}
