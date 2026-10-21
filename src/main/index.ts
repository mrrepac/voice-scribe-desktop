import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, screen, session, Tray, type WebContents } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Storage } from './storage';
import { GigaamService } from './gigaam';
import { NativeBridge } from './native';
import type { Command, Status } from '../shared/contracts';
import { existsSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { UpdateService } from './updates';
import { NativeRecovery } from './native-recovery';
import { hotkeyLabel, type CapturedKey, type Hotkey } from '../shared/hotkeys';
import { Log } from './log';
import { migrateFromOlderApps } from './migration';
import MODEL from '../shared/gigaam-model.json';

// Smoke tests ship only with source checkouts; installed builds ignore the flags.
const smoke = !app.isPackaged && process.argv.includes('--smoke-test');
// A fake microphone plays the Russian fixture once (see tests/gigaam-fixture.ps1).
if(smoke && process.argv.includes('--dictation-test')){
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture',path.join(process.cwd(),'artifacts','fixture-ru.wav')+'%noloop');
}
const NAME='Voice Scribe';
const root = app.getAppPath();
if(smoke)app.setPath('userData',path.join(process.cwd(),'.data','smoke'));
else if (!app.isPackaged) app.setPath('userData',path.join(root,'.data'));
app.setName(NAME);
const log=new Log(path.join(app.getPath('userData'),'logs'));
log.captureConsole();
protocol.registerSchemesAsPrivileged([{scheme:'scribe',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let win:BrowserWindow;
let overlay:BrowserWindow;
let tray:Tray;
let quitting=false;
let deliveryQueue:Promise<unknown>=Promise.resolve();
let deliveryGeneration=0;
let lastStatus:Status={phase:'idle',message:'Готов к диктовке'};
let hotkey:Hotkey='ctrl-space';
let overlayShown=false;
const bridge=new NativeBridge();
const nativeRecovery=new NativeRecovery(bridge,app.isPackaged?path.join(process.resourcesPath,'native/VoiceScribe.Native.exe'):path.join(root,'native/bin/VoiceScribe.Native.exe'),state=>{
  if(win && !win.isDestroyed())win.webContents.send('native:health',state);
});
const storage=new Storage(app.getPath('userData'), message => {
  void dialog.showMessageBox({type:'warning',title:`Восстановление данных ${NAME}`,message});
});
// Installed builds carry GigaAM in resources; a source checkout downloads it on first use.
const downloadedModel=path.join(app.getPath('userData'),'models',MODEL.directory);
const bundledModel=path.join(process.resourcesPath,'models',MODEL.directory);
const modelBundled=app.isPackaged && MODEL.files.every(file=>existsSync(path.join(bundledModel,file.name)));
const gigaam=new GigaamService(path.join(root,'dist/gigaam-worker.cjs'),modelBundled?bundledModel:downloadedModel);
const trusted=(url:string)=>{try { const u=new URL(url); return u.protocol==='scribe:' && u.host==='app'; } catch { return false; }};
const send=(command:Command)=>{if(win && !win.isDestroyed())win.webContents.send('command',command);};
const textArg=(v:unknown)=>{if(typeof v!=='string' || v.length>2_000_000) throw new Error('Некорректный текст');return v;};
const active=()=>['starting','recording','transcribing','preparing','file'].includes(lastStatus.phase);
// The helper swallows bare Enter and Esc system-wide while this holds. Preparing the
// model is not a dictation: blocking those keys for a (possibly minutes-long) load would break typing.
const dictating=()=>['starting','recording','transcribing'].includes(lastStatus.phase);
let tooltip='';
function setTooltip(text:string):void {
  const value=text.slice(0,120);
  if(tray && value!==tooltip){tooltip=value;tray.setToolTip(value);}
}
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
function applyHotkey(value:Hotkey):void {
  hotkey=value;
  if(bridge.ready)void bridge.request('set-hotkey',{hotkey}).catch(error=>console.error('Hotkey change failed',error));
  if(lastStatus.phase==='idle')setTooltip(`${NAME} · ${hotkeyLabel(hotkey)}`);
  if(overlay && !overlay.isDestroyed())overlay.webContents.send('status',{...lastStatus,hotkey:hotkeyLabel(hotkey)});
}
let finishCapture:((key:CapturedKey|null)=>void)|null=null;
// The helper swallows and reports one key press; Esc alone cancels.
function captureHotkey():Promise<CapturedKey|null> {
  if(active())return Promise.reject(new Error('Дождитесь завершения записи или обработки'));
  finishCapture?.(null);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(null),15000);
    const finish=(key:CapturedKey|null)=>{
      if(finishCapture!==finish)return;
      finishCapture=null; clearTimeout(timer);
      if(!key)void bridge.request('cancel-capture').catch(()=>{});
      resolve(key && !(key.key===0x1b && !key.ctrl && !key.alt && !key.win && !key.shift)?key:null);
    };
    finishCapture=finish;
    bridge.request('capture-hotkey').catch(error=>{if(finishCapture===finish){finishCapture=null;clearTimeout(timer);reject(error);}});
  });
}
let sentEnterFinish:boolean|null=null;
// Bare Enter during a dictation finishes it and sends the text. It is intercepted only
// when it can still do something: a recording that has not finished yet, or a
// recognition whose text will be inserted into a window.
function syncEnterFinish(force=false):void {
  const value=!(lastStatus.phase==='transcribing' && !lastStatus.targeted);
  if(!bridge.ready || (!force && value===sentEnterFinish))return;
  sentEnterFinish=value;
  void bridge.request('set-enter-finish',{enabled:value}).catch(error=>{sentEnterFinish=null;console.error('Enter shortcut change failed',error);});
}
// Placed once per appearance: following the cursor on every status update made the pill jump between monitors.
function showOverlay():void {
  if(overlayShown && overlay.isVisible())return;
  overlayShown=true;
  const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  overlay.setPosition(Math.round(area.x+(area.width-430)/2),area.y+area.height-112);
  overlay.showInactive();
}
function makeTray():void {
  const icon=nativeImage.createFromPath(path.join(root,'dist/icon.png')).resize({width:24,height:24});
  tray=new Tray(icon); setTooltip(`${NAME} · ${hotkeyLabel(hotkey)}`); tray.on('double-click',show); refreshTray();
}
function refreshTray():void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    {label:`Открыть ${NAME}`,click:show},
    {label:['starting','recording'].includes(lastStatus.phase) ? 'Остановить диктовку' : 'Записать в буфер',enabled:!['transcribing','file'].includes(lastStatus.phase),click:()=>send({action:'toggle'})},
    {label:'Отменить',enabled:active(),click:()=>send({action:'cancel'})},
    {type:'separator'},
    {label:'Выход',click:()=>{quitting=true;app.quit();}},
  ]));
}
function handle(name:string,fn:(...args:any[])=>unknown):void {
  ipcMain.handle(name,(event,...args)=>{
    if(event.sender!==win.webContents || !trusted(event.senderFrame?.url||'')) throw new Error('Untrusted IPC');
    return fn(...args);
  });
}
async function appResponse(request:Request):Promise<Response> {
  const url=new URL(request.url);
  if(url.host!=='app')return new Response('Not found',{status:404});
  let relative:string;
  try{relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');}catch{return new Response('Bad path',{status:400});}
  const base=path.join(root,'dist'); const file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
  return net.fetch(pathToFileURL(file).href);
}
function setupIpc():void {
  handle('updates:state',()=>updates.state);
  handle('updates:check',()=>updates.check());
  handle('updates:download',()=>updates.download());
  handle('updates:install',()=>updates.install());
  handle('settings:get',()=>storage.settings());
  handle('settings:save',async value=>{
    const saved=await storage.saveSettings(value);
    if(saved.hotkey!==hotkey)applyHotkey(saved.hotkey);
    if(app.isPackaged && !smoke) app.setLoginItemSettings({openAtLogin:saved.startAtLogin,path:process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,args:['--hidden']});
    return saved;
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
    // The paste must not be sent before the clipboard actually holds the text.
    await clipboard.writeText(value);
    if(!targeted) return {status:'clipboard-only',reason:'no-target'};
    // Never paste into this application's own window.
    if(target===ownWindowId()) return {status:'clipboard-only',reason:'own-window'};
    // Failed insertion keeps the text in the clipboard for a manual Ctrl+V.
    try { return await bridge.request('insert',{target,enter:enter===true}); }
    catch(error) { return {status:'clipboard-only',reason:(error as Error).message}; }
    });
    deliveryQueue=run.catch(()=>{});
    return run;
  });
  const gigaamProgress=(value:import('../shared/gigaam').GigaamProgress)=>{if(!win.isDestroyed())win.webContents.send('gigaam:progress',value);};
  handle('gigaam:prepare',()=>gigaam.prepare(gigaamProgress));
  handle('gigaam:recognize',(pcm,timed)=>gigaam.recognize(pcm,timed===true,gigaamProgress));
  handle('gigaam:cancel',()=>gigaam.cancel());
  handle('app:info',()=>({version:app.getVersion(),dataPath:storage.root,nativeReady:bridge.ready,modelBundled}));
  handle('hotkey:capture',captureHotkey);
  handle('hotkey:cancel-capture',()=>finishCapture?.(null));
  handle('native:health',()=>nativeRecovery.state);
  handle('native:restart',()=>{if(active())throw new Error('Дождитесь завершения записи или обработки');nativeRecovery.restart();});
  ipcMain.on('hide',event=>{if(event.sender===win.webContents)win.hide();});
  ipcMain.on('status',(event,status:Status)=>{
    if(event.sender!==win.webContents || !status || !['idle','starting','recording','transcribing','preparing','file','error'].includes(status.phase))return;
    const changed=status.phase!==lastStatus.phase;
    if(changed && ['idle','error'].includes(status.phase)){
      deliveryGeneration++;
      if(bridge.ready)void bridge.request('cancel-insert').catch(()=>{});
    }
    lastStatus={phase:status.phase,message:String(status.message).slice(0,250),seconds:status.seconds,level:status.level,progress:status.progress,targeted:status.targeted===true};
    if(changed){refreshTray();if(bridge.ready)void bridge.request('set-active',{active:dictating()}).catch(()=>{});}
    syncEnterFinish();
    setTooltip(lastStatus.phase==='idle'?`${NAME} · ${hotkeyLabel(hotkey)}`:`${NAME} · ${lastStatus.message}`);
    // A file is transcribed in the window, without global keys: the pill would promise an Esc that does not work.
    if(!smoke && active() && lastStatus.phase!=='file' && !win.isFocused())showOverlay();
    else if(overlayShown){overlay?.hide();overlayShown=false;}
    if(overlay && !overlay.isDestroyed())overlay.webContents.send('status',{...lastStatus,hotkey:hotkeyLabel(hotkey)});
  });
}
// Renderer warnings and errors (microphone failures) go to the log too.
function logConsole(contents:WebContents,name:string):void {
  contents.on('console-message',({level,message,sourceId,lineNumber})=>{
    if(level==='warning' || level==='error')log.write(level==='error'?'ERROR':'WARN',`[${name}] ${message} (${sourceId}:${lineNumber})`);
  });
}
async function createWindows():Promise<void> {
  win=new BrowserWindow({width:560,height:540,minWidth:440,minHeight:420,show:false,title:NAME,backgroundColor:nativeTheme.shouldUseDarkColors?'#202020':'#f6f6f6',icon:path.join(root,'dist/icon.png'),autoHideMenuBar:true,webPreferences:{preload:path.join(root,'dist/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!trusted(url))event.preventDefault();});
  win.webContents.on('render-process-gone',(_event,details)=>{console.error('Renderer stopped',details);gigaam.cancel();deliveryGeneration++;if(bridge.ready){void bridge.request('cancel-insert').catch(()=>{});void bridge.request('set-active',{active:false}).catch(()=>{});}overlay?.hide();if(!quitting)dialog.showErrorBox(NAME,'Процесс распознавания остановился. Перезапустите приложение.');});
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
  log.write('INFO',`${NAME} ${app.getVersion()} · Electron ${process.versions.electron} · Windows ${os.release()} · ${app.isPackaged?(installed?'installed':'portable'):'development'}`);
  app.on('second-instance',()=>{if(win)show();});
  app.on('child-process-gone',(_event,details)=>{if(details.reason!=='clean-exit')console.error('Child process stopped',details);});
  app.on('before-quit',()=>{quitting=true;gigaam.cancel();nativeRecovery.stop();});
  app.on('window-all-closed',()=>{});
  void app.whenReady().then(async()=>{
    // Settings must be imported before they are first read below.
    if(modelBundled && !smoke)await migrateFromOlderApps(app.getPath('userData'),app.getPath('appData'),storage).catch(error=>console.error('Migration failed',error));
    protocol.handle('scribe',appResponse);
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===win?.webContents && permission==='media' && trusted(details.requestingUrl) && (!('mediaTypes' in details) || !details.mediaTypes || details.mediaTypes.every(t=>t==='audio'))));
    session.defaultSession.setPermissionCheckHandler((contents,permission,origin)=>contents===win?.webContents && permission==='media' && trusted(origin));
    // Smoke runs keep the renderer offline; GigaAM downloads in its own Node process.
    if(smoke)session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
    bridge.on('captured',event=>finishCapture?.({key:event.key,ctrl:event.ctrl,alt:event.alt,shift:event.shift,win:event.win}));
    bridge.on('hotkey',event=>{
      if(!win || win.isDestroyed())return;
      if(event.action==='dictation-down' && event.target===ownWindowId())event={...event,target:''};
      send(event as Command);
    });
    // A restarted helper starts with the default shortcut; reapply the saved one.
    bridge.on('ready',()=>{applyHotkey(hotkey);syncEnterFinish(true);void bridge.request('set-active',{active:dictating()}).catch(()=>{});});
    const initial=await storage.settings().catch(()=>null);
    hotkey=initial?.hotkey ?? hotkey;
    nativeRecovery.restart();
    await createWindows(); makeTray();
    if(installed){
      const saved=await storage.settings();
      app.setLoginItemSettings({openAtLogin:saved.startAtLogin,path:process.execPath,args:['--hidden']});
      setTimeout(()=>void updates.check(true),15000).unref();
      setInterval(()=>void updates.check(true),6*60*60*1000).unref();
    }
    if(smoke){
      try{await (require(path.join(root,'dist/smoke-main.cjs')) as typeof import('./smoke')).runSmoke({win,bridge});}
      finally{quitting=true;app.quit();}
    }
  }).catch(error=>{console.error(error);quitting=true;app.exit(1);});
}
