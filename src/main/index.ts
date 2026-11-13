import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { detectMimeType } from 'nodemailer/lib/mime-funcs'
import type { Api, ApiMethod, IpcResult } from '@shared/api'
import type { Account, MessageBody, MessageSummary, Outgoing, OutgoingAttachment } from '@shared/types'
import { compile } from './compose'
import { connectorFor } from './connectors'
import type { AttachmentData } from './connectors/types'
import * as db from './db'
import { signIn } from './oauth'
import * as store from './store'
import * as sync from './sync'
import * as calendar from './calendar'
import { detectProvider } from './signin'
import { captureMode, runCapture, useProfileOverride } from './devcapture'

useProfileOverride()

/**
 * Where Letterwing keeps passwords and sign-in tokens. Electron picks a keyring from the desktop name
 * (KDE -> KWallet, GNOME -> GNOME Keyring) and finds none under Hyprland, Sway and other compositors.
 * Always use the freedesktop Secret Service instead: KWallet and GNOME Keyring both provide it, so the
 * same saved tokens work whichever desktop session you log into. LETTERWING_PASSWORD_STORE overrides.
 */
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store'))
  app.commandLine.appendSwitch('password-store', process.env.LETTERWING_PASSWORD_STORE || 'gnome-libsecret')

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
    title: 'Letterwing',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' && existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: captureMode }
  })
  if (captureMode) win.webContents.once('did-finish-load', () => void runCapture(win!))
  else win.once('ready-to-show', () => win?.show())
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
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') win?.webContents.toggleDevTools()
    // Keys typed while focus is inside the sandboxed mail frame never reach the app's own document.
    // Forward them; the renderer only acts on these when the mail frame actually has focus.
    else send('key:forward', { key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta })
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
  // Push to the server; on failure the next sync restores the server's view
  await Promise.all(groupByFolder(keys).map((g) => sync.connector(account(g.accountId)).setFlags(g.folderId, g.remoteIds, flags)))
}

function groupByFolder(keys: string[]): { accountId: string; folderId: string; keys: string[]; remoteIds: string[] }[] {
  const groups = new Map<string, { accountId: string; folderId: string; keys: string[]; remoteIds: string[] }>()
  for (const k of keys) {
    const m = db.getMessage(k)
    if (!m) continue
    const id = `${m.accountId}\u0000${m.folderId}`
    const g = groups.get(id) ?? { accountId: m.accountId, folderId: m.folderId, keys: [], remoteIds: [] }
    g.keys.push(k)
    g.remoteIds.push(m.remoteId)
    groups.set(id, g)
  }
  return [...groups.values()]
}

/**
 * Move or delete: take the messages out of the list immediately, then tell the server.
 * If the server refuses, put them back and report the error.
 */
async function relocate(keys: string[], target: (accountId: string, fromFolderId: string) => string | null): Promise<void> {
  const groups = groupByFolder(keys)
  for (const g of groups) {
    const acc = account(g.accountId)
    const dest = target(g.accountId, g.folderId)
    if (dest === g.folderId) continue
    const removed = db.removeLocal(g.keys)
    send('mail:changed', {})
    try {
      const c = sync.connector(acc)
      if (dest === null) await c.remove(g.folderId, g.remoteIds)
      else await c.move(g.folderId, g.remoteIds, dest)
    } catch (e) {
      db.restoreLocal(removed)
      send('mail:changed', {})
      throw e
    }
    // Show it in the destination if that folder is synced
    if (dest && db.getFolderState(acc.id, dest) !== null) void sync.syncAccount(acc, dest)
  }
}

let tempRoot: string | null = null
async function tempFile(filename: string, content: Buffer): Promise<string> {
  tempRoot ??= await mkdtemp(join(app.getPath('temp'), 'letterwing-'))
  const dir = await mkdtemp(join(tempRoot, 'a-'))
  const path = join(dir, safeName(filename))
  await writeFile(path, content, { mode: 0o600 })
  return path
}

const safeName = (name: string): string => basename(name).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'attachment'

async function fetchAttachment(key: string, attachmentId: string): Promise<AttachmentData> {
  const m = db.getMessage(key)
  if (!m) throw new Error('That message is no longer here')
  return sync.connector(account(m.accountId)).fetchAttachment(m.folderId, m.remoteId, attachmentId)
}

