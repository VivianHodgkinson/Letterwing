import type { Account, Folder, MessageBody, MessageSummary, NewAccount, Settings, SyncStatus } from './types'

/**
 * Every method callable from the renderer. The main process implements this
 * interface and the preload bridges it over a single IPC channel.
 */
export interface Api {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  openExternal(url: string): Promise<void>

  listAccounts(): Promise<Account[]>
  /** Tests the connection (and runs OAuth sign-in when needed) before saving */
  addAccount(account: NewAccount): Promise<Account>
  updateAccount(id: string, patch: Partial<Account>): Promise<Account>
  removeAccount(id: string): Promise<void>

  listFolders(accountId: string): Promise<Folder[]>
  /** Messages in one folder, or across all inboxes when folderId is '*inbox' */
  listMessages(accountId: string | null, folderId: string, limit: number, before?: number): Promise<MessageSummary[]>
  search(query: string, limit: number): Promise<MessageSummary[]>
  getBody(key: string): Promise<MessageBody>
  setRead(keys: string[], read: boolean): Promise<void>
  setFlagged(keys: string[], flagged: boolean): Promise<void>
  syncNow(accountId?: string): Promise<void>
}

export type ApiMethod = keyof Api

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Push events from main to renderer */
export type EventChannel = 'sync:status' | 'mail:changed'
export type SyncEvent = SyncStatus
