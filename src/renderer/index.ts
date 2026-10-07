import { decodeAudioTo16kMono, type ProgressInfo } from '../asr/client';
import { Recognizer } from './recognizer';
import { appendFileTranscript } from '../asr/file-transcript';
import { makeProofreadBatches, type ProofreadBatch } from '../shared/proofread-batch';
import { Recorder } from '../asr/recorder';
import { DEFAULT_SETTINGS, type Settings, type HistoryItem, type Phase, type Command } from '../shared/contracts';
import { applyVoiceCommands, applyReplacements, parseReplacements } from '../shared/clean';
import { Segmenter, joinSegments } from '../shared/live';
import { DictationGesture } from './gesture';
import { deliveryMessage } from './delivery-message';
import { formatTimestamp, normalizeSegments, transcriptText, type TranscriptDetails, type SubtitleFormat } from '../shared/transcript';
import { TranscriptEditor, type TranscriptView } from './transcript-editor';
import { assignSpeakers } from '../shared/speakers';
import { inferCorrection } from '../shared/corrections';
import { PROVIDERS, providerFor } from '../shared/providers';
import { renderReview, type ReviewBlock } from './proofread-review';
import { keepSurroundingSpace, type ProofreadResult, type ProofreadMode } from '../shared/proofread';
import { WorkProgress } from '../shared/work-progress';
import { effectiveModel, type ModelEntry } from '../shared/models';
import { applyProfile, findProfile, normalizeApp, type AppProfile } from '../shared/profiles';
import type { UpdateState } from '../shared/updates';
import { HOTKEYS } from '../shared/hotkeys';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};
const api = window.scribe;
const asr = new Recognizer(api);
const gesture = new DictationGesture();
const form = $<HTMLFormElement>('settings-form');
const fieldset = $<HTMLFieldSetElement>('settings-fieldset');
const resultText = $<HTMLTextAreaElement>('result-text');
const editor = new TranscriptEditor();
const correctionDialog = $<HTMLDialogElement>('correction-dialog');
const fileOptionsDialog = $<HTMLDialogElement>('file-options-dialog');
document.querySelector('#file-options-form button[value="cancel"]')!.addEventListener('click', () => fileOptionsDialog.close('cancel'));
const correctionForm = $<HTMLFormElement>('correction-form');
const correctionFrom = $<HTMLInputElement>('correction-from');
const correctionTo = $<HTMLInputElement>('correction-to');
const correctionBaselines = new WeakMap<HTMLTextAreaElement, string>();
let correctionInput: HTMLTextAreaElement | null = null;
let composingInput: HTMLTextAreaElement | null = null;
let correctionSaving = false;
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
  proofread: boolean;
  proofreadMode?: ProofreadMode;
  proofreadingStarted?: boolean;
  stopRequested: boolean;
  segmenter: Segmenter | null;
  /** Executable whose application profile this dictation uses. */
  profile?: string;
  /** Raw 16 kHz microphone blocks; recognized directly, without the Opus round trip. */
  pcm: Float32Array[];
  parts: string[];
  jobs: Promise<void>[];
  liveUnavailable: boolean;
  liveFailed: boolean;
  voiced: boolean;
  voicedTicks: number;
  lastVoice: number;
  noise: number;
}
let settings: Settings = { ...DEFAULT_SETTINGS };
let history: HistoryItem[] = [];
let phase: Phase = 'idle';
let statusMessage = 'Готово';
let generation = 0;
let session: Session | null = null;
let initialized = false;
let lastResult = '';
/** PCM of the last dictation, in memory only, for "Перераспознать". Bound to its history entry. */
let lastAudio: { pcm: Float32Array; historyId?: string } | null = null;
/** Twenty minutes of 16 kHz float PCM is about 77 MB; longer recordings are not kept. */
const MAX_KEPT_AUDIO = 20 * 60 * 16000;
let beforeProofread: ReturnType<typeof editor.snapshot> | null = null;
let reviewText: string | null = null;
let updateState: UpdateState = { phase: 'idle', message: 'Проверяем доступность обновлений…' };
let installingUpdate = false;

function renderUpdate(state = updateState): void {
  updateState = state;
  $('update-status').textContent = state.message;
  const downloading = state.phase === 'downloading';
  const ready = state.phase === 'ready';
  const available = state.phase === 'available';
  $<HTMLButtonElement>('update-check').disabled = ['unsupported', 'checking', 'downloading', 'ready'].includes(state.phase);
  $('update-download').hidden = !available;
  $('update-install').hidden = !ready;
  $<HTMLButtonElement>('update-install').disabled = isBusy() || installingUpdate;
  $('update-notice').hidden = !(available || downloading || ready);
  $('update-notice-text').textContent = ready && isBusy() ? `Версия ${state.version} готова. Обновить можно после завершения обработки.` : state.message;
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
    flushHistorySave();
    flushSettingsSave();
    await Promise.all([historySaving, saving]);
    await api.installUpdate();
  } catch (error) { toast(friendlyError(error), true); }
  finally { installingUpdate = false; renderUpdate(); }
}

function showProofreadReview(blocks: ReviewBlock[]): void {
  reviewText = blocks.length ? editor.text : null;
  renderReview($('proofread-review'), blocks, (block,quote) => {
    if(isBusy() || reviewText!==editor.text)return;
    if(block.segment!==undefined)setTranscriptView('segments');
    const input=block.segment===undefined ? resultText : $<HTMLTextAreaElement>(`segment-${block.segment}`);
    const start=input.value.indexOf(quote);
    if(start<0)return;
    input.focus();input.setSelectionRange(start,start+quote.length);input.scrollIntoView({block:'center',behavior:'smooth'});
  });
}
function syncReviewState(): void {
  if(reviewText===null)return;
  const stale=reviewText!==editor.text;
  $('review-state').textContent=stale?'Текст уже изменён вручную. Ниже показан отчёт до этих изменений. Повторите вычитку для новых замечаний.':'';
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-review-select]'))button.disabled=stale || isBusy();
}
let currentHistoryId: string | undefined;
let previousEditor = { content: editor.snapshot(), label: 'Текст', note: '', historyId: currentHistoryId };
let historySaveTimer: ReturnType<typeof setTimeout> | null = null;
let historySaving: Promise<void> = Promise.resolve();
let pendingHistorySave: { id: string; text: string; details: TranscriptDetails; revision: number } | null = null;
let historyRevision = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let pendingCommands: Command[] = [];
let cueContext: AudioContext | null = null;
/** Plays one cue of a file transcript from its source file (scribe://app/media/<history id>). */
const player = new Audio();
let playingCue: { index: number; end: number } | null = null;
let lastSeconds = 0;
const workProgress = new WorkProgress();
let workStarted = 0;
let workStage = '';
const working = () => phase === 'transcribing' || phase === 'preparing';

function renderWork() {
  const now = performance.now();
  const seconds = working() ? (now - workStarted) / 1000 : lastSeconds;
  const remainingSeconds = working() ? workProgress.remaining(now) : undefined;
  const progress = working() ? workProgress.percent : undefined;
  $('work-status').hidden = !working();
  if (working()) {
    $('timer').textContent = formatTime(seconds);
    $('timer').setAttribute('aria-label', 'Прошло времени обработки');
    $('work-title').textContent = statusMessage;
    $('work-percent').textContent = progress === undefined ? '' : `${Math.floor(progress)}%`;
    const bar = $<HTMLProgressElement>('work-progress');
    if (progress === undefined || progress === 0) bar.removeAttribute('value'); else bar.value = progress;
    $('work-elapsed').textContent = `Прошло ${formatTime(seconds)}`;
    $('work-remaining').textContent = remainingSeconds === undefined
      ? 'Оцениваем оставшееся время…' : `До конца этапа ≈ ${formatTime(remainingSeconds)}`;
  }
  return { seconds, progress, remainingSeconds };
}
let historyClearing = false;
// Startup warmup only loads the model; dictation may start and queue behind it.
let warming = false;

