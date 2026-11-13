import type { Account, AccountKind, ServerSettings, CalendarEvent, CalendarInfo, Contact, EventInput, Folder, MessageBody, MessageSummary, NewAccount, Outgoing, OutgoingAttachment, Settings, SyncStatus } from './types'

/** Paging position in a message list: the last row shown */
export interface Cursor {
  date: number
  key: string
}

/**
 * Every method callable from the renderer. The main process implements this
 * interface and the preload bridges it over a single IPC channel.
 */
export interface Api {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  openExternal(url: string): Promise<void>

  listAccounts(): Promise<Account[]>
  /** Who hosts this address, and whether this build can sign in there */
  detectProvider(email: string): Promise<{ kind: AccountKind; reason: string; signInAvailable: boolean; imap?: ServerSettings; smtp?: ServerSettings }>
  /** Tests the connection (and runs OAuth sign-in when needed) before saving */
  addAccount(account: NewAccount): Promise<Account>
  updateAccount(id: string, patch: Partial<Account>): Promise<Account>
  removeAccount(id: string): Promise<void>

  listFolders(accountId: string): Promise<Folder[]>
  /** Messages in one folder, or across all inboxes when folderId is '*inbox'. Grouped by conversation if that setting is on. */
  listMessages(accountId: string | null, folderId: string, limit: number, before?: Cursor): Promise<MessageSummary[]>
  /** Fetch older mail from the server into the cache. False when there's nothing older. */
  loadOlder(accountId: string, folderId: string): Promise<boolean>
  getThread(key: string): Promise<MessageSummary[]>
  search(query: string, limit: number): Promise<MessageSummary[]>
  getBody(key: string): Promise<MessageBody>
  setRead(keys: string[], read: boolean): Promise<void>
  setFlagged(keys: string[], flagged: boolean): Promise<void>
  /** Move to another folder of the same account */
  moveMessages(keys: string[], toFolderId: string): Promise<void>
  /** Move to Trash; messages already in Trash are deleted for good */
  deleteMessages(keys: string[]): Promise<void>
  archiveMessages(keys: string[]): Promise<void>
  openAttachment(key: string, attachmentId: string): Promise<void>
  saveAttachment(key: string, attachmentId: string): Promise<boolean>
  syncNow(accountId?: string): Promise<void>
  syncStatus(): Promise<SyncStatus[]>

  // writing
  suggestContacts(prefix: string): Promise<Contact[]>
  pickFiles(): Promise<OutgoingAttachment[]>
  attachPaths(paths: string[]): Promise<OutgoingAttachment[]>
  /** Saves to the server's Drafts folder; returns the message with its new server copy recorded */
  saveDraft(message: Outgoing): Promise<Outgoing>
  sendMessage(message: Outgoing): Promise<void>
  discardDraft(message: Outgoing): Promise<void>
  /** Reopen a message from Drafts for editing */
  openDraft(key: string): Promise<Outgoing>

  // calendar
  listCalendars(): Promise<CalendarInfo[]>
  listEvents(from: number, to: number): Promise<CalendarEvent[]>
  saveEvent(input: EventInput): Promise<void>
  deleteEvent(key: string): Promise<void>
  respondToEvent(key: string, answer: 'accepted' | 'tentative' | 'declined', comment?: string): Promise<void>
  /** Answer the invitation in a message; the message then moves to Deleted Items, like Classic */
  respondToInvite(messageKey: string, answer: 'accepted' | 'tentative' | 'declined', comment?: string): Promise<void>
  syncCalendars(): Promise<void>
}

export type ApiMethod = keyof Api

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Push events from main to renderer */
export type EventChannel = 'sync:status' | 'mail:changed' | 'key:forward' | 'open:message' | 'calendar:changed' | 'open:event'
export type SyncEvent = SyncStatus
