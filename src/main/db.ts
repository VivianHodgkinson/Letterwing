import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Address, CalendarEvent, CalendarInfo, Contact, Folder, FolderRole, MessageBody, MessageSummary } from '@shared/types'
import type { RemoteEvent } from './ical'
import type { FolderSync, RemoteSummary } from './connectors/types'
import { dataDir } from './store'

/**
 * Local cache of folders, message headers and bodies. The UI only ever reads
 * from here, so it stays fast and works offline; the sync engine fills it.
 * Search uses an FTS5 index over subject, sender, recipients and body text.
 */
let db: DatabaseSync

const SCHEMA_VERSION = 3

export function openDb(path = join(dataDir(), 'mail.db')): void {
  db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  migrate()
}

function migrate(): void {
  const version = (db.prepare('PRAGMA user_version').get() as Row).user_version as number
  if (version < 2) {
    // v2: conversations and address autocomplete. Connector sync states changed too, so resync everything.
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as Row[]).map((c) => c.name)
    if (!cols.includes('message_id')) db.exec("ALTER TABLE messages ADD COLUMN message_id TEXT NOT NULL DEFAULT ''")
    if (!cols.includes('thread_id')) db.exec("ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''")
    db.exec(`
      CREATE INDEX IF NOT EXISTS messages_thread ON messages (account_id, thread_id, date);
      CREATE INDEX IF NOT EXISTS messages_folder_thread ON messages (account_id, folder_id, thread_id, date);
      CREATE TABLE IF NOT EXISTS contacts (address TEXT PRIMARY KEY, name TEXT NOT NULL, score REAL NOT NULL, last INTEGER NOT NULL);
      UPDATE folders SET sync_state = NULL;
    `)
  }
  if (version < 3) {
    // v3: calendars. Events are cached per occurrence for the synced window.
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendars (
        account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
        read_only INTEGER NOT NULL, is_default INTEGER NOT NULL, synced_from INTEGER, synced_to INTEGER,
        PRIMARY KEY (account_id, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        key TEXT PRIMARY KEY, account_id TEXT NOT NULL, calendar_id TEXT NOT NULL,
        start INTEGER NOT NULL, end INTEGER NOT NULL, uid TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_range ON events (start, end);
      CREATE INDEX IF NOT EXISTS events_uid ON events (account_id, uid);
    `)
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

export const messageKey = (accountId: string, folderId: string, remoteId: string): string => `${accountId}\u0000${folderId}\u0000${remoteId}`

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
    hasAttachments: !!r.has_attachments,
    messageId: r.message_id as string,
    threadId: (r.thread_id as string) || (r.key as string),
    ...(r.thread_count !== undefined ? { threadCount: r.thread_count as number, threadUnread: (r.thread_unread as number) ?? 0 } : {})
  }
}

function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ---------------------------------------------------------------- folders

export function saveFolders(accountId: string, folders: Omit<Folder, 'accountId'>[]): void {
  const keep = new Set(folders.map((f) => f.id))
  const existing = db.prepare('SELECT id FROM folders WHERE account_id = ?').all(accountId) as Row[]
  const upsert = db.prepare(`INSERT INTO folders (account_id, id, name, parent_id, role, unread, total) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, role = excluded.role,
    unread = excluded.unread, total = excluded.total`)
  tx(() => {
    for (const f of folders) upsert.run(accountId, f.id, f.name, f.parentId, f.role, f.unread, f.total)
    for (const r of existing) if (!keep.has(r.id as string)) dropFolder(accountId, r.id as string)
  })
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

function toFolder(r: Row): Folder {
  return {
    accountId: r.account_id as string,
    id: r.id as string,
    name: r.name as string,
    parentId: (r.parent_id as string) ?? null,
    role: r.role as FolderRole,
    unread: r.unread as number,
    total: r.total as number
  }
}

export function listFolders(accountId: string): Folder[] {
  return (db.prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY name COLLATE NOCASE').all(accountId) as Row[]).map(toFolder)
}

export function getFolder(accountId: string, folderId: string): Folder | null {
  const r = db.prepare('SELECT * FROM folders WHERE account_id = ? AND id = ?').get(accountId, folderId) as Row | undefined
  return r ? toFolder(r) : null
}

export function folderByRole(accountId: string, role: FolderRole): Folder | null {
  const r = db.prepare('SELECT * FROM folders WHERE account_id = ? AND role = ? LIMIT 1').get(accountId, role) as Row | undefined
  return r ? toFolder(r) : null
}

export function getFolderState(accountId: string, folderId: string): string | null {
  const r = db.prepare('SELECT sync_state FROM folders WHERE account_id = ? AND id = ?').get(accountId, folderId) as Row | undefined
  return (r?.sync_state as string) ?? null
}

// ---------------------------------------------------------------- sync

function writeSummaries(accountId: string, folderId: string, upserts: RemoteSummary[]): void {
  const upsert = db.prepare(`INSERT INTO messages (key, account_id, folder_id, remote_id, subject, from_json, to_json, date, preview, unread, flagged, has_attachments, message_id, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET subject = excluded.subject, from_json = excluded.from_json, to_json = excluded.to_json,
    date = excluded.date, preview = excluded.preview, unread = excluded.unread, flagged = excluded.flagged, has_attachments = excluded.has_attachments,
    message_id = excluded.message_id, thread_id = excluded.thread_id`)
  const delSearch = db.prepare('DELETE FROM search WHERE key = ?')
  const addSearch = db.prepare('INSERT INTO search (key, subject, people, body) VALUES (?, ?, ?, ?)')
  const sent = getFolder(accountId, folderId)?.role === 'sent'
  for (const m of upserts) {
    const key = messageKey(accountId, folderId, m.remoteId)
    upsert.run(key, accountId, folderId, m.remoteId, m.subject, m.from ? JSON.stringify(m.from) : null, JSON.stringify(m.to), m.date,
      m.preview, m.unread ? 1 : 0, m.flagged ? 1 : 0, m.hasAttachments ? 1 : 0, m.messageId, m.threadId)
    const people = [m.from, ...m.to].filter(Boolean).map((a) => `${a!.name} ${a!.address}`).join(' ')
    delSearch.run(key)
    addSearch.run(key, m.subject, people, m.preview)
    // Autocomplete: people you write to rank far above people who write to you
    if (sent) for (const a of m.to) noteContact(a, 5, m.date)
    else if (m.from) noteContact(m.from, 1, m.date)
  }
}

/** Apply one folder sync in a single transaction, so a failed sync leaves the old state intact */
export function applySync(accountId: string, folderId: string, sync: FolderSync): void {
  tx(() => {
    if (sync.reset) clearFolderMessages(accountId, folderId)
    deleteKeys(sync.deletes.map((id) => messageKey(accountId, folderId, id)))
    if (sync.existing) {
      const keep = new Set(sync.existing)
      const local = db.prepare('SELECT key, remote_id FROM messages WHERE account_id = ? AND folder_id = ?').all(accountId, folderId) as Row[]
      deleteKeys(local.filter((r) => !keep.has(r.remote_id as string)).map((r) => r.key as string))
    }
    writeSummaries(accountId, folderId, sync.upserts)
    const flags = db.prepare('UPDATE messages SET unread = ?, flagged = ? WHERE key = ?')
    for (const u of sync.flagUpdates) flags.run(u.unread ? 1 : 0, u.flagged ? 1 : 0, messageKey(accountId, folderId, u.remoteId))
    db.prepare('UPDATE folders SET sync_state = ? WHERE account_id = ? AND id = ?').run(sync.state, accountId, folderId)
  })
}

/** Older messages paged in on demand */
export function applyOlder(accountId: string, folderId: string, upserts: RemoteSummary[], state: string): void {
  tx(() => {
    writeSummaries(accountId, folderId, upserts)
    db.prepare('UPDATE folders SET sync_state = ? WHERE account_id = ? AND id = ?').run(state, accountId, folderId)
  })
}

// ---------------------------------------------------------------- reading

export interface Cursor {
  date: number
  key: string
}

/**
 * Messages in one folder, or across all inboxes when folderId is '*inbox', newest first.
 * In conversation mode each conversation appears once, as its newest message in the folder,
 * with a count of the whole conversation (copies in other folders counted once).
 */
export function listMessages(accountId: string | null, folderId: string, limit: number, before?: Cursor, conversations = false): MessageSummary[] {
  const c = before ?? { date: Number.MAX_SAFE_INTEGER, key: '' }
  const unified = folderId === '*inbox'
  const scope = unified
    ? `m.folder_id IN (SELECT id FROM folders f WHERE f.account_id = m.account_id AND f.role = 'inbox')`
    : `m.account_id = :account AND m.folder_id = :folder`
  const page = `(m.date < :date OR (m.date = :date AND m.key < :key))`
  // node:sqlite rejects named parameters a query doesn't use, so only pass the folder ones when needed
  const params = { ...(unified ? {} : { account: accountId ?? '', folder: folderId }), date: c.date, key: c.key, limit }
  const sql = conversations
    ? `SELECT m.*,
         (SELECT COUNT(DISTINCT t.message_id) FROM messages t WHERE t.account_id = m.account_id AND t.thread_id = m.thread_id) AS thread_count,
         (SELECT COUNT(DISTINCT t.message_id) FROM messages t WHERE t.account_id = m.account_id AND t.thread_id = m.thread_id AND t.unread = 1) AS thread_unread
       FROM messages m
       WHERE ${scope} AND ${page} AND NOT EXISTS (
         SELECT 1 FROM messages n WHERE n.account_id = m.account_id AND n.folder_id = m.folder_id AND n.thread_id = m.thread_id
           AND (n.date > m.date OR (n.date = m.date AND n.key > m.key)))
       ORDER BY m.date DESC, m.key DESC LIMIT :limit`
    : `SELECT m.* FROM messages m WHERE ${scope} AND ${page} ORDER BY m.date DESC, m.key DESC LIMIT :limit`
  return (db.prepare(sql).all(params) as Row[]).map(toSummary)
}

/**
 * Every message in a conversation, oldest first, each copy listed once. Messages in Trash and
 * Junk are left out unless the conversation is being read from there.
 */
export function thread(key: string): MessageSummary[] {
  const m = getMessage(key)
  if (!m) return []
  const here = getFolder(m.accountId, m.folderId)?.role
  const hide = here === 'trash' || here === 'junk' ? [] : ['trash', 'junk']
  const rows = db
    .prepare(
      `SELECT m.* FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.id = m.folder_id
       WHERE m.account_id = ? AND m.thread_id = ? AND f.role NOT IN (${hide.map(() => '?').join(',') || "''"})
       ORDER BY m.date ASC`
    )
    .all(m.accountId, m.threadId, ...hide) as Row[]
  // The same message can sit in Inbox and All Mail (Gmail): prefer the copy in the folder being read
  const byId = new Map<string, MessageSummary>()
  for (const s of rows.map(toSummary)) {
    const prev = byId.get(s.messageId)
    if (!prev || s.folderId === m.folderId) byId.set(s.messageId, s)
  }
  return [...byId.values()].sort((a, b) => a.date - b.date)
}

/** Full-text search. Each word becomes a prefix match, so "inv acme" finds "Invoice from ACME Ltd". */
export function search(query: string, limit: number): MessageSummary[] {
  const terms = query.match(/[\p{L}\p{N}@._-]+/gu) ?? []
  if (!terms.length) return []
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
  const rows = db.prepare(`SELECT m.* FROM search s JOIN messages m ON m.key = s.key WHERE search MATCH ? ORDER BY m.date DESC LIMIT ?`).all(match, limit) as Row[]
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

// ---------------------------------------------------------------- local changes

/**
 * Update flags locally. Folder unread counts come from the server (we only
 * cache recent messages), so adjust them by the change rather than recounting.
 */
export function setLocalFlags(keys: string[], flags: { read?: boolean; flagged?: boolean }): void {
  const get = db.prepare('SELECT account_id, folder_id, unread FROM messages WHERE key = ?')
  const r = db.prepare('UPDATE messages SET unread = ? WHERE key = ?')
  const f = db.prepare('UPDATE messages SET flagged = ? WHERE key = ?')
  const count = db.prepare('UPDATE folders SET unread = MAX(0, unread + ?) WHERE account_id = ? AND id = ?')
  tx(() => {
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
  })
}

/** Take messages out of the cache straight away (moved or deleted). Returns them so a failed server call can put them back. */
export function removeLocal(keys: string[]): { message: MessageSummary; body: MessageBody | null }[] {
  return tx(() => {
    const out = keys.flatMap((k) => {
      const message = getMessage(k)
      return message ? [{ message, body: getCachedBody(k) }] : []
    })
    const count = db.prepare('UPDATE folders SET unread = MAX(0, unread - 1), total = MAX(0, total - 1) WHERE account_id = ? AND id = ?')
    for (const { message } of out) if (message.unread) count.run(message.accountId, message.folderId)
    deleteKeys(out.map((o) => o.message.key))
    return out
  })
}

export function restoreLocal(items: { message: MessageSummary; body: MessageBody | null }[]): void {
  tx(() => {
    for (const { message: m, body } of items) {
      writeSummaries(m.accountId, m.folderId, [m])
      if (body) cacheBody(body)
      if (m.unread) db.prepare('UPDATE folders SET unread = unread + 1 WHERE account_id = ? AND id = ?').run(m.accountId, m.folderId)
    }
  })
}

export function removeAccountData(accountId: string): void {
  for (const f of listFolders(accountId)) dropFolder(accountId, f.id)
  db.prepare('DELETE FROM events WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM calendars WHERE account_id = ?').run(accountId)
}

// ---------------------------------------------------------------- calendars

export function saveCalendars(accountId: string, calendars: Omit<CalendarInfo, 'accountId'>[]): void {
  const keep = new Set(calendars.map((c) => c.id))
  tx(() => {
    const up = db.prepare(`INSERT INTO calendars (account_id, id, name, color, read_only, is_default) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, id) DO UPDATE SET name = excluded.name, color = excluded.color, read_only = excluded.read_only, is_default = excluded.is_default`)
    for (const c of calendars) up.run(accountId, c.id, c.name, c.color, c.readOnly ? 1 : 0, c.isDefault ? 1 : 0)
    for (const r of db.prepare('SELECT id FROM calendars WHERE account_id = ?').all(accountId) as Row[])
      if (!keep.has(r.id as string)) {
        db.prepare('DELETE FROM events WHERE account_id = ? AND calendar_id = ?').run(accountId, r.id as string)
        db.prepare('DELETE FROM calendars WHERE account_id = ? AND id = ?').run(accountId, r.id as string)
      }
  })
}

export function listCalendars(): (CalendarInfo & { syncedFrom: number | null; syncedTo: number | null })[] {
  return (db.prepare('SELECT * FROM calendars ORDER BY account_id, is_default DESC, name COLLATE NOCASE').all() as Row[]).map((r) => ({
    accountId: r.account_id as string,
    id: r.id as string,
    name: r.name as string,
    color: r.color as string,
    readOnly: !!r.read_only,
    isDefault: !!r.is_default,
    syncedFrom: (r.synced_from as number) ?? null,
    syncedTo: (r.synced_to as number) ?? null
  }))
}

export const eventKey = (accountId: string, calendarId: string, remoteId: string, start: number): string =>
  `${accountId}\u0000${calendarId}\u0000${remoteId}\u0000${start}`

export function toCalendarEvent(accountId: string, calendarId: string, e: RemoteEvent): CalendarEvent {
  return { ...e, key: eventKey(accountId, calendarId, e.remoteId, e.start), accountId, calendarId }
}

/** Replace a calendar's events for the window just synced */
export function saveEvents(accountId: string, calendarId: string, from: number, to: number, events: RemoteEvent[]): void {
  tx(() => {
    db.prepare('DELETE FROM events WHERE account_id = ? AND calendar_id = ?').run(accountId, calendarId)
    const ins = db.prepare('INSERT OR REPLACE INTO events (key, account_id, calendar_id, start, end, uid, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const e of events) {
      const full = toCalendarEvent(accountId, calendarId, e)
      ins.run(full.key, accountId, calendarId, e.start, e.end, e.uid, JSON.stringify(full))
    }
    db.prepare('UPDATE calendars SET synced_from = ?, synced_to = ? WHERE account_id = ? AND id = ?').run(from, to, accountId, calendarId)
  })
}

export function listEvents(from: number, to: number): CalendarEvent[] {
  return (db.prepare('SELECT json FROM events WHERE start < ? AND end > ? ORDER BY start').all(to, from) as Row[]).map((r) => JSON.parse(r.json as string))
}

export function getEvent(key: string): CalendarEvent | null {
  const r = db.prepare('SELECT json FROM events WHERE key = ?').get(key) as Row | undefined
  return r ? JSON.parse(r.json as string) : null
}

export function eventByUid(accountId: string, uid: string): CalendarEvent | null {
  const r = db.prepare('SELECT json FROM events WHERE account_id = ? AND uid = ? ORDER BY start LIMIT 1').get(accountId, uid) as Row | undefined
  return r ? JSON.parse(r.json as string) : null
}

/** Events starting in [from, to), for reminders */
export function eventsStarting(from: number, to: number): CalendarEvent[] {
  return (db.prepare('SELECT json FROM events WHERE start >= ? AND start < ? ORDER BY start').all(from, to) as Row[]).map((r) => JSON.parse(r.json as string))
}

// ---------------------------------------------------------------- contacts

function noteContact(a: Address, weight: number, date: number): void {
  if (!a.address || !a.address.includes('@') || /no-?reply|do-?not-?reply|mailer-daemon/i.test(a.address)) return
  db.prepare(
    `INSERT INTO contacts (address, name, score, last) VALUES (lower(?), ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET score = score + excluded.score, last = MAX(last, excluded.last),
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`
  ).run(a.address, a.name ?? '', weight, date)
}

export function addContacts(addresses: Address[]): void {
  tx(() => {
    for (const a of addresses) noteContact(a, 5, Date.now())
  })
}

/** Autocomplete: matches the start of the address or any word of the name, best-known people first */
export function suggestContacts(prefix: string, limit: number): Contact[] {
  const p = prefix.trim().toLowerCase().replace(/[%_]/g, '')
  if (!p) return []
  const rows = db
    .prepare(
      `SELECT address, name FROM contacts WHERE address LIKE ? OR lower(name) LIKE ? OR lower(name) LIKE ?
       ORDER BY score DESC, last DESC LIMIT ?`
    )
    .all(`${p}%`, `${p}%`, `% ${p}%`, limit) as Row[]
  return rows.map((r) => ({ address: r.address as string, name: r.name as string }))
}
