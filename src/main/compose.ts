import MailComposer from 'nodemailer/lib/mail-composer'
import type { Account, Outgoing, OutgoingAttachment } from '@shared/types'
import type { AttachmentData, CompiledMessage } from './connectors/types'

/**
 * Turn what the user wrote into a real email, once, so every connector sends
 * the same bytes:
 *  - images pasted into the editor or used in a signature (data: URIs) become
 *    inline cid: attachments, which every mail client displays
 *  - remote images in quoted text, which the editor holds as data-ink-src so
 *    they don't load while you type, get their src back
 *  - a plain-text alternative is generated from the HTML
 *  - Bcc is left out of the headers when sending, but kept in drafts
 */
export async function compile(
  account: Account,
  out: Outgoing,
  load: (a: OutgoingAttachment) => Promise<AttachmentData>,
  opts: { forDraft: boolean }
): Promise<CompiledMessage> {
  const files = await Promise.all(out.attachments.map(load))
  const { html, inline } = embedDataImages(out.html.replace(/\sdata-ink-src=/gi, ' src='))
  const all = [...out.to, ...out.cc, ...out.bcc]
  if (!opts.forDraft && all.length === 0) throw new Error('Add at least one recipient.')

  const build = (withFiles: boolean): Promise<Buffer> => {
    const node = new MailComposer({
      from: { name: account.senderName ?? '', address: account.email },
      to: out.to,
      cc: out.cc,
      bcc: out.bcc,
      subject: out.subject,
      html: wrapHtml(html),
      text: htmlToText(html),
      inReplyTo: out.inReplyTo?.messageId || undefined,
      references: out.inReplyTo ? [...out.inReplyTo.references, out.inReplyTo.messageId].filter(Boolean).join(' ') : undefined,
      attachments: [
        ...inline.map((i) => ({ cid: i.cid, filename: i.filename, content: i.content, contentType: i.contentType, contentDisposition: 'inline' })),
        ...(withFiles ? files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType })) : [])
      ],
      headers: { 'X-Mailer': 'Letterwing' }
    }).compile()
    // Bcc never appears in a sent message's headers, but a draft needs it to survive being reopened
    node.keepBcc = opts.forDraft
    return node.build()
  }

  return {
    mime: () => build(true),
    mimeWithoutAttachments: () => build(false),
    attachments: files,
    envelope: { from: account.email, to: all.map((a) => a.address) }
  }
}

export function embedDataImages(html: string): { html: string; inline: (AttachmentData & { cid: string })[] } {
  const inline: (AttachmentData & { cid: string })[] = []
  const seen = new Map<string, string>()
  const out = html.replace(/(<img\b[^>]*?\bsrc=)(["'])data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)\2/gi, (_m, pre: string, q: string, type: string, data: string) => {
    // The same logo used twice is attached once
    let cid = seen.get(data)
    if (!cid) {
      cid = `img${inline.length + 1}.${Date.now().toString(36)}@letterwing`
      seen.set(data, cid)
      const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
      inline.push({ cid, filename: `image${inline.length + 1}.${ext}`, contentType: type, content: Buffer.from(data.replace(/\s/g, ''), 'base64') })
    }
    return `${pre}${q}cid:${cid}${q}`
  })
  return { html: out, inline }
}

function wrapHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt;">${body}</body></html>`
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    // Links keep their URL. Placeholders, because "<url>" would be stripped as a tag below.
    .replace(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) =>
      text.replace(/<[^>]+>/g, '').trim() === href ? href : `${text} \u0001${href}\u0002`
    )
    .replace(/<[^>]+>/g, '')
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}


/** An iMIP reply to a meeting invitation: a short note plus the text/calendar part calendars act on */
export async function compileInviteReply(account: Account, to: { name: string; address: string }, subject: string, note: string, ics: string): Promise<CompiledMessage> {
  const build = () =>
    new MailComposer({
      from: { name: account.senderName ?? '', address: account.email },
      to: [to],
      subject,
      text: note,
      icalEvent: { method: 'REPLY', content: ics },
      headers: { 'X-Mailer': 'Letterwing' }
    })
      .compile()
      .build()
  return { mime: build, mimeWithoutAttachments: build, attachments: [], envelope: { from: account.email, to: [to.address] } }
}