const isBusy = () => historyClearing || !['idle', 'error'].includes(phase);
const canStart = () => !historyClearing && (['idle', 'error'].includes(phase) || (phase === 'preparing' && warming));
const valid = (token: number) => token === generation;
const modelName = (model: Settings['model']) => model === 'auto' ? 'Авто' : model === 'turbo-hq' ? 'Turbo HQ' : model === 'gigaam' ? 'GigaAM v3' : model[0].toUpperCase() + model.slice(1);
/** GigaAM recognizes Russian only; the language settings apply to Whisper. */
const engineSummary = (value: Settings) => effectiveModel(value) === 'gigaam' ? `${value.model === 'auto' ? 'Авто · ' : ''}GigaAM v3 · только русский` : `Whisper · ${modelName(value.model)} · ${value.language === 'auto' ? 'Автоязык' : value.language.toUpperCase()}`;
const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

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
  workProgress.reset(performance.now());
  workStage = '';
  if (!isBusy() && !['idle', 'error'].includes(value)) {
    flushHistorySave();
    previousEditor = { content: editor.snapshot(), label: $('result-label').textContent || 'Текст', note: $('result-note').textContent || '', historyId: currentHistoryId };
  }
  phase = value;
  statusMessage = value === 'error' ? 'Ошибка' : message ?? ({ idle: 'Готово', starting: 'Подключение', recording: 'Запись', transcribing: 'Распознавание', preparing: 'Подготовка модели', error: 'Ошибка' })[value];
  $('record-card').dataset.phase = value;
  $('status-label').textContent = statusMessage;
  const titles: Record<Phase, string> = {
    idle: 'Диктовка', starting: 'Подключение микрофона',
    recording: 'Запись', transcribing: 'Распознавание',
    preparing: 'Подготовка модели', error: 'Ошибка',
  };
  const descriptions: Record<Phase, string> = {
    idle: '',
    starting: 'Разрешите приложению использовать микрофон, если Windows спросит.',
    recording: session?.target ? `После остановки текст вставится в выбранное поле.${session.profile ? ` Профиль: ${session.profile}.` : ''}` : '',
    transcribing: '',
    preparing: warming ? 'Диктовку можно начать сразу: распознавание дождётся модели.' : 'Первая загрузка может занять несколько минут.',
    error: message ?? 'Проверьте настройки и начните снова.',
  };
  $('record-title').textContent = titles[value];
  $('record-description').textContent = descriptions[value];
  recordButton.disabled = !initialized || value === 'transcribing' || (value === 'preparing' && !warming);
  const buttonLabel = ({ idle: 'Записать', starting: 'Стоп', recording: 'Стоп', transcribing: 'Распознаём…', preparing: warming ? 'Записать' : 'Подготовка…', error: 'Повторить' })[value];
  $('record-button-label').textContent = buttonLabel;
  recordButton.setAttribute('aria-label', buttonLabel);
  $('record-icon').querySelector('use')?.setAttribute('href', value === 'recording' || value === 'starting' ? '#i-stop' : '#i-mic');
  $('cancel-button').hidden = !isBusy();
  fieldset.disabled = !initialized || isBusy();
  $('settings-busy').hidden = !isBusy();
  $<HTMLButtonElement>('pick-file').disabled = !initialized || isBusy();
  $<HTMLButtonElement>('prepare-button').disabled = !initialized || isBusy();
  resultText.readOnly = isBusy() || editor.segments.length > 0;
  for (const input of document.querySelectorAll<HTMLInputElement>('.segment-speaker')) input.disabled = isBusy();
  for (const input of document.querySelectorAll<HTMLTextAreaElement>('.segment-text')) input.readOnly = isBusy();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-open-history], [data-pin-history]')) button.disabled = isBusy();
  $<HTMLButtonElement>('clear-history').disabled = !history.length || isBusy();
  syncResultActions();
  renderUpdate();
  if (value !== 'recording') bars.forEach(bar => { bar.style.removeProperty('transform'); });
  api.status({ phase, message: statusMessage, ...renderWork(), level: 0 });
}

function messageProgress(progress: ProgressInfo, token: number): void {
  if (!valid(token)) return;
  if (progress.note === 'webgpu-fallback') toast('Видеокарта недоступна. Распознавание продолжится на процессоре.');
  if (progress.note === 'cache-write-failed') toast('Не удалось сохранить модель на диск. При следующем запуске потребуется загрузка.', true);
  let message = 'Распознаём речь';
  if (progress.stage === 'device') message = 'Выбираем устройство';
  if (progress.stage === 'model') {
    message = progress.dl ? 'Загружаем модель' : 'Загружаем модель в память';
    if (typeof progress.pct === 'number') message += ` · ${Math.round(progress.pct)}%`;
  }
  if (phase === 'recording') {
    if (progress.stage === 'model') $('record-description').textContent = `${message}. Запись продолжается.`;
  } else {
    if (workStage !== progress.stage) {
      workStage = progress.stage;
      workProgress.reset(performance.now());
    }
    if (progress.stage === 'run') workProgress.update(progress.pct, performance.now());
    statusMessage = message;
    $('status-label').textContent = message;
    $('record-description').textContent = progress.stage === 'model'
      ? `${message}. Аудио остаётся на вашем компьютере.` : 'Можно отменить распознавание клавишей Esc.';
  }
  if (progress.tail && phase === 'transcribing') showResult(progress.tail, 'Сейчас распознаётся', 'Последние слова из аудио. Полная расшифровка появится после завершения.', false);
}

function friendlyError(error: unknown): string {
  const value = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || /permission|notallowed/i.test(value)) return 'Нет доступа к микрофону. Разрешите доступ в Windows → Параметры → Конфиденциальность → Микрофон.';
  if (name === 'NotFoundError' || /device not found/i.test(value)) return 'Микрофон не найден. Подключите его и проверьте выбор в настройках.';
  if (name === 'NotReadableError') return 'Не удалось открыть микрофон. Проверьте, не занят ли он другим приложением, и попробуйте снова.';
  if (/decode|EncodingError|AUDIO_/i.test(value)) return 'Не удалось прочитать аудио. Попробуйте файл WAV, MP3, M4A, OGG или WebM.';
  if (/fetch|network|download|ENOTFOUND|ERR_INTERNET/i.test(value)) return 'Не удалось загрузить модель. Проверьте интернет и повторите попытку. Уже загруженные файлы останутся в кэше.';
  if (/memory|allocation|out of|bad_alloc/i.test(value)) return 'Недостаточно памяти для модели. Выберите Tiny или Base в настройках.';
  if (/WORKER_/i.test(value)) return 'Не удалось запустить распознавание. Перезапустите приложение. Если ошибка повторится, выберите процессор в настройках.';
  return value.length > 300 ? `${value.slice(0, 300)}…` : value || 'Не удалось завершить распознавание. Попробуйте ещё раз.';
}

function fail(error: unknown, token: number): void {
  if (!valid(token) || (error instanceof Error && error.name === 'AbortError')) return;
  generation++;
  gesture.reset();
  session?.recorder.cancel();
  session = null;
  asr.cancel();
  void api.cancelDiarization().catch(() => {});
  $('setup-card').hidden = false;
  const message = friendlyError(error);
  restoreEditor();
  setPhase('error', message);
  toast(message, true);
}

function processText(text: string, options: Settings): string {
  return applyReplacements(options.voiceCommands ? applyVoiceCommands(text) : text, parseReplacements(options.replacements)).trim();
}

function syncResultActions(completed = true): void {
  syncReviewState();
  const disabled = !initialized || isBusy() || !completed || !resultText.value.trim();
  $<HTMLButtonElement>('copy-result').disabled = disabled;
  $<HTMLButtonElement>('export-result').disabled = disabled;
  $<HTMLButtonElement>('proofread-result').disabled = disabled || correctionSaving || composingInput !== null;
  $<HTMLButtonElement>('undo-proofread').disabled = disabled;
  $('undo-proofread').hidden = !beforeProofread;
  $('retranscribe').hidden = !lastAudio?.historyId || lastAudio.historyId !== currentHistoryId;
  $<HTMLButtonElement>('retranscribe').disabled = !initialized || isBusy() || correctionSaving;
  $<HTMLButtonElement>('remember-correction').disabled = !initialized || isBusy() || correctionSaving || composingInput !== null;
  for (const format of ['srt', 'vtt']) $<HTMLButtonElement>('export-' + format).disabled = disabled || !editor.segments.some(segment => segment.text.trim());
}

function updateResultText(): void {
  resultText.value = editor.text;
  $('word-count').textContent = `${editor.text.trim() ? editor.text.trim().split(/\s+/u).length : 0} слов`;
  syncResultActions();
}

function trackCorrectionInput(input: HTMLTextAreaElement): void {
  correctionBaselines.set(input, input.value);
  input.addEventListener('focus', () => { correctionInput = input; });
  input.addEventListener('select', () => { correctionInput = input; });
  input.addEventListener('input', () => { correctionInput = input; });
  input.addEventListener('compositionstart', () => { composingInput = input; syncResultActions(); });
  input.addEventListener('compositionend', () => { composingInput = null; syncResultActions(); });
}

function resetCorrectionDraft(): void {
  correctionInput = null;
  composingInput = null;
  correctionBaselines.set(resultText, editor.text);
}

function openCorrection(): void {
  if (!initialized || isBusy() || correctionSaving || correctionDialog.open || composingInput) return;
  const input = correctionInput?.isConnected ? correctionInput : null;
  const selected = input?.value.slice(input.selectionStart, input.selectionEnd).trim() ?? '';
  const inferred = input ? inferCorrection(correctionBaselines.get(input) ?? input.value, input.value) : null;
  correctionFrom.value = selected || inferred?.from || '';
  correctionTo.value = selected ? '' : inferred?.to || '';
  $('correction-error').hidden = true;
  $('correction-error').textContent = '';
  flushSettingsSave();
  flushHistorySave();
  gesture.reset();
  correctionDialog.showModal();
  if (correctionFrom.value) correctionTo.focus(); else correctionFrom.focus();
}

function setCorrectionSaving(value: boolean): void {
  correctionSaving = value;
  for (const input of correctionForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) input.disabled = value;
  $('correction-save').textContent = value ? 'Сохраняем…' : 'Запомнить';
  correctionForm.setAttribute('aria-busy', String(value));
  fieldset.disabled = !initialized || isBusy() || value;
  syncResultActions();
}

