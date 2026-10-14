/** Cue positions are seconds from the beginning of the recognized audio. */
export interface TranscriptSegment { start: number; end: number; text: string; }
export interface Transcript { text: string; segments: TranscriptSegment[]; }
