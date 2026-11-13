import { ImapFlow, type ListResponse, type MessageStructureObject } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import type { Account, Address, FolderRole } from '@shared/types'
import type { FolderSync, MailConnector, RemoteSummary } from './types'

/**
 * Any IMAP server: Gmail (OAuth), Microsoft 365 / personal Microsoft accounts IMAP, Fastmail,
 * iCloud, cPanel/Dovecot hosting, etc. `auth` returns either a password or an
 * OAuth access token (sent as XOAUTH2).
 */
export class ImapConnector implements MailConnector {
  private client: ImapFlow | null = null

  constructor(
    private account: Account,
    private auth: () => Promise<{ pass: string } | { accessToken: string }>
  ) {}

  private async conn(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    const s = this.account.imap
    if (!s) throw new Error('No IMAP server configured')
    const client = new ImapFlow({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      doSTARTTLS: s.security === 'starttls' ? true : undefined,
      auth: { user: this.account.username || this.account.email, ...(await this.auth()) },
      logger: false,
      emitLogs: false
    })
    // A dropped connection is not fatal: the next call reconnects.
    client.on('error', () => {})
    await client.connect()
    this.client = client
    return client
  }

  async verify(): Promise<void> {
    await this.conn()
  }

  async listFolders(): Promise<{ id: string; name: string; parentId: string | null; role: FolderRole; unread: number; total: number }[]> {
    const c = await this.conn()
    const boxes = await c.list({ statusQuery: { messages: true, unseen: true } })
    return boxes
      .filter((b) => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent'))
      .map((b) => ({
        id: b.path,
        name: b.name,
        parentId: b.parentPath || null,
        role: roleOf(b),
        unread: b.status?.unseen ?? 0,
        total: b.status?.messages ?? 0
      }))
  }

  /**
   * State is "UIDVALIDITY:highestUID". New mail is fetched by UID range; flag
   * changes and deletions on the recent window are picked up by re-reading
   * flags for the last `limit` UIDs (cheap: flags only, no headers).
   */
  async syncFolder(folderId: string, state: string | null, limit: number): Promise<FolderSync> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId, { readOnly: true })
    try {
      const box = c.mailbox
      if (!box) throw new Error(`Could not open ${folderId}`)
      const validity = String(box.uidValidity)
      const [prevValidity, prevHigh] = (state ?? '').split(':')
      const reset = !state || prevValidity !== validity
      const high = reset ? 0 : Number(prevHigh) || 0

      const upserts: RemoteSummary[] = []
      let maxUid = high
      if (box.exists > 0) {
        // On a first sync take the newest `limit` messages by sequence number; afterwards, anything above the old high UID.
        const range = reset ? `${Math.max(1, box.exists - limit + 1)}:*` : `${high + 1}:*`
        for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: !reset })) {
          if (!reset && m.uid <= high) continue // "n:*" always returns at least the last message
          maxUid = Math.max(maxUid, m.uid)
          const e = m.envelope
          upserts.push({
            remoteId: String(m.uid),
            subject: e?.subject ?? '(no subject)',
            from: e?.from?.[0] ? addr(e.from[0]) : null,
            to: (e?.to ?? []).map(addr),
            date: new Date(e?.date ?? m.internalDate ?? Date.now()).getTime(),
            preview: '',
            unread: !m.flags?.has('\\Seen'),
            flagged: !!m.flags?.has('\\Flagged'),
            hasAttachments: m.bodyStructure ? hasAttachment(m.bodyStructure) : false
          })
        }
      }

      // Flag refresh + deletion detection for already-known messages
      const deletes: string[] = []
      const flagUpdates: FolderSync['flagUpdates'] = []
      if (!reset && high > 0) {
        const from = Math.max(1, high - limit * 2)
        const seen = new Set<number>()
        for await (const m of c.fetch(`${from}:${high}`, { uid: true, flags: true }, { uid: true })) {
          seen.add(m.uid)
          flagUpdates.push({ remoteId: String(m.uid), unread: !m.flags?.has('\\Seen'), flagged: !!m.flags?.has('\\Flagged') })
        }
        for (let u = from; u <= high; u++) if (!seen.has(u)) deletes.push(String(u))
      }
      return { upserts, flagUpdates, deletes, reset, state: `${validity}:${maxUid}` }
    } finally {
      lock.release()
    }
  }

  async fetchBody(folderId: string, remoteId: string) {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId, { readOnly: true })
    try {
      const msg = await c.fetchOne(remoteId, { source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('Message no longer exists on the server')
      const p = await simpleParser(msg.source)
      const html = typeof p.html === 'string' ? p.html : null
      return {
        html,
        text: p.text ?? null,
        cc: flatten(p.cc),
        attachments: p.attachments.map((a, i) => ({
          id: String(i),
          filename: a.filename ?? `attachment-${i + 1}`,
          contentType: a.contentType,
          size: a.size,
          inline: a.contentDisposition === 'inline' && !!a.cid
        })),
        hasRemoteContent: !!html && /\b(src|background)\s*=\s*["']?https?:/i.test(html)
      }
    } finally {
      lock.release()
    }
  }

  async setFlags(folderId: string, remoteIds: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderId)
    try {
      const range = remoteIds.join(',')
      if (flags.read !== undefined) await (flags.read ? c.messageFlagsAdd : c.messageFlagsRemove).call(c, range, ['\\Seen'], { uid: true })
      if (flags.flagged !== undefined) await (flags.flagged ? c.messageFlagsAdd : c.messageFlagsRemove).call(c, range, ['\\Flagged'], { uid: true })
    } finally {
      lock.release()
    }
  }

  async close(): Promise<void> {
    await this.client?.logout().catch(() => {})
    this.client = null
  }
}

function roleOf(b: ListResponse): FolderRole {
  const use = b.specialUse
  if (b.path.toUpperCase() === 'INBOX' || use === '\\Inbox') return 'inbox'
  const map: Record<string, FolderRole> = { '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk', '\\Archive': 'archive' }
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