function saveCorrection(): void {
  if (correctionSaving || !correctionDialog.open || !correctionForm.reportValidity()) return;
  const from = correctionFrom.value;
  const to = correctionTo.value;
  $('correction-error').hidden = true;
  flushSettingsSave();
  setCorrectionSaving(true);
  saving = saving.then(async () => {
    try {
      const learned = await api.rememberCorrection(from, to);
      settings = { ...settings, replacements: learned.replacements };
      form.querySelector<HTMLTextAreaElement>('[name="replacements"]')!.value = learned.replacements;
      $('settings-saved').textContent = 'Все изменения сохранены';
      if (correctionInput?.isConnected) correctionBaselines.set(correctionInput, correctionInput.value);
      correctionDialog.close();
      toast('Исправление запомнено. Оно применится к следующим расшифровкам.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      $('correction-error').textContent = /REPLACEMENTS_TOO_LONG/.test(message)
        ? 'Словарь заполнен. Удалите ненужные правила в настройках и повторите.'
        : /INVALID_CORRECTION/.test(message)
          ? 'Введите разные слова или фразы до 200 символов. В поле «Распознано» нельзя использовать =, →, ->, переносы строк или # в начале.'
          : `Не удалось сохранить исправление: ${friendlyError(error)}`;
      $('correction-error').hidden = false;
    } finally {
      setCorrectionSaving(false);
    }
  });
}

function setTranscriptView(view: TranscriptView): void {
  editor.view = editor.segments.length ? view : 'text';
  resultText.hidden = editor.view === 'segments';
  $('transcript-segments').hidden = editor.view !== 'segments';
  $('result-view-text').setAttribute('aria-pressed', String(editor.view === 'text'));
  $('result-view-segments').setAttribute('aria-pressed', String(editor.view === 'segments'));
  $('transcript-help').textContent = editor.view === 'segments'
    ? `Таймкоды определены автоматически и могут быть неточными. Исправляйте текст в фрагментах.${editor.segments.some(cue => cue.speaker) ? ' Имя оратора меняется во всей расшифровке. Чтобы объединить лишние метки одного голоса, задайте им одинаковое имя. «Не определён» и «Несколько ораторов» меняются только у выбранной реплики.' : ''}${currentHistoryId ? ' Правки сохраняются в истории.' : ''}`
    : 'Текст собран из фрагментов. Для исправлений откройте «Таймкоды».';
}

function renderTranscript(): void {
  const timed = editor.segments.length > 0;
  $('transcript-toolbar').hidden = !timed;
  $('transcript-help').hidden = !timed;
  $('transcript-name').hidden = !editor.name;
  $('transcript-name').textContent = editor.name ?? '';
  $('transcript-count').textContent = `${editor.segments.length} фрагм.`;
  stopPlayback();
  $('transcript-segments').replaceChildren();
  const playable = Boolean(currentHistoryId && history.find(item => item.id === currentHistoryId)?.audioPath);
  const fragment = document.createDocumentFragment();
  for (const [index, segment] of editor.segments.entries()) {
    const row = document.createElement('li');
    row.className = 'transcript-segment';
    const time = document.createElement('label');
    time.className = 'segment-time';
    time.htmlFor = `segment-${index}`;
    time.textContent = `${formatTimestamp(segment.start)} — ${formatTimestamp(segment.end)}`;
    const input = document.createElement('textarea');
    input.id = `segment-${index}`;
    input.className = 'segment-text';
    input.value = segment.text;
    input.spellcheck = true;
    input.readOnly = isBusy();
    input.setAttribute('aria-label', `Фрагмент ${index + 1}, ${time.textContent}`);
    trackCorrectionInput(input);
    input.addEventListener('input', () => {
      editor.editSegment(index, input.value);
      updateResultText();
      lastResult = editor.text;
      queueHistorySave();
    });
    input.addEventListener('change', flushHistorySave);
    const meta = document.createElement('div');
    meta.className = 'segment-meta';
    if (playable) {
      const head = document.createElement('div');
      head.className = 'segment-head';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'icon-button segment-play';
      play.dataset.cue = String(index);
      play.setAttribute('aria-pressed', 'false');
      play.setAttribute('aria-label', `Прослушать фрагмент ${index + 1}`);
      play.title = 'Прослушать фрагмент';
      play.innerHTML = '<svg aria-hidden="true"><use href="#i-play"/></svg>';
      play.addEventListener('click', () => toggleCue(index));
      head.append(play, time);
      meta.append(head);
    } else meta.append(time);
    if (editor.segments.some(cue => cue.speaker)) {
      const speaker = document.createElement('input');
      speaker.className = 'segment-speaker';
      speaker.value = segment.speaker ?? '';
      speaker.placeholder = 'Не определён';
      speaker.maxLength = 80;
      speaker.disabled = isBusy();
      speaker.setAttribute('aria-label', 'Оратор фрагмента ' + (index + 1));
      speaker.title = 'Переименовать этого оратора во всей расшифровке. Одинаковые имена объединяют метки.';
      speaker.addEventListener('change', () => {
        editor.renameSpeaker(index, speaker.value);
        document.querySelectorAll<HTMLInputElement>('.segment-speaker').forEach((input, i) => {
          input.value = editor.segments[i].speaker ?? '';
        });
        updateResultText();
        lastResult = editor.text;
        queueHistorySave();
        flushHistorySave();
      });
      meta.append(speaker);
    }
    row.append(meta, input);
    fragment.append(row);
  }
  $('transcript-segments').append(fragment);
  resultText.readOnly = isBusy() || timed;
  setTranscriptView(editor.view);
}

function markPlaying(index: number | null): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.segment-play')) {
    const active = Number(button.dataset.cue) === index;
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? 'Остановить' : 'Прослушать фрагмент';
    button.querySelector('use')?.setAttribute('href', active ? '#i-stop' : '#i-play');
    button.closest('.transcript-segment')?.classList.toggle('playing', active);
  }
}

function stopPlayback(): void {
  if (!playingCue) return;
  playingCue = null;
  player.pause();
  markPlaying(null);
}

function toggleCue(index: number): void {
  if (playingCue?.index === index) { stopPlayback(); return; }
  const cue = editor.segments[index];
  if (!cue || !currentHistoryId || phase === 'recording' || phase === 'starting') return;
  const source = new URL(`./media/${encodeURIComponent(currentHistoryId)}`, window.location.href).href;
  if (player.src !== source) player.src = source;
  playingCue = { index, end: cue.end };
  markPlaying(index);
  player.currentTime = cue.start;
  void player.play().catch(error => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    stopPlayback();
    toast('Не удалось проиграть фрагмент: исходный файл перемещён, удалён или его формат не поддерживается.', true);
  });
}

player.addEventListener('timeupdate', () => { if (playingCue && player.currentTime >= playingCue.end) stopPlayback(); });
player.addEventListener('ended', stopPlayback);
player.addEventListener('error', () => {
  if (!playingCue) return;
  stopPlayback();
  toast('Не удалось проиграть фрагмент: исходный файл перемещён, удалён или его формат не поддерживается.', true);
});

function showResult(text: string, label: string, note: string, completed: boolean, details: TranscriptDetails & { historyId?: string; view?: TranscriptView } = {}): void {
  showProofreadReview([]);
  beforeProofread = null;
  flushHistorySave();
  editor.load(text, details.segments, details.name, details.view);
  currentHistoryId = details.historyId;
  $('transcript-save').textContent = '';
  $('result-card').hidden = false;
  $('result-label').textContent = label;
  $('result-note').textContent = note;
  renderTranscript();
  updateResultText();
  resetCorrectionDraft();
  syncResultActions(completed);
}

function restoreEditor(): void {
  flushHistorySave();
  editor.restore(previousEditor.content);
  currentHistoryId = previousEditor.historyId;
  $('result-label').textContent = previousEditor.label;
  $('result-note').textContent = previousEditor.note;
  $('transcript-save').textContent = '';
  renderTranscript();
  updateResultText();
  resetCorrectionDraft();
}

function flushHistorySave(): void {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = null;
  const pending = pendingHistorySave;
  if (!pending) return;
  pendingHistorySave = null;
  historySaving = historySaving.then(async () => {
    try {
      await api.updateHistory(pending.id, pending.text, pending.details);
      // The list is rebuilt on navigation; avoid re-rendering it on every edit.
      if (!$('view-history').hidden) renderHistory();
      if (currentHistoryId === pending.id && historyRevision === pending.revision) $('transcript-save').textContent = 'Правки сохранены';
    } catch (error) {
      if (currentHistoryId === pending.id && historyRevision === pending.revision) $('transcript-save').textContent = 'Правки не сохранены';
      toast(`Не удалось сохранить правки в истории: ${friendlyError(error)}. Можно сохранить текущий текст в файл.`, true);
    }
  });
}

function queueHistorySave(): void {
  if (!currentHistoryId) return;
  if (pendingHistorySave && pendingHistorySave.id !== currentHistoryId) flushHistorySave();
  const content = editor.snapshot();
  pendingHistorySave = { id: currentHistoryId, text: content.text, details: { segments: content.segments, name: content.name }, revision: ++historyRevision };
  // Reopening history before the disk write completes should show the latest edits.
  history = history.map(item => item.id === currentHistoryId ? { ...item, text: content.text, segments: content.segments, name: content.name } : item);
  $('transcript-save').textContent = 'Сохраняем правки…';
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(flushHistorySave, 350);
}

async function exportSubtitles(format: SubtitleFormat): Promise<void> {
  if (isBusy() || !editor.text.trim() || !editor.segments.length) return;
  try {
    const saved = await api.saveSubtitles(editor.segments, format, editor.name);
    if (saved) toast(`Субтитры ${format.toUpperCase()} сохранены.`);
  } catch (error) { toast(friendlyError(error), true); }
}

