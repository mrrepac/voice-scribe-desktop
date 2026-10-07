import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AudioImport, quietCut } from '../src/main/audio-import';
import { appendFileTranscript } from '../src/asr/file-transcript';
import type { Transcript } from '../src/shared/transcript';

test('file transcript offsets preserve pauses and missing timings disable partial subtitles', () => {
  const target: Transcript={text:'',segments:[]};
  appendFileTranscript(target,{text:'one',segments:[{text:'one',start:1,end:2}]},0);
  appendFileTranscript(target,{text:'two',segments:[{text:'two',start:1,end:2}]},60);
  assert.equal(target.segments[1].start,61);
  appendFileTranscript(target,{text:'three',segments:[]},120);
  appendFileTranscript(target,{text:'four',segments:[{text:'four',start:0,end:1}]},180);
  assert.equal(target.text,'one two three four'); assert.deepEqual(target.segments,[]);
});

test('real decoder reads bounded chunks and releases disk files; malformed files leave no residue',async()=>{
  const directory=await mkdtemp(path.resolve('.test-build/audio-'));
  try {
    const rate=16000, samples=rate*65;
    const wave=Buffer.alloc(44+samples*2);
    wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);
    wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);
    wave.writeUInt32LE(rate,24);wave.writeUInt32LE(rate*2,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);
    wave.write('data',36);wave.writeUInt32LE(samples*2,40);
    const source=path.join(directory,'fixture.wav');await writeFile(source,wave);
    const temp=path.join(directory,'temporary');
    const service=new AudioImport(path.resolve('node_modules/ffmpeg-static/ffmpeg.exe'),temp);
    const file=await service.select(source);
    const info=await service.prepare(file.id);assert.equal(info.samples,samples);
    let total=0;
    while(total<samples){const chunk=await service.chunk(file.id,total);assert.ok(chunk.length<=rate*30);total+=chunk.length;}
    assert.equal(total,samples);
    await assert.rejects(service.chunk(file.id,-1));
    await service.release(file.id);assert.deepEqual(await readdir(temp),[]);
    await writeFile(source,'broken');
    const invalid=await service.select(source);
    await assert.rejects(service.prepare(invalid.id),/звуковую дорожку/);
    assert.deepEqual(await readdir(temp),[]);
    await writeFile(source,wave);
    const cancelled=await service.select(source);
    const decoding=service.prepare(cancelled.id);
    const rejected=assert.rejects(decoding,/отменён/);
    await service.cancelAll();await rejected;
    assert.deepEqual(await readdir(temp),[]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('30 s chunks are cut in the middle of the quietest pause of their last seconds', () => {
  const rate=16000;
  const speech=(seconds:number)=>{const pcm=new Float32Array(seconds*rate);for(let i=0;i<pcm.length;i++)pcm[i]=0.3*Math.sin(i/7)*(1+Math.sin(i/900));return pcm;};
  const pcm=speech(30);
  // A 400 ms pause at 23.0-23.4 s and a shorter, louder dip at 27 s.
  pcm.fill(0,23*rate,23.4*rate);
  pcm.fill(0.01,27*rate,27.1*rate);
  const cut=quietCut(pcm)/rate;
  assert.ok(cut>23 && cut<23.4,`cut at ${cut}`);
  // Pauses before the search window are ignored: windows must stay long.
  const early=speech(30);early.fill(0,5*rate,6*rate);
  assert.ok(quietCut(early)>=20*rate);
  // Continuous speech still makes progress and never exceeds the window.
  const solid=speech(30);const forced=quietCut(solid);
  assert.ok(forced>=20*rate && forced<=solid.length);
});
