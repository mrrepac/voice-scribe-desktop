import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { assignSpeakers, speakerCuts } from '../src/shared/speakers';
import { normalizeSegments, formatSubtitles, transcriptText } from '../src/shared/transcript';
import { TranscriptEditor } from '../src/renderer/transcript-editor';
import { Storage, validateSettings } from '../src/main/storage';
import { DiarizationService } from '../src/main/diarization';

test('speaker ids follow first appearance and repeated voices retain their labels', () => {
  const cues = [{ start: 0, end: 3, text: 'A' }, { start: 4, end: 7, text: 'B' }, { start: 8, end: 9, text: 'A again' }];
  const result = assignSpeakers(cues, [{ start: 4, end: 7, speaker: 4 }, { start: 0, end: 3, speaker: 7 }, { start: 8, end: 9, speaker: 7 }]);
  assert.deepEqual(result.map(c => c.speaker), ['Оратор 1', 'Оратор 2', 'Оратор 1']);
  assert.deepEqual(result.map(({ speaker, ...cue }) => cue), cues);
});

test('mixed, simultaneous, and unmatched cues are explicit instead of inventing word alignment', () => {
  const cues = [{ start: 0, end: 4, text: 'mixed' }, { start: 5, end: 8, text: 'overlap' }, { start: 9, end: 10, text: 'unknown' }];
  const result = assignSpeakers(cues, [{ start: 0, end: 2, speaker: 0 }, { start: 2, end: 4, speaker: 1 }, { start: 5, end: 8, speaker: 0 }, { start: 5, end: 8, speaker: 1 }, { start: 9, end: 10, speaker: NaN }]);
  assert.deepEqual(result.map(c => c.speaker), ['Несколько ораторов', 'Несколько ораторов', 'Не определён']);
});

test('cues in a short pause take the adjacent voice', () => {
  const result = assignSpeakers([{ start: 3.2, end: 3.8, text: 'drifted' }, { start: 10, end: 11, text: 'far' }], [{ start: 0, end: 3, speaker: 2 }, { start: 4.5, end: 6, speaker: 5 }]);
  assert.deepEqual(result.map(c => c.speaker), ['Оратор 1', 'Не определён']);
});

test('speaker cuts split pauses in the middle and keep overlaps with the first voice', () => {
  assert.deepEqual(speakerCuts([], 10), []);
  assert.deepEqual(speakerCuts([{ start: 0, end: 4, speaker: 1 }, { start: 5, end: 9, speaker: 0 }], 10), [4.5]);
  // B interrupts while A still talks: the cut is where A stops.
  assert.deepEqual(speakerCuts([{ start: 0, end: 4, speaker: 1 }, { start: 3, end: 8, speaker: 0 }], 10), [4]);
  // Same voice across a pause and a back-channel inside it: no cut at all.
  assert.deepEqual(speakerCuts([{ start: 0, end: 10, speaker: 1 }, { start: 4, end: 5, speaker: 0 }, { start: 11, end: 14, speaker: 1 }], 15), []);
});

test('voices too short for Whisper join a neighbour instead of becoming separate chunks', () => {
  const turns = [{ start: 0, end: 4, speaker: 0 }, { start: 4.1, end: 4.4, speaker: 1 }, { start: 4.5, end: 8, speaker: 0 }, { start: 8, end: 12, speaker: 2 }];
  assert.deepEqual(speakerCuts(turns, 12), [8]);
  assert.deepEqual(speakerCuts([{ start: 0, end: 0.3, speaker: 1 }, { start: 0.4, end: 5, speaker: 0 }, { start: 5, end: 9, speaker: 1 }], 9), [5]);
  assert.deepEqual(speakerCuts(turns, 12, 0.2), [4.05, 4.45, 8]);
});

test('labels are bounded, escaped in subtitles, editable and preserved in snapshots', () => {
  const cues = normalizeSegments([{ start: 0, end: 1, text: 'Hello', speaker: '<Alice>\n\0' }, { start: 1, end: 2, text: 'Hi', speaker: 22 }]);
  assert.equal(cues[0].speaker, '<Alice>');
  assert.equal(cues[1].speaker, undefined);
  assert.match(formatSubtitles(cues, 'srt'), /&lt;Alice&gt;: Hello/);
  assert.match(formatSubtitles(cues, 'vtt'), /&lt;Alice&gt;: Hello/);
  assert.equal(transcriptText(cues), '<Alice>: Hello\nHi');
  const editor = new TranscriptEditor();
  editor.load('', cues);
  editor.editSpeaker(0, 'Анна');
  const saved = editor.snapshot();
  editor.load('new dictation');
  editor.restore(saved);
  assert.equal(editor.text, 'Анна: Hello\nHi');
  editor.editSegment(0, '');
  editor.editSegment(1, '');
  assert.equal(editor.text, '');
  assert.equal(cues[0].speaker, '<Alice>');
});

