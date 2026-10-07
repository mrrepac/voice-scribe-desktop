const RATE = 16000;
/** One recognition window: Whisper's limit, and GigaAM drops words on longer input. */
export const WINDOW_SECONDS = 30;
/** A cut is searched in the chunk's last seconds; earlier cuts would shorten every window. */
const CUT_SEARCH_SECONDS = 10;
/** 20 ms frames, energy smoothed over 300 ms so the cut lands in a pause, not between syllables. */
const CUT_FRAME = 320;
const CUT_SMOOTH_FRAMES = 15;

/**
 * Chunks are transcribed independently, so a cut inside a word loses it. Cut in
 * the middle of the quietest 300 ms of the last seconds: usually a pause between phrases.
 */
export function quietCut(pcm: Float32Array): number {
  const frames = Math.floor(pcm.length / CUT_FRAME);
  const first = Math.max(0, frames - CUT_SEARCH_SECONDS * RATE / CUT_FRAME);
  const energy = new Float64Array(frames);
  for (let f = first; f < frames; f++) {
    let sum = 0;
    for (let i = f * CUT_FRAME; i < (f + 1) * CUT_FRAME; i++) sum += pcm[i] * pcm[i];
    energy[f] = sum;
  }
  let best = frames, lowest = Infinity, window = 0;
  for (let f = first; f < frames; f++) {
    window += energy[f];
    if (f - first >= CUT_SMOOTH_FRAMES) window -= energy[f - CUT_SMOOTH_FRAMES];
    if (f - first + 1 < CUT_SMOOTH_FRAMES) continue;
    // "<=" prefers the later of equally quiet pauses, keeping windows long.
    if (window <= lowest) { lowest = window; best = f + 1 - Math.floor(CUT_SMOOTH_FRAMES / 2); }
  }
  return best >= frames ? pcm.length : best * CUT_FRAME;
}

/** Views of at most one window each, cut in pauses; offsets are in samples. */
export function splitAtPauses(pcm: Float32Array): { pcm: Float32Array; offset: number }[] {
  const parts: { pcm: Float32Array; offset: number }[] = [];
  for (let offset = 0; offset < pcm.length;) {
    let part = pcm.subarray(offset, Math.min(pcm.length, offset + WINDOW_SECONDS * RATE));
    if (offset + part.length < pcm.length) part = part.subarray(0, quietCut(part));
    parts.push({ pcm: part, offset });
    offset += part.length;
  }
  return parts;
}
