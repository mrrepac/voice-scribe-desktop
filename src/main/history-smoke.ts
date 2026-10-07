import { app, dialog, type BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { strict as assert } from 'node:assert';

export async function historySmokeTest(win: BrowserWindow): Promise<void> {
  assert.equal(path.resolve(app.getPath('userData')),path.resolve('.data',app.isPackaged?'smoke-packaged':'smoke'));
  const out=path.resolve('artifacts/history');await mkdir(out,{recursive:true});
  const files=await Promise.all(['history.json','history.json.bak','settings.json','settings.json.bak'].map(async name=>{
    const file=path.join(app.getPath('userData'),name);
    return {file,data:await readFile(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;})};
  }));
  const originalSave=dialog.showSaveDialog;
  let cancelExport=true;
  dialog.showSaveDialog=(async()=>({canceled:cancelExport,filePath:cancelExport?undefined:path.join(out,'export.txt')})) as typeof dialog.showSaveDialog;
  const execute=(source:string)=>win.webContents.executeJavaScript(source);
  const until=async(source:string)=>{
    for(let i=0;i<100;i++){if(await execute(source))return;await new Promise(resolve=>setTimeout(resolve,30));}
    throw new Error('History smoke timeout: '+source);
  };
  try {
    await execute(`(async()=>{await window.scribe.clearHistory();await window.scribe.addHistory('Важная встреча','dictation');await window.scribe.addHistory('Обычная запись','dictation');})()`);
    await win.loadURL('scribe://app/index.html');
    await until(`!document.querySelector('#record-button').disabled`);
    await execute(`document.querySelector('[data-view="history"]').click();document.querySelectorAll('.history-actions button')[2].click()`);
    await until(`document.querySelector('.history-actions button[aria-pressed="true"]')!==null`);
    const items=await execute(`window.scribe.getHistory()`);
    assert.equal(items.filter((item:any)=>item.pinned).length,1);
    await new Promise(resolve=>setTimeout(resolve,200));
    await writeFile(path.join(out,'pinned.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await execute(`document.querySelector('#clear-history').click()`);
    await writeFile(path.join(out,'clear-dialog.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await execute(`(async()=>{const dialog=document.querySelector('#history-clear-dialog');const closed=new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));dialog.querySelector('button[value="export"]').click();await closed;})()`);
    await until(`!document.querySelector('main').inert`);
    assert.equal((await execute(`window.scribe.getHistory()`)).length,2);
    cancelExport=false;
    await execute(`(async()=>{document.querySelector('#clear-history').click();const dialog=document.querySelector('#history-clear-dialog');const closed=new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));dialog.querySelector('button[value="export"]').click();await closed;})()`);
    await until(`!document.querySelector('main').inert && document.querySelector('#history-count').textContent==='1'`);
    assert.equal((await execute(`window.scribe.getHistory()`))[0].pinned,true);
    const exported=await readFile(path.join(out,'export.txt'),'utf8');
    assert.ok(exported.includes('Важная встреча') && exported.includes('Обычная запись'));
    await execute(`document.querySelector('[data-view="settings"]').click();const select=document.querySelector('[name="historyLimit"]');select.value='500';select.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until(`document.querySelector('#settings-saved').textContent==='Все изменения сохранены'`);
    assert.equal((await execute(`window.scribe.getSettings()`)).historyLimit,500);
    await execute(`window.scribe.restartNative()`);
    await until(`document.querySelector('#native-health').textContent==='Горячие клавиши подключены'`);
    await writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks:['pin via UI','cancel export preserves history','export then clear retains pinned','history limit persists','manual hotkey reconnect']},null,2));
  } finally {
    dialog.showSaveDialog=originalSave;
    for(const {file,data} of files){if(data)await writeFile(file,data);else await rm(file,{force:true});}
    await win.loadURL('scribe://app/index.html');
    await until(`!document.querySelector('#record-button').disabled`);
  }
}
