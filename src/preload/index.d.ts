import type { ApiMethod, EventChannel, IpcResult } from '../shared/api'

declare global {
  interface Window {
    bridge: {
      invoke(method: ApiMethod, args: unknown[]): Promise<IpcResult<unknown>>
      on(channel: EventChannel, cb: (payload: unknown) => void): () => void
      platform: string
    }
  }
}

export {}