async function fromPath(path: string): Promise<OutgoingAttachment> {
  const st = await stat(path)
  if (!st.isFile()) throw new Error(`${basename(path)} is not a file`)
  return { id: randomUUID(), filename: basename(path), contentType: detectMimeType(path) || 'application/octet-stream', size: st.size, source: { kind: 'file', path } }
}

/**
 * Attachments taken from another message (forwards, reopened drafts) are copied to temp files
 * first, so the draft keeps working after the original moves or the old draft copy is replaced.
 */
async function materialise(out: Outgoing): Promise<Outgoing> {
  const attachments = await Promise.all(
    out.attachments.map(async (a): Promise<OutgoingAttachment> => {
      if (a.source.kind === 'file') return a
      const data = await fetchAttachment(a.source.key, a.source.attachmentId)
      return { ...a, size: data.content.length, source: { kind: 'file', path: await tempFile(a.filename, data.content) } }
    })
  )
  return { ...out, attachments }
}

async function compiled(out: Outgoing, forDraft: boolean) {
  const acc = account(out.accountId)
  return {
    acc,
    msg: await compile(
      acc,
      out,
      async (a) => {
        if (a.source.kind !== 'file') throw new Error('Attachment was not prepared')
        return { filename: a.filename, contentType: a.contentType, content: await readFile(a.source.path) }
      },
      { forDraft }
    )
  }
}

async function dropServerDraft(out: Outgoing): Promise<void> {
  const d = out.serverDraft
  if (!d) return
  await sync.connector(account(out.accountId)).remove(d.folderId, [d.remoteId]).catch(() => {})
  db.removeLocal([db.messageKey(out.accountId, d.folderId, d.remoteId)])
  send('mail:changed', {})
}

