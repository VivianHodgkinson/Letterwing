import type { Account, Address, FolderRole } from '@shared/types'
import type { FolderSync, MailConnector, RemoteSummary } from './types'

const GRAPH = 'https://graph.microsoft.com/v1.0'

/**
 * Microsoft 365 / Exchange Online / personal Microsoft accounts via Microsoft Graph. Uses
 * delta queries per folder, so after the first sync only changes come down.
 */
export class GraphConnector implements MailConnector {
  constructor(
    private account: Account,
    private token: () => Promise<string>
  ) {}

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
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
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        throw new Error(`Microsoft Graph: ${body.error?.message ?? res.statusText} (${res.status})`)
      }
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
    }
  }

  async verify(): Promise<void> {
    await this.call('/me?$select=mail')
  }

  async listFolders() {
    type F = { id: string; displayName: string; parentFolderId: string; unreadItemCount: number; totalItemCount: number; childFolderCount: number; wellKnownName?: string }
    const out: { id: string; name: string; parentId: string | null; role: FolderRole; unread: number; total: number }[] = []
    // Well-known folders, so we can tag roles (Graph doesn't put the role on the folder itself)
    const roles = new Map<string, FolderRole>()
    for (const [wk, role] of [['inbox', 'inbox'], ['sentitems', 'sent'], ['drafts', 'drafts'], ['deleteditems', 'trash'], ['junkemail', 'junk'], ['archive', 'archive']] as const) {
      const f = await this.call<{ id: string }>(`/me/mailFolders/${wk}?$select=id`).catch(() => null)
      if (f) roles.set(f.id, role)
    }
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
    type M = {
      id: string
      subject?: string
      from?: { emailAddress: { name: string; address: string } }
      toRecipients?: { emailAddress: { name: string; address: string } }[]
      receivedDateTime?: string
      bodyPreview?: string
      isRead?: boolean
      flag?: { flagStatus: string }
      hasAttachments?: boolean
      '@removed'?: unknown
    }
    const select = 'subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,flag,hasAttachments'
    let url: string | undefined = state ?? `/me/mailFolders/${folderId}/messages/delta?$select=${select}&$orderby=receivedDateTime+desc`
    const upserts: RemoteSummary[] = []
    const deletes: string[] = []
    let deltaLink = state ?? ''
    const headers = { Prefer: `odata.maxpagesize=${Math.min(limit, 100)}` }
    while (url) {
      type Page = { value: M[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
      const page: Page = await this.call<Page>(url, { headers }).catch((e: Error): Page => {
        // An expired delta token means start over
        if (state && /410|SyncStateNotFound|resync/i.test(e.message)) return { value: [], '@odata.nextLink': undefined, '@odata.deltaLink': 'RESET' }
        throw e
      })
      if (page['@odata.deltaLink'] === 'RESET') return this.syncFolder(folderId, null, limit).then((s) => ({ ...s, reset: true }))
      for (const m of page.value) {
        if (m['@removed']) {
          deletes.push(m.id)
          continue
        }
        upserts.push({
          remoteId: m.id,
          subject: m.subject || '(no subject)',
          from: m.from ? toAddr(m.from) : null,
          to: (m.toRecipients ?? []).map(toAddr),
          date: m.receivedDateTime ? Date.parse(m.receivedDateTime) : Date.now(),
          preview: m.bodyPreview ?? '',
          unread: m.isRead === false,
          flagged: m.flag?.flagStatus === 'flagged',
          hasAttachments: !!m.hasAttachments
        })
      }
      url = page['@odata.nextLink']
      if (page['@odata.deltaLink']) deltaLink = page['@odata.deltaLink']
      // Big folder: stop here and resume from this page next sync, so older mail backfills gradually (newest first)
      else if (url && upserts.length >= limit) return { upserts, flagUpdates: [], deletes, reset: !state, state: url }
    }
    return { upserts, flagUpdates: [], deletes, reset: !state, state: deltaLink }
  }

  async fetchBody(_folderId: string, remoteId: string) {
    type B = {
      body: { contentType: 'html' | 'text'; content: string }
      ccRecipients: { emailAddress: { name: string; address: string } }[]
      attachments?: { id: string; name: string; contentType: string; size: number; isInline: boolean }[]
    }
    const m = await this.call<B>(`/me/messages/${remoteId}?$select=body,ccRecipients&$expand=attachments($select=id,name,contentType,size,isInline)`)
    const html = m.body.contentType === 'html' ? m.body.content : null
    return {
      html,
      text: m.body.contentType === 'text' ? m.body.content : null,
      cc: m.ccRecipients.map(toAddr),
      attachments: (m.attachments ?? []).map((a) => ({ id: a.id, filename: a.name, contentType: a.contentType, size: a.size, inline: a.isInline })),
      hasRemoteContent: !!html && /\b(src|background)\s*=\s*["']?https?:/i.test(html)
    }
  }

  async setFlags(_folderId: string, remoteIds: string[], flags: { read?: boolean; flagged?: boolean }): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (flags.read !== undefined) patch.isRead = flags.read
    if (flags.flagged !== undefined) patch.flag = { flagStatus: flags.flagged ? 'flagged' : 'notFlagged' }
    await Promise.all(remoteIds.map((id) => this.call(`/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })))
  }

  async close(): Promise<void> {}
}

function toAddr(r: { emailAddress: { name: string; address: string } }): Address {
  return { name: r.emailAddress.name ?? '', address: r.emailAddress.address ?? '' }
}