test('speaker settings and corrected labels survive restart without affecting dictation', async () => {
  const directory = await mkdtemp(path.resolve('.test-build/speakers-'));
  try {
    const store = new Storage(directory);
    assert.equal(validateSettings({ diarization: 'bad' }).diarization, true);
    await store.saveSettings({ diarization: false });
    const segments = [{ start: 0, end: 1, text: 'Hello', speaker: 'Оратор 1' }];
    const item = await store.addHistory(transcriptText(segments), 'file', { segments });
    segments[0].speaker = 'Анна';
    await store.updateHistory(item.id, transcriptText(segments), { segments });
    const reopened = new Storage(directory);
    assert.equal((await reopened.settings()).diarization, false);
    assert.equal((await reopened.history())[0].segments?.[0].speaker, 'Анна');
    assert.equal((await store.addHistory('dictation', 'dictation', { segments })).segments, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('global rename merges split labels and survives history reload and subtitle export', async () => {
  const directory = await mkdtemp(path.resolve('.test-build/speaker-rename-'));
  try {
    const editor = new TranscriptEditor();
    const speakers = ['Оратор 1', 'Оратор 2', 'Оратор 1', 'Оратор 3', 'Оратор 3', 'Не определён', 'Не определён'];
    editor.load('', speakers.map((speaker, i) => ({ start: i * 2, end: i * 2 + 1, text: `Реплика ${i}`, speaker })));
    editor.renameSpeaker(0, 'Анна');
    editor.renameSpeaker(3, 'Анна');
    editor.renameSpeaker(0, 'Мария');
    editor.renameSpeaker(5, 'Борис');
    assert.deepEqual(editor.segments.map(s => s.speaker), ['Мария', 'Оратор 2', 'Мария', 'Мария', 'Мария', 'Борис', 'Не определён']);
    const store = new Storage(directory);
    const item = await store.addHistory(editor.text, 'file', { segments: editor.segments, name: 'meeting.mp4' });
    editor.renameSpeaker(1, 'Иван');
    await store.updateHistory(item.id, editor.text, { segments: editor.segments, name: editor.name });
    const saved = (await new Storage(directory).history())[0];
    assert.equal(saved.text, editor.text);
    assert.deepEqual(saved.segments, editor.segments);
    assert.equal((formatSubtitles(saved.segments!, 'srt').match(/Мария:/g) ?? []).length, 4);
    assert.equal((formatSubtitles(saved.segments!, 'vtt').match(/Мария:/g) ?? []).length, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('requested speaker count reaches worker and invalid counts are rejected', async () => {
  const directory = await mkdtemp(path.resolve('.test-build/speaker-count-'));
  try {
    const script = path.join(directory, 'fixture.cjs');
    await writeFile(script, "process.on('message',m=>process.send({type:'result',turns:[{start:0,end:1,speaker:m.speakerCount??-1}]}));");
    const service = new DiarizationService(script, directory);
    const pcm = new Float32Array(16000);
    for (const value of [0, -1, 1.5, 51, NaN]) await assert.rejects(service.run(pcm, () => {}, value), /число ораторов/);
    assert.equal((await service.run(pcm, () => {}, 2))[0].speaker, 2);
    assert.equal((await service.run(pcm, () => {}))[0].speaker, -1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native process cancellation rejects promptly and permits a subsequent run', async () => {
  const directory = await mkdtemp(path.resolve('.test-build/speaker-worker-'));
  const script = path.join(directory, 'fixture.cjs');
  const service = new DiarizationService(script, directory);
  try {
    await writeFile(script, "process.on('message',()=>{process.send({type:'progress',message:'ready'});setTimeout(()=>process.send({type:'result',turns:[{start:0,end:1,speaker:0}]}),200);});");
    const cancelled = service.run(new Float32Array(16000), () => service.cancel());
    await assert.rejects(cancelled, /отменено/);
    assert.deepEqual(await service.run(new Float32Array(16000), () => {}), [{ start: 0, end: 1, speaker: 0 }]);
    await assert.rejects(service.run(new Float32Array([NaN]), () => {}), /аудиофайл/);
  } finally { service.cancel(); await rm(directory, { recursive: true, force: true }); }
});
