import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Folder, MessageBody, MessageSummary } from '@shared/types'
import type { FolderSync } from './connectors/types'
import { dataDir } from './store'

/**
 * Local cache of folders, message headers and bodies. The UI only ever reads
 * from here, so it stays fast and works offline; the sync engine fills it.
 * Search uses an FTS5 index over subject, sender, recipients and body text.
 */
let db: DatabaseSync

export function openDb(path = join(dataDir(), 'mail.db')): void {
  db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS folders (
      account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT,
      role TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      sync_state TEXT,
      PRIMARY KEY (account_id, id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      key TEXT PRIMARY KEY, account_id TEXT NOT NULL, folder_id TEXT NOT NULL, remote_id TEXT NOT NULL,
      subject TEXT NOT NULL, from_json TEXT, to_json TEXT NOT NULL, date INTEGER NOT NULL,
      preview TEXT NOT NULL, unread INTEGER NOT NULL, flagged INTEGER NOT NULL, has_attachments INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_folder_date ON messages (account_id, folder_id, date DESC);
    CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC);
    CREATE TABLE IF NOT EXISTS bodies (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(key UNINDEXED, subject, people, body, tokenize = 'unicode61 remove_diacritics 2');
  `)
}

export const messageKey = (accountId: string, folderId: string, remoteId: string): string =>
  `${accountId}\u0000${folderId}\u0000${remoteId}`

type Row = Record<string, unknown>

function toSummary(r: Row): MessageSummary {
  return {
    key: r.key as string,
    accountId: r.account_id as string,
    folderId: r.folder_id as string,
    remoteId: r.remote_id as string,
    subject: r.subject as string,
    from: r.from_json ? JSON.parse(r.from_json as string) : null,
    to: JSON.parse(r.to_json as string),
    date: r.date as number,
    preview: r.preview as string,
    unread: !!r.unread,
    flagged: !!r.flagged,
    hasAttachments: !!r.has_attachments
  }
}

export function saveFolders(accountId: string, folders: Omit<Folder, 'accountId'>[]): void {
  const keep = new Set(folders.map((f) => f.id))
  const existing = db.prepare('SELECT id FROM folders WHERE account_id = ?').all(accountId) as Row[]
  const upsert = db.prepare(`INSERT INTO folders (account_id, id, name, parent_id, role, unread, total) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, role = excluded.role,
    unread = excluded.unread, total = excluded.total`)
  db.exec('BEGIN')
  try {
    for (const f of folders) upsert.run(accountId, f.id, f.name, f.parentId, f.role, f.unread, f.total)
    for (const r of existing) if (!keep.has(r.id as string)) dropFolder(accountId, r.id as string)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function dropFolder(accountId: string, folderId: string): void {
  clearFolderMessages(accountId, folderId)
  db.prepare('DELETE FROM folders WHERE account_id = ? AND id = ?').run(accountId, folderId)
}

function clearFolderMessages(accountId: string, folderId: string): void {
  const keys = db.prepare('SELECT key FROM messages WHERE account_id = ? AND folder_id = ?').all(accountId, folderId) as Row[]
  deleteKeys(keys.map((k) => k.key as string))
}

function deleteKeys(keys: string[]): void {
  const m = db.prepare('DELETE FROM messages WHERE key = ?')
  const b = db.prepare('DELETE FROM bodies WHERE key = ?')
  const s = db.prepare('DELETE FROM search WHERE key = ?')
  for (const k of keys) {
    m.run(k)
    b.run(k)
    s.run(k)
  }
}

export function listFolders(accountId: string): Folder[] {
  const rows = db.prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(accountId) as Row[]
  return rows.map((r) => ({
    accountId,
    id: r.id as string,
    name: r.name as string,
    parentId: (r.parent_id as string) ?? null,
    role: r.role as Folder['role'],
    unread: r.unread as number,
    total: r.total as number
  }))
}

export function getFolderState(accountId: string, folderId: string): string | null {
  const r = db.prepare('SELECT sync_state FROM folders WHERE account_id = ? AND id = ?').get(accountId, folderId) as Row | undefined
  return (r?.sync_state as string) ?? null
}

/** Apply one folder sync in a single transaction, so a failed sync leaves the old state intact */
export function applySync(
  accountId: string,
  folderId: string,
  sync: FolderSync
): void {
  const upsert = db.prepare(`INSERT INTO messages (key, account_id, folder_id, remote_id, subject, from_json, to_json, date, preview, unread, flagged, has_attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET subject = excluded.subject, from_json = excluded.from_json, to_json = excluded.to_json,
    date = excluded.date, preview = excluded.preview, unread = excluded.unread, flagged = excluded.flagged, has_attachments = excluded.has_attachments`)
  const delSearch = db.prepare('DELETE FROM search WHERE key = ?')
  const addSearch = db.prepare('INSERT INTO search (key, subject, people, body) VALUES (?, ?, ?, ?)')
  db.exec('BEGIN')
  try {
    if (sync.reset) clearFolderMessages(accountId, folderId)
    deleteKeys(sync.deletes.map((id) => messageKey(accountId, folderId, id)))
    for (const m of sync.upserts) {
      const key = messageKey(accountId, folderId, m.remoteId)
      upsert.run(key, accountId, folderId, m.remoteId, m.subject, m.from ? JSON.stringify(m.from) : null, JSON.stringify(m.to), m.date,
        m.preview, m.unread ? 1 : 0, m.flagged ? 1 : 0, m.hasAttachments ? 1 : 0)
      const people = [m.from, ...m.to].filter(Boolean).map((a) => `${a!.name} ${a!.address}`).join(' ')
      delSearch.run(key)
      addSearch.run(key, m.subject, people, m.preview)
    }
    const flags = db.prepare('UPDATE messages SET unread = ?, flagged = ? WHERE key = ?')
    for (const u of sync.flagUpdates) flags.run(u.unread ? 1 : 0, u.flagged ? 1 : 0, messageKey(accountId, folderId, u.remoteId))
    db.prepare('UPDATE folders SET sync_state = ? WHERE account_id = ? AND id = ?').run(sync.state, accountId, folderId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function listMessages(accountId: string | null, folderId: string, limit: number, before?: number): MessageSummary[] {
  const until = before ?? Number.MAX_SAFE_INTEGER
  if (folderId === '*inbox') {
    // Unified inbox: every account's inbox folder, newest first
    const rows = db.prepare(`SELECT m.* FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.id = m.folder_id
      WHERE f.role = 'inbox' AND m.date < ? ORDER BY m.date DESC LIMIT ?`).all(until, limit) as Row[]
    return rows.map(toSummary)
  }
  const rows = db.prepare('SELECT * FROM messages WHERE account_id = ? AND folder_id = ? AND date < ? ORDER BY date DESC LIMIT ?')
    .all(accountId, folderId, until, limit) as Row[]
  return rows.map(toSummary)
}

/** Full-text search. Each word becomes a prefix match, so "inv acme" finds "Invoice from ACME Ltd". */
export function search(query: string, limit: number): MessageSummary[] {
  const terms = query.match(/[\p{L}\p{N}@._-]+/gu) ?? []
  if (!terms.length) return []
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
  const rows = db.prepare(`SELECT m.* FROM search s JOIN messages m ON m.key = s.key WHERE search MATCH ? ORDER BY m.date DESC LIMIT ?`)
    .all(match, limit) as Row[]
  return rows.map(toSummary)
}

export function getMessage(key: string): MessageSummary | null {
  const r = db.prepare('SELECT * FROM messages WHERE key = ?').get(key) as Row | undefined
  return r ? toSummary(r) : null
}

export function getCachedBody(key: string): MessageBody | null {
  const r = db.prepare('SELECT json FROM bodies WHERE key = ?').get(key) as Row | undefined
  return r ? (JSON.parse(r.json as string) as MessageBody) : null
}

export function cacheBody(body: MessageBody): void {
  db.prepare('INSERT OR REPLACE INTO bodies (key, json) VALUES (?, ?)').run(body.key, JSON.stringify(body))
  // Index the full text for search now that we have it
  const text = (body.text ?? body.html?.replace(/<[^>]+>/g, ' ') ?? '').slice(0, 200_000)
  db.prepare('UPDATE search SET body = ? WHERE key = ?').run(text, body.key)
}

/**
 * Update flags locally. Folder unread counts come from the server (we only
 * cache recent messages), so adjust them by the change rather than recounting.
 */
export function setLocalFlags(keys: string[], flags: { read?: boolean; flagged?: boolean }): void {
  const get = db.prepare('SELECT account_id, folder_id, unread FROM messages WHERE key = ?')
  const r = db.prepare('UPDATE messages SET unread = ? WHERE key = ?')
  const f = db.prepare('UPDATE messages SET flagged = ? WHERE key = ?')
  const count = db.prepare('UPDATE folders SET unread = MAX(0, unread + ?) WHERE account_id = ? AND id = ?')
  db.exec('BEGIN')
  try {
    for (const k of keys) {
      const m = get.get(k) as Row | undefined
      if (!m) continue
      if (flags.read !== undefined) {
        const wasUnread = !!m.unread
        if (wasUnread === flags.read) count.run(flags.read ? -1 : 1, m.account_id as string, m.folder_id as string)
        r.run(flags.read ? 0 : 1, k)
      }
      if (flags.flagged !== undefined) f.run(flags.flagged ? 1 : 0, k)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function removeAccountData(accountId: string): void {
  for (const f of listFolders(accountId)) dropFolder(accountId, f.id)
}
