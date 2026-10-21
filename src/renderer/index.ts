import { Recorder } from '../asr/recorder';
import { DEFAULT_SETTINGS, type Settings, type Phase, type Command } from '../shared/contracts';
import { trimSilence } from '../shared/clean';
import { quietCut } from '../shared/quiet-cut';
import { DictationGesture } from './gesture';
import { deliveryMessage } from './delivery-message';
import type { UpdateState } from '../shared/updates';
import { capturedHotkey, hotkeyLabel, isHotkey, MAC_DEFAULT_HOTKEY } from '../shared/hotkeys';
import { IS_MAC } from '../shared/platform';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};
const api = window.scribe;
const gesture = new DictationGesture();
const form = $<HTMLFormElement>('settings-form');
const fieldset = $<HTMLFieldSetElement>('settings-fieldset');
const resultText = $<HTMLTextAreaElement>('result-text');
const recordButton = $<HTMLButtonElement>('record-button');
const bars: HTMLElement[] = [];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
for (let i = 0; i < 43; i++) {
  const bar = document.createElement('i');
  bar.style.animationDelay = `${i * 35}ms`;
  $('waveform').append(bar);
  bars.push(bar);
}

interface Session {
  token: number;
  settings: Settings;
  recorder: Recorder;
  target: string | null;
  enter: boolean;
  stopRequested: boolean;
  /** Raw 16 kHz microphone blocks; recognized directly, without the Opus round trip. */
  pcm: Float32Array[];
  tapUnavailable: boolean;
  voiced: boolean;
  voicedTicks: number;
  lastVoice: number;
  noise: number;
}
let settings: Settings = { ...DEFAULT_SETTINGS };
let phase: Phase = 'idle';
let statusMessage = 'Готово';
let generation = 0;
let session: Session | null = null;
let initialized = false;
let lastResult = '';
let updateState: UpdateState = { phase: 'idle', message: 'Проверяем доступность обновлений…' };
let installingUpdate = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let pendingCommands: Command[] = [];
let cueContext: AudioContext | null = null;
let lastSeconds = 0;
let workStarted = 0;
let downloadPercent: number | undefined;
/** Share of the file already recognized while transcribing a file. */
let filePercent: number | undefined;
// "Подготовить модель" (source checkouts only) loads the model; dictation may start and queue behind it.
let warming = false;
/** GigaAM is loaded in its process; cancelling recognition kills that process and unloads it. */
let modelReady = false;
/** Installed builds carry the model, so there is nothing to prepare up front. */
let modelBundled = false;
let fileName = '';
/** The file the text in the window came from; empty for a dictation. Names the saved .txt. */
let resultSource = '';

const working = () => phase === 'transcribing' || phase === 'preparing' || phase === 'file';
const isBusy = () => !['idle', 'error'].includes(phase);
const canStart = () => ['idle', 'error'].includes(phase) || (phase === 'preparing' && warming);
const valid = (token: number) => token === generation;
/** Longer recordings are finished automatically: the audio stays in memory until recognition (~230 MB per hour). */
const MAX_RECORDING_SECONDS = 60 * 60;
/** Files are sent to GigaAM in pause-aligned parts, so the text appears as it is recognized and Esc stops it quickly. */
const FILE_PART_SECONDS = 5 * 60;
/** The whole file is read into memory to decode its sound track. */
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

function renderUpdate(state = updateState): void {
  updateState = state;
  $('update-status').textContent = state.message;
  const downloading = state.phase === 'downloading';
  const ready = state.phase === 'ready';
  const available = state.phase === 'available';
  $<HTMLButtonElement>('update-check').disabled = ['unsupported', 'checking', 'downloading', 'ready'].includes(state.phase);
  $('update-notice').hidden = !(available || downloading || ready);
  $('update-notice-text').textContent = ready && isBusy() ? `Версия ${state.version} готова. Обновить можно после завершения записи.` : state.message;
  const action = $<HTMLButtonElement>('update-notice-action');
  action.hidden = downloading || !(available || ready);
  action.textContent = ready ? 'Перезапустить и обновить' : 'Скачать';
  action.disabled = ready && (isBusy() || installingUpdate);
}

