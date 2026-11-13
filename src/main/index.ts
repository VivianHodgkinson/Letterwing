import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Api, ApiMethod, IpcResult } from '@shared/api'
import type { Account, MessageBody } from '@shared/types'
import { connectorFor } from './connectors'
import * as db from './db'
import { signIn } from './oauth'
import * as store from './store'
import * as sync from './sync'

let win: BrowserWindow | null = null
const devIcon = join(__dirname, '../../resources/icon.png')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#ffffff',
    title: 'Inkwell',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' && existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.once('ready-to-show', () => win?.show())
  // Links in mail open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^(https?|mailto):/.test(url)) shell.openExternal(url)
    }
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })
  win.on('closed', () => (win = null))
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function account(id: string): Account {
  const a = store.getAccounts().find((x) => x.id === id)
  if (!a) throw new Error('Account not found')
  return a
}

async function withFlags(keys: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void> {
  db.setLocalFlags(keys, flags)
  send('mail:changed', {})
  // Group by account + folder and push to the server; on failure the next sync restores the server's view
  const groups = new Map<string, { accountId: string; folderId: string; ids: string[] }>()
  for (const k of keys) {
    const m = db.getMessage(k)
    if (!m) continue
    const g = groups.get(m.accountId + m.folderId) ?? { accountId: m.accountId, folderId: m.folderId, ids: [] }
    g.ids.push(m.remoteId)
    groups.set(m.accountId + m.folderId, g)
  }
  await Promise.all([...groups.values()].map((g) => sync.connector(account(g.accountId)).setFlags(g.folderId, g.ids, flags)))
}

const api: Api = {
  async getSettings() {
    return store.getSettings()
  },
  async saveSettings(patch) {
    const s = store.saveSettings(patch)
    if (patch.syncInterval) sync.schedule(s.syncInterval)
    return s
  },
  async openExternal(url) {
    if (/^(https?|mailto):/.test(url)) await shell.openExternal(url)
  },

  async listAccounts() {
    return store.getAccounts()
  },
  async addAccount(input) {
    const { password, ...rest } = input
    const acc: Account = { ...rest, id: randomUUID() }
    if (acc.auth === 'oauth') store.setSecret(acc.id, JSON.stringify(await signIn(acc)))
    else store.setSecret(acc.id, password ?? '')
    // Prove it works before saving, so a typo doesn't leave a broken account behind
    const c = connectorFor(acc)
    try {
      await c.verify()
    } catch (e) {
      store.setSecret(acc.id, null)
      throw e
    } finally {
      await c.close()
    }
    store.saveAccounts([...store.getAccounts(), acc])
    void sync.syncAccount(acc)
    return acc
  },
  async updateAccount(id, patch) {
    const next = { ...account(id), ...patch, id }
    store.saveAccounts(store.getAccounts().map((a) => (a.id === id ? next : a)))
    await sync.dropConnector(id)
    return next
  },
  async removeAccount(id) {
    await sync.dropConnector(id)
    store.saveAccounts(store.getAccounts().filter((a) => a.id !== id))
    store.setSecret(id, null)
    db.removeAccountData(id)
  },

  async listFolders(accountId) {
    return db.listFolders(accountId)
  },
  async listMessages(accountId, folderId, limit, before) {
    // Opening a folder that isn't synced in the background: sync it now
    if (accountId && folderId !== '*inbox' && db.getFolderState(accountId, folderId) === null) void sync.syncAccount(account(accountId), folderId)
    return db.listMessages(accountId, folderId, limit, before)
  },
  async search(query, limit) {
    return db.search(query, limit)
  },
  async getBody(key) {
    const cached = db.getCachedBody(key)
    if (cached) return cached
    const m = db.getMessage(key)
    if (!m) throw new Error('Message not found')
    const body: MessageBody = { key, ...(await sync.connector(account(m.accountId)).fetchBody(m.folderId, m.remoteId)) }
    db.cacheBody(body)
    return body
  },
  setRead: (keys, read) => withFlags(keys, { read }),
  setFlagged: (keys, flagged) => withFlags(keys, { flagged }),
  async syncNow(accountId) {
    if (accountId) await sync.syncAccount(account(accountId))
    else await sync.syncAll()
  }
}

ipcMain.handle('api', async (_e, method: ApiMethod, args: unknown[]): Promise<IpcResult<unknown>> => {
  try {
    const fn = api[method] as (...a: unknown[]) => Promise<unknown>
    if (typeof fn !== 'function') throw new Error(`Unknown method ${method}`)
    return { ok: true, value: await fn(...args) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  db.openDb()
  sync.init(send)
  createWindow()
  sync.schedule(store.getSettings().syncInterval)
  void sync.syncAll()
})

app.on('window-all-closed', () => app.quit())
