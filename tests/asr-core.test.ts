import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { trimSilence, cleanTranscript, applyVoiceCommands, parseReplacements, applyReplacements } from '../src/shared/clean';
import { Segmenter, joinSegments } from '../src/shared/live';

const silence = (seconds: number) => new Float32Array(Math.round(seconds * 16000));
const tone = (seconds: number) => Float32Array.from({length:Math.round(seconds*16000)}, (_,i) => Math.sin(i / 12)*0.3);
const concat = (...parts: Float32Array[]) => {
  const result = new Float32Array(parts.reduce((sum, part) => sum+part.length,0));
  let offset = 0;
  for (const part of parts) { result.set(part,offset); offset += part.length; }
  return result;
};

test('silence and clicks are rejected while spoken content is retained', () => {
  assert.equal(trimSilence(silence(3)),null);
  assert.equal(trimSilence(concat(silence(1),tone(0.1),silence(1))),null);
  const result = trimSilence(concat(silence(2),tone(1),silence(2)));
  assert.ok(result && result.length >= 16000 && result.length < 2*16000);
  assert.equal(cleanTranscript('[музыка] Продолжение следует…'),'');
  assert.equal(cleanTranscript('Спасибо за просмотр документа.'),'Спасибо за просмотр документа.');
});

test('voice commands and user replacements preserve paragraph and word boundaries', () => {
  assert.equal(applyVoiceCommands('привет запятая мир новый абзац готово точка'),'Привет, мир\n\nГотово.');
  const dictionary = parseReplacements('обсидиан = Obsidian\nмс = МС');
  assert.equal(applyReplacements('Обсидиан и смс',dictionary),'Obsidian и смс');
});

test('live segmentation emits ordered phrases and keeps long phrases under Whisper window', () => {
  const segments: {pcm:Float32Array;startSec:number;endSec:number}[] = [];
  const segmenter = new Segmenter(segment => segments.push(segment));
  const pcm = concat(silence(1),tone(1),silence(1),tone(28),silence(1));
  for (let offset=0;offset<pcm.length;offset+=2560) segmenter.push(pcm.subarray(offset,offset+2560));
  segmenter.flush();
  assert.ok(segments.length >= 3);
  assert.ok(segments.every(segment => segment.pcm.length < 30*16000));
  for (let i=1;i<segments.length;i++) assert.ok(segments[i].startSec >= segments[i-1].endSec);
  assert.equal(joinSegments(['Привет','', 'Как дела?']),'Привет. Как дела?');
});

test('audio worklet flush delivers its final partial PCM packet exactly once', () => {
  const output: (Float32Array | {flushed:boolean})[] = [];
  let Processor: any;
  class Base {
    port = {postMessage:(data:Float32Array|{flushed:boolean}) => output.push(data), onmessage:null as unknown};
  }
  vm.runInNewContext(readFileSync('src/asr/tap-worklet.js','utf8'), {
    AudioWorkletProcessor:Base,Float32Array, registerProcessor:(_name:string,ctor:unknown) => {Processor=ctor;},
  });
  const processor = new Processor();
  processor.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(output.length,0);
  processor.port.onmessage({data:'flush'});
  assert.equal((output[0] as Float32Array).length,128);
  assert.equal((output[0] as Float32Array)[0],0.5);
  assert.equal((output[1] as {flushed:boolean}).flushed,true);
  processor.process([[new Float32Array(128).fill(1)]]);
  assert.equal(output.length,2);
});
