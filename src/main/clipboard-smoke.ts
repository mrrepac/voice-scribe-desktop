import { app, BrowserWindow, clipboard, ClipboardItem } from 'electron';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import type { NativeBridge } from './native';

const handleOf=(window:BrowserWindow)=>{const handle=window.getNativeWindowHandle();return handle.length===8?handle.readBigUInt64LE().toString():handle.readUInt32LE().toString();};

/** Real paste into a temporary window. The helper only sends Ctrl+V when that window is in the foreground. */
export async function clipboardSmokeTest(win:BrowserWindow,bridge:NativeBridge):Promise<void> {
  const files=await Promise.all(['settings.json','settings.json.bak'].map(async name=>{
    const file=path.join(app.getPath('userData'),name);
    return {file,data:await readFile(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;})};
  }));
  const original:ClipboardItem[]=[];
  for(const item of await clipboard.read()){
    const data:Record<string,Blob>={};
    for(const type of item.types)if(!/"(DataObject|Ole Private Data)"/.test(type)){const value=await item.getType(type);if(value instanceof Blob)data[type]=value;}
    if(Object.keys(data).length)original.push(new ClipboardItem(data));
  }
  const execute=(source:string)=>win.webContents.executeJavaScript(source);
  const setRestore=(value:boolean)=>execute(`(async()=>{const s=await window.scribe.getSettings();await window.scribe.saveSettings({...s,restoreClipboard:${value}});})()`);
  const target=new BrowserWindow({width:420,height:200,show:false,title:'Voice Scribe clipboard smoke',webPreferences:{sandbox:true,contextIsolation:true}});
  try {
    await target.loadURL('data:text/html,<textarea id="field" autofocus></textarea>');
    target.show();target.focus();
    await target.webContents.executeJavaScript(`document.getElementById('field').focus()`);
    const hwnd=handleOf(target);
    for(let i=0;i<50 && (await bridge.request('get-target')).target!==hwnd;i++)await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal((await bridge.request('get-target')).target,hwnd,'test window must be in the foreground');
    const field=()=>target.webContents.executeJavaScript(`document.getElementById('field').value`);
    const clear=()=>target.webContents.executeJavaScript(`document.getElementById('field').value=''`);
    const deliver=(text:string,to:string)=>execute(`window.scribe.deliver(${JSON.stringify(text)},${JSON.stringify(to)},false)`);
    const sentinel=async()=>{await clipboard.write([new ClipboardItem({'text/plain':'copied before','text/html':'<b>copied before</b>'})]);};

    await setRestore(true);
    await sentinel();
    let result=await deliver('Первая диктовка',hwnd);
    assert.equal(result.status,'inserted');
    assert.equal(result.restored,true);
    assert.equal(await field(),'Первая диктовка');
    assert.equal(await clipboard.readText(),'copied before','previous text is back');
    assert.ok((await clipboard.read()).some(item=>item.types.includes('text/html')),'previous HTML is back');

    await clear();
    await sentinel();
    const hidden=new BrowserWindow({show:false});
    try {
      result=await deliver('Не вставилось',handleOf(hidden));
      assert.equal(result.status,'clipboard-only');
      assert.equal(await clipboard.readText(),'Не вставилось','failed insertion keeps the text for manual paste');
    } finally { hidden.destroy(); }

    await setRestore(false);
    await sentinel();
    target.focus();
    result=await deliver('Вторая диктовка',hwnd);
    assert.equal(result.status,'inserted');
    assert.equal(result.restored,undefined);
    assert.equal(await field(),'Вторая диктовка');
    assert.equal(await clipboard.readText(),'Вторая диктовка','default keeps the dictation in the clipboard');
  } finally {
    target.destroy();
    if(original.length)await clipboard.write(original);else clipboard.clear();
    for(const {file,data} of files){if(data===null)await rm(file,{force:true});else await writeFile(file,data);}
  }
}