async function installUpdate(): Promise<void> {
  if (isBusy() || installingUpdate) return;
  installingUpdate = true;
  renderUpdate();
  try {
    flushSettingsSave();
    await saving;
    await api.installUpdate();
  } catch (error) { toast(friendlyError(error), true); }
  finally { installingUpdate = false; renderUpdate(); }
}

function renderWork() {
  const seconds = working() ? (performance.now() - workStarted) / 1000 : lastSeconds;
  const progress = phase === 'preparing' ? downloadPercent : phase === 'file' ? downloadPercent ?? filePercent : undefined;
  $('work-status').hidden = !working();
  if (working()) {
    $('timer').textContent = formatTime(seconds);
    $('work-percent').textContent = progress === undefined ? '' : `${progress}%`;
    const bar = $<HTMLProgressElement>('work-progress');
    if (!progress) bar.removeAttribute('value'); else bar.value = progress;
  }
  return { seconds, progress };
}

function toast(message: string, error = false): void {
  if (toastTimer) clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 10000 : 5000);
}

function setPhase(value: Phase, message?: string): void {
  if (value !== 'preparing') warming = false;
  if ((value === 'transcribing' || value === 'preparing') && !working()) workStarted = performance.now();
  phase = value;
  statusMessage = value === 'error' ? 'Ошибка' : message ?? ({ idle: 'Готово', starting: 'Подключение', recording: 'Запись', transcribing: 'Распознаём речь', preparing: 'Подготовка модели', file: 'Расшифровываем файл', error: 'Ошибка' })[value];
  $('record-card').dataset.phase = value;
  $('status-label').textContent = statusMessage;
  const descriptions: Record<Phase, string> = {
    idle: `${hotkeyLabel(settings.hotkey)} — запись в любом приложении`,
    starting: `Разрешите приложению использовать микрофон, если ${IS_MAC ? 'macOS' : 'Windows'} спросит.`,
    recording: session?.target ? `Текст вставится в выбранное поле${session.enter ? ' и будет нажат Enter' : ''}. Enter — завершить и отправить.` : '',
    transcribing: '',
    preparing: warming ? 'Диктовку можно начать сразу: распознавание дождётся модели.' : 'Первая загрузка может занять несколько минут.',
    file: fileName,
    error: message ?? 'Проверьте настройки и начните снова.',
  };
  $('record-description').textContent = descriptions[value];
  recordButton.disabled = !initialized || value === 'transcribing' || value === 'file' || (value === 'preparing' && !warming);
  const buttonLabel = ({ idle: 'Записать', starting: 'Стоп', recording: 'Стоп', transcribing: 'Распознаём…', preparing: warming ? 'Записать' : 'Подготовка…', file: 'Записать', error: 'Повторить' })[value];
  $('record-button-label').textContent = buttonLabel;
  recordButton.setAttribute('aria-label', buttonLabel);
  $('record-icon').querySelector('use')?.setAttribute('href', value === 'recording' || value === 'starting' ? '#i-stop' : '#i-mic');
  $('cancel-button').hidden = !isBusy();
  fieldset.disabled = !initialized || isBusy();
  $('settings-busy').hidden = !isBusy();
  $<HTMLButtonElement>('prepare-button').disabled = !initialized || isBusy();
  $<HTMLButtonElement>('open-file').disabled = !initialized || !canStart();
  $('setup-card').hidden = modelReady || modelBundled;
  resultText.readOnly = isBusy();
  syncResultActions();
  renderUpdate();
  if (value !== 'recording') bars.forEach(bar => { bar.style.removeProperty('transform'); });
  syncTicker();
  api.status({ phase, message: statusMessage, ...renderWork(), level: 0, targeted: session?.target != null });
}

