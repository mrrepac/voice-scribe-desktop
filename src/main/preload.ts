import { contextBridge, ipcRenderer } from 'electron';
import type { ScribeAPI, Command } from '../shared/contracts';
const api: ScribeAPI = {
  getUpdateState:()=>ipcRenderer.invoke('updates:state'),
  checkForUpdates:()=>ipcRenderer.invoke('updates:check'),
  downloadUpdate:()=>ipcRenderer.invoke('updates:download'),
  installUpdate:()=>ipcRenderer.invoke('updates:install'),
  onUpdateState:handler=>{const fn=(_:unknown,value:import('../shared/updates').UpdateState)=>handler(value);ipcRenderer.on('updates:state',fn);return()=>ipcRenderer.removeListener('updates:state',fn);},
  getSettings:()=>ipcRenderer.invoke('settings:get'),
  saveSettings:s=>ipcRenderer.invoke('settings:save',s),
  deliver:(text,target,enter)=>ipcRenderer.invoke('deliver',text,target,enter),
  copy:text=>ipcRenderer.invoke('copy',text),
  prepareGigaam:()=>ipcRenderer.invoke('gigaam:prepare'),
  recognizeGigaam:(pcm,timed)=>ipcRenderer.invoke('gigaam:recognize',pcm,timed),
  cancelGigaam:()=>ipcRenderer.invoke('gigaam:cancel'),
  onGigaamProgress:handler=>{const fn=(_:unknown,value:import('../shared/gigaam').GigaamProgress)=>handler(value);ipcRenderer.on('gigaam:progress',fn);return()=>ipcRenderer.removeListener('gigaam:progress',fn);},
  status:value=>ipcRenderer.send('status',value),
  hide:()=>ipcRenderer.send('hide'),
  onCommand:handler=>{const fn=(_:unknown,cmd:Command)=>handler(cmd);ipcRenderer.on('command',fn);return()=>ipcRenderer.removeListener('command',fn);},
  getAppInfo:()=>ipcRenderer.invoke('app:info'),
  captureHotkey:()=>ipcRenderer.invoke('hotkey:capture'),
  cancelHotkeyCapture:()=>ipcRenderer.invoke('hotkey:cancel-capture'),
  getNativeHealth:()=>ipcRenderer.invoke('native:health'),
  restartNative:()=>ipcRenderer.invoke('native:restart'),
  onNativeHealth:handler=>{const fn=(_:unknown,state:import('./native-recovery').NativeHealth)=>handler(state);ipcRenderer.on('native:health',fn);return()=>ipcRenderer.removeListener('native:health',fn);},
};
contextBridge.exposeInMainWorld('scribe',api);
