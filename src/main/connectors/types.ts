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
   * whatever the connector returned last time (IMAP: UIDVALIDITY + highest
   * UID; Graph: a delta link). Pass null for a first sync.
   */
  syncFolder(folderId: string, state: string | null, limit: number): Promise<FolderSync>
  fetchBody(folderId: string, remoteId: string): Promise<Omit<MessageBody, 'key'>>
  setFlags(folderId: string, remoteIds: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void>
  close(): Promise<void>
}

export type RemoteSummary = Omit<MessageSummary, 'key' | 'accountId' | 'folderId'>

export interface FolderSync {
  /** Messages to insert or update */
  upserts: RemoteSummary[]
  /** Flag changes for messages we already have */
  flagUpdates: { remoteId: string; unread: boolean; flagged: boolean }[]
  /** Remote IDs that no longer exist on the server */
  deletes: string[]
  /** When true, the local copy of this folder is stale (e.g. UIDVALIDITY changed): drop it first */
  reset: boolean
  state: string
}
