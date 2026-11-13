import type { Folder, MessageBody, MessageSummary } from '@shared/types'

/**
 * The contract every mail backend implements. Adding a new kind of server
 * (EWS, JMAP, POP3...) means writing one of these and registering it in
 * connectors/index.ts; the store, sync engine and UI don't change.
 */
export interface MailConnector {
  /** Connect and authenticate; throws with a readable message on failure */
  verify(): Promise<void>
  listFolders(): Promise<Omit<Folder, 'accountId'>[]>
  /**
   * New or changed messages in a folder since the last sync. `state` is
   * whatever the connector returned last time; null for a first sync, which
   * fetches only the newest `limit` messages. Older mail comes via fetchOlder.
   */
  syncFolder(folderId: string, state: string | null, limit: number): Promise<FolderSync>
  /** The next `limit` messages older than anything fetched so far. `done` when the folder is exhausted. */
  fetchOlder(folderId: string, state: string, limit: number): Promise<{ upserts: RemoteSummary[]; state: string; done: boolean }>
  fetchBody(folderId: string, remoteId: string): Promise<Omit<MessageBody, 'key'>>
  fetchAttachment(folderId: string, remoteId: string, attachmentId: string): Promise<AttachmentData>
  setFlags(folderId: string, remoteIds: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void>
  move(folderId: string, remoteIds: string[], toFolderId: string): Promise<void>
  /** Permanently delete. "Delete" in the UI is a move to Trash; this is for messages already there. */
  remove(folderId: string, remoteIds: string[]): Promise<void>
  /** Send, and keep a copy in Sent when the server doesn't do that itself */
  send(message: CompiledMessage, sentFolderId: string | null): Promise<void>
  /** Store a draft on the server, replacing the previous copy. Returns where it went, if the server says. */
  saveDraft(message: CompiledMessage, draftsFolderId: string | null, replaces: { folderId: string; remoteId: string } | null): Promise<{ folderId: string; remoteId: string } | null>
  /**
   * Call `onChange` when new mail may have arrived (IMAP IDLE, or polling for
   * servers without push). Returns a function that stops watching.
   */
  watch(inboxId: string, onChange: () => void): () => void
  close(): Promise<void>
}

export type RemoteSummary = Omit<MessageSummary, 'key' | 'accountId' | 'folderId' | 'threadCount' | 'threadUnread'>

export interface AttachmentData {
  filename: string
  contentType: string
  content: Buffer
}

/** A message ready to go, built once in compose.ts and handed to whichever connector sends it */
export interface CompiledMessage {
  /** The whole message as MIME, attachments included */
  mime(): Promise<Buffer>
  /** MIME without the file attachments, for servers that take big attachments as separate uploads */
  mimeWithoutAttachments(): Promise<Buffer>
  attachments: AttachmentData[]
  envelope: { from: string; to: string[] }
}

export interface FolderSync {
  /** Messages to insert or update */
  upserts: RemoteSummary[]
  /** Flag changes for messages we already have */
  flagUpdates: { remoteId: string; unread: boolean; flagged: boolean }[]
  /** Remote IDs that no longer exist on the server */
  deletes: string[]
  /** When set: the complete list of remote IDs still on the server; any other cached message in the folder is gone */
  existing?: string[]
  /** When true, the local copy of this folder is stale (e.g. UIDVALIDITY changed): drop it first */
  reset: boolean
  state: string
}
