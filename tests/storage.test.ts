import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Storage, validateSettings } from '../src/main/storage';
import { applyReplacements, parseReplacements } from '../src/shared/clean';

test('corrupt settings recover a backup, preserve the original and report recovery once', async () => {
  const base=await mkdtemp(path.resolve('.test-build/recovery-'));
  try {
    const notices: string[]=[];
    const store=new Storage(base,message=>notices.push(message));
    await store.saveSettings({sounds:false});
    await store.saveSettings({sounds:false,replacements:'спб = Санкт-Петербург'});
    await writeFile(path.join(base,'settings.json'),'{broken');
    const fresh=new Storage(base,message=>notices.push(message));
    const results=await Promise.all([fresh.settings(),fresh.settings()]);
    assert.equal(results[0].sounds,false);
    assert.deepEqual(results[0],results[1]);
    assert.equal(notices.length,1);
    const archived=(await readdir(base)).find(name=>name.endsWith('.corrupt'))!;
    assert.equal(await readFile(path.join(base,archived),'utf8'),'{broken');
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

test('settings reject unsafe values and bound memory usage',()=>{
  const settings=validateSettings({silenceSeconds:-2,startAtLogin:'true',replacements:'a'.repeat(60000),model:'turbo'});
  assert.equal(settings.silenceSeconds,2);assert.equal(settings.startAtLogin,false);assert.equal(settings.replacements.length,50000);
  assert.equal('model' in settings,false);
  assert.equal(validateSettings({hotkey:'toString'}).hotkey,'ctrl-space');
  assert.equal(validateSettings({hotkey:'win-alt'}).hotkey,'win-alt');
  assert.equal(validateSettings({hotkey:'key:ctrl+shift+68'}).hotkey,'key:ctrl+shift+68');
  assert.equal(validateSettings({hotkey:'key:65'}).hotkey,'ctrl-space');
});

test('the dictionary survives a restart and applies to text',async()=>{
  const base=await mkdtemp(path.resolve('.test-build/dictionary-'));
  try {
    await new Storage(base).saveSettings({replacements:'войс скрайб = Voice Scribe'});
    const next=await new Storage(base).settings();
    assert.equal(applyReplacements('войс скрайб лайт',parseReplacements(next.replacements)),'Voice Scribe лайт');
  } finally {await rm(base,{recursive:true,force:true});}
});
