// Adapted from Voice Scribe 0.4.1 by mrrepac (MIT). Local Whisper inference.
import { cleanTranscript, trimSilence } from "../shared/clean";
import { Segmenter, joinSegments } from "../shared/live";
import type { Segment } from "../shared/live";
import type { Transcript, TranscriptSegment } from "../shared/transcript";

/*
 * Минимальные типы transformers.js. Библиотека приезжает динамическим import(),
 * поэтому без объявлений всё, что из неё выходит, было бы any — и tsc не ловил
 * бы ни опечатку в имени опции, ни изменение сигнатуры при обновлении версии.
 */

/** Хранилище моделей: интерфейс Web Cache, который ждёт env.customCache. */
export interface CacheLike {
  match(request: string | { url?: string }): Promise<Response | undefined>;
  put(request: string | { url?: string }, response: Response): Promise<void>;
}
interface OnnxEnv {
  logLevel: "verbose" | "info" | "warning" | "error" | "fatal";
  wasm: {
    /** Строка-префикс либо точные адреса файлов. */
    wasmPaths?: string | { mjs: string; wasm: string };
    numThreads: number;
  };
}
interface TfEnv {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  useFSCache: boolean;
  useBrowserCache: boolean;
  useCustomCache: boolean;
  customCache?: CacheLike;
  backends: { onnx: OnnxEnv };
}
/** Событие загрузки файла модели. */
interface TfProgress {
  status?: string;
  file?: string;
  progress?: number;
}
/** Общий dtype либо отдельно на энкодер и декодер (см. dtypeFor). */
type Dtype = "q8" | "q4" | "fp16" | "fp32" | { encoder_model: string; decoder_model_merged: string };
interface PipelineOptions {
  device: Device;
  dtype: Dtype;
  session_options?: { logSeverityLevel: number };
  progress_callback?: (p: TfProgress) => void;
}
interface AsrOptions {
  chunk_length_s: number;
  stride_length_s: number;
  task: "transcribe";
  return_timestamps: boolean;
  force_full_sequences: boolean;
  /** Живой текст по токенам; для коротких фраз не нужен. */
  streamer?: unknown;
  language?: string;
}
interface AsrResult {
  text?: string;
  /** Whisper may omit the closing timestamp when audio ends mid-word. */
  chunks?: { text: string; timestamp: [number | null, number | null] }[];
}
/** Пайплайн — вызываемый объект с довеском (токенайзер, освобождение памяти). */
interface AsrPipeline {
  (audio: Float32Array, opts: AsrOptions): Promise<AsrResult | AsrResult[]>;
  tokenizer: unknown;
  /** Аудио → log-mel признаки (первые 30 с). Нужен определению языка. */
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  /** Сама модель: прямой проход энкодер+декодер (определение языка). */
  model: WhisperModelLike;
  dispose?: () => Promise<void>;
}
interface WhisperModelLike {
  (inputs: { input_features: unknown; decoder_input_ids: unknown }): Promise<
    { logits: { data: Float32Array; dims: number[] } } & Record<string, unknown>
  >;
  generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
}
interface StreamerOptions {
  skip_prompt?: boolean;
  callback_function?: (text: string) => void;
  /** Timestamp inside the current decoding window, not the whole recording. */
  on_chunk_start?: (sec: number) => void;
  on_finalize?: () => void;
}
interface TfModule {
  env: TfEnv;
  pipeline(task: "automatic-speech-recognition", model: string, opts: PipelineOptions): Promise<AsrPipeline>;
  WhisperTextStreamer: new (tokenizer: unknown, opts: StreamerOptions) => unknown;
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}

/** WebGPU: типов в lib.dom нет, объявляем используемый минимум. */
interface GpuAdapter {
  features?: { has?(name: string): boolean };
}
interface GpuLike {
  requestAdapter(): Promise<GpuAdapter | null>;
}

