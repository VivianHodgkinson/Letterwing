import type { Account, Address, FolderRole, Invite } from '@shared/types'
import { poll } from '../pace'
import type { AttachmentData, CompiledMessage, FolderSync, MailConnector, RemoteSummary } from './types'

const GRAPH = 'https://graph.microsoft.com/v1.0'
/** Graph rejects request bodies over 4 MB; MIME is base64'd on top, so stay well under */
const MAX_INLINE_MIME = 2.8 * 1024 * 1024
/** Attachments up to 3 MB can be posted directly; bigger ones need an upload session */
const MAX_SIMPLE_ATTACHMENT = 3 * 1024 * 1024
const CHUNK = 3_932_160 // multiple of 320 KiB, as upload sessions require

const SELECT = 'subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,flag,hasAttachments,internetMessageId,conversationId'

type GMessage = {
  id: string
  subject?: string
  from?: { emailAddress: { name: string; address: string } }
  toRecipients?: { emailAddress: { name: string; address: string } }[]
  receivedDateTime?: string
  bodyPreview?: string
  isRead?: boolean
  flag?: { flagStatus: string }
  hasAttachments?: boolean
  internetMessageId?: string
  conversationId?: string
  '@removed'?: unknown
}

/** Folder state: the delta link (or the next page of an unfinished delta), and how far back we've fetched */
interface GState {
  delta: string
  oldest: number
  done: boolean
}

/**
 * Microsoft 365 / Exchange Online / personal Microsoft accounts via Microsoft Graph. The first
 * sync takes the newest messages; after that a delta query, limited to that
 * window and newer, brings down only changes. Older mail is paged in on demand.
 */
