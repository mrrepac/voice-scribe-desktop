import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptEditor } from '../src/renderer/transcript-editor';
import { formatSubtitles } from '../src/shared/transcript';

test('cue edits update plain text and both subtitle exports without touching saved history', () => {
  const saved = [{ start: 1.5, end: 3.75, text: 'Ошибка' }, { start: 5, end: 8, text: 'Вторая фраза.' }];
  const editor = new TranscriptEditor();
  editor.load('Ошибка Вторая фраза.', saved, 'lecture.wav');
  editor.editSegment(0, 'Исправленный текст.');
  assert.equal(editor.text, 'Исправленный текст. Вторая фраза.');
  assert.match(formatSubtitles(editor.segments, 'srt'), /00:00:01,500 --> 00:00:03,750\nИсправленный текст\./);
  assert.match(formatSubtitles(editor.segments, 'vtt'), /00:00:01\.500 --> 00:00:03\.750\nИсправленный текст\./);
  assert.equal(saved[0].text, 'Ошибка');
  editor.editText('Unaligned full-text edit');
  assert.equal(editor.text, 'Исправленный текст. Вторая фраза.');
});

test('snapshot restores corrected timed transcript after a cancelled or failed preview', () => {
  const editor = new TranscriptEditor();
  editor.load('Один Два', [{ start: 0, end: 2, text: 'Один' }, { start: 2, end: 4, text: 'Два' }], 'audio.mp3');
  editor.editSegment(0, '');
  editor.editSegment(1, 'Исправлено');
  editor.view = 'text';
  const previous = editor.snapshot();
  editor.load('Предварительная новая диктовка');
  assert.equal(editor.segments.length, 0);
  editor.restore(previous);
  assert.equal(editor.text, 'Исправлено');
  assert.equal(editor.name, 'audio.mp3');
  assert.equal(editor.view, 'text');
  assert.equal(editor.segments.length, 2);
  assert.equal(editor.segments[0].text, '');
  editor.editSegment(1, 'Следующая правка');
  assert.equal(previous.segments[1].text, 'Исправлено');
});

test('new dictation and legacy history discard previous timing and filename', () => {
  const editor = new TranscriptEditor();
  editor.load('Аудио', [{ start: 0, end: 1, text: 'Аудио' }], 'audio.wav');
  editor.load('Новый текст');
  assert.equal(editor.text, 'Новый текст');
  assert.equal(editor.name, undefined);
  assert.equal(editor.view, 'text');
  assert.deepEqual(editor.segments, []);
  editor.editText('Новый исправленный текст');
  assert.equal(editor.text, 'Новый исправленный текст');
});