/** turbo-hq: the same Turbo weights with an fp16 encoder — more accurate, larger download. */
export type WhisperModel = "tiny" | "base" | "small" | "turbo" | "turbo-hq";
const isTurbo = (model: WhisperModel) => model === "turbo" || model === "turbo-hq";
/** Настройка модели: конкретная или «авто» — лучшая, которую тянет ЭТО устройство. */
export type ModelPref = WhisperModel | "auto";
export type DevicePref = "auto" | "webgpu" | "wasm";
export type Device = "webgpu" | "wasm";

const MODEL_IDS: Record<WhisperModel, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
  turbo: "onnx-community/whisper-large-v3-turbo",
  "turbo-hq": "onnx-community/whisper-large-v3-turbo",
};

export interface ProgressInfo {
  /** Этап: подбор устройства / загрузка модели / расшифровка. */
  stage: "device" | "model" | "run";
  /** Имя файла модели (этап model). */
  file?: string;
  /** 0..100, если известен. */
  pct?: number;
  /** true = файл реально качается из сети; false = читается из дискового кэша. */
  dl?: boolean;
  /** Хвост уже распознанного текста (этап run) — живой индикатор. */
  tail?: string;
  /** Runtime changed device or could not persist a downloaded model. */
  note?: "webgpu-fallback" | "cache-write-failed";
}

export type ProgressFn = (p: ProgressInfo) => void;

/**
 * Всё, что ядро не может добыть само: кэш моделей на диске, пропатченный
 * рантайм ORT и признак платформы. Поставляет главный поток.
 */
export interface EngineHost {
  /** Телефон: своего кэша нет, ORT берётся с CDN, WebGPU не трогаем вовсе. */
  mobile: boolean;
  /** Файловый кэш моделей; null = положиться на браузерный Cache API. */
  cache: CacheLike | null;
  /** Bundled runtime URLs; this application does not fetch executable code from a CDN. */
  ort: { mjsUrl: string; wasmUrl: string };
  /** Без него многопоточный wasm недоступен. */
  crossOriginIsolated: boolean;
}

let host: EngineHost | null = null;
export function setHost(h: EngineHost): void {
  host = h;
  envConfigured = false; // настройки env перечитаются на следующем запуске
  probed = null; // опрос железа зависит от host.mobile — считаем заново
}

let tfPromise: Promise<TfModule> | null = null;
/** Ленивая загрузка transformers.js: до первой расшифровки её никто не тянет. */
function tf(): Promise<TfModule> {
  // Единственное место, где мы доверяем библиотеке на слово: дальше всё типизировано.
  return (tfPromise ??= import("@huggingface/transformers") as unknown as Promise<TfModule>);
}

let envConfigured = false;

/** Имена файлов модели, которых не было в кэше (реально качаются) — для честной надписи. */
const downloadingFiles = new Set<string>();
/** Кэш докладывает о промахах: только так видно, что файл идёт из сети. */
export function noteCacheMiss(key: string): void {
  const name = key.split("/").pop();
  if (name && /^https?:.*\.onnx$/i.test(key)) downloadingFiles.add(name);
}

/** Настройка env transformers.js под наше окружение. */
async function configureEnv(): Promise<void> {
  if (envConfigured) return;
  if (!host) throw new Error("ASR_NOT_CONFIGURED");
  const { env } = await tf();

  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useFSCache = false;

  if (host.cache) {
    // Десктоп: свой файловый кэш вне хранилища. Cache API на 600-МБ файлах
    // (turbo) молча роняет put по квоте — модель качалась бы каждый раз заново.
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = host.cache;
  } else {
    // Мобайл: node недоступен → браузерный Cache API. Для tiny/base (40–80 МБ)
    // квоты хватает, перекачки нет.
    env.useBrowserCache = true;
    env.useCustomCache = false;
  }

  const onnx = env.backends.onnx;
  // Приглушаем болтливый логгер ORT: на WebGPU он на каждом запуске сыпет
  // W:VerifyEachNodeIsAssignedToAnEp («часть узлов на CPU») — норма, не ошибка.
  onnx.logLevel = "error";

  // This worker has no Node integration. The original Emscripten module therefore
  // takes its browser path without the patches required inside Obsidian.
  onnx.wasm.wasmPaths = { mjs: host.ort.mjsUrl, wasm: host.ort.wasmUrl };
  onnx.wasm.numThreads = host.crossOriginIsolated
    ? Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1))
    : 1;

  envConfigured = true;
}

