import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageStructureObject } from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import nodemailer from 'nodemailer'
import type { Account, Address, FolderRole } from '@shared/types'
import type { AttachmentData, CompiledMessage, FolderSync, MailConnector, RemoteSummary } from './types'

type Auth = { pass: string } | { accessToken: string }

/** Inline images up to this size are embedded into the cached body; bigger ones are left as attachments */
const MAX_INLINE = 5 * 1024 * 1024
/** Flags are re-read for this many of the newest known messages on every sync */
const FLAG_WINDOW = 500

/**
 * Any IMAP server: Gmail (OAuth), Microsoft 365 / personal Microsoft accounts IMAP, Fastmail,
 * iCloud, cPanel/Dovecot hosting, etc. Sends over SMTP with the same login.
 *
 * Folder state is "UIDVALIDITY:highestUID:lowestUID:done", i.e. the UID range
 * we've fetched and whether everything older has been fetched too.
 */
export class ImapConnector implements MailConnector {
  private client: ImapFlow | null = null
  private connecting: Promise<ImapFlow> | null = null

  constructor(
    private account: Account,
    private auth: () => Promise<Auth>
  ) {}

  private async makeClient(extra: { autoIdleDelay?: number } = {}): Promise<ImapFlow> {
    const s = this.account.imap
    if (!s) throw new Error('No IMAP server configured')
    const client = new ImapFlow({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      doSTARTTLS: s.security === 'starttls' ? true : undefined,
      auth: { user: this.account.username || this.account.email, ...(await this.auth()) },
      logger: false,
      emitLogs: false,
      ...extra
    })
    // A dropped connection is not fatal: the next call reconnects.
    client.on('error', () => {})
    await client.connect()
    return client
  }

  private async conn(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    // Several callers at once share one connection attempt
    this.connecting ??= this.makeClient().then(
      (c) => {
        this.client = c
        this.connecting = null
        return c
      },
      (e) => {
        this.connecting = null
        throw e
      }
    )
    return this.connecting
  }

  async verify(): Promise<void> {
    await this.conn()
  }

