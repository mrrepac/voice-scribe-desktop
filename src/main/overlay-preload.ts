import { contextBridge,ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('overlay',{onStatus:(fn:(value:unknown)=>void)=>ipcRenderer.on('status',(_event,value)=>fn(value))});