export interface GpuInfo {
  device: Device;
  /** Поддержка расширения shader-f16 — без неё fp16-модели не запускаются. */
  f16: boolean;
}

/**
 * Подбор устройства + возможностей. 'auto'/'webgpu' → пробуем WebGPU-адаптер
 * и заодно смотрим shader-f16 (у многих встроенных/старых GPU его нет — тогда
 * fp16-энкодер падает, и нужен fp32; это и была причина отката на wasm).
 */
let probed: { pref: DevicePref; info: GpuInfo } | null = null;

/**
 * То же, но с памятью: в живом режиме пайплайн запрашивается на каждую фразу, а
 * requestAdapter стоит недёшево и, по опыту, умеет надолго залипать. Железо
 * между фразами не меняется — опрашиваем его один раз на настройку.
 */
async function probeDeviceCached(pref: DevicePref): Promise<GpuInfo> {
  if (probed?.pref === pref) return probed.info;
  const info = await probeDevice(pref);
  probed = { pref, info };
  return info;
}

export async function probeDevice(pref: DevicePref): Promise<GpuInfo> {
  // МОБАЙЛ: navigator.gpu не трогаем ВООБЩЕ. В Android WebView requestAdapter
  // блокирует поток намертво (тогда и setTimeout не срабатывает) — телефон вис
  // на «Определяю устройство». Там всё равно считает только процессор.
  if (pref === "wasm" || host?.mobile) return { device: "wasm", f16: false };
  const gpu = (globalThis.navigator as Navigator & { gpu?: GpuLike })?.gpu;
  if (gpu) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // requestAdapter иногда залипает (драйвер/потерянное устройство) — не даём
      // стадии «Определяю устройство» повиснуть навсегда.
      const adapter = await Promise.race([
        gpu.requestAdapter(),
        new Promise<null>((r) => { timeout = setTimeout(() => r(null), 5000); }),
      ]);
      if (adapter) return { device: "webgpu", f16: !!adapter.features?.has?.("shader-f16") };
      console.warn("voice-scribe: requestAdapter returned null/timed out");
    } catch (e) {
      console.warn("voice-scribe: webgpu adapter failed", e);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  return { device: "wasm", f16: false };
}

export interface Loaded {
  key: string;
  asr: AsrPipeline;
  device: Device;
  model: WhisperModel;
  f16: boolean;
  /** WebGPU выбрали, но пайплайн не завёлся — реально работаем на wasm. */
  fellBack: boolean;
}

let loaded: Loaded | null = null;

/**
 * Ключ загруженного пайплайна. Считается ОТ ФАКТИЧЕСКОГО устройства: иначе
 * после отката WebGPU→wasm сохранённый ключ не совпал бы с проверочным, и
 * пайплайн пересобирался бы на каждый запрос (в живом режиме — на каждую фразу).
 */
const keyOf = (model: WhisperModel, dev: Device, f16: boolean) => `${model}|${dev}|${f16 ? "f16" : "f32"}`;

/** «Авто» = максимум, который реально тянет это устройство. */
function resolveAutoModel(device: Device, mobile: boolean, f16 = false): WhisperModel {
  // Телефон: base. small упирается в память WebView (32-битный WASM, пики
  // 0.5–0.8 ГБ — OOM-киллер убивает всё приложение без перехватываемой ошибки)
  // и в один поток (нет crossOriginIsolated) — 5–10× медленнее реального времени.
  if (mobile) return "base";
  // Десктоп: turbo на видеокарте, иначе small — потолок 32-битного WASM.
  // With shader-f16, Turbo HQ: its fp16 encoder measured ~35% faster than q4.
  if (device !== "webgpu") return "small";
  return f16 ? "turbo-hq" : "turbo";
}