async function complete(text: string, source: 'dictation' | 'file', token: number, target: string | null, enter: boolean, details: TranscriptDetails = {}): Promise<void> {
  if (!valid(token)) return;
  if (!text) {
    session = null;
    restoreEditor();
    setPhase('idle', 'Речь не обнаружена');
    toast('Не удалось распознать речь. Попробуйте говорить ближе к микрофону.');
    return;
  }
  showResult(text, 'Текст', 'Сохраняем результат…', true, details);
  let historyId: string | undefined;
  try {
    const item = await api.addHistory(text, source, details);
    historyId = item.id;
    history = await api.getHistory();
    renderHistory();
    if (!valid(token)) return;
  } catch (error) {
    if (!valid(token)) return;
    toast(`Текст готов, но история не сохранена: ${friendlyError(error)}`, true);
  }
  if (!valid(token)) return;
  let note = 'Текст готов. Можно скопировать или сохранить в файл.';
  try {
    // A null target explicitly selects clipboard-only delivery for UI/file recordings.
    const delivery = await api.deliver(text, target, enter && target !== null);
    if (!valid(token)) return;
    note = deliveryMessage(delivery, target !== null, enter);
  } catch (error) {
    if (!valid(token)) return;
    note = `Текст готов. Автовставка не выполнена: ${friendlyError(error)}. Нажмите «Копировать».`;
  }
  if (!valid(token)) return;
  if (source === 'file' && !details.segments?.length) note += ' Модель не вернула таймкоды: доступен только текст.';
  lastResult = text;
  $('setup-card').hidden = true;
  showResult(text, 'Текст', note, true, { ...details, historyId });
  const sounds = session?.settings.sounds ?? settings.sounds;
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

function keepAudio(token: number, audio: Float32Array | null): void {
  if (!valid(token) || !audio || audio.length > MAX_KEPT_AUDIO) return;
  lastAudio = { pcm: audio, historyId: currentHistoryId };
  syncResultActions();
}

const retranscribeDialog = $<HTMLDialogElement>('retranscribe-dialog');
const retranscribeModel = $<HTMLSelectElement>('retranscribe-model');
const retranscribeLanguage = $<HTMLSelectElement>('retranscribe-language');
function syncRetranscribeLanguage(): void {
  const giga = retranscribeModel.value === 'gigaam';
  retranscribeLanguage.disabled = giga;
  $('retranscribe-language-note').textContent = giga ? 'GigaAM распознаёт только русскую речь.' : '';
}

async function retranscribe(): Promise<void> {
  const audio = lastAudio;
  if (!initialized || isBusy() || correctionSaving || !audio?.historyId || audio.historyId !== currentHistoryId || retranscribeDialog.open) return;
  // Offer the other engine first: GigaAM for Russian Whisper users, Whisper for GigaAM users.
  retranscribeModel.replaceChildren(...Array.from(form.querySelector<HTMLSelectElement>('[name="model"]')!.options, option => new Option(option.text, option.value)));
  retranscribeLanguage.replaceChildren(...Array.from(form.querySelector<HTMLSelectElement>('[name="language"]')!.options, option => new Option(option.text, option.value)));
  for (const option of retranscribeModel.options) if (option.value === 'auto') option.text = 'Авто · Whisper, подобрать для этого ПК';
  retranscribeModel.value = effectiveModel(settings) === 'gigaam' ? 'auto' : settings.language === 'ru' ? 'gigaam' : settings.model;
  retranscribeLanguage.value = settings.language;
  syncRetranscribeLanguage();
  gesture.reset();
  retranscribeDialog.returnValue = 'cancel';
  const decision = new Promise<string>(resolve => retranscribeDialog.addEventListener('close', () => resolve(retranscribeDialog.returnValue), { once: true }));
  retranscribeDialog.showModal();
  if (await decision !== 'start' || isBusy() || lastAudio !== audio) return;
  const options = { ...settings, model: retranscribeModel.value as Settings['model'], language: retranscribeLanguage.value, language2: '', autoGigaam: false };
  const token = ++generation;
  const previous = editor.snapshot();
  setPhase('transcribing', 'Перераспознаём запись…');
  try {
    const text = processText(await asr.transcribe(audio.pcm, options, progress => messageProgress(progress, token)), settings);
    if (!valid(token)) return;
    if (!text) { setPhase('idle'); toast('Модель не нашла речь в записи. Текст не изменён.'); return; }
    await api.updateHistory(audio.historyId, text);
    history = history.map(item => item.id === audio.historyId ? { ...item, text } : item);
    renderHistory();
    if (!valid(token)) return;
    lastResult = text;
    showResult(text, 'Текст', `Перераспознано: ${modelName(options.model)}. Вставьте в нужное поле через Ctrl + Alt + V или скопируйте.`, true, { historyId: audio.historyId });
    beforeProofread = previous;
    setPhase('idle', 'Готово');
  } catch (error) {
    if (!valid(token) || (error instanceof Error && error.name === 'AbortError')) return;
    restoreEditor();
    setPhase('idle');
    toast(`Не удалось перераспознать: ${friendlyError(error)} Текст не изменён.`, true);
  }
}

async function start(target: string | null): Promise<void> {
  if (!initialized || !canStart() || correctionDialog.open || correctionSaving || retranscribeDialog.open) return;
  const token = ++generation;
  const active: Session = {
    token, settings: { ...settings }, recorder: new Recorder(), target, enter: false, proofread: false,
    stopRequested: false, segmenter: null, pcm: [], parts: [], jobs: [], liveUnavailable: false,
    liveFailed: false, voiced: false, voicedTicks: 0, lastVoice: performance.now(), noise: .002,
  };
  session = active;
  lastAudio = null;
  // The speakers must not play into the microphone.
  stopPlayback();
  lastSeconds = 0;
  $('timer').textContent = '00:00';
  setPhase('starting');
  if (target) {
    const lookup = api.windowProcess(target).catch(() => null);
    void lookup.then(rememberApp);
    if (settings.profiles.length) {
      // A stuck helper must not delay the recording: give up after 300 ms.
      const process = await Promise.race([lookup, new Promise<null>(resolve => setTimeout(() => resolve(null), 300))]);
      if (!valid(token)) return;
      const profile = findProfile(settings.profiles, process);
      if (profile) {
        active.settings = applyProfile(active.settings, profile);
        active.profile = profile.app;
        if (profile.enter) active.enter = true;
        if (profile.proofread && active.settings.llmEnabled) { active.proofread = true; active.proofreadMode = 'plain'; }
      }
    }
  }
  // Load the model while the user speaks. Errors resurface from transcription.
  void asr.prepare(active.settings, progress => messageProgress(progress, token)).catch(() => {});
  if (active.settings.live) {
    active.segmenter = new Segmenter(segment => {
      if (!valid(token) || active.liveUnavailable || active.liveFailed) return;
      const index = active.parts.length;
      active.parts.push('');
      const job = asr.transcribe(segment.pcm, { ...active.settings, segment: true }, progress => messageProgress(progress, token))
        .then(text => {
          if (!valid(token)) return;
          active.parts[index] = text;
          const preview = processText(joinSegments(active.parts), active.settings);
          if (preview) showResult(preview, 'Предпросмотр по фразам', 'Текст вставится в поле после завершения записи.', false);
        }).catch(error => {
          if (!valid(token) || active.liveFailed || (error instanceof Error && error.name === 'AbortError')) return;
          active.liveFailed = true;
          // Drop the backlog after the first failure; retry the whole recording once at stop.
          asr.cancel();
          $('record-description').textContent = 'Предпросмотр недоступен. Полная запись будет распознана после остановки.';
        });
      active.jobs.push(job);
    });
  }
  try {
    await active.recorder.start(active.settings.microphone || undefined, {
      onPcm: pcm => {
        if (!valid(token)) return;
        active.pcm.push(pcm);
        active.segmenter?.push(pcm);
      },
      onUnavailable: () => { active.liveUnavailable = true; },
    });
    if (!valid(token)) { active.recorder.cancel(); return; }
    setPhase('recording');
    if (active.liveUnavailable && active.segmenter) $('record-description').textContent = 'Предпросмотр недоступен на этом устройстве. Запись будет распознана целиком.';
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
    active.segmenter?.flush();
    let text = '';
    if (active.segmenter && !active.liveUnavailable) {
      await Promise.all(active.jobs);
      if (!valid(token)) return;
      if (!active.liveFailed) text = joinSegments(active.parts);
    }
    let audio: Float32Array | null = !active.liveUnavailable && active.pcm.length ? joinPcm(active.pcm) : null;
    if (!text && audio) {
      text = await asr.transcribe(audio, active.settings, progress => messageProgress(progress, token));
    } else if (!text && recording) {
      // The PCM tap is unavailable: fall back to decoding the compressed recording.
      const buffer = await recording.blob.arrayBuffer();
      if (!valid(token)) return;
      audio = await decodeAudioTo16kMono(buffer);
      if (!valid(token)) return;
      text = await asr.transcribe(audio, active.settings, progress => messageProgress(progress, token));
    }
    if (!valid(token)) return;
    text = processText(text, active.settings);
    beforeProofread = null;
    let originalForUndo: string | null = null;
    let review: ProofreadResult | null = null;
    if (active.proofread && text) {
      active.proofreadingStarted = true;
      const original = text;
      showResult(original, 'Исходный текст', 'Вычитываем через API…', false);
      previousEditor = { content: editor.snapshot(), label: 'Исходный текст', note: 'Вычитка отменена. Исходный текст сохранён.', historyId: undefined };
      try {
        setPhase('transcribing', 'Вычитываем текст…');
        flushSettingsSave();
        await saving;
        if (!valid(token)) return;
        await api.saveSettings(settings);
        if (!valid(token)) return;
        review = await api.proofread(original,active.proofreadMode ?? 'review');
        text = review.text;
        if (!valid(token)) return;
        originalForUndo = original;
      } catch (error) {
        if (!valid(token)) return;
        // Preserve the recognized text, but do not insert a failed proofreading result.
        await complete(original, 'dictation', token, null, false);
        keepAudio(token, audio);
        if (valid(token)) {
          const message = `Вычитка не выполнена: ${friendlyError(error)} Исходный текст сохранён в редакторе и буфере.`;
          $('result-note').textContent = message;
          toast(message, true);
        }
        return;
      }
    }
    await complete(text, 'dictation', token, active.proofread && active.proofreadMode==='review' ? null : active.target, active.proofread ? false : active.enter);
    if (text) keepAudio(token, audio);
    if (valid(token) && originalForUndo !== null) {
      beforeProofread = { text: originalForUndo, segments: [], view: 'text' };
      if(review && active.proofreadMode==='review')showProofreadReview([{before:originalForUndo,result:review}]);
      syncResultActions();
    }
  } catch (error) { fail(error, token); }
}

function cancel(message = 'Диктовка отменена', notify = true): void {
  if(historyClearing)return;
  if (!isBusy()) return;
  if (fileOptionsDialog.open) fileOptionsDialog.close('cancel');
  generation++;
  void api.cancelProofread().catch(() => {});
  void api.cancelAudio().catch(() => {});
  gesture.reset();
  session?.recorder.cancel();
  session = null;
  asr.cancel();
  $('setup-card').hidden = false;
  lastSeconds = 0;
  $('timer').textContent = '00:00';
  restoreEditor();
  setPhase('idle', message);
  if (notify) toast(message);
}

async function prepare(): Promise<void> {
  if (!initialized || isBusy() || correctionDialog.open || correctionSaving) return;
  const token = ++generation;
  warming = true;
  setPhase('preparing');
  try {
    const loaded = await asr.prepare(settings, progress => messageProgress(progress, token));
    // A dictation started during warmup supersedes the token, but the model is still ready.
    $('setup-card').hidden = true;
    // Without shader-f16 Turbo HQ silently runs the regular q4 files; say so.
    const reduced = loaded.model === 'turbo-hq' && !loaded.f16 ? ' · без fp16, как Turbo' : '';
    $('engine-summary').textContent = `${modelName(loaded.model)} · ${loaded.device === 'webgpu' ? 'Видеокарта' : 'Процессор'}${reduced}`;
    if (!valid(token)) return;
    setPhase('idle', 'Модель готова');
    toast(`Модель готова. Поставьте курсор в любом приложении и нажмите ${HOTKEYS[settings.hotkey].label}.`);
  } catch (error) { fail(error, token); }
}

async function pickFile(dropped?: File): Promise<void> {
  if($<HTMLDialogElement>('history-clear-dialog').open)return;
  if (!initialized || isBusy() || correctionDialog.open || correctionSaving) return;
  const token = ++generation;
  const options = { ...settings };
  setPhase('starting', 'Выберите аудио или видео');
  $('record-title').textContent = 'Выберите аудиозапись';
  $('record-description').textContent = 'WAV, MP3, M4A, OGG или WebM.';
  let audioId: string | undefined;
  try {
    if (dropped && dropped.size > 250 * 1024 * 1024) throw new Error('Файл больше 250 МБ. Разделите запись на части.');
    if (dropped && !/\.(wav|mp3|m4a|ogg|flac|webm|mp4|aac|mov|mkv|avi|m4v|opus)$/i.test(dropped.name)) throw new Error('Перетащите аудио или видео: WAV, MP3, M4A, OGG, FLAC, WebM, MP4, MOV, MKV или AVI.');
    const file = dropped ? { name: dropped.name, id: undefined } : await api.pickAudio();
    audioId = file?.id;
    if (!valid(token)) return;
    if (!file) { setPhase('idle'); return; }
    $('file-options-name').textContent = file.name;
    const enabled = $<HTMLInputElement>('file-diarization');
    const countInput = $<HTMLInputElement>('file-speaker-count');
    enabled.checked = options.diarization;
    countInput.value = '';
    countInput.disabled = !enabled.checked;
    enabled.onchange = () => { countInput.disabled = !enabled.checked; };
    fileOptionsDialog.returnValue = 'cancel';
    const decision = new Promise<string>(resolve => fileOptionsDialog.addEventListener('close', () => resolve(fileOptionsDialog.returnValue), { once: true }));
    fileOptionsDialog.showModal();
    const choice = await decision;
    if (!valid(token)) return;
    if (choice !== 'start') { setPhase('idle'); return; }
    options.diarization = enabled.checked;
    const speakerCount = countInput.value ? Number(countInput.value) : undefined;
    setPhase('transcribing', 'Читаем аудиофайл');
    $('record-description').textContent = file.name;
    if (dropped) audioId = (await api.droppedAudio(dropped)).id;
    if (!valid(token) || !audioId) return;
    const audio = await api.prepareAudio(audioId);
    if (!valid(token)) return;
    const transcript: import('../shared/transcript').Transcript = {text:'',segments:[]};
    // Auto language costs an extra encoder pass per 30 s chunk. Fix it for the rest
    // of the file once two chunks in a row agree, so one misdetected intro cannot.
    let detected: string | undefined;
    for (let offset = 0; offset < audio.samples;) {
      const pcm = await api.audioChunk(audioId, offset);
      if (!valid(token)) return;
      const part = await asr.transcribeTimed(pcm, options, progress => messageProgress(progress.stage==='run' && typeof progress.pct==='number' ? {...progress,pct:(offset+pcm.length*progress.pct/100)/audio.samples*100}:progress, token));
      if (!valid(token)) return;
      if (options.language === 'auto' && part.language) {
        if (part.language === detected) options.language = detected;
        detected = part.language;
      }
      appendFileTranscript(transcript,part,offset / 16000);
      offset += pcm.length;
      $('record-description').textContent = `${file.name} · обработано ${Math.round(offset / audio.samples * 100)}%`;
    }
    if (!valid(token)) return;
    let segments = normalizeSegments(transcript.segments.map(segment => ({ ...segment, text: processText(segment.text, options) })));
    let speakerNote = '';
    if (options.diarization && segments.length) {
      setPhase('transcribing', 'Определяем ораторов');
      const unsubscribe = api.onDiarizationProgress(progress => {
        if (!valid(token)) return;
        statusMessage = progress.message;
        $('status-label').textContent = progress.message;
        $('record-description').textContent = progress.message + '. Аудио остаётся на компьютере.';
      });
      try {
        const turns = await api.diarizeAudio(audioId, speakerCount);
        if (!valid(token)) return;
        segments = assignSpeakers(segments, turns);
        const count = new Set(turns.map(turn => turn.speaker)).size;
        speakerNote = count ? 'Ораторов найдено: ' + count + '. Метки можно исправить в таймкодах.' : 'Не удалось определить ораторов.';
      } catch (error) {
        if (!valid(token)) return;
        speakerNote = 'Ораторы не определены: ' + friendlyError(error) + '. Текст сохранён.';
      } finally { unsubscribe(); }
    }
    if (!valid(token)) return;
    const text = transcript.segments.length ? transcriptText(segments) : processText(transcript.text, options);
    await complete(text, 'file', token, null, false, { segments, name: file.name, audioId });
    if (valid(token) && speakerNote) $('result-note').textContent += ' ' + speakerNote;
  } catch (error) { fail(error, token); }
  finally { if (audioId) await api.releaseAudio(audioId).catch(() => {}); }
}

async function proofreadEditor(): Promise<void> {
  if (!initialized || isBusy() || correctionDialog.open || correctionSaving || composingInput) return;
  if (!editor.text.trim()) { toast('Сначала добавьте текст в редактор.'); return; }
  if (editor.text.length > 50000) { toast('Для вычитки доступно до 50 000 символов за раз.', true); return; }
  const token = ++generation;
  const original = editor.snapshot();
  const corrected = editor.snapshot();
  const reviews: ReviewBlock[] = [];
  let unfinished = '';
  setPhase('transcribing', 'Вычитываем текст…');
  try {
    flushSettingsSave();
    await saving;
    if (!valid(token)) return;
    await api.saveSettings(settings);
    if (!valid(token)) return;
    if (corrected.segments.length) {
      const batches=makeProofreadBatches(original.segments);
      // Paid batches that already succeeded are kept even if a later one fails.
      const missed: ProofreadBatch[] = [];
      let lastError: unknown = null;
      let failedInRow = 0;
      for (let i=0;i<batches.length;i++) {
        setPhase('transcribing', `Вычитываем группу ${i+1} из ${batches.length}…`);
        let results: Awaited<ReturnType<typeof api.proofreadBatch>> | null = null;
        let fatal = false;
        for (let attempt=0; attempt<2 && !results; attempt++) {
          try { results=await api.proofreadBatch(batches[i]); }
          catch (error) {
            if (!valid(token)) return;
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            fatal = /HTTP (401|403|429)/.test(message);
            // Auth, quota and timeouts will not improve on an immediate retry.
            if (fatal || /отменена/.test(message)) break;
          }
        }
        if (!valid(token)) return;
        if (!results) {
          missed.push(batches[i]);
          if (fatal || ++failedInRow >= 2) { missed.push(...batches.slice(i+1)); break; }
          continue;
        }
        failedInRow = 0;
        for(const result of results) {
          const segment=corrected.segments[result.id];
          reviews.push({before:segment.text,result,segment:result.id});
          segment.text=result.text;
        }
      }
      if (!reviews.length) throw lastError;
      if (missed.length) {
        const spans: [number, number][] = [];
        for (const batch of missed) {
          const first = batch.cues[0].id + 1, last = batch.cues[batch.cues.length-1].id + 1;
          if (spans.length && spans[spans.length-1][1] + 1 === first) spans[spans.length-1][1] = last;
          else spans.push([first, last]);
        }
        const ranges = spans.map(([first, last]) => first === last ? String(first) : `${first}–${last}`).join(', ');
        unfinished = `Фразы ${ranges} не вычитаны и остались без изменений: ${friendlyError(lastError)}`;
      }
    } else {
      const result = await api.proofread(original.text);
      corrected.text = result.text;
      reviews.push({before:original.text,result});
    }
    if (!valid(token)) return;
    editor.restore(corrected);
    beforeProofread = original;
    showProofreadReview(reviews);
    renderTranscript();
    updateResultText();
    lastResult = editor.text;
    setPhase('idle', 'Вычитка завершена');
    queueHistorySave();
    resetCorrectionDraft();
    $('result-note').textContent = unfinished
      ? `Текст вычитан частично. ${unfinished} Можно вернуть исходный вариант.`
      : 'Текст вычитан. Можно вернуть исходный вариант, скопировать или сохранить результат.';
    if (unfinished) toast(`Вычитка завершена частично. ${unfinished}`, true); else toast('Вычитка завершена.');
  } catch (error) {
    if (!valid(token)) return;
    setPhase('idle');
    toast(`Вычитка не выполнена: ${friendlyError(error)} Исходный текст сохранён.`, true);
  }
}

const selectionReasons: Record<string, string> = {
  'nothing-copied': 'Выделите текст и нажмите сочетание ещё раз.',
  'not-text': 'В выделении нет текста.',
  'target-changed': 'Активное окно изменилось.',
  'modifiers-held': 'Отпустите Ctrl и Shift сразу после нажатия.',
  'input-blocked': 'Windows или приложение заблокировали копирование.',
};

// The window is usually hidden while another application is in front: also show the result in the overlay.
function selectionNotice(message: string, error = false): void {
  toast(message, error);
  api.notice(message, error);
}

/** Ctrl+Shift+Space outside Voice Scribe: copy the selection, proofread it and paste the result over it. */
async function proofreadSelection(target: string): Promise<void> {
  if (!initialized || isBusy() || correctionDialog.open || correctionSaving) return;
  const token = ++generation;
  setPhase('transcribing', 'Копируем выделенный текст…');
  try {
    flushSettingsSave();
    await saving;
    if (!valid(token)) return;
    await api.saveSettings(settings);
    if (!valid(token)) return;
    const copied = await api.copySelection(target);
    if (!valid(token)) return;
    if (copied.text === null) {
      setPhase('idle');
      selectionNotice(`Выделенный текст не скопирован. ${selectionReasons[copied.reason ?? ''] ?? selectionReasons['nothing-copied']}`, true);
      return;
    }
    if (copied.text.length > 50000) {
      setPhase('idle');
      selectionNotice('Для вычитки доступно до 50 000 символов за раз.', true);
      return;
    }
    setPhase('transcribing', 'Вычитываем выделенный текст…');
    const result = await api.proofread(copied.text, 'selection');
    if (!valid(token)) return;
    const corrected = keepSurroundingSpace(copied.text, result.text);
    if (corrected === copied.text) {
      setPhase('idle', 'Вычитка завершена');
      selectionNotice('Ошибок не найдено. Текст не изменён.');
      return;
    }
    setPhase('transcribing', 'Заменяем выделенный текст…');
    const delivery = await api.deliver(corrected, target, false);
    if (!valid(token)) return;
    setPhase('idle', 'Вычитка завершена');
    selectionNotice(delivery.status === 'inserted' ? 'Выделенный текст исправлен.' : deliveryMessage(delivery, true, false), delivery.status !== 'inserted');
  } catch (error) {
    if (!valid(token)) return;
    setPhase('idle');
    selectionNotice(`Вычитка не выполнена: ${friendlyError(error)} Текст не изменён.`, true);
  }
}

async function saveLlmKey(remove = false): Promise<void> {
  const input = $<HTMLInputElement>('llm-api-key');
  if (!remove && !input.value.trim()) { toast('Введите API-ключ.', true); return; }
  const save = $<HTMLButtonElement>('llm-save-key');
  const del = $<HTMLButtonElement>('llm-delete-key');
  save.disabled = del.disabled = true;
  fieldset.disabled = true;
  try {
    flushSettingsSave();
    await saving;
    await api.saveSettings(settings);
    await api.saveApiKey(remove ? '' : input.value);
    input.value = '';
    $('llm-key-status').textContent = remove ? 'Ключ этого провайдера удалён.' : 'Ключ этого провайдера сохранён и зашифрован средствами Windows.';
  } catch (error) { toast(friendlyError(error), true); }
  finally { save.disabled = del.disabled = false; fieldset.disabled = isBusy(); }
}

function syncProvider(): void {
  $<HTMLSelectElement>('llm-provider').value = providerFor(settings.llmBaseUrl)?.id ?? 'custom';
}

async function refreshKeyStatus(): Promise<void> {
  const base = settings.llmBaseUrl;
  try {
    flushSettingsSave();
    await saving;
    const has = await api.hasApiKey();
    if (base === settings.llmBaseUrl) $('llm-key-status').textContent = has ? 'Для этого адреса ключ сохранён.' : 'Для этого адреса ключ не сохранён. Введите ключ выбранного провайдера.';
  } catch (error) { $('llm-key-status').textContent = friendlyError(error); }
}

async function checkLlm(modelsOnly: boolean): Promise<void> {
  if (isBusy()) return;
  const status = $('llm-connection-status');
  if ($<HTMLInputElement>('llm-api-key').value.trim()) { status.textContent = 'Сначала нажмите «Сохранить ключ».'; return; }
  const token = ++generation;
  setPhase('preparing', modelsOnly ? 'Получаем модели…' : 'Проверяем API…');
  status.textContent = modelsOnly ? 'Загружаем список моделей…' : 'Отправляем тестовый текст выбранной модели…';
  try {
    flushSettingsSave();
    await saving;
    await api.saveSettings(settings);
    if (!valid(token)) return;
    if (modelsOnly) {
      const models = await api.listModels();
      if (!valid(token)) return;
      const select = $<HTMLSelectElement>('llm-model-list');
      select.replaceChildren(new Option('Выберите модель', ''), ...models.map(model => new Option(model,model)));
      select.disabled = false;
      select.value = models.includes(settings.llmModel) ? settings.llmModel : '';
      status.textContent = `Список получен: ${models.length} моделей. Выберите модель и нажмите «Проверить модель».`;
    } else {
      await api.proofread('Привет мир');
      if (!valid(token)) return;
      status.textContent = 'Подключение работает: выбранная модель ответила на тестовый запрос.';
    }
  } catch (error) { if (valid(token)) status.textContent = friendlyError(error); }
  finally { if (valid(token)) setPhase('idle'); }
}

async function handleCommand(command: Command): Promise<void> {
  if (!initialized) { pendingCommands.push(command); return; }
  if(historyClearing || $<HTMLDialogElement>('history-clear-dialog').open) {
    gesture.reset();
    if(command.action==='cancel' && !historyClearing)$<HTMLDialogElement>('history-clear-dialog').close('cancel');
    return;
  }
  if (correctionDialog.open || correctionSaving) {
    gesture.reset();
    if (command.action === 'cancel' && !correctionSaving) correctionDialog.close();
    if (command.action === 'bridge-error') toast(command.message, true);
    return;
  }
  switch (command.action) {
    case 'dictation-down': {
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
    case 'proofread':
      if (session && ['starting', 'recording', 'transcribing'].includes(phase)) {
        if(session.proofreadingStarted)break;
        session.proofread = true;
        session.proofreadMode = command.mode ?? 'review';
        session.enter = false;
        gesture.reset();
        await finish();
      } else if (!isBusy() && command.target) await proofreadSelection(command.target);
      else if (!isBusy() && command.mode !== 'plain') await proofreadEditor();
      break;
    case 'cancel': cancel(); break;
    case 'show-history': navigate('history'); break;
    case 'paste-last':
      if (!isBusy() && (lastResult || history[0]?.text)) {
        try {
          const result = await api.deliver(lastResult || history[0].text, command.target, false);
          toast(deliveryMessage(result, true, false));
        } catch (error) { toast(friendlyError(error), true); }
      } else if (!isBusy()) toast('Пока нет готовой расшифровки.');
      break;
    case 'bridge-error': toast(command.message, true); break;
  }
}

function navigate(view: string): void {
  for (const name of ['dictation', 'history', 'settings']) $('view-' + name).hidden = name !== view;
  for (const nav of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const active = nav.dataset.view === view;
    nav.classList.toggle('active', active);
    if (active) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  $('page-name').textContent = ({ dictation: 'Диктовка', history: 'История', settings: 'Настройки' } as Record<string, string>)[view];
  if (view === 'history') renderHistory();
  if (view === 'settings') { void refreshMicrophones(); void refreshModelFiles(); }
  $('view-' + view).scrollTop = 0;
  window.scrollTo(0, 0);
}

function renderHistory(): void {
  $('history-count').textContent = String(history.length);
  $<HTMLButtonElement>('export-history').disabled = !history.length;
  $<HTMLButtonElement>('clear-history').disabled = !history.length || isBusy();
  const query = $<HTMLInputElement>('history-search').value.trim().toLocaleLowerCase();
  const visible = history.filter(item => `${item.name ?? ''} ${item.text}`.toLocaleLowerCase().includes(query)).sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned)));
  $('history-list').replaceChildren();
  $('history-empty').hidden = visible.length > 0;
  $('history-empty').querySelector('h2')!.textContent = query ? 'Ничего не найдено' : 'История пуста';
  $('history-empty').querySelector('p')!.textContent = query ? 'Попробуйте другой запрос.' : 'Здесь появятся расшифровки.';
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const article = document.createElement('article');
    article.className = 'history-item';
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const date = document.createElement('span');
    const createdAt = new Date(item.createdAt);
    date.textContent = `${Number.isNaN(createdAt.valueOf()) ? item.createdAt : createdAt.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · ${item.source === 'file' ? 'Аудиофайл' : 'Диктовка'}${item.segments?.length ? ' · С таймкодами' : ''}`;
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const open = document.createElement('button');
    open.className = 'text-button';
    open.textContent = 'Открыть';
    open.dataset.openHistory = item.id;
    open.disabled = isBusy();
    open.addEventListener('click', () => {
      if (isBusy()) return;
      const current = history.find(entry => entry.id === item.id);
      if (!current) return;
      showResult(current.text, 'Текст', 'Открыто из истории.', true, { segments: current.segments, name: current.name, historyId: current.id });
      lastResult = editor.text;
      navigate('dictation');
    });
    const copy = document.createElement('button');
    copy.className = 'text-button';
    copy.textContent = 'Копировать';
    copy.addEventListener('click', () => void copyText(item.text));
    const pin=document.createElement('button');
    pin.dataset.pinHistory=item.id;
    pin.className='text-button';pin.textContent=item.pinned?'Открепить':'Закрепить';
    pin.setAttribute('aria-pressed',String(Boolean(item.pinned)));
    pin.disabled=isBusy();
    pin.addEventListener('click',()=>{
      if(isBusy())return;
      pin.disabled=true;
      flushHistorySave();
      historySaving=historySaving.then(async()=>{
        try{await api.pinHistory(item.id,!item.pinned);history=await api.getHistory();}
        catch(error){toast(friendlyError(error),true);}
        finally{renderHistory();}
      });
    });
    actions.append(open, copy, pin);
    meta.append(date, actions);
    const body = document.createElement('p');
    body.className = 'history-text';
    // Long transcripts are opened in the editor; the list only needs a preview.
    body.textContent = item.text.length > 600 ? `${item.text.slice(0, 600).trimEnd()}…` : item.text;
    article.append(meta);
    if (item.name) {
      const name = document.createElement('p');
      name.className = 'history-name';
      name.textContent = item.name;
      article.append(name);
    }
    article.append(body);
    fragment.append(article);
  }
  $('history-list').append(fragment);
}

