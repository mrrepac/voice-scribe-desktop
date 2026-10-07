// Ported unchanged from Voice Scribe 0.4.1 by mrrepac (MIT).
/*
 * Живая расшифровка: нарезка потока микрофона на фразы.
 *
 * Whisper не потоковый — он берёт окно в 30 секунд и ждёт готовый кусок аудио.
 * Поэтому показать текст «по ходу» можно ровно одним способом: резать речь на
 * фразы по паузам и отдавать модели каждую фразу отдельно. Границы ставим
 * ТОЛЬКО в тишине — там, где контекст рвётся сам собой (передать его между
 * кусками всё равно нечем: prompt_ids в transformers.js 3.8.1 не реализован).
 *
 * Пороги здесь родня clean.ts: те же 20-мс кадры и та же логика «громкость выше
 * фона = речь», только фон оценивается на ходу, а не по всей записи разом.
 *
 * Модуль намеренно без зависимостей от Obsidian — чтобы гонять тестами
 * (tools/test-live.mjs).
 */

const SR = 16000;
/** Кадр анализа, 20 мс — как в clean.ts. */
const FRAME = 320;
const FRAME_MS = (FRAME / SR) * 1000;

/**
 * Гистерезис: речь «включается» выше ON и «выключается» ниже OFF. Один общий
 * порог дребезжал бы на согласных, разрывая фразу на куски.
 * Абсолютные значения — от замеров с включённым шумодавом: комнатный фон ≈0.003,
 * даже тихая речь ≈0.05. Относительные подстраховывают в шумной комнате.
 */
const ON_ABS = 0.012;
const OFF_ABS = 0.007;
const ON_REL = 4;
const OFF_REL = 2.5;

/** Пауза, после которой фраза считается законченной. */
const SILENCE_HOLD_MS = 700;
/** Меньше озвученного — это щелчок, кашель или стук, но не фраза. */
const MIN_VOICED_MS = 250;
/** Максимум без единой паузы: с запасом влезает в 30-секундное окно Whisper. */
const MAX_SEG_MS = 25000;
/** Захват ДО начала речи, иначе срезается первый слог. */
const PREROLL_MS = 300;
/** Немного тишины в хвосте: с ней модель увереннее закрывает фразу. */
const TAIL_MS = 200;
/** В каком окне искать тихое место, когда резать приходится не по паузе. */
const CUT_WINDOW_MS = 2000;

const ms2frames = (ms: number) => Math.round(ms / FRAME_MS);
const PREROLL_FRAMES = ms2frames(PREROLL_MS);
const SILENCE_FRAMES = ms2frames(SILENCE_HOLD_MS);
const MIN_VOICED_FRAMES = ms2frames(MIN_VOICED_MS);
const MAX_SEG_FRAMES = ms2frames(MAX_SEG_MS);
const TAIL_FRAMES = ms2frames(TAIL_MS);
const CUT_WINDOW_FRAMES = ms2frames(CUT_WINDOW_MS);

export interface Segment {
  /** Готовый кусок PCM 16 кГц mono — можно сразу отдавать модели. */
  pcm: Float32Array;
  /** Положение в записи, секунды. Расшифровке не нужно: этим тест проверяет,
   *  что фразы идут по порядку и не наезжают друг на друга (tools/test-live.mjs). */
  startSec: number;
  endSec: number;
}

/** Средняя громкость кадра: по ней и отличается речь от паузы. */
function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

function joinFrames(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => out.set(f, i * FRAME));
  return out;
}

/**
 * Режет непрерывный поток PCM на фразы. Кормить чем угодно — блоками любой
 * длины (AudioWorklet присылает по 128 сэмплов), кадры собираются внутри.
 */
export class Segmenter {
  private onSegment: (seg: Segment) => void;

  private state: "silence" | "speech" = "silence";
  /** Незаполненный хвост кадра между вызовами push. */
  private partial = new Float32Array(FRAME);
  private partialLen = 0;
  /** Сколько целых кадров прошло с начала записи — из них считаем секунды. */
  private frames = 0;

  /** Последние кадры тишины: попадут в начало фразы, если речь начнётся сейчас. */
  private preroll: Float32Array[] = [];
  private seg: Float32Array[] = [];
  /** Громкость кадров текущей фразы — для поиска места принудительной резки. */
  private segRms: number[] = [];
  private segStart = 0;
  private silence = 0;
  private voiced = 0;

