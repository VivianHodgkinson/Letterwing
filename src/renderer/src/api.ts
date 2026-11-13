import type { Api, EventChannel } from '@shared/api'

/** Typed proxy over the single IPC channel: api.listFolders(id) etc. Errors come back as thrown Errors. */
export const api = new Proxy({} as Api, {
  get:
    (_t, method: string) =>
    async (...args: unknown[]) => {
      const r = await window.bridge.invoke(method as keyof Api, args)
      if (!r.ok) throw new Error(r.error)
      return r.value
    }
})

export const on = (channel: EventChannel, cb: (payload: unknown) => void): (() => void) => window.bridge.on(channel, cb)