function renderHotkeyLabels(): void {
  const keys = HOTKEYS[settings.hotkey];
  for (const element of document.querySelectorAll<HTMLElement>('[data-hotkey]')) element.textContent = element.dataset.hotkey === 'proofread' ? keys.proofread : keys.label;
}

const recentApps = new Set<string>();
function rememberApp(process: string | null): void {
  const app = process ? normalizeApp(process) : '';
  if (!app || app === 'voice scribe.exe' || recentApps.has(app)) return;
  recentApps.add(app);
  $('recent-apps').append(new Option(app));
}

function optionsOf(name: 'model' | 'language', globalLabel: string): HTMLOptionElement[] {
  const source = form.querySelector<HTMLSelectElement>(`[name="${name}"]`)!;
  return [new Option(globalLabel, ''), ...Array.from(source.options, option => new Option(option.text, option.value))];
}

function renderProfiles(): void {
  $('profile-list').replaceChildren(...settings.profiles.map((profile, index) => {
    const card = document.createElement('div');
    card.className = 'profile';
    const head = document.createElement('div');
    head.className = 'profile-head';
    const name = document.createElement('strong');
    name.textContent = profile.app;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button danger';
    remove.textContent = 'Удалить';
    remove.setAttribute('aria-label', `Удалить профиль ${profile.app}`);
    remove.addEventListener('click', () => {
      settings = { ...settings, profiles: settings.profiles.filter((_, i) => i !== index) };
      renderProfiles();
      queueSettingsSave();
    });
    head.append(name, remove);
    const grid = document.createElement('div');
    grid.className = 'settings-grid';
    const update = (change: Partial<AppProfile>) => {
      // The form's change listener saves right after this handler.
      settings = { ...settings, profiles: settings.profiles.map((item, i) => i === index ? { ...item, ...change } : item) };
    };
    const select = (label: string, key: 'model' | 'language', global: string) => {
      const field = document.createElement('label');
      field.className = 'field';
      field.append(label);
      const control = document.createElement('select');
      control.append(...optionsOf(key, global));
      control.value = profile[key];
      control.addEventListener('change', () => update({ [key]: control.value } as Partial<AppProfile>));
      field.append(control);
      return field;
    };
    grid.append(select('Модель', 'model', 'Как в настройках'), select('Язык', 'language', 'Как в настройках'));
    const checks = document.createElement('div');
    checks.className = 'profile-checks';
    const check = (label: string, key: 'enter' | 'proofread') => {
      const field = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = profile[key];
      box.addEventListener('change', () => update({ [key]: box.checked } as Partial<AppProfile>));
      field.append(box, label);
      return field;
    };
    checks.append(check('Нажимать Enter после вставки', 'enter'), check('Вычитывать через API перед вставкой', 'proofread'));
    card.append(head, grid, checks);
    return card;
  }));
}