const api: Api = {
  async getSettings() {
    return store.getSettings()
  },
  async saveSettings(patch) {
    const s = store.saveSettings(patch)
    if (patch.syncInterval) sync.schedule(s.syncInterval)
    if (patch.icsSubscriptions) void calendar.syncAll()
    return s
  },
  async openExternal(url) {
    if (/^(https?|mailto):/.test(url)) await shell.openExternal(url)
  },

  detectProvider: (email) => detectProvider(email),
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
    void sync.syncAccount(acc).then(() => calendar.syncAll())
    return acc
  },
  async updateAccount(id, patch) {
    const next = { ...account(id), ...patch, id }
    store.saveAccounts(store.getAccounts().map((a) => (a.id === id ? next : a)))
    // Only connection details need a new connector; a signature or colour change doesn't
    if (['imap', 'smtp', 'username', 'email', 'tenant', 'clientId', 'caldavUrl'].some((k) => k in patch)) {
      await sync.dropConnector(id)
      calendar.forget(id)
      if ('caldavUrl' in patch) void calendar.syncAll()
    }
    return next
  },
  async removeAccount(id) {
    await sync.dropConnector(id)
    calendar.forget(id)
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
    return db.listMessages(accountId, folderId, limit, before, store.getSettings().conversations)
  },
  async loadOlder(accountId, folderId) {
    return sync.loadOlder(account(accountId), folderId)
  },
  async getThread(key) {
    return db.thread(key)
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
  async moveMessages(keys, toFolderId) {
    await relocate(keys, () => toFolderId)
  },
  async deleteMessages(keys) {
    await relocate(keys, (accountId, from) => {
      const trash = db.folderByRole(accountId, 'trash')
      return !trash || trash.id === from ? null : trash.id
    })
  },
  async archiveMessages(keys) {
    await relocate(keys, (accountId) => {
      const archive = db.folderByRole(accountId, 'archive')
      if (!archive) throw new Error(`${account(accountId).name} has no Archive folder.`)
      return archive.id
    })
  },
  async openAttachment(key, attachmentId) {
    const a = await fetchAttachment(key, attachmentId)
    const err = await shell.openPath(await tempFile(a.filename, a.content))
    if (err) throw new Error(err)
  },
  async saveAttachment(key, attachmentId) {
    const a = await fetchAttachment(key, attachmentId)
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), safeName(a.filename)) })
    if (r.canceled || !r.filePath) return false
    await writeFile(r.filePath, a.content)
    return true
  },
  async syncStatus() {
    return sync.statuses()
  },
  async syncNow(accountId) {
    if (accountId) await sync.syncAccount(account(accountId))
    else await sync.syncAll()
    void calendar.syncAll()
  },

  async suggestContacts(prefix) {
    return db.suggestContacts(prefix, 8)
  },
  async pickFiles() {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], title: 'Attach files' })
    return r.canceled ? [] : Promise.all(r.filePaths.map(fromPath))
  },
  async attachPaths(paths) {
    return Promise.all(paths.map(fromPath))
  },
  async saveDraft(message) {
    const out = await materialise(message)
    const { acc, msg } = await compiled(out, true)
    const drafts = db.folderByRole(acc.id, 'drafts')
    const serverDraft = await sync.connector(acc).saveDraft(msg, drafts?.id ?? null, out.serverDraft ?? null)
    if (out.serverDraft) db.removeLocal([db.messageKey(acc.id, out.serverDraft.folderId, out.serverDraft.remoteId)])
    if (drafts) void sync.syncAccount(acc, drafts.id)
    return { ...out, serverDraft }
  },
  async sendMessage(message) {
    const out = await materialise(message)
    const { acc, msg } = await compiled(out, false)
    await sync.connector(acc).send(msg, db.folderByRole(acc.id, 'sent')?.id ?? null)
    db.addContacts([...out.to, ...out.cc, ...out.bcc])
    await dropServerDraft(out)
    const sent = db.folderByRole(acc.id, 'sent')
    if (sent) setTimeout(() => void sync.syncAccount(acc, sent.id), 2000)
  },
  async discardDraft(message) {
    await dropServerDraft(message)
  },
  async listCalendars() {
    return calendar.listCalendars()
  },
  listEvents: (from, to) => calendar.listEvents(from, to),
  saveEvent: (input) => calendar.saveEvent(input),
  deleteEvent: (key) => calendar.deleteEvent(key),
  respondToEvent: (key, answer, comment) => calendar.respond(key, answer, comment),
  async respondToInvite(messageKey, answer, comment) {
    await calendar.respondToInvite(messageKey, answer, comment)
    // Like Classic: an answered invitation leaves the inbox
    await api.deleteMessages([messageKey]).catch(() => {})
  },
  syncCalendars: () => calendar.syncAll(),
  async openDraft(key) {
    const m = db.getMessage(key)
    if (!m) throw new Error('Draft not found')
    const body = await api.getBody(key)
    const refs = body.references
    return {
      accountId: m.accountId,
      to: m.to,
      cc: body.cc,
      bcc: [],
      subject: m.subject === '(no subject)' ? '' : m.subject,
      html: body.html ?? `<p>${(body.text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/\n/g, '<br>')}</p>`,
      attachments: body.attachments
        .filter((a) => !a.inline)
        .map((a) => ({ id: randomUUID(), filename: a.filename, contentType: a.contentType, size: a.size, source: { kind: 'message' as const, key, attachmentId: a.id } })),
      inReplyTo: refs.length ? { key: '', messageId: refs[refs.length - 1], references: refs.slice(0, -1) } : undefined,
      serverDraft: { folderId: m.folderId, remoteId: m.remoteId }
    }
  }
}

function notifyNewMail(acc: Account, messages: MessageSummary[]): void {
  if (!store.getSettings().notifications || !Notification.isSupported()) return
  const newest = messages.sort((a, b) => b.date - a.date)[0]
  const n = new Notification({
    title: messages.length === 1 ? `${newest.from?.name || newest.from?.address || 'New mail'}` : `${messages.length} new messages · ${acc.name}`,
    body: messages.length === 1 ? newest.subject : messages.slice(0, 3).map((m) => `${m.from?.name || m.from?.address}: ${m.subject}`).join('\n'),
    silent: false
  })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('open:message', { key: newest.key })
  })
  n.show()
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
  // Electron's default menu owns Ctrl+R (reload), Ctrl+Q (quit on Linux), Ctrl+W and others, which would
  // swallow Classic shortcuts such as Ctrl+Q "mark as read". All shortcuts go through the user's keymap instead.
  // (macOS needs a menu for copy/paste, so it keeps one there.)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  db.openDb()
  sync.init(send, notifyNewMail)
  createWindow()
  calendar.init(send, () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  sync.schedule(store.getSettings().syncInterval)
  // Calendars refresh with the mail, after it so the inbox comes first
  sync.onCycle(() => void calendar.syncAll())
  void sync.syncAll().then(() => calendar.syncAll())
})

app.on('window-all-closed', () => app.quit())
// Opened and forwarded attachments live in temp files only while Letterwing runs
app.on('will-quit', () => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})
