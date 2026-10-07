import type { BrowserWindow } from 'electron';
import { strict as assert } from 'node:assert';
import type { Transcript } from '../shared/transcript';

interface Report { seconds: number; prepareMs: number; plain: string; plainMs: number; timed: Transcript; cancelled: boolean; again: string }

/** Real GigaAM through preload, IPC, the service and the worker process. May download the model. */
export async function gigaamSmokeTest(win: BrowserWindow): Promise<Report> {
  const report: Report = await win.webContents.executeJavaScript(`(async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    const audio = await context.decodeAudioData(await (await fetch('./fixture-ru.wav')).arrayBuffer());
    const pcm = audio.getChannelData(0).slice();
    await context.close();
    let at = performance.now();
    await window.scribe.prepareGigaam();
    const prepareMs = Math.round(performance.now() - at);
    at = performance.now();
    const plain = (await window.scribe.recognizeGigaam(pcm, false)).text;
    const plainMs = Math.round(performance.now() - at);
    const timed = await window.scribe.recognizeGigaam(pcm, true);
    const pending = window.scribe.recognizeGigaam(pcm, true);
    await window.scribe.cancelGigaam();
    const cancelled = await pending.then(() => false, () => true);
    const again = (await window.scribe.recognizeGigaam(pcm, false)).text;
    return { seconds: pcm.length / 16000, prepareMs, plain, plainMs, timed, cancelled, again };
  })()`);
  const words = (text: string) => text.toLowerCase().replace(/ё/g, 'е');
  for (const text of [report.plain, report.timed.text, report.again]) {
    assert.match(words(text), /квартал/, `GigaAM text: ${text}`);
    assert.match(words(text), /голос становится текстом/, `GigaAM text: ${text}`);
  }
  const { segments } = report.timed;
  assert.ok(segments.length >= 2, 'one cue per sentence');
  assert.equal(segments.map(segment => segment.text).join(' '), report.timed.text);
  for (const [index, segment] of segments.entries()) {
    assert.ok(segment.start >= 0 && segment.end > segment.start && segment.end <= report.seconds + 0.01, `cue ${index} inside the audio`);
    if (index) assert.ok(segment.start >= segments[index - 1].end, `cue ${index} after the previous one`);
  }
  return report;
}
