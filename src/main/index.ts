import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, shell, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { detectMimeType } from 'nodemailer/lib/mime-funcs'
import type { Api, ApiMethod, IpcResult, MenuItem } from '@shared/api'
import { prefKey, type Account, type MessageBody, type MessageSummary, type Outgoing, type OutgoingAttachment } from '@shared/types'
import { compile } from './compose'
import { connectorFor } from './connectors'
import type { AttachmentData } from './connectors/types'
import * as db from './db'
import { signIn } from './oauth'
import * as store from './store'
import * as sync from './sync'
import * as calendar from './calendar'
import * as pace from './pace'
import { mailtoFromArgs, parseMailto, type MailtoRequest } from './mailto'
import { detectProvider } from './signin'
import { createTray, hasTray, iconPath, setTrayUnread } from './tray'
import { checkForUpdates, getUpdateStatus, initUpdater, installUpdate, openReleasePage, showUpdateFile } from './updater'
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
/** True once the user really quits (tray menu, Cmd+Q), so closing the window can hide it instead */
let quitting = false

/** Light or dark everywhere: the page (via prefers-color-scheme), native menus and dialogs */
function applyTheme(): void {
  nativeTheme.themeSource = store.getSettings().theme
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#ffffff')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    // Small on purpose: tiling window managers size windows freely, and the layout adapts down to phone-like widths
    minWidth: 360,
    minHeight: 400,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#ffffff',
    title: 'Letterwing',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' && iconPath(256) ? { icon: iconPath(256) } : {}),
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
  // Text, links and spelling. Fires only where the app didn't show its own menu (it cancels the event when it does),
  // so this covers text boxes, the message editor and the inside of emails.
  win.webContents.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = []
    const wc = win!.webContents
    if (p.isEditable && p.misspelledWord) {
      for (const w of p.dictionarySuggestions.slice(0, 5)) items.push({ label: w, click: () => wc.replaceMisspelling(w) })
      if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false })
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' })
    }
    const link = /^(https?|mailto):/i.test(p.linkURL) ? p.linkURL : ''
    if (link.toLowerCase().startsWith('mailto:')) {
      const address = decodeURIComponent(link.slice(7).split('?')[0])
      items.push({ label: 'Copy email address', click: () => clipboard.writeText(address) }, { type: 'separator' })
    } else if (link) {
      items.push(
        { label: 'Open link in browser', click: () => void shell.openExternal(link) },
        { label: 'Copy link address', click: () => clipboard.writeText(link) },
        { type: 'separator' }
      )
    }
    if (p.isEditable) {
      const f = p.editFlags
      items.push(
        { label: 'Undo', role: 'undo', enabled: f.canUndo },
        { label: 'Redo', role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: f.canCut },
        { label: 'Copy', role: 'copy', enabled: f.canCopy },
        { label: 'Paste', role: 'paste', enabled: f.canPaste },
        { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste },
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll' }
      )
    } else if (p.selectionText.trim()) {
      const text = p.selectionText
      items.push({ label: 'Copy', click: () => clipboard.writeText(text) })
    }
    if (p.mediaType === 'image' && !link) items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) })
    while (items.length && items[items.length - 1].type === 'separator') items.pop()
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win! })
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') win?.webContents.toggleDevTools()
    // Keys typed while focus is inside the sandboxed mail frame never reach the app's own document.
    // Forward them; the renderer only acts on these when the mail frame actually has focus.
    else send('key:forward', { key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta })
  })
  // With "keep running in the tray" on, closing the window (including Hyprland's Super+Q) only hides it
  win.on('close', (e) => {
    if (!quitting && store.getSettings().closeToTray && hasTray()) {
      e.preventDefault()
      win?.hide()
    }
  })
  // New-mail checks run faster while the window is on screen (see pace.ts), and at once when it comes back
  win.on('show', () => pace.setVisible(true))
  win.on('restore', () => pace.setVisible(true))
  win.on('hide', () => pace.setVisible(false))
  win.on('minimize', () => pace.setVisible(false))
  win.on('focus', () => pace.wake())
  win.webContents.on('did-start-loading', () => (rendererReady = false))
  win.on('closed', () => {
    rendererReady = false
    win = null
    pace.setVisible(false)
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Bring the window back from the tray, minimised or closed */
function showWindow(): void {
  if (!win) createWindow()
  if (win!.isMinimized()) win!.restore()
  win!.show()
  win!.focus()
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

/** Our keybinding text ("Ctrl+Shift+R") as an Electron accelerator, when it is one. Sequences ("G I") can't be shown. */
function accelerator(binding: string | undefined): string | undefined {
  if (!binding || /\s/.test(binding)) return undefined
  const parts = binding.split('+')
  if (binding.endsWith('++')) parts.splice(-2, 2, 'Plus')
  const key = parts[parts.length - 1]
  const named = /^(F([1-9]|1\d|2[0-4])|Enter|Delete|Insert|Backspace|Escape|Up|Down|Left|Right|Home|End|PageUp|PageDown|Tab|Space|Plus)$/
  if (!(key.length === 1 && /[A-Z0-9,./;'[\]\\=`#*!@$%^&()_~-]/.test(key)) && !named.test(key)) return undefined
  return parts.map((p) => (p === 'Meta' ? 'Super' : p)).join('+')
}

/** Right-click menus are native, so they sit above the mail frame, never run off-screen and follow the OS look */
function showMenu(items: MenuItem[], at?: { x: number; y: number }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (id: string | null) => {
      if (done) return
      done = true
      resolve(id)
    }
    const build = (list: MenuItem[]): MenuItemConstructorOptions[] =>
      list.map((m) =>
        m.type === 'separator'
          ? { type: 'separator' }
          : {
              label: m.label ?? '',
              enabled: m.enabled !== false,
              ...(m.checked !== undefined ? { type: 'checkbox' as const, checked: m.checked } : {}),
              ...(accelerator(m.shortcut) ? { accelerator: accelerator(m.shortcut), registerAccelerator: false } : {}),
              ...(m.submenu ? { submenu: build(m.submenu) } : { click: () => finish(m.id ?? null) })
            }
      )
    // Drop leading, trailing and doubled separators left by items that didn't apply
    const tidy = (list: MenuItem[]): MenuItem[] =>
      list
        .map((m) => (m.submenu ? { ...m, submenu: tidy(m.submenu) } : m))
        .filter((m, i, a) => m.type !== 'separator' || (i > 0 && i < a.length - 1 && a[i - 1].type !== 'separator'))
    const template = build(tidy(items))
    if (!win || !template.length) return finish(null)
    // On some platforms the close callback runs before the click handler; give the click a moment to land
    Menu.buildFromTemplate(template).popup({ window: win, ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}), callback: () => setTimeout(() => finish(null), 150) })
  })
}

/** Re-read an account's folder list after creating, renaming or deleting a folder */
async function refreshFolders(acc: Account): Promise<void> {
  db.saveFolders(acc.id, await sync.connector(acc).listFolders())
  send('mail:changed', { accountId: acc.id })
}

/**
 * Favourites and colours follow a folder when it changes ID (IMAP renames change the path, and the paths of its
 * subfolders), and go when it's deleted. `rename` maps an old folder ID to its new one.
 */
function movePrefs(accountId: string, rename: (folderId: string) => string | null): void {
  const prefs = store.getSettings().folderPrefs
  const prefix = prefKey(accountId, '')
  let changed = false
  const next: typeof prefs = {}
  for (const [k, v] of Object.entries(prefs)) {
    if (!k.startsWith(prefix)) {
      next[k] = v
      continue
    }
    const to = rename(k.slice(prefix.length))
    if (to !== k.slice(prefix.length)) changed = true
    if (to !== null) next[prefKey(accountId, to)] = v
  }
  if (changed) store.saveSettings({ folderPrefs: next })
}

function editableFolder(accountId: string, folderId: string) {
  const f = db.getFolder(accountId, folderId)
  if (!f) throw new Error('That folder no longer exists.')
  if (f.role !== 'other') throw new Error(`${f.name} is a special folder and can't be renamed or deleted.`)
  return f
}

const api: Api = {
  async getSettings() {
    return store.getSettings()
  },
  async saveSettings(patch) {
    const s = store.saveSettings(patch)
    if (patch.theme) applyTheme()
    if (patch.syncInterval) sync.schedule(s.syncInterval)
    if (patch.icsSubscriptions) void calendar.syncAll()
    return s
  },
  async openExternal(url) {
    if (/^(https?|mailto):/.test(url)) await shell.openExternal(url)
  },
  showMenu: (items, at) => showMenu(items, at),
  async confirm({ message, detail, ok }) {
    if (!win) return false
    const r = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })
    return r.response === 0
  },
  async choose({ message, detail, options }) {
    if (!win) return -1
    const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: [...options, 'Cancel'], defaultId: 0, cancelId: options.length, noLink: true })
    return r.response >= options.length ? -1 : r.response
  },
  async takePendingMailto() {
    rendererReady = true
    return pendingMailto.splice(0)
  },
  async mailAppStatus() {
    // A development build runs inside Electron itself, which can't sensibly become the mail app
    return { isDefault: app.isDefaultProtocolClient('mailto'), canSet: app.isPackaged }
  },
  async setDefaultMailApp() {
    return app.setAsDefaultProtocolClient('mailto') && app.isDefaultProtocolClient('mailto')
  },
  async copyText(text) {
    clipboard.writeText(text)
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
    movePrefs(id, () => null)
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
  async junkMessages(keys) {
    await relocate(keys, (accountId, from) => {
      const junk = db.folderByRole(accountId, 'junk')
      if (!junk) throw new Error(`${account(accountId).name} has no Junk folder.`)
      return junk.id === from ? from : junk.id
    })
  },
  async markFolderRead(accountId, folderId) {
    const targets =
      folderId === '*inbox'
        ? store.getAccounts().flatMap((a) => {
            const inbox = db.folderByRole(a.id, 'inbox')
            return inbox ? [[a.id, inbox.id] as const] : []
          })
        : [[accountId!, folderId] as const]
    const errors: string[] = []
    await Promise.all(
      targets.map(async ([a, f]) => {
        // Show it straight away; put it back if the server says no
        const was = db.markFolderReadLocal(a, f)
        send('mail:changed', {})
        try {
          await sync.connector(account(a)).markFolderRead(f)
        } catch (e) {
          db.undoMarkFolderRead(a, f, was)
          send('mail:changed', {})
          errors.push(`${account(a).name}: ${(e as Error).message}`)
        }
      })
    )
    if (errors.length) throw new Error(errors.join(' · '))
  },
  async emptyFolder(accountId, folderId) {
    const acc = account(accountId)
    await sync.connector(acc).emptyFolder(folderId)
    db.clearFolder(accountId, folderId)
    send('mail:changed', { accountId })
  },
  async createFolder(accountId, parentId, name) {
    const acc = account(accountId)
    await sync.connector(acc).createFolder(parentId, name)
    await refreshFolders(acc)
  },
  async renameFolder(accountId, folderId, name) {
    const before = editableFolder(accountId, folderId)
    const acc = account(accountId)
    await sync.connector(acc).renameFolder(folderId, name)
    await refreshFolders(acc)
    // Graph keeps the ID; on IMAP the folder (and everything under it) has a new path
    const after = db.listFolders(accountId).find((f) => f.parentId === before.parentId && f.name === name.trim())
    if (after && after.id !== folderId) {
      // The hierarchy separator, read off a subfolder's new path ("Projects/Acme" -> "/")
      const child = db.listFolders(accountId).find((f) => f.parentId === after.id)
      const sep = child ? child.id.charAt(after.id.length) : null
      movePrefs(accountId, (id) => (id === folderId ? after.id : sep && id.startsWith(folderId + sep) ? after.id + id.slice(folderId.length) : id))
    }
  },
  async deleteFolder(accountId, folderId) {
    editableFolder(accountId, folderId)
    const acc = account(accountId)
    await sync.connector(acc).deleteFolder(folderId)
    await refreshFolders(acc)
    const still = new Set(db.listFolders(accountId).map((f) => f.id))
    movePrefs(accountId, (id) => (still.has(id) ? id : null))
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
  getUpdateStatus: async () => getUpdateStatus(),
  checkForUpdates: () => checkForUpdates(),
  installUpdate: () => installUpdate(),
  showUpdateFile: async () => showUpdateFile(),
  openReleasePage: async () => openReleasePage(),
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
  deleteEvent: (key, scope) => calendar.deleteEvent(key, scope),
  respondToEvent: (key, answer, comment) => calendar.respond(key, answer, comment),
  async respondToInvite(messageKey, answer, comment) {
    await calendar.respondToInvite(messageKey, answer, comment)
    // An answered invitation leaves the inbox
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
    showWindow()
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

/**
 * Mail links (mailto:). Windows and Linux start the app with the link as an argument (a second copy hands
 * it to this one); macOS sends open-url. Links that arrive before the window has loaded wait here.
 */
const pendingMailto: MailtoRequest[] = []
let rendererReady = false
function openMailto(url: string | null): void {
  const req = url ? parseMailto(url) : null
  if (!req) return
  showWindow()
  if (rendererReady) send('compose:mailto', req)
  else pendingMailto.push(req)
}
// Launching Letterwing again (menu, dock, desktop file, a mail link) brings back the running copy
app.on('second-instance', (_e, argv) => {
  showWindow()
  openMailto(mailtoFromArgs(argv))
})
app.on('open-url', (e, url) => {
  e.preventDefault()
  if (app.isReady()) openMailto(url)
  else pendingMailto.push(...[parseMailto(url)].filter((r) => r !== null))
})
{
  const first = parseMailto(mailtoFromArgs(process.argv) ?? '')
  if (first) pendingMailto.push(first)
}

app.whenReady().then(() => {
  applyTheme()
  // After sleep or a locked screen, look for mail straight away
  powerMonitor.on('resume', () => pace.wake())
  powerMonitor.on('unlock-screen', () => pace.wake())
  // Electron's default menu owns Ctrl+R (reload), Ctrl+Q (quit on Linux), Ctrl+W and others, which would
  // swallow mail shortcuts such as Ctrl+Q "mark as read". All shortcuts go through the user's keymap instead.
  // (macOS needs a menu for copy/paste, so it keeps one there.)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  db.openDb()
  sync.init(send, notifyNewMail)
  createWindow()
  calendar.init(send, showWindow)
  if (!captureMode)
    createTray({
      show: showWindow,
      newMessage: () => {
        showWindow()
        send('compose:new', {})
      },
      sync: () => void api.syncNow(),
      quit: () => {
        quitting = true
        app.quit()
      }
    })
  // Tray tooltip shows unread inbox mail across accounts
  const unread = () =>
    setTrayUnread(store.getAccounts().reduce((n, a) => n + (db.folderByRole(a.id, 'inbox')?.unread ?? 0), 0))
  unread()
  setInterval(unread, 30_000)
  initUpdater((s) => send('update:status', s), () => store.getSettings().autoUpdate)
  sync.schedule(store.getSettings().syncInterval)
  // Calendars refresh with the mail, after it so the inbox comes first
  sync.onCycle(() => void calendar.syncAll())
  void sync.syncAll().then(() => calendar.syncAll())
})

app.on('before-quit', () => (quitting = true))
// macOS: clicking the Dock icon reopens the window
app.on('activate', () => showWindow())
// Without a tray there's no way back to a hidden app, so then closing the last window quits
app.on('window-all-closed', () => {
  if (!hasTray() || !store.getSettings().closeToTray) app.quit()
})
// Opened and forwarded attachments live in temp files only while Letterwing runs
app.on('will-quit', () => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})
