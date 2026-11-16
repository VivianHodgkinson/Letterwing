import type { Account, MailtoRequest, AccountKind, ServerSettings, CalendarEvent, CalendarInfo, Contact, EventInput, Folder, MessageBody, MessageSummary, NewAccount, Outgoing, OutgoingAttachment, Settings, SyncStatus, UpdateStatus } from './types'

/** One entry of a right-click menu. The menu is drawn by the OS; the renderer gets back the id that was clicked. */
export interface MenuItem {
  id?: string
  label?: string
  type?: 'separator'
  enabled?: boolean
  /** Shown as a tick */
  checked?: boolean
  /** A keybinding as written in the keymap ("Ctrl+R"); shown next to the label when the OS can draw it */
  shortcut?: string
  submenu?: MenuItem[]
}

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
  /** Show a native right-click menu at the mouse (or at x/y in window coordinates). Resolves with the chosen id, or null if dismissed. */
  showMenu(items: MenuItem[], at?: { x: number; y: number }): Promise<string | null>
  /** Native yes/no question. Resolves true when the user picks `ok`. */
  confirm(question: { message: string; detail?: string; ok: string }): Promise<boolean>
  /** Native question with several answers (plus Cancel). Resolves with the chosen option's index, or -1 for Cancel. */
  choose(question: { message: string; detail?: string; options: string[] }): Promise<number>
  copyText(text: string): Promise<void>
  /** Mail links (mailto:) that arrived before the window was ready; the renderer asks once it has loaded */
  takePendingMailto(): Promise<MailtoRequest[]>
  /** Whether Letterwing opens mail links, and making it do so */
  mailAppStatus(): Promise<{ isDefault: boolean; canSet: boolean }>
  setDefaultMailApp(): Promise<boolean>

  listAccounts(): Promise<Account[]>
  /** Who hosts this address, and whether this build can sign in there */
  detectProvider(email: string): Promise<{ kind: AccountKind; reason: string; signInAvailable: boolean; imap?: ServerSettings; smtp?: ServerSettings }>
  /** Tests the connection (and runs OAuth sign-in when needed) before saving */
  addAccount(account: NewAccount): Promise<Account>
  /** Stop waiting for a browser sign-in */
  cancelSignIn(): Promise<void>
  /** Microsoft 365: the link an organisation's admin opens to approve Letterwing once for everyone there */
  adminConsentUrl(email: string): Promise<string | null>
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
  /** Move to the account's Junk folder */
  junkMessages(keys: string[]): Promise<void>
  /** Mark every message in a folder read on the server, not only the cached ones. folderId '*inbox' means every account's inbox. */
  markFolderRead(accountId: string | null, folderId: string): Promise<void>
  /** Permanently delete everything in a folder (for Trash and Junk) */
  emptyFolder(accountId: string, folderId: string): Promise<void>
  createFolder(accountId: string, parentId: string | null, name: string): Promise<void>
  renameFolder(accountId: string, folderId: string, name: string): Promise<void>
  /** Deletes the folder and everything in it */
  deleteFolder(accountId: string, folderId: string): Promise<void>
  openAttachment(key: string, attachmentId: string): Promise<void>
  saveAttachment(key: string, attachmentId: string): Promise<boolean>
  syncNow(accountId?: string): Promise<void>
  syncStatus(): Promise<SyncStatus[]>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  showUpdateFile(): Promise<void>
  openReleasePage(): Promise<void>

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
  /** For a repeating event: just this occurrence (default) or the whole series */
  deleteEvent(key: string, scope?: 'occurrence' | 'series'): Promise<void>
  respondToEvent(key: string, answer: 'accepted' | 'tentative' | 'declined', comment?: string): Promise<void>
  /** Answer the invitation in a message; the message then moves to Deleted Items */
  respondToInvite(messageKey: string, answer: 'accepted' | 'tentative' | 'declined', comment?: string): Promise<void>
  syncCalendars(): Promise<void>
}

export type ApiMethod = keyof Api

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Push events from main to renderer */
export type EventChannel = 'compose:mailto' | 'sync:status' | 'mail:changed' | 'key:forward' | 'open:message' | 'calendar:changed' | 'open:event' | 'update:status' | 'compose:new'
export type SyncEvent = SyncStatus
