import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, screen, session, Tray } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Storage } from './storage';
import { DiarizationService } from './diarization';
import { GigaamService } from './gigaam';
import { ModelStore } from './models';
import { NativeBridge } from './native';
import type { Command, Status } from '../shared/contracts';
import { formatSubtitles, normalizeSegments, subtitleFilename } from '../shared/transcript';
import { speakerSmokeTest } from './speaker-smoke';
import { importSmokeTest } from './import-smoke';
import { subtitleSmokeTest } from './subtitle-smoke';
import { correctionSmokeTest } from './correction-smoke';
import { proofread, proofreadBatch, listModels } from './llm';
import { ApiKeyStore } from './api-key';
import { llmSmokeTest } from './llm-smoke';
import { existsSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { UpdateService } from './updates';
import { AudioImport } from './audio-import';
import { NativeRecovery } from './native-recovery';
import { historySmokeTest } from './history-smoke';
import { clipboardSmokeTest } from './clipboard-smoke';
import { gigaamSmokeTest } from './gigaam-smoke';
import { dictationSmokeTest } from './dictation-smoke';
import { HOTKEYS, type Hotkey } from '../shared/hotkeys';

const smoke = process.argv.includes('--smoke-test');
// A fake microphone plays the Russian fixture once (see tests/gigaam-fixture.ps1).
if(smoke && process.argv.includes('--dictation-test')){
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture',path.join(process.cwd(),'artifacts','fixture-ru.wav')+'%noloop');
}
const root = app.getAppPath();
if(smoke)app.setPath('userData',path.join(process.cwd(),'.data',app.isPackaged?'smoke-packaged':'smoke'));
else if (!app.isPackaged) app.setPath('userData',path.join(root,'.data'));
app.setName('Voice Scribe');
protocol.registerSchemesAsPrivileged([{scheme:'scribe',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:true}}]);
let win:BrowserWindow;
let overlay:BrowserWindow;
let tray:Tray;
let quitting=false;
let deliveryQueue:Promise<unknown>=Promise.resolve();
let deliveryGeneration=0;
let lastStatus:Status={phase:'idle',message:'Готов к диктовке'};
let hotkey:Hotkey='ctrl-space';
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
function ownWindowId():string {
  const handle=win.getNativeWindowHandle();
  return handle.length===8?handle.readBigUInt64LE().toString():handle.readUInt32LE().toString();
}
function configureNativeWindow():void {
  if(win && !win.isDestroyed() && bridge.ready)void bridge.request('set-scribe-window',{target:ownWindowId()}).catch(()=>{});
}
function applyHotkey(value:Hotkey):void {
  hotkey=value;
  if(bridge.ready)void bridge.request('set-hotkey',{hotkey}).catch(error=>console.error('Hotkey change failed',error));
  if(lastStatus.phase==='idle')tray?.setToolTip(`Voice Scribe · ${HOTKEYS[hotkey].label}`);
  if(overlay && !overlay.isDestroyed())overlay.webContents.send('status',{...lastStatus,hotkey:HOTKEYS[hotkey].label});
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
    if(mode!=='plain' && mode!=='review')throw new Error('Неизвестный режим вычитки.');
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
    // Free GigaAM's memory once another model is chosen.
    if(saved.model!=='gigaam')gigaam.cancel();
    if(app.isPackaged && !smoke) app.setLoginItemSettings({openAtLogin:saved.startAtLogin,path:process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,args:['--hidden']});
    return saved;
  });
  handle('correction:remember',(from,to)=>storage.rememberCorrection(textArg(from),textArg(to)));
  handle('history:get',()=>storage.history());
  handle('history:add',(text,source,details)=>storage.addHistory(textArg(text),source==='file'?'file':'dictation',details));
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
    if(!smoke && active() && !win.isFocused()){
      const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      overlay.setPosition(Math.round(area.x+(area.width-430)/2),area.y+area.height-112);
      overlay.showInactive();
    }else overlay?.hide();
    if(overlay && !overlay.isDestroyed())overlay.webContents.send('status',{...lastStatus,hotkey:HOTKEYS[hotkey].label});
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
  setupIpc();
  await Promise.all([win.loadURL('scribe://app/index.html'),overlay.loadURL('scribe://app/overlay.html')]);
  if(!smoke && !process.argv.includes('--hidden'))show();
}
// Optional visual audit of the real renderer. Fixtures below change DOM presentation
// only; they deliberately do not claim to test recording, downloads, or delivery.
async function designSmokeTest():Promise<void> {
  const out=path.join(process.cwd(),'artifacts','design');
  await mkdir(out,{recursive:true});
  const originalTheme=nativeTheme.themeSource;
  const originalBounds=win.getBounds();
  const attachedDebugger=!win.webContents.debugger.isAttached();
  if(attachedDebugger)win.webContents.debugger.attach('1.3');
  const captures:unknown[]=[];
  const failures:string[]=[];
  let expectedView='';
  const settle=()=>new Promise(resolve=>setTimeout(resolve,180));
  const navigate=async(view:string)=>{
    expectedView=view;
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click(); document.querySelector('main').scrollTop=0; document.querySelector('.view:not([hidden])').scrollTop=0; window.scrollTo(0,0);`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:350,y:20});
    await settle();
  };
  const capture=async(name:string,kind='live',requiredVisible:string[]=[])=>{
    const geometry=await win.webContents.executeJavaScript(`(()=>{
      const visible=el=>el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
      const name=el=>el.id?'#'+el.id:el.tagName.toLowerCase()+'.'+String(el.className||'').replace(/\\s+/g,'.');
      const bounds=el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};};
      const horizontalOverflow=[...document.body.querySelectorAll('*')].filter(el=>visible(el) && el.getBoundingClientRect().width>0).filter(el=>{const r=el.getBoundingClientRect();return r.left < -2 || r.right > innerWidth+2;}).map(el=>({element:name(el),...bounds(el)}));
      const scrollOverflow=[document.documentElement,document.querySelector('main'),...document.querySelectorAll('.view:not([hidden]),.settings-group,.field,.history-item,.file-row,.setup-card')].filter(el=>visible(el) && el.clientWidth>0 && el.scrollWidth>el.clientWidth+2).map(el=>({element:name(el),clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}));
      const requiredVisible=${JSON.stringify(requiredVisible)}.map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,visible:false,missing:true};const r=el.getBoundingClientRect();return {selector,visible:Boolean(visible(el) && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth),disabled:Boolean(el.disabled),...bounds(el)};});
      return {viewport:{width:innerWidth,height:innerHeight},dark:matchMedia('(prefers-color-scheme: dark)').matches,activeView:document.querySelector('[data-view][aria-current="page"]')?.dataset.view,visibleViews:[...document.querySelectorAll('.view:not([hidden])')].map(el=>el.id),horizontalOverflow,scrollOverflow,requiredVisible};
    })()`);
    // The first capture wakes a hidden window's compositor; wait for its new
    // frame before saving so a preceding view cannot leak into this screenshot.
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await settle();
    await writeFile(path.join(out,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    captures.push({name,kind,window:win.getSize(),...geometry});
    if(geometry.activeView!==expectedView || geometry.visibleViews.length!==1 || geometry.visibleViews[0]!=='view-'+expectedView)failures.push(name+': unexpected active view');
    if(geometry.horizontalOverflow.length || geometry.scrollOverflow.length)failures.push(name+': horizontal overflow');
    if(geometry.requiredVisible.some((item:{visible:boolean;disabled:boolean})=>!item.visible || item.disabled))failures.push(name+': primary action is unavailable or outside the viewport');
  };
  try {
    // A hidden smoke window has no native focus. Emulate focus only for this
    // audit so keyboard focus styles can be checked without raising the window.
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    for(const theme of ['light','dark'] as const){
      nativeTheme.themeSource=theme;
      for(const size of [{name:'default',width:760,height:620},{name:'minimum',width:600,height:480}]){
        win.setSize(size.width,size.height);
        await settle();
        for(const view of ['dictation','history','settings']){
          await navigate(view);
          await capture(`${theme}-${size.name}-${view}`,'live',view==='dictation'?['#record-button','#prepare-button','#pick-file']:[]);
          if(view==='settings'){
            const groupCount=await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-group').length`);
            for(let index=1;index<groupCount;index++){
              await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-group')[${index}].scrollIntoView({block:'start',behavior:'instant'})`);
              await settle();
              await capture(`${theme}-${size.name}-settings-section-${index+1}`);
            }
          }
        }
      }
      overlay.webContents.send('status',lastStatus);
      await overlay.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await settle();
      await writeFile(path.join(out,`${theme}-overlay-idle.png`),(await overlay.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      captures.push({name:`${theme}-overlay-idle`,kind:'live-overlay',window:overlay.getSize(),phase:lastStatus.phase,note:'The idle overlay is normally hidden; captured here to inspect its theme.'});
      win.setSize(760,620);
      await navigate('settings');
      for(const [label,selector] of [['select','select[name="model"]'],['toggle','input[name="live"]'],['textarea','textarea[name="replacements"]']]){
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        const focus=await win.webContents.executeJavaScript(`(()=>{
          const control=document.querySelector(${JSON.stringify(selector)});
          const surface=control.closest('.switch')?.querySelector('span') || control;
          control.blur();
          const baseline=getComputedStyle(surface);const previous={outline:baseline.outline,boxShadow:baseline.boxShadow};
          control.scrollIntoView({block:'center',behavior:'instant'});control.focus({preventScroll:true});
          const style=getComputedStyle(surface);
          return {selector:${JSON.stringify(selector)},active:document.activeElement===control,focusVisible:control.matches(':focus-visible'),outline:style.outline,boxShadow:style.boxShadow,visibleIndicator:(style.outlineStyle!=='none' && parseFloat(style.outlineWidth)>0 && style.outline!==previous.outline) || (style.boxShadow!=='none' && style.boxShadow!==previous.boxShadow)};
        })()`);
        await settle();
        await capture(`${theme}-focus-${label}`);
        captures.push({name:`${theme}-focus-${label}`,kind:'focus-check',...focus});
        if(!focus.active || !focus.focusVisible || !focus.visibleIndicator)failures.push(`${theme}-focus-${label}: missing visible keyboard focus`);
        await win.webContents.executeJavaScript(`document.activeElement.blur()`);
      }
      await navigate('dictation');
      const editor=await win.webContents.executeJavaScript(`(()=>{
        const field=document.getElementById('result-text');
        const card=document.getElementById('result-card');
        const copy=document.getElementById('copy-result');
        const save=document.getElementById('export-result');
        const value=field.value;
        const visible=card.getClientRects().length>0 && field.getClientRects().length>0;
        const initial={empty:field.value==='',disabled:copy.disabled && save.disabled};
        field.value='Проверка редактирования';field.dispatchEvent(new Event('input',{bubbles:true}));
        const populated={enabled:!copy.disabled && !save.disabled};
        field.value='';field.dispatchEvent(new Event('input',{bubbles:true}));
        const cleared={disabled:copy.disabled && save.disabled};
        field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));
        return {visible,initial,populated,cleared};
      })()`);
      captures.push({name:`${theme}-editor-actions`,kind:'input-check',...editor});
      if(!editor.visible || !editor.initial.empty || !editor.initial.disabled || !editor.populated.enabled || !editor.cleared.disabled)failures.push(`${theme}-editor-actions: editor visibility or action state is incorrect`);
      for(const fixture of ['recording','preparing','error','result']){
        await win.webContents.executeJavaScript(`(()=>{
          const ids=['record-card','status-label','timer','record-title','record-description','record-button','record-button-label','record-icon','cancel-button','setup-card','result-card','result-text','result-label','word-count','result-note','copy-result','export-result','pick-file','prepare-button'];
          const textIds=['status-label','timer','record-title','record-description','record-button-label','result-label','word-count','result-note'];
          const elements=ids.map(id=>document.getElementById(id));
          const snapshot=elements.map(el=>({el,attributes:[...el.attributes].map(a=>[a.name,a.value]),text:textIds.includes(el.id)?el.textContent:null,value:el.id==='result-text'?el.value:null}));
          const icon=document.querySelector('#record-icon use');const iconHref=icon.getAttribute('href');
          const bars=[...document.querySelectorAll('#waveform i')].map(el=>({el,style:el.style.cssText}));
          window.__scribeDesignRestore=()=>{for(const saved of snapshot){for(const attribute of [...saved.el.attributes])saved.el.removeAttribute(attribute.name);for(const [name,value] of saved.attributes){if(name==='style')saved.el.style.cssText=value;else saved.el.setAttribute(name,value);}if(saved.text!==null)saved.el.textContent=saved.text;if(saved.value!==null)saved.el.value=saved.value;}icon.setAttribute('href',iconHref);for(const bar of bars)bar.el.style.cssText=bar.style;delete window.__scribeDesignRestore;};
          const set=(id,text)=>document.getElementById(id).textContent=text;
          const fixture=${JSON.stringify(fixture)};
          const busy=['recording','preparing'].includes(fixture);
          document.getElementById('record-card').dataset.phase=fixture==='result'?'idle':fixture;
          document.getElementById('cancel-button').hidden=!busy;
          document.getElementById('record-button').disabled=fixture==='preparing';
          const buttonLabel=fixture==='recording'?'Стоп':fixture==='preparing'?'Подготовка…':fixture==='error'?'Повторить':'Записать';
          set('record-button-label',buttonLabel);document.getElementById('record-button').setAttribute('aria-label',buttonLabel);
          for(const id of ['pick-file','prepare-button'])document.getElementById(id).disabled=busy;
          if(fixture==='recording'){
            set('status-label','Запись');set('timer','00:12');set('record-title','Запись');set('record-description','');
            icon.setAttribute('href','#i-stop');bars.forEach(({el},i)=>el.style.transform='scaleY('+(0.15+Math.abs(Math.sin(i*.71))*.85)+')');
          }else if(fixture==='preparing'){
            set('status-label','Загружаем модель · 42%');set('record-title','Подготовка модели');set('record-description','Загружаем модель · 42%. Аудио остаётся на вашем компьютере.');
          }else if(fixture==='error'){
            set('status-label','Ошибка');set('record-title','Ошибка');set('record-description','Нет доступа к микрофону. Разрешите доступ в Windows → Параметры → Конфиденциальность → Микрофон.');
          }else{
            set('status-label','Готово');document.getElementById('setup-card').hidden=true;document.getElementById('result-card').hidden=false;
            document.getElementById('result-text').value='Обсудили новый проект. К пятнице подготовим первый вариант и соберём обратную связь. Следующий шаг — проверить текст и отправить его команде.';
            set('result-label','Текст');set('word-count',document.getElementById('result-text').value.trim().split(/\\s+/u).length+' слов');set('result-note','Скопировано');
            document.getElementById('copy-result').disabled=false;document.getElementById('export-result').disabled=false;
          }
        })()`);
        try {
          await settle();
          await capture(`${theme}-fixture-${fixture}`,'dom-fixture');
          if(fixture==='result'){
            await win.webContents.executeJavaScript(`document.getElementById('result-card').scrollIntoView({block:'center',behavior:'instant'})`);
            await settle();
            await capture(`${theme}-fixture-result-detail`,'dom-fixture');
          }
        }finally{
          await win.webContents.executeJavaScript(`window.__scribeDesignRestore?.(); document.querySelector('main').scrollTop=0; document.querySelector('.view:not([hidden])').scrollTop=0; window.scrollTo(0,0);`);
        }
      }
    }
  }catch(error){
    failures.push('Visual audit interrupted: '+String(error));
    throw error;
  }finally{
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});
    if(attachedDebugger)win.webContents.debugger.detach();
    nativeTheme.themeSource=originalTheme;
    win.setBounds(originalBounds);
    await writeFile(path.join(out,'design-report.json'),JSON.stringify({ok:failures.length===0,notes:['Live captures use the isolated smoke profile.','DOM fixture captures verify presentation only; audio recording, model download, and text delivery are not exercised.','Viewport dimensions exclude the native window frame.'],failures,captures},null,2));
  }
  if(failures.length)throw new Error('Design smoke failed: '+failures.join('; '));
}
async function smokeTest():Promise<void> {
  const out=path.join(process.cwd(),'artifacts',app.isPackaged?'packaged':'.'); await mkdir(out,{recursive:true});
  const logs:string[]=[];
  win.webContents.on('console-message',(_event,_level,message)=>logs.push(message));
  try {
    await new Promise(resolve=>setTimeout(resolve,1200));
    const result=await win.webContents.executeJavaScript(`(async()=>{ const settings=await window.scribe.getSettings(); const info=await window.scribe.getAppInfo(); if(document.querySelector('#record-button').disabled || document.querySelector('#record-card').dataset.phase==='error')throw new Error('UI boot failed: '+document.body.innerText); return {title:document.title,settings,info,body:document.body.innerText.slice(0,1000)}; })()`);
    await writeFile(path.join(out,'smoke-ui.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="settings"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,200));
    await writeFile(path.join(out,'smoke-settings.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="history"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,200));
    await writeFile(path.join(out,'smoke-history.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    if(process.argv.includes('--design-test'))await designSmokeTest();
    if(process.argv.includes('--import-test'))await importSmokeTest(win);
    if(process.argv.includes('--speakers-test'))await speakerSmokeTest(win);
    if(process.argv.includes('--subtitles-test'))await subtitleSmokeTest(win);
    if(process.argv.includes('--corrections-test'))await correctionSmokeTest(win);
    if(process.argv.includes('--llm-test'))await llmSmokeTest(win);
    if(process.argv.includes('--history-test'))await historySmokeTest(win);
    const giga=process.argv.includes('--gigaam-test')?await gigaamSmokeTest(win):undefined;
    if(giga)console.log('GIGAAM_SMOKE',JSON.stringify(giga));
    if(process.argv.includes('--dictation-test'))console.log('DICTATION_SMOKE',JSON.stringify(await dictationSmokeTest(win)));
    if(!bridge.ready)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Native helper startup timeout')),10000);bridge.once('ready',()=>{clearTimeout(timer);resolve();});bridge.once('failure',message=>{clearTimeout(timer);reject(new Error(message));});});
    if(process.argv.includes('--clipboard-test'))await clipboardSmokeTest(win,bridge);
    const native=await bridge.request('diagnostics');
    const asr=app.isPackaged ? await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const w=new Worker('./asr-worker.js',{type:'module'}); const t=setTimeout(()=>{w.terminate();reject(new Error('Packaged worker timeout'));},20000); w.onerror=e=>{clearTimeout(t);w.terminate();reject(new Error(e.message));}; w.onmessage=({data})=>{if(data.t==='ready')w.postMessage({t:'plan',id:1,pref:'auto',devicePref:'auto'});if(data.t==='plan'){clearTimeout(t);w.terminate();resolve({ok:true,plan:data.plan});}if(data.t==='error'){clearTimeout(t);w.terminate();reject(new Error(data.message));}};})`) : await win.webContents.executeJavaScript(`(async()=>{ const m=await import('./smoke.js'); const audio=${process.argv.includes('--asr-test')} ? await (await fetch('./fixture.wav')).arrayBuffer() : undefined; return m.runAsrSmoke({model:'auto',device:'auto',audio,checkIsolation:true}); })()`);
    if(asr.ok===false)throw new Error(JSON.stringify(asr));
    await writeFile(path.join(out,'smoke-result.json'),JSON.stringify({ok:true,result,native,asr,logs},null,2));
    console.log('SMOKE_OK',JSON.stringify({native,asr}));
  } catch(error) {
    await writeFile(path.join(out,'smoke-result.json'),JSON.stringify({ok:false,error:String(error),logs},null,2)); console.error(error);process.exitCode=1;
  } finally {quitting=true;app.quit();}
}
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{if(win)show();});
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
      if(event.action==='proofread'){send({action:'proofread',mode:own?'review':'plain'});return;}
      if(event.action==='dictation-down' && own)event={...event,target:''};
      send(event as Command);
    });
    // A restarted helper starts with the default shortcut; reapply the saved one.
    bridge.on('ready',()=>{configureNativeWindow();applyHotkey(hotkey);void bridge.request('set-active',{active:active()}).catch(()=>{});});
    hotkey=(await storage.settings().catch(()=>null))?.hotkey ?? hotkey;
    nativeRecovery.restart();
    await createWindows(); configureNativeWindow(); makeTray();
    if(installed){
      const saved=await storage.settings();
      app.setLoginItemSettings({openAtLogin:saved.startAtLogin,path:process.execPath,args:['--hidden']});
      setTimeout(()=>void updates.check(true),15000).unref();
      setInterval(()=>void updates.check(true),6*60*60*1000).unref();
    }
    if(smoke)await smokeTest();
  }).catch(error=>{console.error(error);quitting=true;app.exit(1);});
}