function friendlyError(error: unknown): string {
  const value = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || /permission|notallowed/i.test(value)) return IS_MAC
    ? 'Нет доступа к микрофону. Разрешите его Voice Scribe в «Системные настройки → Конфиденциальность и безопасность → Микрофон».'
    : 'Нет доступа к микрофону. Разрешите доступ в Windows → Параметры → Конфиденциальность → Микрофон.';
  if (name === 'NotFoundError' || /device not found/i.test(value)) return 'Микрофон не найден. Подключите его и проверьте выбор в настройках.';
  if (name === 'NotReadableError') return 'Не удалось открыть микрофон. Проверьте, не занят ли он другим приложением, и попробуйте снова.';
  if (/decode|EncodingError/i.test(value)) return 'Не удалось прочитать запись с микрофона. Попробуйте ещё раз.';
  if (/fetch|network|download|ENOTFOUND|ERR_INTERNET|HTTP \d/i.test(value)) return 'Не удалось загрузить модель. Проверьте интернет и повторите попытку. Уже загруженная часть сохранится.';
  if (/memory|allocation|out of|bad_alloc/i.test(value)) return 'Недостаточно памяти для модели. Закройте другие программы и попробуйте снова.';
  return value.length > 300 ? `${value.slice(0, 300)}…` : value || 'Не удалось завершить распознавание. Попробуйте ещё раз.';
}

function fail(error: unknown, token: number): void {
  if (!valid(token)) return;
  generation++;
  gesture.reset();
  session?.recorder.cancel();
  session = null;
  // Microphone errors leave the model loaded (or loading); only failed model work restarts GigaAM.
  if (working()) { void api.cancelGigaam().catch(() => {}); modelReady = false; }
  const message = friendlyError(error);
  setPhase('error', message);
  toast(message, true);
}

function syncResultActions(): void {
  $<HTMLButtonElement>('copy-result').disabled = !initialized || isBusy() || !resultText.value.trim();
  $<HTMLButtonElement>('save-result').disabled = $<HTMLButtonElement>('copy-result').disabled;
  const text = resultText.value.trim();
  $('word-count').textContent = `${text ? text.split(/\s+/u).length : 0} слов`;
}

function showResult(text: string, note: string): void {
  resultText.value = text;
  $('result-note').textContent = note;
  syncResultActions();
}

/** Loads GigaAM, downloading it first when it is not bundled; download progress is shown while preparing. */
async function loadModel(token: number): Promise<void> {
  if (modelReady) return;
  const unsubscribe = api.onGigaamProgress(({ pct }) => {
    if (!valid(token) && !warming) return;
    downloadPercent = pct;
    if (phase === 'recording') $('record-description').textContent = `Загружаем модель · ${pct}%. Запись продолжается.`;
    else if (working()) { statusMessage = `Загружаем модель · ${pct}%`; $('status-label').textContent = statusMessage; }
  });
  try { await api.prepareGigaam(); modelReady = true; }
  finally { unsubscribe(); downloadPercent = undefined; }
}

async function recognize(pcm: Float32Array, token: number): Promise<string> {
  // Silence never reaches the model: recordings without speech are skipped, and
  // silence at the edges is cut off. A copy, because IPC would clone the whole buffer of a view.
  const voiced = trimSilence(pcm);
  if (!voiced) return '';
  const audio = voiced.length === pcm.length ? pcm : voiced.slice();
  if (!modelReady) {
    setPhase('transcribing', 'Загружаем модель');
    await loadModel(token);
    if (!valid(token)) return '';
    setPhase('transcribing');
  }
  return (await api.recognizeGigaam(audio, false)).text;
}

async function complete(text: string, token: number, target: string | null, enter: boolean): Promise<void> {
  if (!valid(token)) return;
  const sounds = session?.settings.sounds ?? settings.sounds;
  if (!text) {
    session = null;
    setPhase('idle', 'Речь не обнаружена');
    toast('Не удалось распознать речь. Попробуйте говорить ближе к микрофону.');
    return;
  }
  lastResult = text;
  resultSource = '';
  showResult(text, 'Вставляем текст…');
  let note: string;
  try {
    // A null target explicitly selects clipboard-only delivery for recordings started in this window.
    const delivery = await api.deliver(text, target, enter && target !== null);
    if (!valid(token)) return;
    note = deliveryMessage(delivery, target !== null, enter);
  } catch (error) {
    if (!valid(token)) return;
    note = `Текст готов. Автовставка не выполнена: ${friendlyError(error)}. Нажмите «Копировать».`;
  }
  $('result-note').textContent = note;
  session = null;
  setPhase('idle', 'Готово');
  if (sounds) playCue('done');
  toast(note);
}

