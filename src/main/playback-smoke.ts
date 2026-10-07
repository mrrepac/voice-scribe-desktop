import { dialog, type BrowserWindow } from 'electron';
import path from 'node:path';

/** Imports the Russian fixture through the UI and plays its first cue from the source file. */
export async function playbackSmokeTest(win: BrowserWindow): Promise<{ cues: number; playedMs: number; range: string }> {
  const fixture = path.resolve('artifacts/fixture-ru.wav');
  const originalOpen = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [fixture] })) as typeof dialog.showOpenDialog;
  try {
    return await win.webContents.executeJavaScript(`(async () => {
      const $ = id => document.getElementById(id);
      const until = async (check, what, ms = 180000) => {
        const end = Date.now() + ms;
        while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + what); await new Promise(r => setTimeout(r, 50)); }
      };
      document.querySelector('[data-view="dictation"]').click();
      $('pick-file').click();
      await until(() => $('file-options-dialog').open, 'file options');
      $('file-diarization').checked = false;
      $('file-options-dialog').close('start');
      await until(() => $('record-card').dataset.phase === 'idle' && document.querySelectorAll('.segment-play').length, 'transcript with play buttons');
      const item = (await window.scribe.getHistory())[0];
      if (!item.audioPath || !item.audioPath.endsWith('fixture-ru.wav')) throw new Error('Source path was not kept: ' + item.audioPath);
      const ranged = await fetch('./media/' + item.id, { headers: { Range: 'bytes=0-99' } });
      if (ranged.status !== 206 || (await ranged.arrayBuffer()).byteLength !== 100) throw new Error('Range request failed: ' + ranged.status);
      const missing = await fetch('./media/not-an-id');
      if (missing.status !== 404) throw new Error('Unknown ids must not resolve');
      const button = document.querySelector('.segment-play');
      const started = performance.now();
      button.click();
      if (button.getAttribute('aria-pressed') !== 'true') throw new Error('Playback did not start');
      // The cue stops by itself at its end time, which proves the audio advanced.
      await until(() => button.getAttribute('aria-pressed') === 'false', 'cue end', 20000);
      const playedMs = Math.round(performance.now() - started);
      if ($('toast').classList.contains('error') && !$('toast').hidden) throw new Error('Playback error: ' + $('toast').textContent);
      return { cues: document.querySelectorAll('.segment-play').length, playedMs, range: ranged.headers.get('content-range') };
    })()`);
  } finally { dialog.showOpenDialog = originalOpen; }
}
