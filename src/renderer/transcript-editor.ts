import { normalizeSegments, transcriptText, normalizeSpeaker, type TranscriptSegment } from '../shared/transcript';

export type TranscriptView = 'text' | 'segments';

export interface TranscriptEditorState {
  text: string;
  segments: TranscriptSegment[];
  name?: string;
  view: TranscriptView;
}

/** Timed cues are the source of truth for every preview and export. */
export class TranscriptEditor {
  private plainText = '';
  segments: TranscriptSegment[] = [];
  name: string | undefined;
  view: TranscriptView = 'text';

  get text(): string {
    return this.segments.length
      ? transcriptText(this.segments)
      : this.plainText;
  }

  load(text: string, segments: TranscriptSegment[] = [], name?: string, view?: TranscriptView): void {
    this.plainText = text;
    this.segments = normalizeSegments(segments);
    this.name = name;
    this.view = this.segments.length ? view ?? 'segments' : 'text';
  }

  editText(text: string): void {
    if (!this.segments.length) this.plainText = text;
  }

  editSegment(index: number, text: string): void {
    if (this.segments[index]) this.segments[index].text = text;
  }

  editSpeaker(index: number, name: string): void {
    const cue = this.segments[index];
    if (!cue) return;
    const label = normalizeSpeaker(name);
    if (label) cue.speaker = label; else delete cue.speaker;
  }

  snapshot(): TranscriptEditorState {
    return { text: this.text, segments: this.segments.map(segment => ({ ...segment })), name: this.name, view: this.view };
  }

  restore(state: TranscriptEditorState): void {
    // Keep empty edited cues, which can still be filled back in by the user.
    this.plainText = state.text;
    this.segments = state.segments.map(segment => ({ ...segment }));
    this.name = state.name;
    this.view = state.view;
  }
}