function joinPcm(blocks: Float32Array[]): Float32Array {
  const out = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return out;
}

/** Chromium-supported audio formats -> mono PCM at 16 kHz. */
async function decodeAudioTo16kMono(buffer: ArrayBuffer): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await context.decodeAudioData(buffer);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    return mono;
  } finally {
    await context.close();
  }
}

async function transcribeFile(file: File): Promise<void> {
  if (!initialized || !canStart()) return;
  if (file.size > MAX_FILE_BYTES) { toast('Файл больше 2 ГБ. Сохраните из него только звук (например, в MP3) и откройте снова.', true); return; }
  navigate('dictation');
  const token = ++generation;
  session = null;
  fileName = file.name;
  resultSource = file.name;
  filePercent = undefined;
  lastSeconds = 0;
  showResult('', '');
  setPhase('file', 'Читаем файл');
  void loadModel(token).catch(() => {});
  try {
    let pcm: Float32Array;
    try { pcm = await decodeAudioTo16kMono(await file.arrayBuffer()); }
    catch (error) {
      if (/memory|allocation/i.test(String(error))) throw error;
      throw new Error('Не удалось прочитать звук из файла. Подходят MP3, WAV, M4A, OGG, FLAC, а также видео MP4 и WebM.');
    }
    if (!valid(token)) return;
    if (!modelReady) {
      setPhase('file', 'Загружаем модель');
      await loadModel(token);
      if (!valid(token)) return;
    }
    filePercent = 0;
    setPhase('file');
    const texts: string[] = [];
    for (let offset = 0; offset < pcm.length;) {
      let part = pcm.subarray(offset, Math.min(pcm.length, offset + FILE_PART_SECONDS * 16000));
      if (offset + part.length < pcm.length) part = part.subarray(0, quietCut(part));
      offset += part.length;
      // A copy, because IPC would clone the whole buffer of a view.
      const voiced = trimSilence(part);
      const text = voiced ? (await api.recognizeGigaam(voiced.slice(), false)).text.trim() : '';
      if (!valid(token)) return;
      if (text) { texts.push(text); showResult(texts.join(' '), ''); resultText.scrollTop = resultText.scrollHeight; }
      filePercent = Math.floor(offset / pcm.length * 100);
    }
    const duration = formatTime(pcm.length / 16000);
    if (!texts.length) {
      setPhase('idle', 'Речь не обнаружена');
      toast(`В файле «${fileName}» не найдено речи.`);
      return;
    }
    lastResult = texts.join(' ');
    $('result-note').textContent = `Файл «${fileName}» · ${duration}. Текст можно отредактировать и скопировать.`;
    setPhase('idle', 'Готово');
    if (settings.sounds) playCue('done');
    toast('Файл расшифрован.');
  } catch (error) { fail(error, token); }
}

async function start(target: string | null): Promise<void> {
  if (!initialized || !canStart()) return;
  const token = ++generation;
  const active: Session = {
    token, settings: { ...settings }, recorder: new Recorder(), target, enter: false,
    stopRequested: false, pcm: [], tapUnavailable: false,
    voiced: false, voicedTicks: 0, lastVoice: performance.now(), noise: .002,
  };
  session = active;
  lastSeconds = 0;
  $('timer').textContent = '00:00';
  setPhase('starting');
  // Load the model while the user speaks. Errors resurface from recognition.
  void loadModel(token).catch(() => {});
  try {
    await active.recorder.start(active.settings.microphone || undefined, {
      onPcm: pcm => { if (valid(token)) active.pcm.push(pcm); },
      onUnavailable: () => { active.tapUnavailable = true; },
    });
    if (!valid(token)) { active.recorder.cancel(); return; }
    setPhase('recording');
    void refreshMicrophones();
    if (active.stopRequested) { await finish(active.enter); return; }
    if (active.settings.sounds) playCue('start');
  } catch (error) { fail(error, token); }
}

