import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Storage, validateSettings } from '../src/main/storage';
import { DEFAULT_SETTINGS } from '../src/shared/contracts';

test('corrupt settings recover a backup, preserve the original and report recovery once', async () => {
  const base=await mkdtemp(path.resolve('.test-build/recovery-'));
  try {
    const notices: string[]=[];
    const store=new Storage(base,message=>notices.push(message));
    await store.saveSettings({sounds:false});
    await store.saveSettings({sounds:false,microphone:'usb-mic'});
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
  const settings=validateSettings({silenceSeconds:-2,startAtLogin:'true',microphone:'a'.repeat(1000),model:'turbo',replacements:'x = y'});
  assert.equal(settings.silenceSeconds,2);assert.equal(settings.startAtLogin,false);assert.equal(settings.microphone.length,300);
  assert.equal('model' in settings,false);assert.equal('replacements' in settings,false,'removed settings are dropped');
  assert.equal(validateSettings({hotkey:'toString'}).hotkey,DEFAULT_SETTINGS.hotkey);
  assert.equal(validateSettings({hotkey:'win-alt'}).hotkey,'win-alt');
  assert.equal(validateSettings({hotkey:'key:ctrl+shift+68'}).hotkey,'key:ctrl+shift+68');
  assert.equal(validateSettings({hotkey:'key:65'}).hotkey,DEFAULT_SETTINGS.hotkey);
});

test('settings survive a restart',async()=>{
  const base=await mkdtemp(path.resolve('.test-build/restart-'));
  try {
    await new Storage(base).saveSettings({sounds:false,microphone:'usb-mic',hotkey:'insert'});
    const next=await new Storage(base).settings();
    assert.equal(next.sounds,false);assert.equal(next.microphone,'usb-mic');assert.equal(next.hotkey,'insert');
  } finally {await rm(base,{recursive:true,force:true});}
});
