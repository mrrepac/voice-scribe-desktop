import { app, clipboard, dialog, nativeTheme, type BrowserWindow } from 'electron';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Exercise the real renderer and IPC using the isolated smoke profile only. */
export async function subtitleSmokeTest(win: BrowserWindow): Promise<void> {
  if (!process.argv.includes('--smoke-test')) throw new Error('Subtitle smoke requires the isolated --smoke-test profile');
  const profile = path.resolve(app.getPath('userData'));
  const expectedProfile = path.resolve(process.cwd(), '.data', app.isPackaged ? 'smoke-packaged' : 'smoke');
  if (profile.toLowerCase() !== expectedProfile.toLowerCase()) throw new Error('Subtitle smoke refused a non-test data directory');

  const out = path.resolve(process.cwd(), 'artifacts', 'subtitles');
  await mkdir(out, { recursive: true });
  const historyFile = path.join(profile, 'history.json');
  const previousHistory = await readFile(historyFile).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const originalTheme = nativeTheme.themeSource;
  const originalBounds = win.getBounds();
  const originalCopy = clipboard.writeText;
  const originalSaveDialog = dialog.showSaveDialog;
  const assertions: string[] = [];
  const captures: unknown[] = [];
  const exports: unknown[] = [];
  const failures: string[] = [];
  let copied: string | undefined;
  let saveDestination: string | undefined;
  let saveRequests = 0;
  const execute = <T = any>(source: string): Promise<T> => win.webContents.executeJavaScript(source);
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const check = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
    assertions.push(message);
  };
  const until = async (predicate: () => Promise<boolean>, message: string): Promise<void> => {
    const deadline = Date.now() + 8_000;
    do {
      if (await predicate()) return;
      await delay(60);
    } while (Date.now() < deadline);
    throw new Error(message);
  };
  const ready = () => until(() => execute<boolean>(`Boolean(window.scribe && document.getElementById('record-button') && !document.getElementById('record-button').disabled && document.getElementById('record-card').dataset.phase === 'idle')`), 'Renderer did not initialize');
  const reload = async () => { await win.loadURL('scribe://app/index.html'); await ready(); };
  const click = async (selector: string) => {
    await execute(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error('Unavailable control: ' + ${JSON.stringify(selector)}); element.click(); })()`);
  };
  const openHistory = async (id: string) => {
    await click('[data-view="history"]');
    await click(`[data-open-history="${id}"]`);
  };
  const editCue = async (index: number, value: string) => {
    await execute(`(() => { const input = document.getElementById('segment-${index}'); if (!input || input.readOnly) throw new Error('Cue is not editable'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  };
  const snapshot = () => execute(`(() => ({
    activeView: document.querySelector('[data-view][aria-current="page"]')?.dataset.view,
    text: document.getElementById('result-text').value,
    textVisible: document.getElementById('result-text').getClientRects().length > 0,
    readOnly: document.getElementById('result-text').readOnly,
    toolbarHidden: document.getElementById('transcript-toolbar').hidden,
    nameHidden: document.getElementById('transcript-name').hidden,
    cuesVisible: document.getElementById('transcript-segments').getClientRects().length > 0,
    cues: [...document.querySelectorAll('#transcript-segments .segment-text')].map(input => input.value),
    times: [...document.querySelectorAll('#transcript-segments .segment-time')].map(label => label.textContent),
    disabled: ['copy-result','export-result','export-srt','export-vtt'].map(id => document.getElementById(id).disabled)
  }))()`);
  const capture = async (name: string) => {
    await delay(160);
    const geometry = await execute(`(() => {
      const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const label = element => element.id ? '#' + element.id : element.tagName.toLowerCase() + '.' + String(element.className || '').replace(/\\s+/g, '.');
      const horizontalOverflow = [...document.body.querySelectorAll('*')].filter(visible).filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.left < -2 || rect.right > innerWidth + 2); }).map(label);
      const scrollOverflow = [document.documentElement, document.querySelector('main'), ...document.querySelectorAll('.view:not([hidden]), .result-card, .transcript-toolbar, .transcript-segments, .transcript-segment, .history-item')].filter(visible).filter(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2).map(label);
      const bounds = element => { const rect = element.getBoundingClientRect(); return {element:label(element), top:rect.top, bottom:rect.bottom}; };
      const resultCard = document.getElementById('result-card');
      const resultBounds = bounds(resultCard);
      // Direct children must stay in their card; nested cues may legitimately
      // extend inside a scrolling cue list. Off-screen outer content is allowed.
      const resultChildren = [...resultCard.children].filter(visible).map(bounds);
      const resultOverflow = resultChildren.filter(child => child.top < resultBounds.top - 2 || child.bottom > resultBounds.bottom + 2);
      const panels = [...document.getElementById('view-dictation').children].filter(visible).map(bounds);
      const siblingOverlaps = panels.slice(1).flatMap((panel, index) => panel.top < panels[index].bottom - 2 ? [{previous:panels[index], next:panel}] : []);
      const actions = ['#export-srt','#export-vtt','#result-view-text','#result-view-segments'].map(selector => { const element = document.querySelector(selector); const rect = element.getBoundingClientRect(); return {selector, visible:Boolean(visible(element) && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight), disabled:element.disabled}; });
      return {viewport:{width:innerWidth,height:innerHeight}, dark:matchMedia('(prefers-color-scheme: dark)').matches, horizontalOverflow, scrollOverflow, verticalLayout:{resultBounds,resultChildren,resultOverflow,panels,siblingOverlaps}, actions};
    })()`);
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await delay(100);
    await writeFile(path.join(out, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    captures.push({ name, ...geometry });
    check(!geometry.horizontalOverflow.length && !geometry.scrollOverflow.length, name + ': no horizontal overflow');
    check(!geometry.verticalLayout.resultOverflow.length, name + ': visible result controls remain inside the result card');
    check(!geometry.verticalLayout.siblingOverlaps.length, name + ': recorder, result, model controls, and footer do not overlap');
    check(geometry.actions.every((action: { visible: boolean; disabled: boolean }) => action.visible && !action.disabled), name + ': transcript controls remain visible and enabled');
  };
  const exportFixture = async (format: 'txt' | 'srt' | 'vtt', expectedText: string): Promise<string> => {
    const destination = path.join(out, `edited-transcript.${format}`);
    await writeFile(destination, 'PENDING SMOKE EXPORT', 'utf8');
    saveDestination = destination;
    const previousRequests = saveRequests;
    await click(format === 'txt' ? '#export-result' : '#export-' + format);
    await until(async () => saveRequests > previousRequests && (await readFile(destination, 'utf8')).includes(expectedText), format.toUpperCase() + ' export did not contain the edited cue');
    const result = await readFile(destination, 'utf8');
    exports.push({ format, file: path.basename(destination), bytes: Buffer.byteLength(result, 'utf8') });
    return result;
  };

  // Capture the actual IPC output without changing the Windows clipboard or opening dialogs.
  clipboard.writeText = async (text: string) => { copied = text; };
  dialog.showSaveDialog = (async (...args: unknown[]) => {
    const destination = saveDestination;
    saveDestination = undefined;
    if (!destination || path.dirname(destination) !== out) throw new Error('Unexpected save dialog during subtitle smoke');
    saveRequests++;
    const options = args[args.length - 1] as { defaultPath?: string };
    exports.push({ requestedFilename: options.defaultPath });
    return { canceled: false, filePath: destination };
  }) as typeof dialog.showSaveDialog;

  try {
    await ready();
    const fixture = {
      name: 'Обсуждение проекта — проверка длинного названия аудиофайла и переноса текста в узком окне.wav',
      segments: [
        { start: 1.25, end: 4.5, text: 'Первый фрагмент о новом проекте.' },
        { start: 5.75, end: 9.25, text: 'Второй фрагмент: согласуем план и подготовим материалы к следующей встрече.' },
      ],
    };
    const legacyText = 'Обычная диктовка без таймкодов из прежней версии.';
    const seeded = await execute<{ timedId: string; legacyId: string }>(`(async () => { await window.scribe.clearHistory(); const fixture = ${JSON.stringify(fixture)}; const timed = await window.scribe.addHistory(fixture.segments.map(cue => cue.text).join(' '), 'file', fixture); const legacy = await window.scribe.addHistory(${JSON.stringify(legacyText)}, 'dictation'); return {timedId:timed.id,legacyId:legacy.id}; })()`);
    await reload();
    await openHistory(seeded.timedId);
    const initial = await snapshot();
    check(initial.activeView === 'dictation' && initial.cuesVisible && !initial.toolbarHidden && initial.cues.length === 2, 'Opening timed history displays both cue editors');
    check(initial.times[0] === '00:00:01.250 — 00:00:04.500' && initial.times[1] === '00:00:05.750 — 00:00:09.250', 'Timecodes retain positions in the original file');

    const editedCue = 'Исправленный фрагмент: <проект> & план.';
    await editCue(0, editedCue);
    const edited = await snapshot();
    check(edited.cues[0] === editedCue && edited.times.join('|') === initial.times.join('|'), 'Editing a cue changes its text without changing timecodes');
    check(edited.text === editedCue + ' ' + fixture.segments[1].text && edited.disabled.every((disabled: boolean) => !disabled), 'Edited cues synchronize plain text and enable all exports');
    await click('#result-view-text');
    const plain = await snapshot();
    check(plain.textVisible && plain.readOnly && !plain.cuesVisible && plain.text === edited.text, 'Plain view is a read-only rendering of the edited cues');
    await click('#copy-result');
    await until(async () => copied === plain.text, 'Copy did not receive the current plain text');
    check(copied === plain.text, 'Copy receives the edited plain text through IPC');
    const txt = await exportFixture('txt', editedCue);
    check(txt === plain.text, 'TXT export matches the displayed plain text exactly');
    const srt = await exportFixture('srt', 'Исправленный фрагмент: &lt;проект&gt; &amp; план.');
    check(srt.startsWith('1\n00:00:01,250 --> 00:00:04,500\n') && srt.includes('\n2\n00:00:05,750 --> 00:00:09,250\n'), 'SRT export contains numbered cues and millisecond timestamps');
    const vtt = await exportFixture('vtt', 'Исправленный фрагмент: &lt;проект&gt; &amp; план.');
    check(vtt.startsWith('WEBVTT\n\n00:00:01.250 --> 00:00:04.500\n') && vtt.includes('00:00:05.750 --> 00:00:09.250'), 'VTT export contains its header and millisecond timestamps');
    await until(() => execute<boolean>(`(async () => { const item = (await window.scribe.getHistory()).find(item => item.id === ${JSON.stringify(seeded.timedId)}); return item?.text === ${JSON.stringify(plain.text)} && item.segments?.[0]?.text === ${JSON.stringify(editedCue)} && document.getElementById('transcript-save').textContent === 'Правки сохранены'; })()`), 'Edited cue was not persisted to history');
    check(true, 'Cue edits persist through the history update IPC');

    await reload();
    await openHistory(seeded.timedId);
    const reopened = await snapshot();
    check(reopened.cues[0] === editedCue && reopened.text === plain.text && reopened.times.join('|') === initial.times.join('|'), 'Reloading and reopening history preserves edits and timing');
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme;
      for (const size of [{ name: 'default', width: 760, height: 620 }, { name: 'minimum', width: 600, height: 480 }]) {
        win.setSize(size.width, size.height);
        await execute(`document.getElementById('view-dictation').scrollTop = 0; document.getElementById('transcript-segments').scrollTop = 0;`);
        await capture(theme + '-' + size.name + '-timed-history');
      }
    }

    await editCue(0, '');
    await editCue(1, '  ');
    const empty = await snapshot();
    check(!empty.text.trim() && empty.disabled.every((disabled: boolean) => disabled), 'Empty cue edits disable copy, TXT, SRT, and VTT exports');
    // Restore the fixture so saved screenshots and history remain useful for inspection.
    await editCue(0, editedCue);
    await editCue(1, fixture.segments[1].text);
    await openHistory(seeded.legacyId);
    const legacy = await snapshot();
    check(legacy.text === legacyText && legacy.textVisible && !legacy.readOnly && legacy.toolbarHidden && !legacy.cuesVisible && legacy.cues.length === 0 && legacy.nameHidden, 'Opening legacy dictation removes timed cues and restores editable plain text');
    check(!legacy.disabled[0] && !legacy.disabled[1] && legacy.disabled[2] && legacy.disabled[3], 'Legacy dictation enables plain exports and disables subtitle exports');
    await until(() => execute<boolean>(`(async () => { const item = (await window.scribe.getHistory()).find(item => item.id === ${JSON.stringify(seeded.timedId)}); return item?.text === ${JSON.stringify(plain.text)}; })()`), 'Final fixture edit was not saved');
  } catch (error) {
    failures.push(String(error));
    try { await writeFile(path.join(out, 'failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); } catch { /* Preserve the original test failure. */ }
    throw error;
  } finally {
    clipboard.writeText = originalCopy;
    dialog.showSaveDialog = originalSaveDialog;
    nativeTheme.themeSource = originalTheme;
    win.setBounds(originalBounds);
    // Reload clears renderer debounce callbacks; queued local IPC writes settle
    // before the original isolated-profile history is restored byte for byte.
    await win.loadURL('scribe://app/index.html').catch(() => {});
    await delay(450);
    try {
      if (previousHistory) await writeFile(historyFile, previousHistory);
      else await unlink(historyFile).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    } catch (error) { failures.push('Could not restore isolated smoke history: ' + String(error)); }
    await writeFile(path.join(out, 'subtitle-report.json'), JSON.stringify({
      ok: failures.length === 0,
      notes: ['Uses seeded history in the isolated smoke profile and restores its original history file afterward.', 'Exercises real renderer controls and IPC; the OS clipboard and native save dialog are replaced with test sinks.', 'ASR timing accuracy is not tested by these UI fixtures.'],
      assertions, failures, captures, exports,
    }, null, 2));
  }
  if (failures.length) throw new Error(failures.join('; '));
}
