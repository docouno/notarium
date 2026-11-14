import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopCapabilities, Greeting } from '../bridge.js';
const bridge: DesktopBridge = {
  getCapabilities: () => ipcRenderer.invoke('desktop:capabilities') as Promise<DesktopCapabilities>,
  greet: (name) => ipcRenderer.invoke('desktop:greet', name) as Promise<Greeting>,
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(bridge));
