import DOMPurify from 'dompurify'
import type { Account, Address, MessageBody, MessageSummary, Outgoing } from '@shared/types'
import { whoFull } from './format'

export type ReplyKind = 'reply' | 'replyAll' | 'forward'

const SIGNATURE = (html: string) => `<div class="ink-signature">${html}</div>`

/** A blank message from an account, with its signature */
export function newMessage(account: Account, to: Address[] = []): Outgoing {
  return {
    accountId: account.id,
    to,
    cc: [],
    bcc: [],
    subject: '',
    html: `<p><br></p>${account.signature ? SIGNATURE(account.signature) : ''}`,
    attachments: []
  }
}

/**
 * business-style reply or forward: "RE:"/"FW:" subject, your text on top, then a
 * From/Sent/To/Subject block and the original message.
 */
export function buildReply(kind: ReplyKind, m: MessageSummary, body: MessageBody, account: Account): Outgoing {
  const me = account.email.toLowerCase()
  const notMe = (a: Address) => a.address.toLowerCase() !== me
  const unique = (list: Address[]) => list.filter((a, i) => list.findIndex((b) => b.address.toLowerCase() === a.address.toLowerCase()) === i)
  const sender = body.replyTo.length ? body.replyTo : m.from ? [m.from] : []
  // Replying to your own sent message goes back to the people you sent it to
  const fromMe = !!m.from && !notMe(m.from)

  let to: Address[] = []
  let cc: Address[] = []
  if (kind === 'reply') to = fromMe ? m.to : sender
  if (kind === 'replyAll') {
    to = unique(fromMe ? m.to : [...sender, ...m.to.filter(notMe)])
    cc = unique(body.cc.filter(notMe)).filter((a) => !to.some((t) => t.address.toLowerCase() === a.address.toLowerCase()))
  }

  // Like Classic: RE: on replies unless already there; FW: on forwards unless already there ("RE: FW: x" is normal)
  const already = kind === 'forward' ? /^(fw|fwd|wg)\s*:/i : /^(re|aw)\s*:/i
  const subject = already.test(m.subject) ? m.subject : (kind === 'forward' ? 'FW: ' : 'RE: ') + m.subject

  const header = `<div class="ink-reply-header"><hr tabindex="-1" style="display:inline-block;width:98%">
<p><b>From:</b> ${esc(m.from ? whoFull(m.from) : '')}<br>
<b>Sent:</b> ${esc(new Date(m.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }))}<br>
<b>To:</b> ${esc(m.to.map(whoFull).join('; '))}<br>${body.cc.length ? `<b>Cc:</b> ${esc(body.cc.map(whoFull).join('; '))}<br>` : ''}
<b>Subject:</b> ${esc(m.subject)}</p></div>`

  const signature = account.signatureOnReplies && account.signature ? SIGNATURE(account.signature) : ''
  return {
    accountId: account.id,
    to,
    cc,
    bcc: [],
    subject,
    html: `<p><br></p>${signature}${header}<div class="ink-quoted">${quoteHtml(body)}</div>`,
    attachments:
      kind === 'forward'
        ? body.attachments
            .filter((a) => !a.inline)
            .map((a) => ({ id: crypto.randomUUID(), filename: a.filename, contentType: a.contentType, size: a.size, source: { kind: 'message' as const, key: m.key, attachmentId: a.id } }))
        : [],
    inReplyTo: kind === 'forward' ? undefined : { key: m.key, messageId: body.messageId, references: body.references }
  }
}

/**
 * The original message, safe to put in the editor: no scripts or <style> blocks (they'd restyle
 * the whole app), and remote images parked in data-ink-src so they don't load while you type.
 * compose.ts puts them back on send.
 */
export function quoteHtml(body: MessageBody): string {
  const html = body.html ?? `<p>${esc(body.text ?? '').replace(/\n/g, '<br>')}</p>`
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'], FORBID_ATTR: ['contenteditable'] })
  return clean.replace(/(<img\b[^>]*?\s)src=(["'])(https?:)/gi, '$1data-ink-src=$2$3')
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Swap the signature block when the From account changes */
export function swapSignature(html: string, signature: string | undefined): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')!
  const existing = root.querySelector('.ink-signature')
  if (existing) {
    if (signature) existing.innerHTML = signature
    else existing.remove()
  } else if (signature) {
    const first = root.querySelector('.ink-reply-header')
    const div = doc.createElement('div')
    div.className = 'ink-signature'
    div.innerHTML = signature
    root.insertBefore(div, first)
  }
  return root.innerHTML
}