async function finish(enter = false): Promise<void> {
  const active = session;
  if (!active || !valid(active.token)) return;
  if (phase === 'starting') { active.stopRequested = true; active.enter ||= enter; return; }
  if (phase === 'transcribing') { active.enter ||= enter; return; }
  if (phase !== 'recording') return;
  active.enter ||= enter;
  const { token } = active;
  lastSeconds = active.recorder.durationSec;
  setPhase('transcribing');
  try {
    const recording = await active.recorder.stop();
    if (!valid(token)) return;
    let audio: Float32Array | null = !active.tapUnavailable && active.pcm.length ? joinPcm(active.pcm) : null;
    if (!audio && recording) {
      // The PCM tap is unavailable: fall back to decoding the compressed recording.
      audio = await decodeAudioTo16kMono(await recording.blob.arrayBuffer());
      if (!valid(token)) return;
    }
    const text = audio ? (await recognize(audio, token)).trim() : '';
    await complete(text, token, active.target, active.enter);
  } catch (error) { fail(error, token); }
}

function cancel(message = phase === 'file' ? 'Расшифровка отменена' : 'Диктовка отменена', notify = true): void {
  if (!isBusy()) return;
  generation++;
  gesture.reset();
  session?.recorder.cancel();
  session = null;
  // Cancelling kills the GigaAM process, so the model must be loaded again.
  if (working()) { void api.cancelGigaam().catch(() => {}); modelReady = false; }
  lastSeconds = 0;
  $('timer').textContent = '00:00';
  setPhase('idle', message);
  if (notify) toast(message);
}

async function prepare(): Promise<void> {
  if (!initialized || isBusy()) return;
  const token = ++generation;
  warming = true;
  setPhase('preparing');
  try {
    await loadModel(token);
    // A dictation started while preparing supersedes the token, but the model is still ready.
    if (!valid(token)) return;
    setPhase('idle', 'Модель готова');
    toast(`Модель готова. Поставьте курсор в любом приложении и нажмите ${hotkeyLabel(settings.hotkey)}.`);
  } catch (error) { fail(error, token); }
}

async function handleCommand(command: Command): Promise<void> {
  if (!initialized) { pendingCommands.push(command); return; }
  switch (command.action) {
    case 'dictation-down': {
      if (phase === 'file') { toast('Сначала дождитесь расшифровки файла или отмените её.'); break; }
      const startable = canStart();
      const action = gesture.down(startable ? 'idle' : phase, startable ? generation + 1 : generation);
      if (action === 'start') await start(command.target || null);
      else if (action === 'stop') await finish();
      break;
    }
    case 'dictation-up': if (gesture.up(command.heldMs, generation)) await finish(); break;
    case 'dictation-abort':
      // Win+Alt was the start of a Windows shortcut, not a dictation request.
      if (gesture.abort(generation) && (phase === 'starting' || phase === 'recording')) cancel('Готово', false);
      break;
    case 'toggle':
      if (phase === 'starting' || phase === 'recording') await finish();
      else if (canStart()) await start(command.target ?? null);
      break;
    case 'finish-enter': await finish(true); break;
    // The shortcut with Shift still reaches Voice Scribe during a dictation: it simply finishes it.
    case 'finish': if (phase === 'starting' || phase === 'recording') { gesture.reset(); await finish(); } break;
    case 'cancel': cancel(); break;
    case 'paste-last':
      if (!isBusy() && lastResult) {
        try {
          const result = await api.deliver(lastResult, command.target, false);
          toast(deliveryMessage(result, true, false));
        } catch (error) { toast(friendlyError(error), true); }
      } else if (!isBusy()) toast('Пока нет готового текста.');
      break;
    case 'bridge-error': toast(command.message, true); break;
  }
}

function navigate(view: string): void {
  for (const name of ['dictation', 'settings']) $('view-' + name).hidden = name !== view;
  for (const nav of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const active = nav.dataset.view === view;
    nav.classList.toggle('active', active);
    if (active) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  if (view === 'settings') void refreshMicrophones();
  $('view-' + view).scrollTop = 0;
  window.scrollTo(0, 0);
}

function renderHotkeyLabels(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-hotkey]')) element.textContent = hotkeyLabel(settings.hotkey);
}

