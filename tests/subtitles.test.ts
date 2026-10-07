import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSubtitles, formatTimestamp, normalizeSegments, subtitleFilename } from '../src/shared/transcript';

test('SRT and VTT have standard headers, separators and hour rollover',()=>{
  const cues=[{start:1.23,end:3.456,text:'Первая фраза.'},{start:3599.9996,end:3602.01,text:'Вторая фраза.'}];
  assert.equal(formatSubtitles(cues,'srt'),'1\n00:00:01,230 --> 00:00:03,456\nПервая фраза.\n\n2\n01:00:00,000 --> 01:00:02,010\nВторая фраза.\n');
  assert.equal(formatSubtitles(cues,'vtt'),'WEBVTT\n\n00:00:01.230 --> 00:00:03.456\nПервая фраза.\n\n01:00:00.000 --> 01:00:02.010\nВторая фраза.\n');
  assert.equal(formatTimestamp(59.9996),'00:01:00.000');
});

test('cue text cannot inject markup or new subtitle blocks',()=>{
  const cues=[{start:0,end:1,text:'  <b>A & B</b>\r\n\r\n00:00:02 --> 00:00:03\n  hello  '}];
  assert.equal(formatSubtitles(cues,'vtt'),'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&lt;b&gt;A &amp; B&lt;/b&gt;\n00:00:02 --&gt; 00:00:03\nhello\n');
});

test('malformed, blank and zero-length cues are excluded and overlaps are bounded',()=>{
  const cues=normalizeSegments([null,{start:NaN,end:1,text:'bad'},{start:-1,end:1,text:'bad'},{start:0,end:0,text:'bad'},{start:0,end:1,text:' '},{start:0,end:2,text:'ok'}, {start:1,end:3,text:'overlap'},{start:4,end:4.00001,text:'rounds to zero'},{start:5,end:Infinity,text:'bad'}]);
  assert.deepEqual(cues,[{start:0,end:2,text:'ok'},{start:2,end:3,text:'overlap'}]);
  assert.deepEqual(normalizeSegments({segments:[]}),[]);
  assert.equal(formatSubtitles([],'vtt'),'WEBVTT\n\n');
});

test('subtitle filenames preserve source names but never directories or reserved names',()=>{
  assert.equal(subtitleFilename('D:\\audio\\Встреча.2026.wav','srt'),'Встреча.2026.srt');
  assert.equal(subtitleFilename('../../CON.mp3','vtt'),'voice-CON.vtt');
  assert.equal(subtitleFilename('what?.mp3','srt'),'what-.srt');
  assert.equal(subtitleFilename(undefined,'vtt'),'voice-subtitles.vtt');
});