function dtypeFor(model: WhisperModel, device: Device, f16: boolean): Dtype {
  // CPU (wasm): целиком q8.
  if (device !== "webgpu") return "q8";
  // Desktop turbo always uses q4 weights (~724 MiB combined). This keeps the
  // model's download/memory size stable across GPUs and reuses the original
  // plugin's q4 cache even when a newer Chromium enables shader-f16 support.
  if (model === "turbo") return { encoder_model: "q4", decoder_model_merged: "q4" };
  // Turbo HQ: q4 hurts the encoder most, so it alone stays fp16 (~1.5 GiB in total).
  // Without shader-f16 the fp16 encoder cannot run; fall back to the regular Turbo files.
  if (model === "turbo-hq") return f16 ? { encoder_model: "fp16", decoder_model_merged: "q4" } : { encoder_model: "q4", decoder_model_merged: "q4" };
  // GPU с fp16 — как в официальных whisper-webgpu демо (быстро и точно).
  if (f16) return { encoder_model: "fp16", decoder_model_merged: "q4" };
  // tiny/base/small without shader-f16 use the smaller, built-in fp32 encoder.
  return { encoder_model: "fp32", decoder_model_merged: "q4" };
}

/** Суффиксы файлов ONNX по dtype — как в transformers.js (DEFAULT_DTYPE_SUFFIX_MAPPING). */
const DTYPE_SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4" };

/** Что понадобится загрузить: модель и её тяжёлые файлы (конфиги не в счёт — килобайты). */
export interface DownloadPlan {
  model: WhisperModel;
  /** onnx-community/whisper-small… */
  modelId: string;
  /** Пути внутри репозитория: onnx/encoder_model_q4.onnx… */
  files: string[];
}

/**
 * Какие файлы возьмёт getPipeline при тех же настройках — без загрузки. Нужен,
 * чтобы спросить человека ДО скачивания: turbo весит 724 МБ, а на телефоне это
 * мобильный трафик. Откат WebGPU→wasm возьмёт другие файлы — его заранее не
 * предскажешь, и он редкий.
 */
export async function planDownload(pref: ModelPref, devicePref: DevicePref, onProgress: ProgressFn): Promise<DownloadPlan> {
  if (!probed) onProgress({ stage: "device" });
  const { device, f16 } = await probeDeviceCached(devicePref);
  const model: WhisperModel = pref === "auto" ? resolveAutoModel(device, !!host?.mobile, f16) : pref;
  if (isTurbo(model) && device === "wasm") throw new Error("MODEL_TOO_BIG_FOR_CPU");
  const d = dtypeFor(model, device, f16);
  const enc = typeof d === "string" ? d : d.encoder_model;
  const dec = typeof d === "string" ? d : d.decoder_model_merged;
  return {
    model,
    modelId: MODEL_IDS[model],
    files: [`onnx/encoder_model${DTYPE_SUFFIX[enc]}.onnx`, `onnx/decoder_model_merged${DTYPE_SUFFIX[dec]}.onnx`],
  };
}

/**
 * Все вызовы строго по очереди. Иначе фоновый прогрев и ранняя запись успевали
 * пройти проверки параллельно и собирали ДВА пайплайна (двойное скачивание,
 * второй никогда не освобождался).
 */
let gate: Promise<unknown> = Promise.resolve();

export function getPipeline(pref: ModelPref, devicePref: DevicePref, onProgress: ProgressFn): Promise<Loaded> {
  const run = gate.then(() => getPipelineInner(pref, devicePref, onProgress));
  gate = run.catch(() => {});
  return run;
}

/**
 * Пайплайн-одиночка. Пересоздаётся при смене модели/устройства в настройках.
 * При падении WebGPU (нет поддержки, драйвер, fp16) откатывается на wasm.
 */
