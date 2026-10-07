/** Cue positions are seconds from the beginning of the original audio file. */
export interface TranscriptSegment { start: number; end: number; text: string; speaker?: string; }
/** language: the code Whisper detected when none was given (absent for a fixed or mixed pair). */
export interface Transcript { text: string; segments: TranscriptSegment[]; language?: string; }
export type SubtitleFormat = 'srt' | 'vtt';
/** audioId: the import a file transcript came from; main resolves it to the source path, never the renderer. */
export interface TranscriptDetails { segments?: TranscriptSegment[]; name?: string; audioId?: string; }

/** Accept legacy/untrusted storage and IPC data without keeping malformed cues. */
export function normalizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const result: TranscriptSegment[] = [];
  let characters = 0;
  let previousEnd = 0;
  for (const value of raw.slice(0, 50_000)) {
    if (!value || typeof value !== 'object') continue;
    const { start, end, text, speaker } = value as Partial<TranscriptSegment>;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > Number.MAX_SAFE_INTEGER / 1000 || typeof text !== 'string') continue;
    const clean = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    if (!clean || clean.length > 20_000) continue;
    const from = Math.max(previousEnd, Math.round(start * 1000) / 1000);
    const to = Math.round(end * 1000) / 1000;
    if (to <= from) continue;
    characters += clean.length;
    if (characters > 2_000_000) break;
    const label = normalizeSpeaker(speaker);
    result.push({ start: from, end: to, text: clean, ...(label ? { speaker: label } : {}) });
    previousEnd = to;
  }
  return result;
}

export function normalizeSpeaker(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

export function transcriptText(segments: TranscriptSegment[]): string {
  if (!segments.some(cue => cue.speaker)) return segments.map(cue => cue.text.trim()).filter(Boolean).join(' ');
  return segments.filter(cue => cue.text.trim()).map(cue => `${cue.speaker ? cue.speaker + ': ' : ''}${cue.text.trim()}`).join('\n');
}

/** Millisecond rounding before splitting avoids timestamps such as 00:00:60. */
export function formatTimestamp(seconds: number, format: SubtitleFormat = 'vtt'): string {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const wholeSeconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
}

export function formatSubtitles(segments: TranscriptSegment[], format: SubtitleFormat): string {
  if (format !== 'srt' && format !== 'vtt') throw new Error('Неизвестный формат субтитров');
  const cues = normalizeSegments(segments);
  const blocks = cues.map((cue, index) => {
    // A blank line ends a cue; escape markup so dictated text stays literal.
    const text = `${cue.speaker ? cue.speaker + ': ' : ''}${cue.text}`.split('\n').map(line => line.trim()).filter(Boolean).join('\n')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${format === 'srt' ? `${index + 1}\n` : ''}${formatTimestamp(cue.start, format)} --> ${formatTimestamp(cue.end, format)}\n${text}`;
  });
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}

export function subtitleFilename(name: unknown, format: SubtitleFormat): string {
  const fallback = 'voice-subtitles';
  const basename = typeof name === 'string' ? name.split(/[\\/]/).pop() || fallback : fallback;
  let stem = basename.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 150) || fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = 'voice-' + stem;
  return `${stem}.${format}`;
}
