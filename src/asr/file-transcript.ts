import type { Transcript } from '../shared/transcript';

/** Keep all text if any nonempty chunk lacks reliable subtitle timings. */
export function appendFileTranscript(target: Transcript, part: Transcript, offsetSeconds: number): void {
  const hadText = Boolean(target.text.trim());
  const missingTimings = (hadText && !target.segments.length) || (Boolean(part.text.trim()) && !part.segments.length);
  target.text = [target.text, part.text].filter(Boolean).join(' ');
  if (missingTimings) target.segments = [];
  else target.segments.push(...part.segments.map(cue => ({...cue,start:cue.start + offsetSeconds,end:cue.end + offsetSeconds})));
}