export class GraphConnector implements MailConnector {
  constructor(
    private account: Account,
    private token: () => Promise<string>
  ) {}

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
        ...init,
        headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...init.headers }
      })
      // Graph throttles with 429/503 and says how long to wait
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await new Promise((r) => setTimeout(r, Number(res.headers.get('Retry-After') ?? 2) * 1000))
        continue
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
        throw new GraphError(res.status, body.error?.code ?? '', `Microsoft Graph: ${body.error?.message ?? res.statusText} (${res.status})`)
      }
      return res
    }
  }

  async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init)
    return res.status === 204 || res.status === 202 ? (undefined as T) : ((await res.json()) as T)
  }

  async verify(): Promise<void> {
    await this.call('/me?$select=mail')
  }

  async listFolders() {
    type F = { id: string; displayName: string; unreadItemCount: number; totalItemCount: number; childFolderCount: number }
    const out: { id: string; name: string; parentId: string | null; role: FolderRole; unread: number; total: number }[] = []
    // Well-known folders, so we can tag roles (Graph doesn't put the role on the folder itself)
    const roles = new Map<string, FolderRole>()
    const known = [['inbox', 'inbox'], ['sentitems', 'sent'], ['drafts', 'drafts'], ['deleteditems', 'trash'], ['junkemail', 'junk'], ['archive', 'archive']] as const
    await Promise.all(
      known.map(async ([wk, role]) => {
        const f = await this.call<{ id: string }>(`/me/mailFolders/${wk}?$select=id`).catch(() => null)
        if (f) roles.set(f.id, role)
      })
    )
    const walk = async (url: string, parentId: string | null): Promise<void> => {
      let next: string | undefined = url
      while (next) {
        const page: { value: F[]; '@odata.nextLink'?: string } = await this.call(next)
        for (const f of page.value) {
          out.push({ id: f.id, name: f.displayName, parentId, role: roles.get(f.id) ?? 'other', unread: f.unreadItemCount, total: f.totalItemCount })
          if (f.childFolderCount > 0) await walk(`/me/mailFolders/${f.id}/childFolders?$top=100`, f.id)
        }
        next = page['@odata.nextLink']
      }
    }
    await walk('/me/mailFolders?$top=100', null)
    return out
  }

  async syncFolder(folderId: string, state: string | null, limit: number): Promise<FolderSync> {
    const prev = parseState(state)
    if (!prev) {
      // First sync: newest `limit` messages, then open a delta over that window to track changes from here on
      const page = await this.call<{ value: GMessage[]; '@odata.nextLink'?: string }>(
        `/me/mailFolders/${folderId}/messages?$select=${SELECT}&$orderby=receivedDateTime desc&$top=${limit}`
      )
      const upserts = page.value.map(summarise)
      const oldest = upserts.length ? Math.min(...upserts.map((u) => u.date)) : Date.now()
      const delta = await this.finishDelta(this.deltaStart(folderId, oldest), [], [])
      return { upserts, flagUpdates: [], deletes: [], reset: true, state: JSON.stringify({ delta: delta.link, oldest, done: !page['@odata.nextLink'] }) }
    }
    const upserts: RemoteSummary[] = []
    const deletes: string[] = []
    try {
      const { link } = await this.finishDelta(prev.delta, upserts, deletes)
      return { upserts, flagUpdates: [], deletes, reset: false, state: JSON.stringify({ ...prev, delta: link }) }
    } catch (e) {
      // An expired delta token means start over
      if (e instanceof GraphError && (e.status === 410 || /SyncState|resync/i.test(e.code))) return this.syncFolder(folderId, null, limit)
      throw e
    }
  }

  private deltaStart(folderId: string, oldest: number): string {
    return `/me/mailFolders/${folderId}/messages/delta?$select=${SELECT}&$filter=receivedDateTime+ge+${new Date(oldest).toISOString()}`
  }

  /**
   * Follow a delta chain to its delta link, collecting changes. Graph sometimes reports a message with only
   * the properties that changed (a new message may arrive as just its read state; reading it on a phone
   * sends just isRead). Those are fetched in full, so a partial entry never blanks out a subject or sender.
   */
  private async finishDelta(url: string, upserts: RemoteSummary[], deletes: string[]): Promise<{ link: string }> {
    let next: string | undefined = url
    const partial: string[] = []
    let link: string | undefined
    while (next) {
      const page: { value: GMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await this.call(next, {
        headers: { Prefer: 'odata.maxpagesize=100' }
      })
      for (const m of page.value) {
        if (m['@removed']) deletes.push(m.id)
        else if (isComplete(m)) upserts.push(summarise(m))
        else partial.push(m.id)
      }
      link = page['@odata.deltaLink']
      if (link) break
      next = page['@odata.nextLink']
    }
    if (!link) throw new Error('Microsoft Graph ended a delta query without a delta link')
    const known = new Set(upserts.map((u) => u.remoteId))
    const { found, gone } = await this.fetchSummaries([...new Set(partial)].filter((id) => !known.has(id)))
    upserts.push(...found)
    deletes.push(...gone)
    return { link }
  }

  /** Full summaries for these message IDs, 20 per $batch. Messages deleted in the meantime come back in `gone`. */
  private async fetchSummaries(ids: string[]): Promise<{ found: RemoteSummary[]; gone: string[] }> {
    const found: RemoteSummary[] = []
    const gone: string[] = []
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20)
      let pending = chunk
      for (let attempt = 0; pending.length && attempt < 4; attempt++) {
        const out = await this.call<{ responses: { id: string; status: number; body?: GMessage }[] }>('/$batch', {
          method: 'POST',
          body: JSON.stringify({ requests: pending.map((id) => ({ id, method: 'GET', url: `/me/messages/${id}?$select=${SELECT}` })) })
        })
        const retry: string[] = []
        for (const r of out.responses) {
          if (r.status === 200 && r.body) found.push(summarise(r.body))
          else if (r.status === 404) gone.push(r.id)
          else if (r.status === 429 || r.status >= 500) retry.push(r.id)
          else throw new GraphError(r.status, '', `Microsoft Graph: couldn't read a new message (${r.status})`)
        }
        if (retry.length) await new Promise((res) => setTimeout(res, 2000))
        pending = retry
      }
      if (pending.length) throw new GraphError(429, '', 'Microsoft Graph is busy; new mail will appear on the next check')
    }
    return { found, gone }
  }

  async fetchOlder(folderId: string, state: string, limit: number) {
    const prev = parseState(state)
    if (!prev || prev.done) return { upserts: [], state, done: true }
    const page = await this.call<{ value: GMessage[]; '@odata.nextLink'?: string }>(
      `/me/mailFolders/${folderId}/messages?$select=${SELECT}&$filter=receivedDateTime lt ${new Date(prev.oldest).toISOString()}&$orderby=receivedDateTime desc&$top=${limit}`
    )
    const upserts = page.value.map(summarise)
    const oldest = upserts.length ? Math.min(...upserts.map((u) => u.date)) : prev.oldest
    const done = !page['@odata.nextLink']
    return { upserts, state: JSON.stringify({ ...prev, oldest, done }), done }
  }

  async fetchBody(_folderId: string, remoteId: string) {
    type B = {
      '@odata.type'?: string
      body: { contentType: 'html' | 'text'; content: string }
      ccRecipients: { emailAddress: { name: string; address: string } }[]
      replyTo: { emailAddress: { name: string; address: string } }[]
      internetMessageId?: string
      internetMessageHeaders?: { name: string; value: string }[]
      attachments?: { id: string; name: string; contentType: string; size: number; isInline: boolean }[]
    }
    const m = await this.call<B>(
      `/me/messages/${remoteId}?$select=body,ccRecipients,replyTo,internetMessageId,internetMessageHeaders&$expand=attachments($select=id,name,contentType,size,isInline)`
    )
    let html = m.body.contentType === 'html' ? m.body.content : null
    const embedded = new Set<string>()
    // Inline images (cid:) become data: URIs so the sandboxed viewer can show them
    if (html && /cid:/i.test(html)) {
      const inline = await this.call<{ value: { id: string; contentId?: string; contentType: string; contentBytes?: string }[] }>(
        `/me/messages/${remoteId}/attachments?$filter=isInline eq true`
      ).catch(() => ({ value: [] }))
      for (const a of inline.value) {
        if (!a.contentId || !a.contentBytes) continue
        const re = new RegExp(`cid:${a.contentId.replace(/[<>]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
        if (!re.test(html)) continue
        html = html.replace(re, `data:${a.contentType};base64,${a.contentBytes}`)
        embedded.add(a.id)
      }
    }
    const refs = m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === 'references')?.value.match(/<[^>]+>/g) ?? []
    const invite = m['@odata.type']?.includes('eventMessage') ? await this.invite(remoteId).catch(() => undefined) : undefined
    return {
      ...(invite ? { invite } : {}),
      html,
      text: m.body.contentType === 'text' ? m.body.content : null,
      cc: m.ccRecipients.map(toAddr),
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.name,
        contentType: a.contentType,
        size: a.size,
        inline: embedded.has(a.id) || (a.isInline && !!html && !/cid:/i.test(html))
      })),
      hasRemoteContent: !!html && /\b(src|background)\s*=\s*["']?https?:/i.test(html),
      messageId: m.internetMessageId ?? '',
      references: refs,
      replyTo: (m.replyTo ?? []).map(toAddr)
    }
  }

  /** A meeting request/cancellation and the event it put in the calendar */
  private async invite(remoteId: string): Promise<Invite | undefined> {
    type T = { dateTime: string; timeZone: string }
    type E = {
      meetingMessageType?: string
      event?: {
        id: string
        iCalUId: string
        subject?: string
        start: T
        end: T
        isAllDay: boolean
        location?: { displayName?: string }
        organizer?: { emailAddress: { name: string; address: string } }
        responseStatus?: { response: string }
        type: string
        seriesMasterId?: string
      }
    }
    const m = await this.call<E>(
      `/me/messages/${remoteId}?$select=meetingMessageType&$expand=microsoft.graph.eventMessage/event($select=id,iCalUId,subject,start,end,isAllDay,location,organizer,responseStatus,type,seriesMasterId)`,
      { headers: { Prefer: 'outlook.timezone="UTC"' } }
    )
    const e = m.event
    if (!e) return undefined
    const time = (t: T) => {
      if (e.isAllDay) {
        const [y, mo, d] = t.dateTime.slice(0, 10).split('-').map(Number)
        return new Date(y, mo - 1, d).getTime()
      }
      return Date.parse(t.dateTime.endsWith('Z') ? t.dateTime : t.dateTime + 'Z')
    }
    const method: Record<string, Invite['method']> = { meetingRequest: 'REQUEST', meetingCancelled: 'CANCEL', meetingAccepted: 'REPLY', meetingTenativelyAccepted: 'REPLY', meetingDeclined: 'REPLY' }
    const status: Record<string, Invite['myStatus']> = { accepted: 'accepted', tentativelyAccepted: 'tentative', declined: 'declined', notResponded: 'needsAction', organizer: 'organizer' }
    return {
      method: method[m.meetingMessageType ?? ''] ?? 'OTHER',
      uid: e.iCalUId,
      title: e.subject || '(no title)',
      start: time(e.start),
      end: time(e.end),
      allDay: e.isAllDay,
      location: e.location?.displayName ?? '',
      organizer: e.organizer ? { name: e.organizer.emailAddress.name, address: e.organizer.emailAddress.address } : null,
      myStatus: status[e.responseStatus?.response ?? ''] ?? 'none',
      recurring: e.type !== 'singleInstance',
      // Answer the series when the invite is for one
      eventId: e.seriesMasterId ?? e.id
    }
  }

  async fetchAttachment(_folderId: string, remoteId: string, attachmentId: string): Promise<AttachmentData> {
    const meta = await this.call<{ name: string; contentType: string }>(`/me/messages/${remoteId}/attachments/${attachmentId}?$select=name,contentType`)
    const res = await this.request(`/me/messages/${remoteId}/attachments/${attachmentId}/$value`)
    return { filename: meta.name, contentType: meta.contentType, content: Buffer.from(await res.arrayBuffer()) }
  }

  /**
   * Run many small requests through Graph's $batch endpoint, 20 at a time. Items that get
   * throttled are retried after the wait Graph asks for; any other failure is thrown.
   */
  private async batch(requests: { method: string; url: string; body?: unknown }[]): Promise<void> {
    type Res = { id: string; status: number; headers?: Record<string, string>; body?: { error?: { message?: string } } }
    let pending = requests.map((r, i) => ({ ...r, id: String(i) }))
    for (let attempt = 0; pending.length; attempt++) {
      const retry: typeof pending = []
      let wait = 0
      for (let i = 0; i < pending.length; i += 20) {
        const chunk = pending.slice(i, i + 20)
        const out = await this.call<{ responses: Res[] }>('/$batch', {
          method: 'POST',
          body: JSON.stringify({
            requests: chunk.map((r) => ({ id: r.id, method: r.method, url: r.url, ...(r.body ? { body: r.body, headers: { 'Content-Type': 'application/json' } } : {}) }))
          })
        })
        for (const res of out.responses) {
          if (res.status < 300 || res.status === 404) continue // 404: already gone, which is what we wanted for deletes and moves
          const req = chunk.find((r) => r.id === res.id)!
          if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 5) {
            retry.push(req)
            wait = Math.max(wait, Number(res.headers?.['Retry-After'] ?? res.headers?.['retry-after'] ?? 2))
            continue
          }
          throw new GraphError(res.status, '', `Microsoft Graph: ${res.body?.error?.message ?? 'request failed'} (${res.status})`)
        }
      }
      if (retry.length) await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000))
      pending = retry
    }
  }

  async setFlags(_folderId: string, remoteIds: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (flags.read !== undefined) patch.isRead = flags.read
    if (flags.flagged !== undefined) patch.flag = { flagStatus: flags.flagged ? 'flagged' : 'notFlagged' }
    await this.batch(remoteIds.map((id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body: patch })))
  }

  async move(_folderId: string, remoteIds: string[], toFolderId: string): Promise<void> {
    await this.batch(remoteIds.map((id) => ({ method: 'POST', url: `/me/messages/${id}/move`, body: { destinationId: toFolderId } })))
  }

  async remove(_folderId: string, remoteIds: string[]): Promise<void> {
    await this.batch(remoteIds.map((id) => ({ method: 'DELETE', url: `/me/messages/${id}` })))
  }

  /** IDs of every message in a folder matching a filter, following all pages */
  private async allIds(folderId: string, filter?: string): Promise<string[]> {
    const ids: string[] = []
    let url: string | undefined = `/me/mailFolders/${folderId}/messages?$select=id&$top=500${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}`
    while (url) {
      const page: { value: { id: string }[]; '@odata.nextLink'?: string } = await this.call(url)
      ids.push(...page.value.map((m) => m.id))
      url = page['@odata.nextLink']
    }
    return ids
  }

  async markFolderRead(folderId: string): Promise<void> {
    await this.setFlags(folderId, await this.allIds(folderId, 'isRead eq false'), { read: true })
  }

  async emptyFolder(folderId: string): Promise<void> {
    // permanentDelete skips Recoverable Items, so an emptied Deleted Items really is empty
    await this.batch((await this.allIds(folderId)).map((id) => ({ method: 'POST', url: `/me/messages/${id}/permanentDelete` })))
  }

  async createFolder(parentId: string | null, name: string): Promise<void> {
    const n = name.trim()
    if (!n) throw new Error('Give the folder a name.')
    await this.call(parentId ? `/me/mailFolders/${parentId}/childFolders` : '/me/mailFolders', { method: 'POST', body: JSON.stringify({ displayName: n }) })
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    const n = name.trim()
    if (!n) throw new Error('Give the folder a name.')
    await this.call(`/me/mailFolders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ displayName: n }) })
  }

  async deleteFolder(folderId: string): Promise<void> {
    // Like the web client: the folder goes to Deleted Items with its contents
    await this.call(`/me/mailFolders/${folderId}`, { method: 'DELETE' })
  }

  /** Create a message in Drafts from MIME, uploading big attachments separately. Returns its ID. */
  private async createFromMime(message: CompiledMessage): Promise<string> {
    const total = message.attachments.reduce((n, a) => n + a.content.length, 0)
    const small = total < MAX_INLINE_MIME
    const mime = small ? await message.mime() : await message.mimeWithoutAttachments()
    const created = await this.call<{ id: string }>('/me/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: mime.toString('base64')
    })
    if (!small) for (const a of message.attachments) await this.upload(created.id, a)
    return created.id
  }

  private async upload(messageId: string, a: AttachmentData): Promise<void> {
    if (a.content.length <= MAX_SIMPLE_ATTACHMENT) {
      await this.call(`/me/messages/${messageId}/attachments`, {
        method: 'POST',
        body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.content.toString('base64') })
      })
      return
    }
    const session = await this.call<{ uploadUrl: string }>(`/me/messages/${messageId}/attachments/createUploadSession`, {
      method: 'POST',
      body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.content.length, contentType: a.contentType } })
    })
    for (let start = 0; start < a.content.length; start += CHUNK) {
      const chunk = a.content.subarray(start, start + CHUNK)
      // The upload URL is pre-authorised; sending the Graph token to it is rejected
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${a.content.length}`, 'Content-Length': String(chunk.length) },
        body: new Uint8Array(chunk)
      })
      if (!res.ok) throw new Error(`Uploading ${a.filename} failed (${res.status})`)
    }
  }

  async send(message: CompiledMessage): Promise<void> {
    const total = message.attachments.reduce((n, a) => n + a.content.length, 0)
    if (total < MAX_INLINE_MIME) {
      // One request; Exchange files the copy in Sent Items itself
      await this.call('/me/sendMail', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: (await message.mime()).toString('base64') })
      return
    }
    const id = await this.createFromMime(message)
    await this.call(`/me/messages/${id}/send`, { method: 'POST' })
  }

  async saveDraft(message: CompiledMessage, draftsFolderId: string | null, replaces: { folderId: string; remoteId: string } | null) {
    const id = await this.createFromMime(message)
    if (replaces) await this.remove(replaces.folderId, [replaces.remoteId]).catch(() => {})
    return { folderId: draftsFolderId ?? 'drafts', remoteId: id }
  }

  /** Graph push needs a public webhook, which a desktop app doesn't have; a delta poll every minute is cheap instead */
  /** Graph can't push to a desktop app, so check often: see pace.ts */
  watch(_inboxId: string, onChange: () => void): () => void {
    return poll(onChange)
  }

  async close(): Promise<void> {}
}

export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

function parseState(state: string | null): GState | null {
  if (!state) return null
  try {
    const s = JSON.parse(state) as GState
    return s.delta ? s : null
  } catch {
    return null // a state from an older Letterwing build: resync
  }
}

/** A delta entry carries every selected property only when it's a full record; partial ones lack the received time */
function isComplete(m: GMessage): boolean {
  return typeof m.receivedDateTime === 'string'
}

function summarise(m: GMessage): RemoteSummary {
  return {
    remoteId: m.id,
    subject: m.subject || '(no subject)',
    from: m.from ? toAddr(m.from) : null,
    to: (m.toRecipients ?? []).map(toAddr),
    date: m.receivedDateTime ? Date.parse(m.receivedDateTime) : Date.now(),
    preview: m.bodyPreview ?? '',
    unread: m.isRead === false,
    flagged: m.flag?.flagStatus === 'flagged',
    hasAttachments: !!m.hasAttachments,
    messageId: m.internetMessageId || `<${m.id}@graph>`,
    threadId: m.conversationId ? `conv:${m.conversationId}` : m.id
  }
}

function toAddr(r: { emailAddress: { name: string; address: string } }): Address {
  return { name: r.emailAddress?.name ?? '', address: r.emailAddress?.address ?? '' }
}
