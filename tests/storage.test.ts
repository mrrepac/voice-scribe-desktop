import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Storage, validateSettings, cacheFilename } from '../src/main/storage';
import { applyReplacements, parseReplacements } from '../src/shared/clean';

test('settings reject unsafe values and bound memory usage',()=>{
  const settings=validateSettings({model:'other',device:'unknown',silenceSeconds:-2,startAtLogin:'true',replacements:'a'.repeat(60000)});
  assert.equal(settings.model,'auto');assert.equal(settings.device,'auto');assert.equal(settings.silenceSeconds,2);assert.equal(settings.startAtLogin,false);assert.equal(settings.replacements.length,50000);
});
test('model keys only access allowed Whisper repositories',()=>{
  assert.equal(cacheFilename('https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'),'huggingface.co_onnx-community_whisper-tiny_resolve_main_config.json');
  for(const key of ['file:///secret','https://evil.test/file','https://huggingface.co/other/model/config.json','https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json?bad'])assert.throws(()=>cacheFilename(key));
});
test('concurrent history commits do not lose transcripts; legacy cache is read only',async()=>{
  const base=await mkdtemp(path.resolve('.test-build/storage-'));
  try {
    const legacy=path.join(base,'legacy');await mkdir(legacy);
    const store=new Storage(path.join(base,'app'),legacy);
    await Promise.all(Array.from({length:20},(_,i)=>store.addHistory(`text ${i}`,'dictation')));
    assert.equal((await store.history()).length,20);
    const key='https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json';
    await writeFile(path.join(legacy,cacheFilename(key)),'old');
    assert.equal((await store.cacheGet(key))?.toString(),'old');
    await store.cachePut(key,new TextEncoder().encode('new').buffer);
    assert.equal((await store.cacheGet(key))?.toString(),'new');
    assert.equal(await readFile(path.join(legacy,cacheFilename(key)),'utf8'),'old');
    await store.clearHistory();assert.deepEqual(await store.history(),[]);
  } finally {await rm(base,{recursive:true,force:true});}
});

test('file timestamps and subtitle corrections survive reload alongside legacy history',async()=>{
  const base=await mkdtemp(path.resolve('.test-build/subtitle-storage-'));
  try {
    const store=new Storage(base);
    const legacy=await store.addHistory('old','dictation');
    const file=await store.addHistory('first','file',{name:'meeting.wav',segments:[{start:2,end:3,text:'first'},{start:'bad',end:4,text:'invalid'}]});
    assert.deepEqual(file.segments,[{start:2,end:3,text:'first'}]);
    const saved=await store.updateHistory(file.id,'corrected',{name:'meeting.wav',segments:[{start:2,end:3,text:'corrected'}]});
    assert.equal(saved.createdAt,file.createdAt);
    assert.equal(saved.id,file.id);
    const reloaded=await new Storage(base).history();
    assert.deepEqual(reloaded,[saved,legacy]);
    assert.equal(reloaded[0].segments?.[0].text,'corrected');
    assert.equal(reloaded[1].segments,undefined);
    await store.clearHistory();
    await assert.rejects(store.updateHistory(file.id,'stale'),/не найдена/);
    assert.deepEqual(await store.history(),[]);
  } finally {await rm(base,{recursive:true,force:true});}
});

test('remembered corrections merge atomically, keep settings and apply after restart',async()=>{
  const base=await mkdtemp(path.resolve('.test-build/correction-storage-'));
  try {
    const store=new Storage(base);
    const settings=await store.saveSettings({language:'en',sounds:false,model:'base',replacements:'# Existing dictionary\nстарое = old'});
    await Promise.all([store.rememberCorrection('войс скрайб','Voice Scribe'),store.rememberCorrection('обсидиан','Obsidian')]);
    const next=await new Storage(base).settings();
    assert.deepEqual({...next,replacements:settings.replacements},settings);
    assert.ok(next.replacements.includes('# Existing dictionary'));
    assert.equal(applyReplacements('войс скрайб и обсидиан',parseReplacements(next.replacements)),'Voice Scribe и Obsidian');
    const corrected=await store.rememberCorrection('ВОЙС   СКРАЙБ','VoiceScribe');
    assert.equal(corrected.updated,true);
    assert.equal(applyReplacements('войс скрайб',parseReplacements(corrected.replacements)),'VoiceScribe');
    const before=await readFile(path.join(base,'settings.json'),'utf8');
    await assert.rejects(store.rememberCorrection('','bad'),/INVALID_CORRECTION/);
    assert.equal(await readFile(path.join(base,'settings.json'),'utf8'),before);
  } finally {await rm(base,{recursive:true,force:true});}
});
