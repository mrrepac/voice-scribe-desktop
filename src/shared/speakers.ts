import type { TranscriptSegment } from './transcript';

export interface SpeakerTurn { start: number; end: number; speaker: number; }
export interface SpeakerProgress { message: string; }

/** A cue may cross a speaker change: never pretend its words were aligned. */
export function assignSpeakers(cues: TranscriptSegment[], raw: SpeakerTurn[]): TranscriptSegment[] {
  const turns = raw.filter(t => Number.isFinite(t.start) && Number.isFinite(t.end) && t.start >= 0 && t.end > t.start && Number.isSafeInteger(t.speaker) && t.speaker >= 0)
    .sort((a, b) => a.start - b.start);
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
    const ranked = [...overlap].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, duration]) => sum + duration, 0);
    const speaker = !ranked.length ? 'Не определён'
      : ranked[0][1] / total < 0.8 ? 'Несколько ораторов' : names.get(ranked[0][0])!;
    return { ...cue, speaker };
  });
}