  /** Оценка фона, ползёт за тишиной: в шумной комнате пороги поднимутся сами. */
  private noise = 0.002;

  constructor(onSegment: (seg: Segment) => void) {
    this.onSegment = onSegment;
  }

  push(block: Float32Array): void {
    let off = 0;
    while (off < block.length) {
      const take = Math.min(FRAME - this.partialLen, block.length - off);
      this.partial.set(block.subarray(off, off + take), this.partialLen);
      this.partialLen += take;
      off += take;
      if (this.partialLen === FRAME) {
        this.feed(this.partial);
        // кадр уехал в массив фразы — дальше пишем в свежий буфер
        this.partial = new Float32Array(FRAME);
        this.partialLen = 0;
      }
    }
  }

  /** Стоп записи: отдать незакрытую фразу, если в ней есть речь. */
  flush(): void {
    if (this.state === "speech") this.close();
    this.state = "silence";
    this.preroll = [];
    this.partialLen = 0;
  }

  private onThr(): number {
    return Math.max(ON_ABS, this.noise * ON_REL);
  }
  private offThr(): number {
    return Math.max(OFF_ABS, this.noise * OFF_REL);
  }

  private feed(frame: Float32Array): void {
    const r = rms(frame);
    this.frames++;

    if (this.state === "silence") {
      // фон обновляем только в паузах и только тем, что не похоже на речь
      if (r < this.onThr()) this.noise = this.noise * 0.95 + r * 0.05;
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (r > this.onThr()) {
        this.state = "speech";
        this.seg = this.preroll;
        this.segRms = this.preroll.map(() => 0);
        this.segStart = this.frames - this.seg.length;
        this.preroll = [];
        this.silence = 0;
        this.voiced = 0;
      }
      return;
    }

    this.seg.push(frame);
    this.segRms.push(r);
    if (r < this.offThr()) {
      this.silence++;
    } else {
      this.silence = 0;
      if (r > this.onThr()) this.voiced++;
    }

    if (this.silence >= SILENCE_FRAMES) this.close();
    else if (this.seg.length >= MAX_SEG_FRAMES) this.forceCut();
  }

  /** Закрыть фразу по паузе: хвостовую тишину срезаем, оставив немного «воздуха». */
  private close(): void {
    const keep = Math.max(0, this.seg.length - this.silence + TAIL_FRAMES);
    this.emit(this.seg.slice(0, Math.min(this.seg.length, keep)), this.voiced);
    this.state = "silence";
    this.seg = [];
    this.segRms = [];
    this.silence = 0;
    this.voiced = 0;
  }

  /**
   * Речь идёт без пауз дольше окна Whisper. Режем в самом тихом кадре последних
   * двух секунд: это обычно стык слов, а не середина слога.
   */
  private forceCut(): void {
    const from = Math.max(1, this.seg.length - CUT_WINDOW_FRAMES);
    let cut = this.seg.length;
    let best = Infinity;
    for (let i = from; i < this.seg.length; i++) {
      if (this.segRms[i] < best) {
        best = this.segRms[i];
        cut = i;
      }
    }
    const head = this.seg.slice(0, cut);
    const tail = this.seg.slice(cut);
    const tailRms = this.segRms.slice(cut);
    this.emit(head, this.voiced);
    // остаток становится началом следующей фразы — запись не прерывается
    this.segStart += head.length;
    this.seg = tail;
    this.segRms = tailRms;
    this.silence = 0;
    this.voiced = tailRms.filter((v) => v > this.onThr()).length;
  }

  private emit(frames: Float32Array[], voiced: number): void {
    if (!frames.length || voiced < MIN_VOICED_FRAMES) return; // щелчок, а не фраза
    this.onSegment({
      pcm: joinFrames(frames),
      startSec: (this.segStart * FRAME) / SR,
      endSec: ((this.segStart + frames.length) * FRAME) / SR,
    });
  }
}

/**
 * Склейка распознанных фраз в связный текст. Фразы приходят кусками, каждый со
 * своей заглавной буквы и часто без конечной точки — просто конкатенация давала
 * бы «Привет Как дела».
 */
export function joinSegments(parts: string[]): string {
  const out: string[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    const prev = out[out.length - 1];
    // предыдущая фраза оборвалась без знака — закрываем точкой
    if (prev && !/[.!?…,:;—-]$/u.test(prev)) out[out.length - 1] = prev + ".";
    out.push(s);
  }
  return out.join(" ");
}