  async listFolders() {
    const c = await this.conn()
    const boxes = await c.list({ statusQuery: { messages: true, unseen: true } })
    const usable = boxes.filter((b) => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent'))
    // Gmail has no \Archive folder; archiving there means "All Mail"
    const hasArchive = usable.some((b) => b.specialUse === '\\Archive')
    return usable.map((b) => ({
      id: b.path,
      name: b.name,
      parentId: b.parentPath || null,
      role: roleOf(b, hasArchive),
      unread: b.status?.unseen ?? 0,
      total: b.status?.messages ?? 0
    }))
  }

  async syncFolder(folderId: string, state: string | null, limit: number): Promise<FolderSync> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId, { readOnly: true })
    try {
      const box = c.mailbox
      if (!box) throw new Error(`Could not open ${folderId}`)
      const validity = String(box.uidValidity)
      const prev = parseState(state)

      if (!prev || prev.validity !== validity) {
        // First sync (or the server renumbered the folder): the newest `limit` messages, by sequence number
        const upserts: RemoteSummary[] = []
        if (box.exists > 0) for await (const m of c.fetch(`${Math.max(1, box.exists - limit + 1)}:*`, SUMMARY)) upserts.push(summarise(m))
        const uids = upserts.map((u) => Number(u.remoteId))
        const high = uids.length ? Math.max(...uids) : 0
        const low = uids.length ? Math.min(...uids) : 1
        return { upserts, flagUpdates: [], deletes: [], reset: true, state: formatState(validity, high, low, box.exists <= limit) }
      }

      // New mail: anything above the highest UID we have. "n:*" always returns the last message, so filter.
      const upserts: RemoteSummary[] = []
      let high = prev.high
      for await (const m of c.fetch(`${prev.high + 1}:*`, SUMMARY, { uid: true })) {
        if (m.uid <= prev.high) continue
        upserts.push(summarise(m))
        high = Math.max(high, m.uid)
      }

      // Deletions: which of our UID range still exists. Flags: re-read for the newest known messages.
      // (CONDSTORE/QRESYNC would make this incremental; worth adding when someone has a huge folder.)
      const existing = prev.high >= prev.low ? (await c.search({ uid: `${prev.low}:${prev.high}` }, { uid: true })) || [] : []
      const flagUpdates: FolderSync['flagUpdates'] = []
      const recent = existing.slice(-FLAG_WINDOW)
      if (recent.length) {
        for await (const m of c.fetch(recent.join(','), { uid: true, flags: true }, { uid: true }))
          flagUpdates.push({ remoteId: String(m.uid), unread: !m.flags?.has('\\Seen'), flagged: !!m.flags?.has('\\Flagged') })
      }
      return {
        upserts,
        flagUpdates,
        deletes: [],
        existing: [...existing.map(String), ...upserts.map((u) => u.remoteId)],
        reset: false,
        state: formatState(validity, high, prev.low, prev.done)
      }
    } finally {
      lock.release()
    }
  }

  async fetchOlder(folderId: string, state: string, limit: number) {
    const prev = parseState(state)
    if (!prev || prev.done || prev.low <= 1) return { upserts: [], state, done: true }
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId, { readOnly: true })
    try {
      const older = (await c.search({ uid: `1:${prev.low - 1}` }, { uid: true })) || []
      const batch = older.slice(-limit)
      const upserts: RemoteSummary[] = []
      if (batch.length) for await (const m of c.fetch(batch.join(','), SUMMARY, { uid: true })) upserts.push(summarise(m))
      const done = older.length <= limit
      const low = batch.length ? Math.min(...batch) : prev.low
      return { upserts, state: formatState(prev.validity, prev.high, low, done), done }
    } finally {
      lock.release()
    }
  }

  private async parsed(folderId: string, remoteId: string): Promise<ParsedMail> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId, { readOnly: true })
    try {
      const msg = await c.fetchOne(remoteId, { source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('Message no longer exists on the server')
      // keepCidLinks: fetchBody embeds inline images itself, so it can cap their size and mark them inline
      return await simpleParser(msg.source, { keepCidLinks: true })
    } finally {
      lock.release()
    }
  }

  async fetchBody(folderId: string, remoteId: string) {
    const p = await this.parsed(folderId, remoteId)
    let html = typeof p.html === 'string' ? p.html : null
    const embedded = new Set<number>()
    // Inline images (cid:) become data: URIs so the sandboxed viewer can show them
    if (html)
      p.attachments.forEach((a, i) => {
        if (!a.cid || a.size > MAX_INLINE) return
        const re = new RegExp(`cid:${a.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
        if (!re.test(html!)) return
        html = html!.replace(re, `data:${a.contentType};base64,${a.content.toString('base64')}`)
        embedded.add(i)
      })
    return {
      html,
      text: p.text ?? null,
      cc: flatten(p.cc),
      attachments: p.attachments.map((a, i) => ({
        id: String(i),
        filename: a.filename ?? `attachment-${i + 1}`,
        contentType: a.contentType,
        size: a.size,
        inline: embedded.has(i)
      })),
      hasRemoteContent: !!html && /\b(src|background)\s*=\s*["']?https?:/i.test(html),
      messageId: p.messageId ?? '',
      references: typeof p.references === 'string' ? [p.references] : (p.references ?? []),
      replyTo: flatten(p.replyTo)
    }
  }

  async fetchAttachment(folderId: string, remoteId: string, attachmentId: string): Promise<AttachmentData> {
    const p = await this.parsed(folderId, remoteId)
    const a = p.attachments[Number(attachmentId)]
    if (!a) throw new Error('Attachment not found')
    return { filename: a.filename ?? `attachment-${Number(attachmentId) + 1}`, contentType: a.contentType, content: a.content }
  }

  private async inFolder<T>(folderId: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId)
    try {
      return await fn(c)
    } finally {
      lock.release()
    }
  }

  async setFlags(folderId: string, remoteIds: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void> {
    await this.inFolder(folderId, async (c) => {
      const range = remoteIds.join(',')
      const set = (on: boolean, flag: string) => (on ? c.messageFlagsAdd(range, [flag], { uid: true }) : c.messageFlagsRemove(range, [flag], { uid: true }))
      if (flags.read !== undefined) await set(flags.read, '\\Seen')
      if (flags.flagged !== undefined) await set(flags.flagged, '\\Flagged')
    })
  }

  async move(folderId: string, remoteIds: string[], toFolderId: string): Promise<void> {
    await this.inFolder(folderId, async (c) => {
      if (!(await c.messageMove(remoteIds.join(','), toFolderId, { uid: true }))) throw new Error(`Couldn't move to ${toFolderId}`)
    })
  }

  async remove(folderId: string, remoteIds: string[]): Promise<void> {
    await this.inFolder(folderId, async (c) => {
      await c.messageDelete(remoteIds.join(','), { uid: true })
    })
  }

  async send(message: CompiledMessage, sentFolderId: string | null): Promise<void> {
    const s = this.account.smtp
    if (!s) throw new Error('No SMTP server configured for this account')
    const auth = await this.auth()
    const user = this.account.username || this.account.email
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      auth: 'accessToken' in auth ? { type: 'OAuth2', user, accessToken: auth.accessToken } : { user, pass: auth.pass }
    })
    const raw = await message.mime()
    try {
      await transport.sendMail({ envelope: message.envelope, raw })
    } finally {
      transport.close()
    }
    // Gmail and Microsoft file a copy in Sent themselves; everyone else needs us to
    const autoSaves = this.account.kind === 'google' || /(^|\.)(gmail|googlemail|office365|outlook)\.com$/i.test(s.host)
    if (!autoSaves && sentFolderId) {
      const c = await this.conn()
      await c.append(sentFolderId, raw, ['\\Seen']).catch(() => {
        // The message went out; failing to file a copy shouldn't look like a failed send.
      })
    }
  }

  async saveDraft(message: CompiledMessage, draftsFolderId: string | null, replaces: { folderId: string; remoteId: string } | null) {
    if (!draftsFolderId) throw new Error('This account has no Drafts folder')
    const c = await this.conn()
    const res = await c.append(draftsFolderId, await message.mime(), ['\\Draft', '\\Seen'])
    if (replaces) await this.remove(replaces.folderId, [replaces.remoteId]).catch(() => {})
    return res && res.uid ? { folderId: draftsFolderId, remoteId: String(res.uid) } : null
  }

  /** A second connection that sits in IDLE on the inbox, so new mail shows up within seconds */
  watch(inboxId: string, onChange: () => void): () => void {
    let stopped = false
    let client: ImapFlow | null = null
    let delay = 5_000
    const retry = () => {
      if (!stopped) setTimeout(start, delay)
    }
    const start = async (): Promise<void> => {
      if (stopped) return
      try {
        // This connection only waits for news, so go into IDLE almost at once (imapflow's default waits 15 s)
        client = await this.makeClient({ autoIdleDelay: 1000 })
        client.on('exists', onChange)
        client.on('flags', onChange)
        client.on('expunge', onChange)
        client.on('close', retry)
        await client.mailboxOpen(inboxId, { readOnly: true })
        delay = 5_000
        // imapflow enters IDLE by itself once the connection is quiet
      } catch {
        // Offline or auth trouble: back off up to 5 minutes; the normal sync reports the actual error
        delay = Math.min(delay * 2, 300_000)
        retry()
      }
    }
    void start()
    return () => {
      stopped = true
      void client?.logout().catch(() => {})
    }
  }

  async close(): Promise<void> {
    await this.client?.logout().catch(() => {})
    this.client = null
  }
}