let hotkeyCapturing = false;
/** A custom shortcut is shown as an extra option before "Своя клавиша…". */
function syncHotkeyOption(): void {
  const select = form.querySelector<HTMLSelectElement>('[name="hotkey"]')!;
  select.querySelector('option[data-custom]')?.remove();
  if (!settings.hotkey.startsWith('key:') || Array.from(select.options).some(option => option.value === settings.hotkey)) return;
  const option = new Option(hotkeyLabel(settings.hotkey), settings.hotkey);
  option.dataset.custom = '';
  select.add(option, select.querySelector<HTMLOptionElement>('option[value="capture"]'));
}
async function captureHotkey(): Promise<void> {
  const select = form.querySelector<HTMLSelectElement>('[name="hotkey"]')!;
  const hint = $('hotkey-hint');
  select.value = settings.hotkey;
  if (hotkeyCapturing) return;
  hotkeyCapturing = true;
  const previousHint = hint.textContent;
  select.disabled = true;
  hint.textContent = 'Нажмите клавишу или сочетание. Esc — отмена.';
  let error = '';
  try {
    const key = await api.captureHotkey();
    if (key) {
      const result = capturedHotkey(key);
      if ('error' in result) error = result.error;
      else if (isHotkey(result.hotkey)) {
        settings = { ...settings, hotkey: result.hotkey };
        syncHotkeyOption();
        select.value = result.hotkey;
        queueSettingsSave();
        toast(`Диктовка: ${hotkeyLabel(result.hotkey)}.`);
      }
    }
  } catch (cause) { error = friendlyError(cause); }
  finally {
    hotkeyCapturing = false;
    select.disabled = false;
    hint.textContent = previousHint;
  }
  if (error) toast(error, true);
}

function applySettings(): void {
  syncHotkeyOption();
  for (const [name, value] of Object.entries(settings)) {
    const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!control) continue;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = String(value);
  }
  renderHotkeyLabels();
}

function queueSettingsSave(): void {
  if (isBusy()) return;
  const next = { ...settings };
  for (const name of Object.keys(next) as Array<keyof Settings>) {
    const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!control) continue;
    const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : name === 'silenceSeconds' ? Number(control.value) : control.value;
    (next as unknown as Record<string, unknown>)[name] = value;
  }
  settings = next;
  renderHotkeyLabels();
  if (phase === 'idle') $('record-description').textContent = `${hotkeyLabel(settings.hotkey)} — запись в любом приложении`;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettingsSave, 300);
}

function flushSettingsSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = { ...settings };
  saving = saving.then(async () => {
    // Saving is silent; only a failure is worth interrupting for.
    try { await api.saveSettings(snapshot); }
    catch (error) { toast(`Настройки не сохранены. ${friendlyError(error)}`, true); }
  });
}

async function refreshMicrophones(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = $<HTMLSelectElement>('microphone-select');
    const current = settings.microphone;
    select.replaceChildren(new Option('Системный по умолчанию', ''));
    let index = 0;
    for (const device of devices.filter(item => item.kind === 'audioinput' && item.deviceId && item.deviceId !== 'default')) {
      select.append(new Option(device.label || `Микрофон ${++index}`, device.deviceId));
    }
    if (current && !Array.from(select.options).some(option => option.value === current)) select.append(new Option('Выбранный микрофон (сейчас недоступен)', current));
    select.value = current;
  } catch { /* Permission may not be granted before the first recording. */ }
}

async function copyText(text: string): Promise<void> {
  try { await api.copy(text); toast('Текст скопирован.'); }
  catch (error) { toast(friendlyError(error), true); }
}

