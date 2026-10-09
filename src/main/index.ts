import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, screen, session, shell, Tray, type WebContents } from 'electron';
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Storage } from './storage';
import { DiarizationService } from './diarization';
import { GigaamService } from './gigaam';
import { ModelStore } from './models';
import { mediaResponse } from './media';
import { NativeBridge } from './native';
import type { Command, Status } from '../shared/contracts';
import { formatSubtitles, normalizeSegments, subtitleFilename } from '../shared/transcript';
import { proofread, proofreadBatch, listModels } from './llm';
import { ApiKeyStore } from './api-key';
import { existsSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { UpdateService } from './updates';
import { AudioImport } from './audio-import';
import { NativeRecovery } from './native-recovery';
import { HOTKEYS, type Hotkey } from '../shared/hotkeys';
import { effectiveModel } from '../shared/models';
import { Log } from './log';

const smoke = process.argv.includes('--smoke-test');
// A fake microphone plays the Russian fixture once (see tests/gigaam-fixture.ps1).
if(smoke && (process.argv.includes('--dictation-test') || process.argv.includes('--profile-test'))){
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture',path.join(process.cwd(),'artifacts','fixture-ru.wav')+'%noloop');
}
const root = app.getAppPath();
if(smoke)app.setPath('userData',path.join(process.cwd(),'.data',app.isPackaged?'smoke-packaged':'smoke'));
else if (!app.isPackaged) app.setPath('userData',path.join(root,'.data'));
app.setName('Voice Scribe');
const log=new Log(path.join(app.getPath('userData'),'logs'));
log.captureConsole();
protocol.registerSchemesAsPrivileged([{scheme:'scribe',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:true}}]);
let win:BrowserWindow;
let overlay:BrowserWindow;
let tray:Tray;
let quitting=false;
let deliveryQueue:Promise<unknown>=Promise.resolve();
let deliveryGeneration=0;
let lastStatus:Status={phase:'idle',message:'Готов к диктовке'};
let hotkey:Hotkey='ctrl-space';
let noticeTimer:NodeJS.Timeout|undefined;
const bridge=new NativeBridge();
const nativeRecovery=new NativeRecovery(bridge,app.isPackaged?path.join(process.resourcesPath,'native/VoiceScribe.Native.exe'):path.join(root,'native/bin/VoiceScribe.Native.exe'),state=>{
  if(win && !win.isDestroyed())win.webContents.send('native:health',state);
});
const apiKeys=new ApiKeyStore(app.getPath('userData'));
let proofreadController: AbortController | null = null;
const storage=new Storage(app.getPath('userData'),process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA,'voice-scribe','models') : undefined, message => {
  void dialog.showMessageBox({type:'warning',title:'Восстановление данных Voice Scribe',message});
});
const diarization=new DiarizationService(path.join(root,'dist/diarization-worker.cjs'),path.join(app.getPath('userData'),'models','speakers'));
const models=new ModelStore(path.join(app.getPath('userData'),'models'),process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA,'voice-scribe','models') : undefined);
const gigaam=new GigaamService(path.join(root,'dist/gigaam-worker.cjs'),path.join(app.getPath('userData'),'models','gigaam-v3-punct'));
const audioImport = new AudioImport(app.isPackaged ? path.join(process.resourcesPath,'ffmpeg.exe') : path.join(root,'node_modules/ffmpeg-static/ffmpeg.exe'), path.join(app.getPath('userData'),'audio-temp'));
const trusted=(url:string)=>{try { const u=new URL(url); return u.protocol==='scribe:' && u.host==='app'; } catch { return false; }};
const send=(command:Command)=>{if(win && !win.isDestroyed())win.webContents.send('command',command);};
const textArg=(v:unknown)=>{if(typeof v!=='string' || v.length>2_000_000) throw new Error('Некорректный текст');return v;};
// The model returns the whole text, so allow ~10 ms per input character (50 000 chars ≈ 9 min).
const proofreadTimeout=(chars:number)=>Math.min(600_000,60_000+chars*10);
const active=()=>['starting','recording','transcribing','preparing'].includes(lastStatus.phase);
const installed = app.isPackaged && !smoke && !process.env.PORTABLE_EXECUTABLE_FILE && existsSync(path.join(process.resourcesPath,'installed.txt'));
const updates = new UpdateService(autoUpdater, installed, active, state => {
  if(win && !win.isDestroyed())win.webContents.send('updates:state',state);
});
function show():void { win.show(); win.focus(); }
function windowId(window:BrowserWindow):string {
  const handle=window.getNativeWindowHandle();
  return handle.length===8?handle.readBigUInt64LE().toString():handle.readUInt32LE().toString();
}
function ownWindowId():string { return windowId(win); }
function configureNativeWindow():void {
  if(win && !win.isDestroyed() && bridge.ready)void bridge.request('set-scribe-window',{target:ownWindowId()}).catch(()=>{});
}
function applyHotkey(value:Hotkey):void {
  hotkey=value;
  if(bridge.ready)void bridge.request('set-hotkey',{hotkey}).catch(error=>console.error('Hotkey change failed',error));
  if(lastStatus.phase==='idle')tray?.setToolTip(`Voice Scribe · ${HOTKEYS[hotkey].label}`);
  if(overlay && !overlay.isDestroyed())overlay.webContents.send('status',{...lastStatus,hotkey:HOTKEYS[hotkey].label});
}
// Ctrl+Shift+Space in another application proofreads its selection only when proofreading can run.
function applySelection(settings:{llmEnabled:boolean;llmModel:string}):void {
  if(bridge.ready)void bridge.request('set-selection',{enabled:settings.llmEnabled && settings.llmModel.trim()!==''}).catch(error=>console.error('Selection shortcut change failed',error));
}
function showOverlay():void {
  const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  overlay.setPosition(Math.round(area.x+(area.width-430)/2),area.y+area.height-112);
  overlay.showInactive();
}
function makeTray():void {
  const icon=nativeImage.createFromPath(path.join(root,'dist/icon.png')).resize({width:24,height:24});
  tray=new Tray(icon); tray.setToolTip(`Voice Scribe · ${HOTKEYS[hotkey].label}`); tray.on('double-click',show); refreshTray();
}
function refreshTray():void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    {label:'Открыть Voice Scribe',click:show},
    {label:['starting','recording'].includes(lastStatus.phase) ? 'Остановить диктовку' : 'Записать в буфер',enabled:lastStatus.phase!=='transcribing',click:()=>send({action:'toggle'})},
    {label:'Отменить',enabled:active(),click:()=>send({action:'cancel'})},
    {type:'separator'},
    {label:'История',click:()=>{show();send({action:'show-history'});}},
    {label:'Открыть папку журналов',click:()=>void shell.openPath(log.directory)},
    {label:'Выход',click:()=>{quitting=true;app.quit();}},
  ]));
}
function handle(name:string,fn:(...args:any[])=>unknown):void {
  ipcMain.handle(name,(event,...args)=>{
    if(event.sender!==win.webContents || !trusted(event.senderFrame?.url||'')) throw new Error('Untrusted IPC');
    return fn(...args);
  });
}
async function modelCacheResponse(key:string):Promise<Response> {
  let cached:{file:string;size:number}|null;
  try{cached=await storage.cacheFile(key);}catch{return new Response('Bad key',{status:400});}
  if(!cached)return new Response('Not cached',{status:404});
  const response=await net.fetch(pathToFileURL(cached.file).href);
  return new Response(response.body,{headers:{'content-type':'application/octet-stream','content-length':String(cached.size)}});
}
// Copies every format the clipboard offers (including raw Windows formats such as
// copied files) so it can be put back after insertion. OLE bookkeeping formats
// only point at the previous owner's live object and must not be replayed.
async function snapshotClipboard():Promise<ClipboardItem[]> {
  const items:ClipboardItem[]=[];
  for(const item of await clipboard.read()){
    const data:Record<string,Blob>={};
    for(const type of item.types)if(!/"(DataObject|Ole Private Data)"/.test(type)){
      const value=await item.getType(type);
      if(value instanceof Blob)data[type]=value;
    }
    if(Object.keys(data).length)items.push(new ClipboardItem(data));
  }
  return items;
}
async function restoreClipboard(previous:ClipboardItem[]):Promise<void> {
  if(previous.length)await clipboard.write(previous);else clipboard.clear();
}
async function appResponse(request:Request):Promise<Response> {
  const url=new URL(request.url);
  if(url.host!=='app')return new Response('Not found',{status:404});
  let relative:string;
  try{relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');}catch{return new Response('Bad path',{status:400});}
  if(relative.startsWith('model-cache/'))return modelCacheResponse(relative.slice('model-cache/'.length));
  // Source files of file transcripts, by history id: the renderer never names a path.
  if(relative.startsWith('media/')){
    const item=(await storage.history()).find(entry=>entry.id===relative.slice('media/'.length));
    return item?.audioPath ? mediaResponse(item.audioPath,request.headers.get('range')) : new Response('Not found',{status:404});
  }
  const base=path.join(root,'dist'); const file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
  return net.fetch(pathToFileURL(file).href);
}
// Cross-origin isolation enables SharedArrayBuffer, which multithreaded ONNX
// Runtime WASM needs. "credentialless" keeps the Hugging Face model downloads working.
function isolated(response:Response):Response {
  const headers=new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy','same-origin');
  headers.set('Cross-Origin-Embedder-Policy','credentialless');
  headers.set('Cross-Origin-Resource-Policy','same-origin');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
function setupIpc():void {
  handle('updates:state',()=>updates.state);
  handle('updates:check',()=>updates.check());
  handle('updates:download',()=>updates.download());
  handle('updates:install',()=>updates.install());
  handle('llm:key-has',async()=>apiKeys.has((await storage.settings()).llmBaseUrl));
  handle('llm:models',async()=>{
    const settings=await storage.settings();
    return listModels(settings.llmBaseUrl,await apiKeys.get(settings.llmBaseUrl),AbortSignal.timeout(20000));
  });
  handle('llm:key-save',async key=>{
    if(typeof key!=='string' || key.length>4096 || /[\r\n]/.test(key))throw new Error('Некорректный API-ключ');
    return apiKeys.save(key.trim(),(await storage.settings()).llmBaseUrl);
  });
  handle('llm:cancel',()=>{proofreadController?.abort();});
  handle('llm:batch',async batch=>{
    if(proofreadController)throw new Error('Вычитка уже выполняется.');
    const controller=new AbortController();proofreadController=controller;
    const chars=Array.isArray(batch?.cues)?batch.cues.reduce((sum:number,cue:{text?:unknown})=>sum+(typeof cue?.text==='string'?cue.text.length:0),0):0;
    const timer=setTimeout(()=>controller.abort(),proofreadTimeout(chars));
    try {const settings=await storage.settings();return await proofreadBatch(batch,settings,await apiKeys.get(settings.llmBaseUrl),controller.signal);}
    finally {clearTimeout(timer);if(proofreadController===controller)proofreadController=null;}
  });
  handle('llm:proofread',async(value,mode='review')=>{
    if(mode!=='plain' && mode!=='review' && mode!=='selection')throw new Error('Неизвестный режим вычитки.');
    if(proofreadController)throw new Error('Вычитка уже выполняется.');
    const controller=new AbortController();
    proofreadController=controller;
    const timer=setTimeout(()=>controller.abort(),proofreadTimeout(typeof value==='string'?value.length:0));
    try { const settings=await storage.settings(); return await proofread(textArg(value),settings,await apiKeys.get(settings.llmBaseUrl),controller.signal,undefined,mode); }
    finally { clearTimeout(timer); if(proofreadController===controller)proofreadController=null; }
  });
  handle('settings:get',()=>storage.settings());
  handle('settings:save',async value=>{
    await apiKeys.migrate((await storage.settings()).llmBaseUrl);
    const saved=await storage.saveSettings(value);
    if(saved.hotkey!==hotkey)applyHotkey(saved.hotkey);
    applySelection(saved);
    // Free GigaAM's memory once another model is chosen.
    if(effectiveModel(saved)!=='gigaam')gigaam.cancel();
    if(app.isPackaged && !smoke) app.setLoginItemSettings({openAtLogin:saved.startAtLogin,path:process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,args:['--hidden']});
    return saved;
  });
  handle('correction:remember',(from,to)=>storage.rememberCorrection(textArg(from),textArg(to)));
  handle('history:get',()=>storage.history());
  handle('history:add',(text,source,details)=>{
    let audioPath:string|undefined;
    try{if(source==='file' && typeof details?.audioId==='string')audioPath=audioImport.sourceOf(details.audioId);}catch{/* The import was released: no playback. */}
    return storage.addHistory(textArg(text),source==='file'?'file':'dictation',details,audioPath);
  });
  handle('history:update',(id,text,details)=>storage.updateHistory(textArg(id),textArg(text),details));
  handle('history:clear',keepPinned=>storage.clearHistory(keepPinned===true));
  handle('history:pin',(id,pinned)=>{if(typeof pinned!=='boolean')throw new Error('Некорректное закрепление');return storage.pinHistory(textArg(id),pinned);});
  handle('history:export',async()=>{
    const result=await dialog.showSaveDialog(win,{title:'Экспорт всей истории',defaultPath:'voice-scribe-history.txt',filters:[{name:'Текст',extensions:['txt']}]});
    if(result.canceled || !result.filePath)return false;
    const items=await storage.history();
    const text=items.map(item=>`${item.createdAt}${item.name?' · '+item.name:''}${item.pinned?' · Закреплено':''}\n\n${item.text}`).join('\n\n────────────────────────\n\n');
    await writeFile(result.filePath,text,'utf8');return true;
  });
  handle('copy',text=>{
    const value=textArg(text);
    const run=deliveryQueue.then(async()=>{await clipboard.writeText(value);});
    deliveryQueue=run.catch(()=>{});
    return run;
  });
  handle('deliver',(text,target,enter)=>{
    const value=textArg(text);
    const generation=deliveryGeneration;
    const run=deliveryQueue.then(async()=>{
    if(generation!==deliveryGeneration)return {status:'clipboard-only',reason:'cancelled'};
    const targeted=typeof target==='string' && /^[1-9]\d*$/.test(target) && bridge.ready;
    let previous:ClipboardItem[]|null=null;
    if(targeted && (await storage.settings().catch(()=>null))?.restoreClipboard){
      try{previous=await snapshotClipboard();}catch(error){console.error('Clipboard snapshot failed',error);}
    }
    // The paste must not be sent before the clipboard actually holds the text.
    await clipboard.writeText(value);
    if(!targeted) return {status:'clipboard-only',reason:'no-target'};
    // Never paste into this application's own window.
    const own=win.getNativeWindowHandle();
    const ownId=own.length===8?own.readBigUInt64LE().toString():own.readUInt32LE().toString();
    if(target===ownId) return {status:'clipboard-only',reason:'own-window'};
    let result;
    try { result=await bridge.request('insert',{target,enter:enter===true}); }
    catch(error) { return {status:'clipboard-only',reason:(error as Error).message}; }
    // Failed insertion keeps the text in the clipboard for a manual Ctrl+V.
    if(previous && result?.status==='inserted'){
      // Some applications read the clipboard lazily after Ctrl+V; give them time first.
      await new Promise(resolve=>setTimeout(resolve,500));
      // Something newer was copied in the meantime: leave it alone.
      if(await clipboard.readText().catch(()=>'')===value){
        try{await restoreClipboard(previous);result={...result,restored:true};}
        catch(error){console.error('Clipboard restore failed',error);}
      }
    }
    return result;
    });
    deliveryQueue=run.catch(()=>{});
    return run;
  });
  // Copies the selection of another window with Ctrl+C and puts the previous clipboard back.
  handle('selection:copy',target=>{
    if(typeof target!=='string' || !/^[1-9]\d*$/.test(target) || target===ownWindowId())throw new Error('Окно с выделенным текстом недоступно.');
    const run=deliveryQueue.then(async()=>{
      if(!bridge.ready)throw new Error('Служба горячих клавиш пока недоступна.');
      let previous:ClipboardItem[]|null=null;
      try{previous=await snapshotClipboard();}catch(error){console.error('Clipboard snapshot failed',error);}
      const result=await bridge.request('copy-selection',{target});
      const copied=result?.status==='copied';
      const text=copied ? await clipboard.readText() : '';
      // A cancelled copy may still have reached the application after Ctrl+C was sent.
      if(previous && (copied || result?.sent===true)){try{await restoreClipboard(previous);}catch(error){console.error('Clipboard restore failed',error);}}
      if(!copied)return {text:null,reason:typeof result?.reason==='string'?result.reason:'nothing-copied'};
      return text.trim() ? {text} : {text:null,reason:'not-text'};
    });
    deliveryQueue=run.catch(()=>{});
    return run;
  });
  handle('text:save',async text=>{
    const value=textArg(text);
    const result=await dialog.showSaveDialog(win,{title:'Сохранить расшифровку',defaultPath:`voice-${new Date().toISOString().slice(0,10)}.txt`,filters:[{name:'Текст',extensions:['txt']},{name:'Markdown',extensions:['md']}]});
    if(result.canceled || !result.filePath) return false;
    await writeFile(result.filePath,value,'utf8'); return true;
  });
  handle('subtitles:save',async(raw,format,name)=>{
    if(format!=='srt' && format!=='vtt')throw new Error('Неизвестный формат субтитров');
    const segments=normalizeSegments(raw);
    if(!segments.length)throw new Error('Нет фраз с таймкодами для экспорта');
    const value=formatSubtitles(segments,format);
    const result=await dialog.showSaveDialog(win,{title:'Сохранить субтитры',defaultPath:subtitleFilename(name,format),filters:[{name:format==='srt'?'SubRip (SRT)':'WebVTT',extensions:[format]}]});
    if(result.canceled || !result.filePath)return false;
    await writeFile(result.filePath,value,'utf8');return true;
  });
  handle('speakers:run',(pcm,speakerCount)=>diarization.run(pcm,value=>{if(!win.isDestroyed())win.webContents.send('speakers:progress',value);},speakerCount));
  handle('speakers:cancel',()=>diarization.cancel());
  const gigaamProgress=(value:import('../shared/gigaam').GigaamProgress)=>{if(!win.isDestroyed())win.webContents.send('gigaam:progress',value);};
  handle('gigaam:prepare',()=>gigaam.prepare(gigaamProgress));
  handle('gigaam:recognize',(pcm,timed)=>gigaam.recognize(pcm,timed===true,gigaamProgress));
  handle('gigaam:cancel',()=>gigaam.cancel());
  handle('models:list',()=>models.list());
  handle('window:process',async target=>{
    if(typeof target!=='string' || !bridge.ready)return null;
    try{const info=await bridge.request('window-info',{target});return typeof info?.process==='string'?info.process:null;}
    catch{return null;}
  });
  handle('models:delete',async id=>{
    // The worker may hold the model open; it reloads (or downloads) on next use.
    if(id==='gigaam')gigaam.cancel();
    await models.remove(id);
    return models.list();
  });
  handle('audio:select',source=>audioImport.select(textArg(source)));
  handle('audio:prepare',id=>audioImport.prepare(textArg(id)));
  handle('audio:chunk',(id,offset)=>audioImport.chunk(textArg(id),offset));
  handle('audio:release',id=>audioImport.release(textArg(id)));
  handle('audio:cancel',()=>{diarization.cancel();return audioImport.cancelAll();});
  handle('audio:diarize',(id,count)=>diarization.runFile(audioImport.pcmPath(textArg(id)),value=>{if(!win.isDestroyed())win.webContents.send('speakers:progress',value);},count));
  handle('audio:pick',async()=>{
    const result=await dialog.showOpenDialog(win,{title:'Расшифровать аудио или видео',properties:['openFile'],filters:[{name:'Аудио и видео',extensions:['wav','mp3','m4a','ogg','flac','webm','mp4','aac','mov','mkv','avi','m4v','opus']}]});
    if(result.canceled || !result.filePaths[0]) return null;
    return audioImport.select(result.filePaths[0]);
  });
  handle('cache:has',key=>storage.cacheHas(textArg(key)));
  handle('cache:put',(key,data)=>{if(!(data instanceof ArrayBuffer) || data.byteLength>1_000_000_000) throw new Error('Invalid cache data');return storage.cachePut(textArg(key),data);});
  handle('app:info',()=>({version:app.getVersion(),dataPath:storage.root,nativeReady:bridge.ready}));
  handle('native:health',()=>nativeRecovery.state);
  handle('native:restart',()=>{if(active())throw new Error('Дождитесь завершения записи или обработки');nativeRecovery.restart();});
  ipcMain.on('hide',event=>{if(event.sender===win.webContents)win.hide();});
  ipcMain.on('notice',(event,message,error)=>{
    if(event.sender!==win.webContents || typeof message!=='string' || smoke || active() || win.isFocused() || !overlay || overlay.isDestroyed())return;
    overlay.webContents.send('status',{phase:error===true?'error':'idle',message:message.slice(0,250),notice:true});
    showOverlay();
    clearTimeout(noticeTimer);
    noticeTimer=setTimeout(()=>{if(!active())overlay?.hide();},error===true?6000:3000);
  });
  ipcMain.on('status',(event,status:Status)=>{
    if(event.sender!==win.webContents || !status || !['idle','starting','recording','transcribing','preparing','error'].includes(status.phase))return;
    const changed=status.phase!==lastStatus.phase;
    if(changed && ['idle','error'].includes(status.phase)){
      deliveryGeneration++;
      if(bridge.ready)void bridge.request('cancel-insert').catch(()=>{});
    }
    lastStatus={phase:status.phase,message:String(status.message).slice(0,250),seconds:status.seconds,level:status.level,progress:status.progress,remainingSeconds:status.remainingSeconds};
    if(changed){refreshTray();if(bridge.ready)void bridge.request('set-active',{active:active()}).catch(()=>{});}
    tray?.setToolTip(`Voice Scribe · ${lastStatus.message}`.slice(0,120));
    clearTimeout(noticeTimer);
    if(!smoke && active() && !win.isFocused())showOverlay();
    else overlay?.hide();
    if(overlay && !overlay.isDestroyed())overlay.webContents.send('status',{...lastStatus,hotkey:HOTKEYS[hotkey].label});
  });
}
// Renderer warnings and errors (model fallbacks, microphone failures) go to the log too.
function logConsole(contents:WebContents,name:string):void {
  contents.on('console-message',({level,message,sourceId,lineNumber})=>{
    if(level==='warning' || level==='error')log.write(level==='error'?'ERROR':'WARN',`[${name}] ${message} (${sourceId}:${lineNumber})`);
  });
}
async function createWindows():Promise<void> {
  win=new BrowserWindow({width:760,height:620,minWidth:600,minHeight:480,show:false,title:'Voice Scribe',backgroundColor:nativeTheme.shouldUseDarkColors?'#202020':'#f6f6f6',icon:path.join(root,'dist/icon.png'),autoHideMenuBar:true,webPreferences:{preload:path.join(root,'dist/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!trusted(url))event.preventDefault();});
  win.webContents.on('render-process-gone',(_event,details)=>{console.error('Renderer stopped',details);diarization.cancel();gigaam.cancel();proofreadController?.abort();void audioImport.cancelAll().catch(error=>console.error('Audio cleanup failed',error));deliveryGeneration++;if(bridge.ready){void bridge.request('cancel-insert').catch(()=>{});void bridge.request('set-active',{active:false}).catch(()=>{});}overlay?.hide();if(!quitting)dialog.showErrorBox('Voice Scribe','Процесс распознавания остановился. Перезапустите приложение. Сохранённая история останется на диске.');});
  overlay=new BrowserWindow({width:430,height:90,show:false,transparent:true,frame:false,focusable:false,skipTaskbar:true,resizable:false,alwaysOnTop:true,webPreferences:{preload:path.join(root,'dist/overlay-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  overlay.setIgnoreMouseEvents(true);
  logConsole(win.webContents,'renderer');logConsole(overlay.webContents,'overlay');
  overlay.webContents.on('render-process-gone',(_event,details)=>console.error('Overlay stopped',details));
  setupIpc();
  await Promise.all([win.loadURL('scribe://app/index.html'),overlay.loadURL('scribe://app/overlay.html')]);
  if(!smoke && !process.argv.includes('--hidden'))show();
}
if(!app.requestSingleInstanceLock())app.quit();
else {
  log.write('INFO',`Voice Scribe ${app.getVersion()} · Electron ${process.versions.electron} · Windows ${os.release()} · ${app.isPackaged?(installed?'installed':'portable'):'development'}`);
  app.on('second-instance',()=>{if(win)show();});
  app.on('child-process-gone',(_event,details)=>{if(details.reason!=='clean-exit')console.error('Child process stopped',details);});
  let audioCleaned = false;
  app.on('before-quit',event=>{
    quitting=true;diarization.cancel();gigaam.cancel();nativeRecovery.stop();
    if (!audioCleaned) {
      event.preventDefault();
      void audioImport.cancelAll().catch(error=>console.error('Audio cleanup failed',error)).finally(()=>{audioCleaned=true;app.quit();});
    }
  });
  app.on('window-all-closed',()=>{});
  void app.whenReady().then(async()=>{
    await audioImport.cleanupAbandoned();
    protocol.handle('scribe',async request=>isolated(await appResponse(request)));
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===win?.webContents && permission==='media' && trusted(details.requestingUrl) && (!('mediaTypes' in details) || !details.mediaTypes || details.mediaTypes.every(t=>t==='audio'))));
    session.defaultSession.setPermissionCheckHandler((contents,permission,origin)=>contents===win?.webContents && permission==='media' && trusted(origin));
    if(smoke)session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
    bridge.on('hotkey',event=>{
      if(!win || win.isDestroyed())return;
      const own=event.target===ownWindowId();
      if(event.action==='proofread'){send(own?{action:'proofread',mode:'review'}:{action:'proofread',mode:'plain',target:event.target});return;}
      if(event.action==='dictation-down' && own)event={...event,target:''};
      send(event as Command);
    });
    // A restarted helper starts with the default shortcut; reapply the saved one.
    bridge.on('ready',()=>{configureNativeWindow();applyHotkey(hotkey);void storage.settings().then(applySelection,()=>{});void bridge.request('set-active',{active:active()}).catch(()=>{});});
    hotkey=(await storage.settings().catch(()=>null))?.hotkey ?? hotkey;
    nativeRecovery.restart();
    await createWindows(); configureNativeWindow(); makeTray();
    if(installed){
      const saved=await storage.settings();
      app.setLoginItemSettings({openAtLogin:saved.startAtLogin,path:process.execPath,args:['--hidden']});
      setTimeout(()=>void updates.check(true),15000).unref();
      setInterval(()=>void updates.check(true),6*60*60*1000).unref();
    }
    if(smoke){
      try{await (require(path.join(root,'dist/smoke-main.cjs')) as typeof import('./smoke')).runSmoke({win,overlay,bridge,status:()=>lastStatus,windowId});}
      finally{quitting=true;app.quit();}
    }
  }).catch(error=>{console.error(error);quitting=true;app.exit(1);});
}
