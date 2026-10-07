import { app, nativeTheme, type BrowserWindow } from 'electron';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/contracts';

/** Exercise correction review and persistence without recording or external UI. */
export async function correctionSmokeTest(win: BrowserWindow): Promise<void> {
  if (!process.argv.includes('--smoke-test')) throw new Error('Correction smoke requires --smoke-test');
  const profile = path.resolve(app.getPath('userData'));
  const expectedProfile = path.resolve(process.cwd(), '.data', app.isPackaged ? 'smoke-packaged' : 'smoke');
  if (profile.toLowerCase() !== expectedProfile.toLowerCase()) throw new Error('Correction smoke refused a non-test profile');
  const out = path.resolve(process.cwd(), 'artifacts', 'corrections');
  await mkdir(out, { recursive: true });
  const snapshots = await Promise.all(['settings.json', 'history.json'].map(async name => {
    const file = path.join(profile, name);
    const data = await readFile(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    return { file, data };
  }));
  const originalTheme = nativeTheme.themeSource;
  const originalBounds = win.getBounds();
  const attachedDebugger = !win.webContents.debugger.isAttached();
  const assertions: string[] = [];
  const captures: unknown[] = [];
  const failures: string[] = [];
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
  const click = (selector: string) => execute(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error('Unavailable control: ' + ${JSON.stringify(selector)}); element.click(); })()`);
  const fill = (selector: string, value: string, change = false) => execute(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input || input.readOnly || input.disabled) throw new Error('Input unavailable'); input.focus(); input.value = ${JSON.stringify(value)}; input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('input', {bubbles:true})); if (${change}) input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const openHistory = async (id: string) => { await click('[data-view="history"]'); await click(`[data-open-history="${id}"]`); };
  const getSettings = () => execute(`window.scribe.getSettings()`);
  const dialogState = () => execute(`(() => ({open:document.getElementById('correction-dialog').open, from:document.getElementById('correction-from').value, to:document.getElementById('correction-to').value, error:document.getElementById('correction-error').textContent, errorVisible:document.getElementById('correction-error').getClientRects().length > 0, saveDisabled:document.getElementById('correction-save').disabled}))()`);
  const waitClosed = () => until(() => execute<boolean>(`!document.getElementById('correction-dialog').open`), 'Correction dialog did not close after saving');
  const ruleEntries = (dictionary: string, source: string): string[] => {
    const normalized = source.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
    return dictionary.split(/\r?\n/).filter(line => {
      if (line.trim().startsWith('#')) return false;
      const [from] = line.split(/=|→|->/);
      return from?.toLocaleLowerCase().trim().replace(/\s+/g, ' ') === normalized;
    });
  };
  const capture = async (name: string) => {
    await delay(160);
    const geometry = await execute(`(() => {
      const dialog = document.getElementById('correction-dialog');
      const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const label = element => element.id ? '#' + element.id : element.tagName.toLowerCase() + '.' + String(element.className || '').replace(/\\s+/g, '.');
      const rect = element => { const bounds = element.getBoundingClientRect(); return {element:label(element),top:bounds.top,bottom:bounds.bottom,left:bounds.left,right:bounds.right}; };
      const bounds = rect(dialog);
      const elements = [...dialog.querySelectorAll('*')].filter(visible);
      const horizontalOverflow = elements.filter(element => { const box = element.getBoundingClientRect(); return box.left < bounds.left - 2 || box.right > bounds.right + 2 || box.left < -2 || box.right > innerWidth + 2; }).map(label);
      const scrollOverflow = [dialog,document.getElementById('correction-form'),...dialog.querySelectorAll('.field,.correction-actions')].filter(element => element.clientWidth && element.scrollWidth > element.clientWidth + 2).map(label);
      const panels = [...document.getElementById('correction-form').children].filter(visible).map(rect);
      const overlaps = panels.slice(1).flatMap((panel,index) => panel.top < panels[index].bottom - 2 ? [{previous:panels[index],next:panel}] : []);
      const actions = ['#correction-from','#correction-to','#correction-save','#correction-cancel','#correction-dictionary'].map(selector => { const element = document.querySelector(selector); const box = rect(element); return {selector,visible:Boolean(visible(element) && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),disabled:element.disabled,...box}; });
      return {viewport:{width:innerWidth,height:innerHeight},dark:matchMedia('(prefers-color-scheme: dark)').matches,open:dialog.open,bounds,horizontalOverflow,scrollOverflow,panels,overlaps,actions};
    })()`);
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await delay(100);
    await writeFile(path.join(out, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    captures.push({ name, ...geometry });
    check(geometry.open && !geometry.horizontalOverflow.length && !geometry.scrollOverflow.length && !geometry.overlaps.length, name + ': correction form has no overflow or overlapping sections');
    check(geometry.actions.every((action: { visible: boolean; disabled: boolean }) => action.visible && !action.disabled), name + ': review fields and actions are visible and enabled');
  };

  try {
    await ready();
    const initialDictionary = '# Рабочие названия\nкодекс = Codex\n';
    const plainText = 'Проверяем войс скрайб каждый день.';
    const correctedText = 'Проверяем Voice Scribe каждый день.';
    const fixture = { name: 'Заметки о проекте.wav', segments: [
      { start: 2.5, end: 5.25, text: 'Открываем обсидиан для заметок.' },
      { start: 7, end: 9.75, text: 'Согласуем следующий шаг.' },
    ] };
    const seeded = await execute<{ plainId: string; timedId: string }>(`(async () => { await window.scribe.saveSettings(${JSON.stringify({ ...DEFAULT_SETTINGS, replacements: initialDictionary, sounds: false })}); await window.scribe.clearHistory(); const plain = await window.scribe.addHistory(${JSON.stringify(plainText)}, 'dictation'); const fixture = ${JSON.stringify(fixture)}; const timed = await window.scribe.addHistory(fixture.segments.map(cue => cue.text).join(' '), 'file', fixture); return {plainId:plain.id,timedId:timed.id}; })()`);
    await reload();
    await openHistory(seeded.plainId);
    await fill('#result-text', correctedText, true);
    check((await getSettings()).replacements === initialDictionary, 'Editing a transcript does not silently add a dictionary rule');
    await click('#remember-correction');
    const inferred = await dialogState();
    check(inferred.open && inferred.from === 'войс скрайб' && inferred.to === 'Voice Scribe', 'Review dialog infers the changed phrase from a plain-text correction');
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme;
      for (const size of [{ name: 'default', width: 760, height: 620 }, { name: 'minimum', width: 600, height: 480 }]) {
        win.setSize(size.width, size.height);
        await capture(theme + '-' + size.name + '-review');
      }
    }
    await click('#correction-cancel');
    check(!(await dialogState()).open && (await getSettings()).replacements === initialDictionary, 'Cancel closes review without saving a correction');
    await click('#remember-correction');
    await click('#correction-save');
    await waitClosed();
    let saved = await getSettings();
    check(ruleEntries(saved.replacements, 'войс скрайб').length === 1 && ruleEntries(saved.replacements, 'войс скрайб')[0].includes('Voice Scribe'), 'Explicit save persists the reviewed rule through IPC');
    check(saved.replacements.includes('# Рабочие названия') && saved.replacements.includes('кодекс = Codex'), 'Adding a correction preserves comments and unrelated dictionary entries');
    check(await execute<boolean>(`document.getElementById('result-text').value === ${JSON.stringify(correctedText)}`), 'Remembering a rule leaves the corrected transcript unchanged');
    await reload();
    saved = await getSettings();
    await click('[data-view="settings"]');
    check(await execute<boolean>(`document.querySelector('[name="replacements"]').value === ${JSON.stringify(saved.replacements)}`), 'The saved rule survives reload and appears in dictionary settings');

    // Begin a normal settings debounce and submit the correction in one browser
    // task, ensuring its old snapshot cannot overwrite the newly merged rule.
    await execute(`(() => {
      const checkbox = document.querySelector('[name="live"]'); checkbox.checked = true; checkbox.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('[data-view="dictation"]').click(); document.getElementById('remember-correction').click();
      const from = document.getElementById('correction-from'); from.value = 'ВОЙС   СКРАЙБ'; from.dispatchEvent(new Event('input',{bubbles:true}));
      const to = document.getElementById('correction-to'); to.value = 'Voice Scribe Desktop'; to.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('correction-save').click();
    })()`);
    await waitClosed();
    await delay(650);
    saved = await getSettings();
    const updatedRules = ruleEntries(saved.replacements, 'войс скрайб');
    check(saved.live === true && updatedRules.length === 1 && updatedRules[0].includes('Voice Scribe Desktop'), 'Updating an equivalent source avoids duplicates and survives the prior settings debounce');
    check(saved.replacements.includes('# Рабочие названия') && saved.replacements.includes('кодекс = Codex'), 'Updating a rule preserves comments and unrelated entries');
    await reload();
    saved = await getSettings();
    check(saved.live === true && ruleEntries(saved.replacements, 'войс скрайб').length === 1 && ruleEntries(saved.replacements, 'войс скрайб')[0].includes('Voice Scribe Desktop'), 'Updated rule and the concurrent setting both persist after reload');

    await openHistory(seeded.timedId);
    const initialTimes = await execute<string[]>(`[...document.querySelectorAll('.segment-time')].map(label => label.textContent)`);
    const correctedCue = 'Открываем Obsidian для заметок.';
    await fill('#segment-0', correctedCue, true);
    await click('#remember-correction');
    const cueSuggestion = await dialogState();
    check(cueSuggestion.from === 'обсидиан' && cueSuggestion.to === 'Obsidian', 'Review infers a correction from an edited timed cue');
    await click('#correction-save');
    await waitClosed();
    await until(() => execute<boolean>(`(async () => { const item = (await window.scribe.getHistory()).find(item => item.id === ${JSON.stringify(seeded.timedId)}); return item?.segments?.[0]?.text === ${JSON.stringify(correctedCue)}; })()`), 'Timed cue correction was not saved to history');
    const timed = await execute(`(async () => ({times:[...document.querySelectorAll('.segment-time')].map(label => label.textContent),item:(await window.scribe.getHistory()).find(item => item.id === ${JSON.stringify(seeded.timedId)})}))()`);
    check(JSON.stringify(timed.times) === JSON.stringify(initialTimes) && timed.item.segments[0].start === 2.5 && timed.item.segments[0].end === 5.25 && timed.item.segments[1].text === fixture.segments[1].text, 'Saving a cue correction preserves original timecodes and the other cue');
    check(ruleEntries((await getSettings()).replacements, 'обсидиан').length === 1, 'The timed-cue correction is also available in the dictionary');

    const beforeInvalid = (await getSettings()).replacements;
    await click('#remember-correction');
    await fill('#correction-from', 'a=b');
    await fill('#correction-to', 'Validated');
    await click('#correction-save');
    await until(async () => { const state = await dialogState(); return state.open && state.errorVisible && Boolean(state.error.trim()) && !state.saveDisabled; }, 'Invalid correction did not leave an editable form with an error');
    const invalid = await dialogState();
    check(invalid.from === 'a=b' && invalid.to === 'Validated' && (await getSettings()).replacements === beforeInvalid, 'Invalid rule keeps its form values and leaves the dictionary unchanged');
    await capture('invalid-rule-review');

    if (attachedDebugger) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitClosed();
    check((await getSettings()).replacements === beforeInvalid, 'Keyboard Escape closes review without saving the invalid rule');
    await openHistory(seeded.plainId);
    check(await execute<boolean>(`document.getElementById('result-text').value === ${JSON.stringify(correctedText)}`), 'The original plain-text edit remains available in history');
  } catch (error) {
    failures.push(String(error));
    try { await writeFile(path.join(out, 'failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); } catch { /* Keep the original failure. */ }
    throw error;
  } finally {
    if (win.webContents.debugger.isAttached()) {
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      if (attachedDebugger) win.webContents.debugger.detach();
    }
    nativeTheme.themeSource = originalTheme;
    win.setBounds(originalBounds);
    await win.loadURL('scribe://app/index.html').catch(() => {});
    await delay(450);
    for (const snapshot of snapshots) {
      try {
        if (snapshot.data) await writeFile(snapshot.file, snapshot.data);
        else await unlink(snapshot.file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      } catch (error) { failures.push('Could not restore isolated smoke file: ' + String(error)); }
    }
    await writeFile(path.join(out, 'correction-report.json'), JSON.stringify({
      ok: failures.length === 0,
      notes: ['Exercises real renderer controls and correction/settings/history IPC with seeded smoke fixtures.', 'Restores the isolated settings.json and history.json byte for byte; no clipboard writes, recording, file dialogs, or downloads.', 'Replacement application and phrase inference edge cases have separate unit coverage.'],
      assertions, failures, captures,
    }, null, 2));
  }
  if (failures.length) throw new Error(failures.join('; '));
}
