// Adapted from Voice Scribe 0.4.1 by mrrepac (MIT).
/* Обрезка тишины перед распознаванием: модель не получает записи без речи. */

const SR = 16000;
const FRAME = 320; // 20 мс
/** Запас по краям при обрезке — чтобы не срезать начало слова. */
const PAD_FRAMES = 15; // ~300 мс
/** Ниже этого пикового кадра (≈ −46 dBFS) в записи заведомо нет речи. */
const SILENT_PEAK = 0.005;
const ABS_FLOOR = 0.004;
const REL_FLOOR = 0.06;
/**
 * Минимум ОЗВУЧЕННОГО материала (сумма громких кадров, а не ширина окна —
 * окно всегда раздуто полями). Ниже этого — щелчок, кашель, стук, но не речь.
 */
const MIN_VOICED_SEC = 0.15;

/**
 * Обрезает тишину по краям записи (внутренние паузы не трогает).
 * Возвращает null, если речи нет вовсе — тогда модель можно вообще не грузить.
 */
export function trimSilence(audio: Float32Array): Float32Array | null {
  const n = Math.floor(audio.length / FRAME);
  if (n === 0) return null;

  const rms = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const start = i * FRAME;
    for (let j = start; j < start + FRAME; j++) sum += audio[j] * audio[j];
    rms[i] = Math.sqrt(sum / FRAME);
    if (rms[i] > peak) peak = rms[i];
  }
  if (peak < SILENT_PEAK) return null;

  const thr = Math.max(ABS_FLOOR, peak * REL_FLOOR);
  let first = -1;
  let last = -1;
  let voiced = 0;
  for (let i = 0; i < n; i++) {
    if (rms[i] > thr) {
      if (first < 0) first = i;
      last = i;
      voiced++;
    }
  }
  if (first < 0 || voiced * FRAME < MIN_VOICED_SEC * SR) return null;

  const from = Math.max(0, first - PAD_FRAMES) * FRAME;
  const to = Math.min(n, last + 1 + PAD_FRAMES) * FRAME;
  return audio.subarray(from, to);
}
