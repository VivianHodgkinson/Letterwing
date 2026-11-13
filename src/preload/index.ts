import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ApiMethod, EventChannel, IpcResult } from '@shared/api'

const bridge = {
  invoke: (method: ApiMethod, args: unknown[]): Promise<IpcResult<unknown>> => ipcRenderer.invoke('api', method, args),
  on: (channel: EventChannel, cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  /** Path of a file dropped onto the window, for attaching it */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: process.platform
}

contextBridge.exposeInMainWorld('bridge', bridge)
