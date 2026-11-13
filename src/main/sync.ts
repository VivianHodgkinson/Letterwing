import type { Account, MessageSummary, SyncStatus } from '@shared/types'
import { connectorFor } from './connectors'
import type { MailConnector } from './connectors/types'
import * as db from './db'
import { getAccounts } from './store'

/** Messages pulled per folder on a first sync, and per "load older" step */
export const BATCH = 200
/** Folders synced on every pass; the rest sync when opened */
const ALWAYS = new Set(['inbox', 'sent', 'drafts'])

const connectors = new Map<string, MailConnector>()
const watchers = new Map<string, () => void>()
const running = new Map<string, Promise<void>>()

type Notify = (channel: 'sync:status' | 'mail:changed', payload: unknown) => void
let notify: Notify = () => {}
/** Called with messages that just arrived in an inbox (not on first sync) */
let onNewMail: (account: Account, messages: MessageSummary[]) => void = () => {}
let timer: NodeJS.Timeout | null = null

export function init(send: Notify, newMail: typeof onNewMail): void {
  notify = send
  onNewMail = newMail
}

export function connector(account: Account): MailConnector {
  let c = connectors.get(account.id)
  if (!c) connectors.set(account.id, (c = connectorFor(account)))
  return c
}

export async function dropConnector(accountId: string): Promise<void> {
  lastStatus.delete(accountId)
  watchers.get(accountId)?.()
  watchers.delete(accountId)
  await connectors.get(accountId)?.close()
  connectors.delete(accountId)
}

/** Last status per account, so a window that opens after startup's first sync still sees errors */
const lastStatus = new Map<string, SyncStatus>()

function status(s: Omit<SyncStatus, 'at'>): void {
  const full = { ...s, at: Date.now() }
  lastStatus.set(s.accountId, full)
  notify('sync:status', full)
}

export function statuses(): SyncStatus[] {
  return [...lastStatus.values()]
}

/** Start push (IMAP IDLE) or polling for an account's inbox, once its folders are known */
function ensureWatcher(account: Account): void {
  if (watchers.has(account.id)) return
  const inbox = db.folderByRole(account.id, 'inbox')
  if (!inbox) return
  let pending: NodeJS.Timeout | null = null
  const stop = connector(account).watch(inbox.id, () => {
    // Servers send several events per arrival; one sync covers them all
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => void syncAccount(account, inbox.id), 1500)
  })
  watchers.set(account.id, stop)
}

/** Sync one account (or one folder of it). Concurrent calls for the same target share the running sync. */
export function syncAccount(account: Account, onlyFolder?: string): Promise<void> {
  const key = account.id + (onlyFolder ?? '')
  const existing = running.get(key)
  if (existing) return existing
  const p = (async () => {
    status({ accountId: account.id, state: 'syncing' })
    try {
      const c = connector(account)
      if (!onlyFolder || !db.getFolder(account.id, onlyFolder)) db.saveFolders(account.id, await c.listFolders())
      notify('mail:changed', { accountId: account.id })
      const folders = db.listFolders(account.id).filter((f) => (onlyFolder ? f.id === onlyFolder : ALWAYS.has(f.role)))
      for (const f of folders) {
        const before = db.getFolderState(account.id, f.id)
        const result = await c.syncFolder(f.id, before, BATCH)
        db.applySync(account.id, f.id, result)
        if (f.role === 'inbox' && before !== null && !result.reset) {
          const fresh = result.upserts.filter((u) => u.unread).map((u) => db.getMessage(db.messageKey(account.id, f.id, u.remoteId))).filter((m) => m !== null)
          if (fresh.length) onNewMail(account, fresh)
        }
        if (result.upserts.length || result.deletes.length || result.flagUpdates.length || result.existing) notify('mail:changed', { accountId: account.id, folderId: f.id })
      }
      ensureWatcher(account)
      status({ accountId: account.id, state: 'idle' })
    } catch (e) {
      // A broken connection gets rebuilt on the next attempt
      await dropConnector(account.id)
      status({ accountId: account.id, state: 'error', message: (e as Error).message })
    } finally {
      running.delete(key)
    }
  })()
  running.set(key, p)
  return p
}

/** Page older mail in from the server. Returns false when the folder has nothing older. */
export async function loadOlder(account: Account, folderId: string): Promise<boolean> {
  const state = db.getFolderState(account.id, folderId)
  if (state === null) {
    await syncAccount(account, folderId)
    return true
  }
  const r = await connector(account).fetchOlder(folderId, state, BATCH)
  db.applyOlder(account.id, folderId, r.upserts, r.state)
  if (r.upserts.length) notify('mail:changed', { accountId: account.id, folderId })
  return !r.done || r.upserts.length > 0
}

export async function syncAll(): Promise<void> {
  await Promise.all(getAccounts().map((a) => syncAccount(a)))
}

let afterCycle: () => void = () => {}
/** Something to run after each scheduled sync (the calendar refresh) */
export function onCycle(fn: () => void): void {
  afterCycle = fn
}

export function schedule(minutes: number): void {
  if (timer) clearInterval(timer)
  timer = setInterval(() => void syncAll().then(() => afterCycle()), Math.max(1, minutes) * 60_000)
}