async function getPipelineInner(pref: ModelPref, devicePref: DevicePref, onProgress: ProgressFn): Promise<Loaded> {
  await configureEnv();
  // Первый опрос железа не мгновенный — говорим об этом; повторные берутся из
  // памяти, и мигать «Определяю устройство…» на каждой фразе незачем.
  if (!probed) onProgress({ stage: "device" });
  // Модель и turbo решаются по РЕАЛЬНОМУ устройству, а не по платформе: если у
  // телефона вдруг есть WebGPU — пусть работает; если нет — честная ошибка ДО загрузки.
  const { device, f16 } = await probeDeviceCached(devicePref);
  let model: WhisperModel = pref === "auto" ? resolveAutoModel(device, !!host?.mobile, f16) : pref;
  let modelId = MODEL_IDS[model];
  if (loaded?.key === keyOf(model, device, f16)) return loaded; // уже готов — молча

  // turbo нужен GPU: на wasm её энкодер (615 МБ одним буфером) не влезает в
  // 32-битную кучу. Бросаем ДО скачивания — чтобы не слить сотни мегабайт зря.
  // Достижимо только ручным выбором: «авто» turbo на wasm не назначает.
  if (isTurbo(model) && device === "wasm") {
    throw new Error("MODEL_TOO_BIG_FOR_CPU");
  }

  // Смена модели/устройства: старый пайплайн освобождаем сразу. Сюда же
  // попадает пайплайн, «воскресший» после dispose, который разминулся с ещё
  // летевшей загрузкой, — иначе он жил бы в VRAM до перезапуска.
  if (loaded) {
    const old = loaded;
    loaded = null;
    try {
      await old.asr.dispose?.();
    } catch (e) {
      console.warn("voice-scribe: dispose failed", e);
    }
  }

  downloadingFiles.clear();
  const { pipeline } = await tf();
  const progress_callback = (p: TfProgress) => {
    if (p.status === "progress" && p.file) {
      const file = p.file;
      onProgress({ stage: "model", file, pct: Math.round(p.progress ?? 0), dl: downloadingFiles.has(file.split("/").pop() ?? file) });
    }
  };
  const make = (dev: Device, useF16: boolean) =>
    pipeline("automatic-speech-recognition", modelId, {
      device: dev,
      dtype: dtypeFor(model, dev, useF16),
      // Уровень логов задаётся на самой сессии (глобальный env.logLevel ORT
      // игнорирует): 3 = Error, глушит W:VerifyEachNodeIsAssignedToAnEp.
      session_options: { logSeverityLevel: 3 },
      progress_callback,
    });

  onProgress({ stage: "model" });
  let dev = device;
  let asr: AsrPipeline;
  try {
    asr = await make(dev, f16);
  } catch (e) {
    // WebGPU может не завестись (драйвер/операции) — откат на CPU, но turbo
    // на CPU не тянет, поэтому его не откатываем, а отдаём понятную ошибку.
    if (dev === "webgpu" && (!isTurbo(model) || pref === "auto")) {
      console.warn("voice-scribe: webgpu pipeline failed, falling back to wasm", e);
      onProgress({ stage: "device", note: "webgpu-fallback" });
      dev = "wasm";
      if (pref === "auto") {
        model = resolveAutoModel("wasm", false);
        modelId = MODEL_IDS[model];
      }
      asr = await make(dev, false);
      // На этом железе WebGPU не заводится — запоминаем как итог опроса. Иначе
      // следующий запрос снова пошёл бы в него и снова откатывался: минуты на
      // пересборку пайплайна вместо мгновенного возврата готового.
      probed = { pref: devicePref, info: { device: "wasm", f16: false } };
    } else {
      throw e;
    }
  }
  const effF16 = dev === "webgpu" ? f16 : false;
  loaded = {
    key: keyOf(model, dev, effF16),
    asr,
    device: dev,
    model,
    f16: effF16,
    fellBack: dev !== device,
  };
  return loaded;
}