function addProfile(): void {
  const input = $<HTMLInputElement>('profile-app');
  const app = normalizeApp(input.value);
  if (!app) { toast('Укажите программу, например telegram.exe.', true); input.focus(); return; }
  if (settings.profiles.some(profile => profile.app === app)) { toast(`Профиль для ${app} уже есть.`, true); return; }
  if (settings.profiles.length >= 50) { toast('Можно создать до 50 профилей.', true); return; }
  settings = { ...settings, profiles: [...settings.profiles, { app, model: '', language: '', enter: false, proofread: false }] };
  input.value = '';
  renderProfiles();
  queueSettingsSave();
}

function applySettings(): void {
  for (const [name, value] of Object.entries(settings)) {
    const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!control) continue;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = String(value);
  }
  $('engine-summary').textContent = engineSummary(settings);
  renderProfiles();
  renderHotkeyLabels();
}

function queueSettingsSave(): void {
  if (isBusy() || correctionSaving) return;
  const previous = settings;
  const next = { ...settings };
  for (const name of Object.keys(next) as Array<keyof Settings>) {
    const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!control) continue;
    const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : name === 'silenceSeconds' || name === 'historyLimit' ? Number(control.value) : control.value;
    (next as unknown as Record<string, unknown>)[name] = value;
  }
  if (next.language === 'auto') next.language2 = '';
  if (next.language2 === next.language) next.language2 = '';
  settings = next;
  syncProvider();
  if (previous.llmBaseUrl !== next.llmBaseUrl) {
    $<HTMLInputElement>('llm-api-key').value = '';
    const list = $<HTMLSelectElement>('llm-model-list');
    list.replaceChildren(new Option('Сначала получите список',''));
    list.disabled = true;
    $('llm-key-status').textContent = 'После выбора адреса сохраните ключ этого провайдера.';
    $('llm-connection-status').textContent = 'Выберите модель этого сервиса и проверьте подключение.';
  }
  if (previous.model !== settings.model || previous.device !== settings.device) {
    $('setup-card').hidden = false;
  }
  $('engine-summary').textContent = engineSummary(settings);
  form.querySelector<HTMLSelectElement>('[name="language2"]')!.value = settings.language2;
  renderHotkeyLabels();
  $('settings-saved').textContent = 'Сохраняем…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettingsSave, 300);
}

function flushSettingsSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = { ...settings };
  saving = saving.then(async () => {
    try { await api.saveSettings(snapshot); $('settings-saved').textContent = 'Все изменения сохранены'; }
    catch (error) { $('settings-saved').textContent = 'Не удалось сохранить'; toast(friendlyError(error), true); }
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

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`;

function renderModelFiles(entries: ModelEntry[]): void {
  $('model-files-empty').hidden = entries.length > 0;
  $('model-files').replaceChildren(...entries.map(entry => {
    const row = document.createElement('li');
    row.className = 'model-file';
    const name = document.createElement('span');
    name.className = 'model-file-name';
    name.textContent = entry.name;
    const size = document.createElement('span');
    size.className = 'model-file-size';
    size.textContent = formatBytes(entry.bytes);
    row.append(name, size);
    if (!entry.removable) {
      const note = document.createElement('span');
      note.className = 'model-file-note';
      note.textContent = 'только чтение';
      note.title = 'Voice Scribe читает этот кэш, но не меняет его.';
      row.append(note);
      return row;
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button danger';
    remove.textContent = 'Удалить';
    let armed: ReturnType<typeof setTimeout> | null = null;
    remove.addEventListener('click', () => {
      if (isBusy()) return;
      // The second click within four seconds confirms; downloads can be large.
      if (!armed) {
        remove.textContent = 'Точно удалить?';
        armed = setTimeout(() => { armed = null; remove.textContent = 'Удалить'; }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      void deleteModelFiles(entry);
    });
    row.append(remove);
    return row;
  }));
}

async function refreshModelFiles(): Promise<void> {
  try { renderModelFiles(await api.listDownloadedModels()); }
  catch (error) { toast(`Не удалось прочитать список моделей: ${friendlyError(error)}`, true); }
}

async function deleteModelFiles(entry: ModelEntry): Promise<void> {
  if (isBusy() || entry.id === 'legacy') return;
  try {
    renderModelFiles(await api.deleteDownloadedModel(entry.id));
    // A loaded pipeline may use the deleted files; the next recognition reloads them.
    asr.cancel();
    $('setup-card').hidden = false;
    toast(`${entry.name}: файлы удалены. Модель загрузится снова, когда понадобится.`);
  } catch (error) {
    toast(`Не удалось удалить модель: ${friendlyError(error)}`, true);
    void refreshModelFiles();
  }
}

async function copyText(text: string): Promise<void> {
  try { await api.copy(text); toast('Текст скопирован.'); }
  catch (error) { toast(friendlyError(error), true); }
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
const ticker = setInterval(() => {
  let level = 0;
  const active = session;
  if (phase === 'recording' && active) {
    lastSeconds = active.recorder.durationSec;
    $('timer').textContent = formatTime(lastSeconds);
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
  api.status({ phase, message: statusMessage, ...renderWork(), level });
}, 100);

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.addEventListener('click', () => navigate(button.dataset.view!));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-go-settings]')) button.addEventListener('click', () => navigate('settings'));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-go-dictation]')) button.addEventListener('click', () => navigate('dictation'));
recordButton.addEventListener('click', () => { if (phase === 'recording' || phase === 'starting') void finish(); else void start(null); });
$('cancel-button').addEventListener('click', () => cancel());
$('prepare-button').addEventListener('click', () => void prepare());
$('pick-file').addEventListener('click', () => void pickFile());
let fileDragDepth = 0;
document.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  fileDragDepth++;
  if (initialized && !isBusy() && !correctionDialog.open) document.body.classList.add('file-dragging');
});
document.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = initialized && !isBusy() && !correctionDialog.open ? 'copy' : 'none';
});
document.addEventListener('dragleave', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  if (--fileDragDepth <= 0) { fileDragDepth = 0; document.body.classList.remove('file-dragging'); }
});
document.addEventListener('drop', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  fileDragDepth = 0;
  document.body.classList.remove('file-dragging');
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  if (!initialized || isBusy() || correctionDialog.open || correctionSaving) { toast('Сначала завершите текущее действие.', true); return; }
  if (files.length !== 1) { toast('Перетащите один файл за раз.', true); return; }
  document.querySelector<HTMLButtonElement>('[data-view="dictation"]')?.click();
  void pickFile(files[0]);
});
$('hide-window').addEventListener('click', () => api.hide());
$('copy-result').addEventListener('click', () => void copyText(resultText.value));
$('export-result').addEventListener('click', () => { void api.saveText(resultText.value).catch(error => toast(friendlyError(error), true)); });
$('remember-correction').addEventListener('click', openCorrection);
$('proofread-result').addEventListener('click', () => void proofreadEditor());
$('retranscribe').addEventListener('click', () => void retranscribe());
retranscribeModel.addEventListener('change', syncRetranscribeLanguage);
$('llm-save-key').addEventListener('click', () => void saveLlmKey());
$('llm-delete-key').addEventListener('click', () => void saveLlmKey(true));
$('llm-fetch-models').addEventListener('click', () => void checkLlm(true));
$('llm-test').addEventListener('click', () => void checkLlm(false));
for (const provider of PROVIDERS) $<HTMLSelectElement>('llm-provider').add(new Option(provider.name,provider.id));
$('llm-provider').addEventListener('change', () => {
  const provider = PROVIDERS.find(p => p.id === $<HTMLSelectElement>('llm-provider').value);
  form.querySelector<HTMLInputElement>('[name="llmBaseUrl"]')!.value = provider?.url ?? '';
  form.querySelector<HTMLInputElement>('[name="llmModel"]')!.value = '';
  queueSettingsSave();
  if (provider) void refreshKeyStatus();
  else form.querySelector<HTMLInputElement>('[name="llmBaseUrl"]')!.focus();
});
$('llm-model-list').addEventListener('change', () => {
  const model = $<HTMLSelectElement>('llm-model-list').value;
  if (!model) return;
  form.querySelector<HTMLInputElement>('[name="llmModel"]')!.value = model;
  queueSettingsSave();
});
$('undo-proofread').addEventListener('click', () => {
  if (isBusy() || !beforeProofread) return;
  editor.restore(beforeProofread);
  beforeProofread = null;
  showProofreadReview([]);
  renderTranscript();
  updateResultText();
  lastResult = editor.text;
  queueHistorySave();
  resetCorrectionDraft();
  $('result-note').textContent = 'Исходный текст восстановлен в редакторе. Уже вставленный в другое приложение текст можно отменить там через Ctrl + Z.';
});
$('correction-cancel').addEventListener('click', () => { if (!correctionSaving) correctionDialog.close(); });
$('correction-dictionary').addEventListener('click', () => {
  if (correctionSaving) return;
  correctionDialog.close();
  navigate('settings');
  form.querySelector<HTMLTextAreaElement>('[name="replacements"]')!.focus();
});
correctionForm.addEventListener('submit', event => { event.preventDefault(); saveCorrection(); });
correctionDialog.addEventListener('cancel', event => { if (correctionSaving) event.preventDefault(); });
correctionDialog.addEventListener('close', () => { gesture.reset(); syncResultActions(); });
$('export-srt').addEventListener('click', () => void exportSubtitles('srt'));
$('export-vtt').addEventListener('click', () => void exportSubtitles('vtt'));
$('result-view-text').addEventListener('click', () => setTranscriptView('text'));
$('result-view-segments').addEventListener('click', () => setTranscriptView('segments'));
trackCorrectionInput(resultText);
resultText.addEventListener('input', () => {
  editor.editText(resultText.value);
  updateResultText();
  lastResult = editor.text;
  queueHistorySave();
});
resultText.addEventListener('change', flushHistorySave);
$('history-search').addEventListener('input', renderHistory);
$('export-history').addEventListener('click', () => {
  flushHistorySave();
  void historySaving.then(()=>api.exportHistory()).catch(error=>toast(friendlyError(error),true));
});
$('clear-history').addEventListener('click', () => {
  if(isBusy())return;
  const dialog=$<HTMLDialogElement>('history-clear-dialog');
  if(dialog.open)return;
  dialog.returnValue='cancel';dialog.showModal();
});
$('history-clear-dialog').addEventListener('close',()=>{
  const choice=$<HTMLDialogElement>('history-clear-dialog').returnValue;
  if(choice!=='clear' && choice!=='export')return;
  const keepPinned=$<HTMLInputElement>('history-keep-pinned').checked;
  historyClearing=true;
  document.querySelector('main')!.inert=true;
  flushHistorySave();
  historySaving = historySaving.then(async () => {
    try {
      if(choice==='export' && !(await api.exportHistory()))return;
      await api.clearHistory(keepPinned);
      history = await api.getHistory();
      if(!history.some(item=>item.id===currentHistoryId))currentHistoryId = undefined;
      if(!history.some(item=>item.id===previousEditor.historyId))previousEditor.historyId = undefined;
      renderHistory();
      toast(keepPinned?'Обычные записи удалены. Закреплённые сохранены.':'История очищена.');
    } catch (error) { toast(friendlyError(error), true); }
    finally {historyClearing=false;document.querySelector('main')!.inert=false;renderHistory();}
  });
});
$('refresh-mics').addEventListener('click', () => void refreshMicrophones());
$('profile-add-button').addEventListener('click', addProfile);
$('profile-app').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addProfile(); } });
function renderNativeHealth(state: import('../main/native-recovery').NativeHealth): void {
  $('native-health').textContent=state.message;
  $<HTMLButtonElement>('native-restart').disabled=state.retrying;
}
$('native-restart').addEventListener('click',()=>{void api.restartNative().catch(error=>toast(friendlyError(error),true));});
const unsubscribeNative=api.onNativeHealth(renderNativeHealth);
void api.getNativeHealth().then(renderNativeHealth).catch(()=>{});
form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('change', queueSettingsSave);
form.querySelector('[name="replacements"]')?.addEventListener('input', queueSettingsSave);
for (const name of ['llmBaseUrl', 'llmModel']) form.querySelector(`[name="${name}"]`)?.addEventListener('input', queueSettingsSave);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && isBusy()) { event.preventDefault(); cancel(); } });
navigator.mediaDevices?.addEventListener('devicechange', () => void refreshMicrophones());
const unsubscribe = api.onCommand(command => { void handleCommand(command); });
const unsubscribeUpdates = api.onUpdateState(renderUpdate);
$('update-check').addEventListener('click', () => { void api.checkForUpdates().then(renderUpdate).catch(error => toast(friendlyError(error), true)); });
$('update-download').addEventListener('click', () => { void api.downloadUpdate().then(renderUpdate).catch(error => toast(friendlyError(error), true)); });
$('update-install').addEventListener('click', () => void installUpdate());
$('update-notice-action').addEventListener('click', () => {
  if (updateState.phase === 'ready') void installUpdate();
  else void api.downloadUpdate().then(renderUpdate).catch(error => toast(friendlyError(error), true));
});
window.addEventListener('beforeunload', () => {
  unsubscribeNative();
  flushHistorySave();
  clearInterval(ticker);
  unsubscribe();
  unsubscribeUpdates();
  session?.recorder.cancel();
  asr.destroy();
  if (cueContext) void cueContext.close();
});

async function boot(): Promise<void> {
  void api.getUpdateState().then(renderUpdate).catch(() => renderUpdate({ phase: 'error', message: 'Не удалось проверить доступность обновлений.' }));
  void api.hasApiKey().then(has => { if (has) $('llm-key-status').textContent = 'API-ключ сохранён и зашифрован средствами Windows.'; }).catch(error => toast(friendlyError(error), true));
  setPhase('idle');
  const loaded = await Promise.allSettled([api.getSettings(), api.getHistory(), api.getAppInfo()]);
  if (loaded[0].status === 'fulfilled') settings = { ...DEFAULT_SETTINGS, ...loaded[0].value };
  else toast('Не удалось прочитать настройки. Используются настройки по умолчанию.', true);
  syncProvider();
  if (loaded[1].status === 'fulfilled') history = loaded[1].value;
  else toast('Не удалось прочитать историю. Новые расшифровки всё ещё доступны.', true);
  if (loaded[2].status === 'fulfilled') {
    const info = loaded[2].value;
    $('version').textContent = `Voice Scribe ${info.version}`;
    $('data-path').textContent = `Данные приложения: ${info.dataPath}`;
    if (!info.nativeReady) toast('Глобальные клавиши пока недоступны. Диктовка кнопкой работает; текст можно вставить через Ctrl + V.', true);
  }
  await refreshMicrophones();
  applySettings();
  renderHistory();
  initialized = true;
  setPhase('idle');
  // Dispatch without awaiting: key-up must reach a pending microphone start.
  const queued = pendingCommands;
  pendingCommands = [];
  for (const command of queued) void handleCommand(command);
  if (settings.warmup && !isBusy()) void prepare();
}
void boot().catch(error => { initialized = true; setPhase('error', friendlyError(error)); });
