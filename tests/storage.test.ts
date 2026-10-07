import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Storage, validateSettings, cacheFilename } from '../src/main/storage';
import { applyReplacements, parseReplacements } from '../src/shared/clean';

test('corrupt history recovers a backup, preserves the original and reports recovery once', async () => {
  const base=await mkdtemp(path.resolve('.test-build/recovery-'));
  try {
    const notices: string[]=[];
    const store=new Storage(base,undefined,message=>notices.push(message));
    const first=await store.addHistory('saved','dictation');
    await store.addHistory('latest','dictation');
    await writeFile(path.join(base,'history.json'),'{broken');
    const results=await Promise.all([store.history(),store.history()]);
    assert.deepEqual(results,[[first],[first]]);
    assert.equal(notices.length,1);
    const archived=(await readdir(base)).find(name=>name.endsWith('.corrupt'))!;
    assert.equal(await readFile(path.join(base,archived),'utf8'),'{broken');
    await store.clearHistory();
    await writeFile(path.join(base,'history.json'),'null');
    assert.deepEqual(await store.history(),[]);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('unrecoverable corruption blocks writes without overwriting evidence', async () => {
  const base=await mkdtemp(path.resolve('.test-build/unrecoverable-'));
  try {
    await writeFile(path.join(base,'settings.json'),'{broken');
    const store=new Storage(base);
    await assert.rejects(store.saveSettings({}),/Не удалось восстановить/);
    assert.equal(await readFile(path.join(base,'settings.json'),'utf8'),'{broken');
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('pinned transcripts survive retention, edits, restart and selective clearing',async()=>{
  const base=await mkdtemp(path.resolve('.test-build/pinned-'));
  try {
    const store=new Storage(base);
    const first=await store.addHistory('important','dictation');
    await store.pinHistory(first.id,true);
    await store.updateHistory(first.id,'edited');
    await store.saveSettings({historyLimit:100});
    for(let i=0;i<103;i++)await store.addHistory(`text ${i}`,'dictation');
    const items=await new Storage(base).history();
    assert.equal(items.length,101);
    assert.equal(items.find(item=>item.id===first.id)?.pinned,true);
    await store.saveSettings({historyLimit:500});
    await store.addHistory('new','dictation');assert.equal((await store.history()).length,102);
    await store.clearHistory(true);
    assert.equal((await store.history())[0].text,'edited');
    await store.pinHistory(first.id,false);
    await store.clearHistory(true);assert.deepEqual(await store.history(),[]);
  }finally{await rm(base,{recursive:true,force:true});}
});

test('settings reject unsafe values and bound memory usage',()=>{
  const settings=validateSettings({model:'other',device:'unknown',silenceSeconds:-2,startAtLogin:'true',replacements:'a'.repeat(60000)});
  assert.equal(settings.model,'auto');assert.equal(settings.device,'auto');assert.equal(settings.silenceSeconds,2);assert.equal(settings.startAtLogin,false);assert.equal(settings.replacements.length,50000);
  assert.equal(validateSettings({hotkey:'toString'}).hotkey,'ctrl-space');
  assert.equal(validateSettings({hotkey:'win-alt'}).hotkey,'win-alt');
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
    assert.equal(await readFile((await store.cacheFile(key))!.file,'utf8'),'old');
    await store.cachePut(key,new TextEncoder().encode('new').buffer);
    assert.equal(await readFile((await store.cacheFile(key))!.file,'utf8'),'new');
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