const SUMMARY = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, threadId: true, headers: ['references'] }

function summarise(m: FetchMessageObject): RemoteSummary {
  const e = m.envelope
  const messageId = e?.messageId || `<uid-${m.uid}@inkwell.local>`
  const refs = m.headers ? (m.headers.toString().match(/<[^>]+>/g) ?? []) : []
  return {
    remoteId: String(m.uid),
    subject: e?.subject || '(no subject)',
    from: e?.from?.[0] ? addr(e.from[0]) : null,
    to: (e?.to ?? []).map(addr),
    date: new Date(e?.date ?? m.internalDate ?? Date.now()).getTime(),
    preview: '',
    unread: !m.flags?.has('\\Seen'),
    flagged: !!m.flags?.has('\\Flagged'),
    hasAttachments: m.bodyStructure ? hasAttachment(m.bodyStructure) : false,
    messageId,
    // Gmail gives a real thread ID; elsewhere the first message in the References chain identifies the conversation
    threadId: m.threadId ? `gm:${m.threadId}` : (refs[0] ?? e?.inReplyTo ?? messageId)
  }
}

function parseState(state: string | null): { validity: string; high: number; low: number; done: boolean } | null {
  if (!state) return null
  const [validity, high, low, done] = state.split(':')
  if (!validity || high === undefined) return null
  return { validity, high: Number(high) || 0, low: Number(low) || 1, done: done === '1' }
}

const formatState = (validity: string, high: number, low: number, done: boolean): string => `${validity}:${high}:${low}:${done ? 1 : 0}`

function roleOf(b: ListResponse, hasArchive: boolean): FolderRole {
  const use = b.specialUse
  if (b.path.toUpperCase() === 'INBOX' || use === '\\Inbox') return 'inbox'
  const map: Record<string, FolderRole> = { '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk', '\\Archive': 'archive' }
  if (use === '\\All' && !hasArchive) return 'archive'
  return (use && map[use]) || 'other'
}

function addr(a: { name?: string; address?: string }): Address {
  return { name: a.name ?? '', address: a.address ?? '' }
}

function flatten(a: AddressObject | AddressObject[] | undefined): Address[] {
  if (!a) return []
  return (Array.isArray(a) ? a : [a]).flatMap((o) => o.value.map((v) => ({ name: v.name, address: v.address ?? '' })))
}

function hasAttachment(s: MessageStructureObject): boolean {
  if (s.disposition === 'attachment') return true
  return (s.childNodes ?? []).some(hasAttachment)
}
