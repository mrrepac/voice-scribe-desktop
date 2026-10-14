// Smoke tests of the real app. Bundled separately (dist/smoke-main.cjs) and loaded
// only with --smoke-test, so ordinary starts never load this code.
import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeBridge } from './native';
import { gigaamSmokeTest } from './gigaam-smoke';
import { dictationSmokeTest } from './dictation-smoke';

export interface SmokeContext { win: BrowserWindow; bridge: NativeBridge; }

export async function runSmoke({ win, bridge }: SmokeContext): Promise<void> {
  const out=path.join(process.cwd(),'artifacts',app.isPackaged?'packaged':'.'); await mkdir(out,{recursive:true});
  const logs:string[]=[];
  win.webContents.on('console-message',({message})=>logs.push(message));
  const capture=async(name:string)=>writeFile(path.join(out,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  try {
    await new Promise(resolve=>setTimeout(resolve,1200));
    const result=await win.webContents.executeJavaScript(`(async()=>{ const settings=await window.scribe.getSettings(); const info=await window.scribe.getAppInfo(); if(document.querySelector('#record-button').disabled || document.querySelector('#record-card').dataset.phase==='error')throw new Error('UI boot failed: '+document.body.innerText); return {title:document.title,settings,info}; })()`);
    await capture('smoke-ui.png');
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="settings"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,200));
    await capture('smoke-settings.png');
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="dictation"]').click()`);
    const giga=process.argv.includes('--gigaam-test')?await gigaamSmokeTest(win):undefined;
    if(giga)console.log('GIGAAM_SMOKE',JSON.stringify(giga));
    if(process.argv.includes('--dictation-test'))console.log('DICTATION_SMOKE',JSON.stringify(await dictationSmokeTest(win)));
    if(!bridge.ready)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native helper startup timeout')),10000);bridge.once('ready',()=>{clearTimeout(timer);resolve();});bridge.once('failure',message=>{clearTimeout(timer);reject(new Error(message));});});
    const native=await bridge.request('diagnostics');
    await writeFile(path.join(out,'smoke-result.json'),JSON.stringify({ok:true,result,native,logs},null,2));
    console.log('SMOKE_OK',JSON.stringify({native}));
  } catch(error) {
    await writeFile(path.join(out,'smoke-result.json'),JSON.stringify({ok:false,error:String(error),logs},null,2)); console.error(error);process.exitCode=1;
  }
}
