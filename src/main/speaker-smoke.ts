import { app, clipboard, dialog, nativeTheme, type BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assignSpeakers } from '../shared/speakers';
import { transcriptText } from '../shared/transcript';

/** Real native inference and renderer/IPC checks in the isolated smoke profile. */
export async function speakerSmokeTest(win: BrowserWindow): Promise<void> {
  if (!process.argv.includes('--smoke-test')) throw new Error('Isolated smoke profile required');
  const out = path.resolve('artifacts/speakers');
  await mkdir(out, { recursive: true });
  const wav = await readFile(path.join(out, 'two-speakers.wav'));
  const historyFile = path.join(app.getPath('userData'), 'history.json');
  const previous = await readFile(historyFile).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const previousSettings = await readFile(settingsFile).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const originalDialog = dialog.showOpenDialog;
  const originalCopy = clipboard.writeText;
  const theme = nativeTheme.themeSource;
  const bounds = win.getBounds();
  const execute = (source: string) => win.webContents.executeJavaScript(source);
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value: unknown, label: string) => { if (!value) throw new Error(label); };
  try {
    const inference = await execute(`(async()=>{
      const context = new AudioContext({sampleRate:16000});
      const bytes = Uint8Array.from(atob(${JSON.stringify(wav.toString('base64'))}), c=>c.charCodeAt(0));
      const audio = await context.decodeAudioData(bytes.buffer); await context.close();
      const pcm = new Float32Array(audio.getChannelData(0));
      const events=[]; const unsubscribe=window.scribe.onDiarizationProgress(p=>events.push(p));
      try {
        const turns=await window.scribe.diarize(pcm);
        const cancelled=window.scribe.diarize(pcm).then(()=>false,()=>true);
        await window.scribe.cancelDiarization();
        if(!await cancelled)throw Error('Cancellation failed');
        const single=await window.scribe.diarize(pcm.slice(0,8*16000));
        const silence=await window.scribe.diarize(new Float32Array(16000*3));
        return {turns,single,silence,events};
      } finally {unsubscribe();}
    })()`);
    check(new Set(inference.turns.map((t: any) => t.speaker)).size === 2, 'Expected two speakers in public fixture');
    check(new Set(inference.single.map((t: any) => t.speaker)).size === 1, 'Single speaker incorrectly split');
    check(inference.silence.length === 0, 'Silence produced speakers');
    // Exercise the actual Open audio button, Whisper, diarization and history.
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path.join(out, 'two-speakers.wav')] })) as typeof dialog.showOpenDialog;
    clipboard.writeText = async () => {};
    await execute(`(async()=>{const settings=await window.scribe.getSettings();await window.scribe.saveSettings({...settings,language:'en',language2:'',diarization:true,warmup:false});})()`);
    await win.loadURL('scribe://app/index.html');
    for (let i = 0; i < 100; i++) {
      if (await execute(`!document.getElementById('pick-file').disabled`)) break;
      await delay(50);
    }
    await execute(`document.querySelector('[data-view="dictation"]').click();document.getElementById('pick-file').click();`);
    let imported: any;
    for (let i = 0; i < 600; i++) {
      await delay(500);
      imported = await execute(`({phase:document.getElementById('record-card').dataset.phase,note:document.getElementById('result-note').textContent,description:document.getElementById('record-description').textContent,text:document.getElementById('result-text').value,speakers:[...document.querySelectorAll('.segment-speaker')].map(el=>el.value)})`);
      if (imported.phase === 'idle' || imported.phase === 'error') break;
    }
    check(imported.phase === 'idle' && imported.speakers.includes('Оратор 1') && imported.speakers.includes('Оратор 2'), 'Audio import failed: ' + JSON.stringify(imported));
    const segments = assignSpeakers([
      { start: 1.5, end: 3.5, text: 'Первый участник обсуждает проект.' },
      { start: 9.3, end: 11.5, text: 'Второй участник отвечает на вопрос.' },
    ], inference.turns);
    const id = await execute(`(async()=>{const item=await window.scribe.addHistory(${JSON.stringify(transcriptText(segments))},'file',${JSON.stringify({ segments, name: 'Два оратора — проверка.wav' })});return item.id;})()`);
    const open = async () => {
      await win.loadURL('scribe://app/index.html');
      for (let i = 0; i < 100; i++) {
        if (await execute(`!document.getElementById('record-button').disabled`)) break;
        await delay(50);
      }
      await execute(`document.querySelector('[data-view="history"]').click();document.querySelector('[data-open-history="${id}"]').click();`);
    };
    await open();
    check(await execute(`document.querySelectorAll('.segment-speaker').length===2 && document.querySelectorAll('.segment-speaker')[1].value==='Оратор 2'`), 'Renderer lost speaker labels');
    await execute(`const label=document.querySelector('.segment-speaker');label.value='Анна';label.dispatchEvent(new Event('change',{bubbles:true}));`);
    await delay(600);
    await open();
    check(await execute(`document.querySelector('.segment-speaker').value==='Анна' && document.getElementById('result-text').value.includes('Анна:')`), 'Speaker edit did not survive reload');
    for (const color of ['light', 'dark'] as const) {
      nativeTheme.themeSource = color;
      for (const size of [{ name: 'default', width: 760, height: 620 }, { name: 'minimum', width: 600, height: 480 }]) {
        win.setSize(size.width, size.height);
        await delay(150);
        check(await execute(`![...document.querySelectorAll('.segment-speaker,.segment-text')].some(el=>{const r=el.getBoundingClientRect();return r.left<0||r.right>innerWidth;})`), 'Speaker controls overflow');
        await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await delay(100);
        await writeFile(path.join(out, `${color}-${size.name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      }
    }
    await writeFile(path.join(out, app.isPackaged ? 'packaged-report.json' : 'report.json'), JSON.stringify({ ok: true, inference, imported, notes: ['Real inference: two speakers, one speaker, silence, cancellation and retry.', 'Open audio exercises real Whisper and diarization; screenshots use Russian fixture captions.', 'Renderer edits survive history reload; four theme/size screenshots.'] }, null, 2));
  } finally {
    dialog.showOpenDialog = originalDialog;
    clipboard.writeText = originalCopy;
    await execute('window.scribe.cancelDiarization()').catch(() => {});
    nativeTheme.themeSource = theme;
    win.setBounds(bounds);
    await win.loadURL('scribe://app/index.html');
    await delay(450);
    if (previous) await writeFile(historyFile, previous);
    else await unlink(historyFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (previousSettings) await writeFile(settingsFile, previousSettings);
    else await unlink(settingsFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}