/** Сброс пайплайна (смена модели/устройства в настройках). */
export async function disposePipeline(): Promise<void> {
  const old = loaded;
  loaded = null;
  try {
    await old?.asr.dispose?.();
  } catch (e) {
    console.warn("voice-scribe: dispose failed", e);
  }
}

const CHUNK_S = 30;
const STRIDE_S = 5;

/** Внутренний маркер: пользователь отменил. Это не ошибка. */
const CANCELLED = "VS_CANCELLED";

interface RunOptions {
  /** Язык речи: код («ru») либо «auto» — определить самим. */
  language?: string;
  /**
   * Второй язык: каждая фраза пишется на том из двух, на котором сказана.
   * Whisper держит один язык на кусок аудио, поэтому смешанную речь режем по
   * паузам и определяем язык каждой фразы отдельно.
   */
  language2?: string;
  /** Живой режим: фраза уже нарезана по паузам — без чанкинга и стримера. */
  segment?: boolean;
}

/**
 * Язык куска аудио: один проход энкодера и один шаг декодера после
 * <|startoftranscript|> — модель сама ставит следующим токен языка, берём самый
 * вероятный (среди allowed, если задан). transformers.js этого не умеет:
 * без языка она молча подставляет английский («TODO: Implement language
 * detection»), и прежнее «Автоопределение» на деле переводило любую речь на
 * английский. Замер на turbo: верно на всех фразах от 1,9 с, отрыв ~7 логитов.
 */
async function detectLanguage(asr: AsrPipeline, speech: Float32Array, allowed: string[] | null): Promise<string> {
  const { Tensor } = await tf();
  const gc = asr.model.generation_config;
  // признаки Whisper всё равно берут только первые 30 секунд
  const { input_features } = await asr.processor(speech.subarray(0, 30 * 16000));
  const decoder_input_ids = new Tensor("int64", BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]);
  const out = await asr.model({ input_features, decoder_input_ids });
  const { data, dims } = out.logits;
  const base = data.length - dims[dims.length - 1]; // логиты последней позиции
  let best = allowed?.[0] ?? "en";
  let bestScore = -Infinity;
  for (const [tok, id] of Object.entries(gc.lang_to_id)) {
    const code = tok.slice(2, -2); // «<|ru|>» → «ru»
    if (allowed && !allowed.includes(code)) continue;
    if (data[base + id] > bestScore) {
      bestScore = data[base + id];
      best = code;
    }
  }
  // кэш ключей/значений декодера на WebGPU лежит в видеопамяти — освобождаем
  for (const v of Object.values(out)) (v as { dispose?: () => void } | null)?.dispose?.();
  return best;
}

/**
 * Расшифровка PCM (16 кГц mono). Пустая строка = речи не найдено или отмена.
 * Тишину модели не отдаём вовсе: на ней Whisper галлюцинирует («[музыка]»,
 * «Продолжение следует…»), а заодно экономим загрузку модели.
 */
export async function runAsr(
  loadedPipe: Loaded,
  audio: Float32Array,
  opts: RunOptions,
  onProgress: ProgressFn,
  isCancelled: () => boolean = () => false
): Promise<string> {
  return (await runAsrResult(loadedPipe, audio, opts, onProgress, isCancelled, false)).text;
}

/** File transcription: timestamps are always requested, including short clips. */
export async function runAsrTimed(
  loadedPipe: Loaded,
  audio: Float32Array,
  opts: RunOptions,
  onProgress: ProgressFn,
  isCancelled: () => boolean = () => false
): Promise<Transcript> {
  return runAsrResult(loadedPipe, audio, opts, onProgress, isCancelled, true);
}

