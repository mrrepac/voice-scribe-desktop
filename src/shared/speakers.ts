import type { TranscriptSegment } from './transcript';

export interface SpeakerTurn { start: number; end: number; speaker: number; }
export interface SpeakerProgress { message: string; }

const validTurns = (raw: SpeakerTurn[]) => raw.filter(t => Number.isFinite(t.start) && Number.isFinite(t.end) && t.start >= 0 && t.end > t.start && Number.isSafeInteger(t.speaker) && t.speaker >= 0)
  .sort((a, b) => a.start - b.start);

const CUT_STEP = 0.05;

/**
 * Speaker change points (seconds) for cutting audio before Whisper, so a cue
 * never spans two voices. Overlapping speech stays with whoever spoke first,
 * a pause between different voices is split in the middle, and voices shorter
 * than minRegion join a neighbour: Whisper is unreliable on such fragments.
 */
export function speakerCuts(raw: SpeakerTurn[], duration: number, minRegion = 0.5): number[] {
  const turns = validTurns(raw);
  const frames = Number.isFinite(duration) && duration > 0 ? Math.ceil(duration / CUT_STEP) : 0;
  if (!turns.length || !frames) return [];
  const owner = new Int32Array(frames).fill(-1);
  const since = new Float64Array(frames).fill(Infinity);
  for (const turn of turns) {
    for (let i = Math.floor(turn.start / CUT_STEP); i < Math.min(frames, Math.ceil(turn.end / CUT_STEP)); i++) {
      if (turn.start < since[i]) { since[i] = turn.start; owner[i] = turn.speaker; }
    }
  }
  // Voiced runs; silence between two runs is divided at its midpoint.
  const runs: { speaker: number; start: number; end: number }[] = [];
  for (let i = 0; i < frames; i++) {
    if (owner[i] < 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.speaker === owner[i]) { last.end = i + 1; continue; }
    if (last) { const middle = Math.round((last.end + i) / 2); last.end = middle; runs.push({ speaker: owner[i], start: middle, end: i + 1 }); }
    else runs.push({ speaker: owner[i], start: i, end: i + 1 });
  }
  const minimum = minRegion / CUT_STEP;
  const merged: typeof runs = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && (last.speaker === run.speaker || run.end - run.start < minimum)) last.end = run.end;
    else if (last && last.end - last.start < minimum) { last.end = run.end; last.speaker = run.speaker; }
    else merged.push({ ...run });
    // Absorbing a short voice may leave two neighbours with the same speaker.
    const tail = merged.length > 1 && merged[merged.length - 2];
    if (tail && tail.speaker === merged[merged.length - 1].speaker) tail.end = merged.pop()!.end;
  }
  return merged.slice(1).map(run => Math.round(run.start * CUT_STEP * 1000) / 1000);
}

/** A cue may cross a speaker change: never pretend its words were aligned. */
export function assignSpeakers(cues: TranscriptSegment[], raw: SpeakerTurn[]): TranscriptSegment[] {
  const turns = validTurns(raw);
  const names = new Map<number, string>();
  for (const turn of turns) if (!names.has(turn.speaker)) names.set(turn.speaker, `Оратор ${names.size + 1}`);
  let first = 0;
  return cues.map(cue => {
    while (first < turns.length && turns[first].end <= cue.start) first++;
    const overlap = new Map<number, number>();
    for (let i = first; i < turns.length && turns[i].start < cue.end; i++) {
      const turn = turns[i];
      const duration = Math.min(cue.end, turn.end) - Math.max(cue.start, turn.start);
      if (duration > 0) overlap.set(turn.speaker, (overlap.get(turn.speaker) ?? 0) + duration);
    }
    // Whisper timings drift: a cue in a pause belongs to a voice right next to it.
    if (!overlap.size) {
      let distance = 1;
      for (const turn of turns) {
        const gap = Math.max(turn.start - cue.end, cue.start - turn.end);
        if (gap < distance) { distance = gap; overlap.clear(); overlap.set(turn.speaker, 1); }
      }
    }
    const ranked = [...overlap].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, duration]) => sum + duration, 0);
    const speaker = !ranked.length ? 'Не определён'
      : ranked[0][1] / total < 0.8 ? 'Несколько ораторов' : names.get(ranked[0][0])!;
    return { ...cue, speaker };
  });
}
