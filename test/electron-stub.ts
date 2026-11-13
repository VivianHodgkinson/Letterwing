// Tests run under plain Node: the cache and compose code import electron (via store.ts) but never call it.
export const app = { getPath: () => { throw new Error('electron app is not available in tests') } }
export const safeStorage = {}
