import type { TranscriptSegment } from './transcript';

/** A new cue starts after a sentence end, a long pause, or once a cue grows this long. */
const PAUSE_SECONDS = 0.8;
const MAX_CUE_SECONDS = 10;
/** The model reports token starts only; a final token is assumed to last this long. */
const LAST_TOKEN_SECONDS = 0.4;
const SENTENCE_END = /[.!?…]$/u;

/**
 * Subtitle cues from GigaAM tokens. Tokens are pieces with a leading space at
 * word starts (" С", "его", "."); timestamps are their starts in seconds from the
 * chunk start. `offset` moves cues to the file timeline, `duration` bounds the chunk.
 * The cue texts joined with spaces equal the returned text, so subtitle editing
 * and the plain transcript never disagree.
 */
export function cuesFromTokens(tokens: string[], timestamps: number[], offset: number, duration: number): { text: string; segments: TranscriptSegment[] } {
  const segments: TranscriptSegment[] = [];
  let pieces: string[] = [];
  let start = 0;
  const close = (end: number) => {
    const text = pieces.join('').replace(/\s+/gu, ' ').trim();
    if (text) {
      const from = Math.min(start, duration);
      const to = Math.max(Math.min(end, duration), from + 0.01);
      segments.push({ start: from + offset, end: to + offset, text });
    }
    pieces = [];
  };
  const count = Math.min(tokens.length, timestamps.length);
  /** Start of the last valid token; malformed entries never move cue boundaries. */
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const token = tokens[i];
    const at = timestamps[i];
    if (typeof token !== 'string' || !Number.isFinite(at)) continue;
    const wordStart = /^\s/u.test(token);
    if (pieces.length && wordStart && (at - previous >= PAUSE_SECONDS || at - start >= MAX_CUE_SECONDS)) {
      close(Math.min(at, previous + LAST_TOKEN_SECONDS));
    }
    if (!pieces.length) {
      // A lone ' ' piece only marks where the next word starts; a cue never begins with it.
      if (!token.trim()) continue;
      start = at;
    }
    pieces.push(token);
    previous = at;
    const next = timestamps[i + 1];
    if (SENTENCE_END.test(token.trim()) && (next === undefined || /^\s/u.test(tokens[i + 1] ?? ' '))) {
      close(Number.isFinite(next) ? Math.min(next, at + LAST_TOKEN_SECONDS) : at + LAST_TOKEN_SECONDS);
    }
  }
  if (pieces.length) close(previous + LAST_TOKEN_SECONDS);
  return { text: segments.map(segment => segment.text).join(' '), segments };
}