async function saveText(text: string): Promise<void> {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, '0');
  const name = resultSource ? resultSource.replace(/\.[^.]+$/, '') : `Диктовка ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  try {
    const saved = await api.saveText(text, `${name}.txt`);
    if (saved) toast(`Текст сохранён в «${saved}».`);
  } catch (error) { toast(`Не удалось сохранить файл. ${friendlyError(error)}`, true); }
}

function playCue(kind: 'start' | 'done'): void {
  try {
    cueContext ??= new AudioContext();
    if (cueContext.state === 'suspended') void cueContext.resume();
    const when = cueContext.currentTime + .02;
    for (const [index, frequency] of (kind === 'start' ? [523.25, 783.99] : [783.99, 1046.5]).entries()) {
      const oscillator = cueContext.createOscillator();
      const gain = cueContext.createGain();
      const time = when + index * .09;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, time);
      gain.gain.exponentialRampToValueAtTime(.055, time + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, time + .11);
      oscillator.connect(gain).connect(cueContext.destination);
      oscillator.start(time); oscillator.stop(time + .15);
    }
  } catch { /* A sound cue must never prevent recording. */ }
}

const levels = new Float32Array(512);
/** Runs only while busy: an idle window has nothing to animate or report. */
let ticker: ReturnType<typeof setInterval> | null = null;
function syncTicker(): void {
  if (isBusy() && !ticker) ticker = setInterval(tick, 100);
  else if (!isBusy() && ticker) { clearInterval(ticker); ticker = null; }
}
function tick(): void {
  let level = 0;
  const active = session;
  if (phase === 'recording' && active) {
    lastSeconds = active.recorder.durationSec;
    $('timer').textContent = formatTime(lastSeconds);
    if (lastSeconds >= MAX_RECORDING_SECONDS) {
      toast('Запись длилась час и завершена автоматически.');
      void finish();
      return;
    }
    if (active.recorder.analyser) {
      active.recorder.analyser.getFloatTimeDomainData(levels);
      const rms = Math.sqrt(levels.reduce((sum, sample) => sum + sample * sample, 0) / levels.length);
      level = Math.min(1, rms * 7);
      const now = performance.now();
      const voiced = rms > Math.max(.01, active.noise * 3);
      if (lastSeconds > .55) {
        if (voiced) { active.voicedTicks++; active.lastVoice = now; if (active.voicedTicks >= 2) active.voiced = true; }
        else { active.voicedTicks = 0; active.noise = Math.min(.012, active.noise * .96 + rms * .04); }
        if (active.voiced && active.settings.silenceSeconds > 0 && now - active.lastVoice > active.settings.silenceSeconds * 1000) void finish();
        else if (!active.voiced && lastSeconds >= 15) { cancel('Запись отменена: 15 секунд без речи.'); return; }
      }
    }
    if (!reducedMotion.matches) {
      bars.forEach((bar, i) => {
        const amplitude = .14 + Math.min(.86, level * (.35 + Math.abs(Math.sin(i * .71 + performance.now() / 270))));
        bar.style.transform = `scaleY(${amplitude})`;
      });
    } else {
      bars.forEach(bar => { bar.style.removeProperty('transform'); });
    }
  }
  api.status({ phase, message: statusMessage, ...renderWork(), level, targeted: session?.target != null });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.addEventListener('click', () => navigate(button.dataset.view!));
recordButton.addEventListener('click', () => { if (phase === 'recording' || phase === 'starting') void finish(); else void start(null); });
$('cancel-button').addEventListener('click', () => cancel());
// "Своя клавиша…" records a shortcut instead of being saved as a setting.
form.querySelector('[name="hotkey"]')!.addEventListener('change', event => {
  if ((event.target as HTMLSelectElement).value !== 'capture') return;
  event.stopPropagation();
  void captureHotkey();
});
$('prepare-button').addEventListener('click', () => void prepare());
$('hide-window').addEventListener('click', () => api.hide());
$('copy-result').addEventListener('click', () => void copyText(resultText.value));
$('save-result').addEventListener('click', () => void saveText(resultText.value));
const fileInput = $<HTMLInputElement>('file-input');
$('open-file').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) void transcribeFile(file);
});
// A dropped file is transcribed; without this Chromium would try to open it as a page.
document.addEventListener('dragover', event => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = canStart() ? 'copy' : 'none';
});
document.addEventListener('drop', event => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  if (canStart()) void transcribeFile(file);
  else toast('Дождитесь окончания текущей записи или расшифровки.');
});
resultText.addEventListener('input', () => { lastResult = resultText.value; syncResultActions(); });
let nativePermission: string | undefined;
function renderNativeHealth(state: import('../main/native-recovery').NativeHealth): void {
  // Shown only when the global shortcuts need attention.
  $('native-problem').hidden = state.ready;
  $('native-health').textContent = state.message;
  const button = $<HTMLButtonElement>('native-restart');
  button.disabled = state.retrying;
  // macOS: the helper waits for a permission and connects by itself once it is granted.
  button.textContent = state.permission ? 'Открыть настройки' : 'Подключить заново';
  if (state.permission && state.permission !== nativePermission) toast(state.message, true);
  nativePermission = state.permission;
}
$('native-restart').addEventListener('click', () => {
  const action = nativePermission ? api.openAccessibilitySettings() : api.restartNative();
  void action.catch(error => toast(friendlyError(error), true));
});
const unsubscribeNative = api.onNativeHealth(renderNativeHealth);
void api.getNativeHealth().then(renderNativeHealth).catch(() => {});
form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('change', queueSettingsSave);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && isBusy()) { event.preventDefault(); cancel(); } });
navigator.mediaDevices?.addEventListener('devicechange', () => void refreshMicrophones());
const unsubscribe = api.onCommand(command => { void handleCommand(command); });
const unsubscribeUpdates = api.onUpdateState(renderUpdate);
$('update-check').addEventListener('click', () => { void api.checkForUpdates().then(renderUpdate).catch(error => toast(friendlyError(error), true)); });
$('update-notice-action').addEventListener('click', () => {
  if (updateState.phase === 'ready') void installUpdate();
  else void api.downloadUpdate().then(renderUpdate).catch(error => toast(friendlyError(error), true));
});
window.addEventListener('beforeunload', () => {
  unsubscribeNative();
  if (ticker) clearInterval(ticker);
  unsubscribe();
  unsubscribeUpdates();
  session?.recorder.cancel();
  void api.cancelGigaam().catch(() => {});
  if (cueContext) void cueContext.close();
});

/** macOS: its own shortcut presets (Control+Space switches the input source) and names. */
function adaptToMac(): void {
  const select = form.querySelector<HTMLSelectElement>('[name="hotkey"]')!;
  const presets: Array<[string, string]> = [[MAC_DEFAULT_HOTKEY, hotkeyLabel(MAC_DEFAULT_HOTKEY)], ['ctrl-space', '⌃ Space'], ['ctrl-alt-space', '⌃⌥ Space'], ['win-alt', 'Левые ⌘ + ⌥'], ['capture', 'Своя клавиша…']];
  select.replaceChildren(...presets.map(([value, label]) => new Option(label, value)));
  $('login-label').textContent = 'Запускать при входе в систему';
  $('paste-last-key').textContent = hotkeyLabel('key:ctrl+alt+86' as never, true, true);
}
if (IS_MAC) adaptToMac();

async function boot(): Promise<void> {
  void api.getUpdateState().then(renderUpdate).catch(() => renderUpdate({ phase: 'error', message: 'Не удалось проверить доступность обновлений.' }));
  setPhase('idle');
  const loaded = await Promise.allSettled([api.getSettings(), api.getAppInfo()]);
  if (loaded[0].status === 'fulfilled') settings = { ...DEFAULT_SETTINGS, ...loaded[0].value };
  else toast('Не удалось прочитать настройки. Используются настройки по умолчанию.', true);
  if (loaded[1].status === 'fulfilled') {
    const info = loaded[1].value;
    $('version').textContent = `Voice Scribe ${info.version}`;
    modelBundled = info.modelBundled;
    if (!info.nativeReady && !nativePermission) toast(`Глобальные клавиши пока недоступны. Диктовка кнопкой работает; текст можно вставить через ${IS_MAC ? '⌘V' : 'Ctrl + V'}.`, true);
  }
  await refreshMicrophones();
  applySettings();
  initialized = true;
  setPhase('idle');
  // Dispatch without awaiting: key-up must reach a pending microphone start.
  const queued = pendingCommands;
  pendingCommands = [];
  for (const command of queued) void handleCommand(command);
}
void boot().catch(error => { initialized = true; setPhase('error', friendlyError(error)); });