async function runAsrResult(
  loadedPipe: Loaded,
  audio: Float32Array,
  opts: RunOptions,
  onProgress: ProgressFn,
  isCancelled: () => boolean,
  timed: boolean
): Promise<Transcript> {
  if (isCancelled()) return { text: "", segments: [] };
  const speech = trimSilence(audio);
  if (!speech) return { text: "", segments: [] };
  // trimSilence returns a view. Subtract the input view's offset as well, since
  // callers may pass a slice of a larger PCM buffer.
  const offset = (speech.byteOffset - audio.byteOffset) / Float32Array.BYTES_PER_ELEMENT / 16000;
  const { asr } = loadedPipe;
  const lang = opts.language || "auto";
  const pair = lang !== "auto" && opts.language2 && opts.language2 !== lang ? [lang, opts.language2] : null;

  try {
    // Один язык и он задан — определять нечего, путь как всегда.
    if (lang !== "auto" && !pair) return await runOnce(asr, speech, lang, !!opts.segment, onProgress, isCancelled, timed, offset);
    // Живая фраза — уже кусок с одним языком.
    if (opts.segment) {
      const code = await detectLanguage(asr, speech, pair);
      return await runOnce(asr, speech, code, true, onProgress, isCancelled, timed, offset);
    }
    // Вся запись, автоопределение: язык по началу, дальше как обычно — так
    // делает и сам Whisper.
    if (!pair) {
      const code = await detectLanguage(asr, speech, null);
      return { ...await runOnce(asr, speech, code, false, onProgress, isCancelled, timed, offset), language: code };
    }
    return await runMixed(asr, speech, pair, onProgress, isCancelled, timed, offset);
  } catch (e) {
    if ((e as Error)?.message === CANCELLED) return { text: "", segments: [] };
    throw e;
  }
}

/**
 * Два языка во всей записи: режем по паузам тем же нарезчиком, что и живой
 * режим, и каждую фразу пишем на её языке. Цена — лишний проход энкодера на
 * фразу и контекст, который между фразами не передаётся.
 */
async function runMixed(
  asr: AsrPipeline,
  speech: Float32Array,
  pair: string[],
  onProgress: ProgressFn,
  isCancelled: () => boolean,
  timed: boolean,
  offset: number
): Promise<Transcript> {
  const segs: Segment[] = [];
  const cutter = new Segmenter((s) => segs.push(s));
  for (let i = 0; i < speech.length; i += 128) cutter.push(speech.subarray(i, i + 128));
  cutter.flush();
  // Нарезчик ничего не нашёл (ровный тихий голос без пауз) — целиком, одним языком.
  if (!segs.length) {
    const code = await detectLanguage(asr, speech, pair);
    return runOnce(asr, speech, code, false, onProgress, isCancelled, timed, offset);
  }
  const parts: string[] = [];
  const segments: TranscriptSegment[] = [];
  let completeTimings = true;
  for (let i = 0; i < segs.length; i++) {
    if (isCancelled()) throw new Error(CANCELLED);
    onProgress({ stage: "run", pct: Math.round((i / segs.length) * 100), tail: joinSegments(parts).slice(-160) });
    const segment = segs[i];
    const code = await detectLanguage(asr, segment.pcm, pair);
    const result = await runOnce(asr, segment.pcm, code, true, () => {}, isCancelled, timed, offset + segment.startSec);
    if (result.text && !result.segments.length) completeTimings = false;
    // Mirror joinSegments' punctuation in the last cue of the previous phrase.
    if (result.text && segments.length && !/[.!?…,:;—-]$/u.test(segments[segments.length - 1].text)) {
      segments[segments.length - 1].text += ".";
    }
    parts.push(result.text);
    segments.push(...result.segments);
  }
  return { text: joinSegments(parts), segments: completeTimings ? segments : [] };
}

