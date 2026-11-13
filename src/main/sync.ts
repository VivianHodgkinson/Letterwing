import type { Account, SyncStatus } from '@shared/types'
import { connectorFor } from './connectors'
import type { MailConnector } from './connectors/types'
import * as db from './db'
import { getAccounts } from './store'

/** Messages pulled per folder per sync. First syncs take this many newest; later syncs backfill or fetch new. */
const BATCH = 200
/** Folders synced on every pass; the rest sync when opened */
const ALWAYS = new Set(['inbox', 'sent', 'drafts'])

const connectors = new Map<string, MailConnector>()
const running = new Map<string, Promise<void>>()
let notify: (channel: 'sync:status' | 'mail:changed', payload: unknown) => void = () => {}
let timer: NodeJS.Timeout | null = null

export function init(send: typeof notify): void {
  notify = send
}

export function connector(account: Account): MailConnector {
  let c = connectors.get(account.id)
  if (!c) connectors.set(account.id, (c = connectorFor(account)))
  return c
}

export async function dropConnector(accountId: string): Promise<void> {
  await connectors.get(accountId)?.close()
  connectors.delete(accountId)
}

function status(s: Omit<SyncStatus, 'at'>): void {
  notify('sync:status', { ...s, at: Date.now() })
}

/** Sync one account. Concurrent calls for the same account share the running sync. */
export function syncAccount(account: Account, onlyFolder?: string): Promise<void> {
  const key = account.id + (onlyFolder ?? '')
  const existing = running.get(key)
  if (existing) return existing
  const p = (async () => {
    status({ accountId: account.id, state: 'syncing' })
    try {
      const c = connector(account)
      db.saveFolders(account.id, await c.listFolders())
      notify('mail:changed', { accountId: account.id })
      const folders = db.listFolders(account.id).filter((f) => (onlyFolder ? f.id === onlyFolder : ALWAYS.has(f.role)))
      for (const f of folders) {
        const result = await c.syncFolder(f.id, db.getFolderState(account.id, f.id), BATCH)
        db.applySync(account.id, f.id, result)
        if (result.upserts.length || result.deletes.length || result.flagUpdates.length) notify('mail:changed', { accountId: account.id, folderId: f.id })
      }
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

export async function syncAll(): Promise<void> {
  await Promise.all(getAccounts().map((a) => syncAccount(a)))
}

export function schedule(minutes: number): void {
  if (timer) clearInterval(timer)
  timer = setInterval(() => void syncAll(), Math.max(1, minutes) * 60_000)
}
