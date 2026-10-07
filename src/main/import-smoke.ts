import { dialog, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Renderer file-drop and options checks without inference or user data. */
export async function importSmokeTest(win: BrowserWindow): Promise<void> {
  if (!process.argv.includes('--smoke-test')) throw new Error('Isolated smoke profile required');
  const result = await win.webContents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw Error(message); };
    const wait = async predicate => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 30)); }
      throw Error('Import UI timeout');
    };
    const drop = names => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File(['fixture'], name));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    };
    const dialog = document.getElementById('file-options-dialog');
    const count = document.getElementById('file-speaker-count');
    const enabled = document.getElementById('file-diarization');
    drop(['meeting.mp4']);
    await wait(() => dialog.open);
    check(document.getElementById('file-options-name').textContent === 'meeting.mp4', 'Dropped video filename missing');
    check(!document.getElementById('view-dictation').hidden, 'Drop did not open dictation');
    enabled.checked = true; enabled.dispatchEvent(new Event('change'));
    count.value = '2.5';
    check(!count.checkValidity(), 'Fractional count accepted');
    count.value = '2'; check(count.checkValidity(), 'Two speakers rejected');
    enabled.click(); check(count.disabled, 'Speaker count stays enabled');
    document.querySelector('#file-options-form button[value="cancel"]').click();
    await wait(() => !document.getElementById('pick-file').disabled);
    drop(['a.wav', 'b.wav']);
    check(!dialog.open, 'Multiple files accepted');
    drop(['meeting.wav']);
    await wait(() => dialog.open);
    check(count.value === '', 'Count leaked between recordings');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(() => !dialog.open && !document.getElementById('pick-file').disabled);
    drop(['notes.txt']);
    await wait(() => document.getElementById('record-card').dataset.phase === 'error');
    check(!dialog.open, 'Unsupported file accepted');
    return { ok: true, checks: ['video drop', 'audio drop', 'count validation', 'disable diarization', 'cancel', 'Escape', 'multiple files', 'unsupported file'] };
  })()`);
  const out = path.resolve('artifacts/import');
  await mkdir(out, { recursive: true });
  const fixture=path.join(out,'silence.wav');
  const wav=Buffer.alloc(44+32000);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
  await writeFile(fixture,wav);
  const originalOpen=dialog.showOpenDialog;
  dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[fixture]})) as typeof dialog.showOpenDialog;
  try {
    await win.webContents.executeJavaScript(`(async()=>{
      const file=await window.scribe.pickAudio();
      try {
        const metadata=await window.scribe.prepareAudio(file.id);
        if(metadata.samples!==16000)throw Error('Incorrect decoded sample count');
        const pcm=await window.scribe.audioChunk(file.id,0);
        if(!(pcm instanceof Float32Array) || pcm.length!==16000 || pcm.some(x=>x!==0))throw Error('Invalid PCM over IPC');
      } finally {await window.scribe.releaseAudio(file.id);}
    })()`);
    result.checks.push('bundled decoder and PCM IPC');
  } finally {dialog.showOpenDialog=originalOpen;}
  await writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  await win.reload();
  await new Promise(resolve => setTimeout(resolve, 800));
}