/** Keep model timings, repairing only a missing end from a known boundary. */
function timedSegments(results: AsrResult[], duration: number, offset: number): TranscriptSegment[] {
  const chunks = results.flatMap(result => Array.isArray(result.chunks) ? result.chunks : []);
  const candidates: { start: number; end: number | null; text: string }[] = [];
  for (const chunk of chunks) {
    if (!chunk || !Array.isArray(chunk.timestamp) || typeof chunk.text !== "string") continue;
    const [from, to] = chunk.timestamp;
    // A missing start provides no usable position. Do not distribute text over
    // the file or invent a cue for a result that contains no model timestamps.
    if (typeof from !== "number" || !Number.isFinite(from)) continue;
    const start = Math.max(0, Math.min(duration, from));
    if (start >= duration || (candidates.length && start < candidates[candidates.length - 1].start)) continue;
    candidates.push({
      start,
      end: typeof to === "number" && Number.isFinite(to) ? to : null,
      text: cleanTranscript(chunk.text),
    });
  }
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const chunk = candidates[i];
    const boundary = candidates[i + 1]?.start ?? duration;
    const end = Math.min(duration, boundary, chunk.end ?? boundary);
    if (!chunk.text || end <= chunk.start) continue;
    segments.push({ start: chunk.start + offset, end: end + offset, text: chunk.text });
  }
  return segments;
}

/**
 * Один проход Whisper с известным языком. isCancelled опрашивается из колбэков
 * стримера, то есть между шагами генерации. Бросаем оттуда исключение — только
 * так обрывается цикл по чанкам внутри transformers.js (иначе часовой файл
 * домолотит до конца в никуда).
 */
async function runOnce(
  asr: AsrPipeline,
  speech: Float32Array,
  language: string,
  segment: boolean,
  onProgress: ProgressFn,
  isCancelled: () => boolean,
  timed: boolean,
  offset: number
): Promise<Transcript> {
  if (isCancelled()) throw new Error(CANCELLED);
  const totalSec = speech.length / 16000;
  // Для обычной диктовки таймстемпы нужны только длиннее одного окна Whisper.
  // На коротких таймстемп-токены — лишние шаги декодера: замер на small,
  // записи 6–29 с — на 8–14% быстрее, текст тот же. А длиннее окна без
  // таймстемпов НЕЛЬЗЯ: модель обрывает текст на первых 30 секундах.
  const chunked = !segment && totalSec > CHUNK_S;

  const asrOpts: AsrOptions = {
    chunk_length_s: chunked ? CHUNK_S : 0,
    stride_length_s: chunked ? STRIDE_S : 0,
    task: "transcribe",
    return_timestamps: timed || chunked,
    force_full_sequences: false,
    language,
  };

  if (!segment) {
    // Each model.generate call finalizes one overlapping window. Timestamp
    // tokens are local to that window and cannot measure whole-file progress.
    const { WhisperTextStreamer } = await tf();
    onProgress({ stage: "run", pct: 0 });
    let recognized = "";
    let pct: number | undefined = chunked ? 0 : undefined;
    let completedWindows = 0;
    const windowCount = chunked ? 1 + Math.ceil((totalSec - CHUNK_S) / (CHUNK_S - 2 * STRIDE_S)) : 1;
    let lastUi = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastUi < 150) return; // не дёргать интерфейс на каждый токен
      lastUi = now;
      onProgress({ stage: "run", pct, tail: recognized.slice(-160) });
    };
    asrOpts.streamer = new WhisperTextStreamer(asr.tokenizer, {
      skip_prompt: true,
      callback_function: (text: string) => {
        if (isCancelled()) throw new Error(CANCELLED);
        recognized += text;
        report();
      },
      on_finalize: () => {
        if (isCancelled()) throw new Error(CANCELLED);
        completedWindows++;
        pct = Math.min(99, Math.floor(completedWindows / windowCount * 100));
        report(true);
      },
    });
  }

  const out = await asr(speech, asrOpts);
  if (isCancelled()) throw new Error(CANCELLED);
  const results = Array.isArray(out) ? out : [out];
  const raw = results.map(result => result.text ?? "").join(" ");
  const text = cleanTranscript(raw);
  const segments = timed ? timedSegments(results, totalSec, offset) : [];
  // Subtitle editing derives the text from cues. If any recognized words have
  // no usable timing, return plain text intact rather than lose those words.
  const compact = (value: string) => value.replace(/\s+/g, "");
  const complete = compact(segments.map(segment => segment.text).join(" ")) === compact(text);
  return { text, segments: complete ? segments : [] };
}
