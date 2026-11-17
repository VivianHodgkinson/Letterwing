import type { Address, MessageSummary } from '@shared/types'
import { api } from './api'
import { bytes, whoFull } from './format'
import { cleanBody, escapeHtml, imagesAllowed } from './mailHtml'

const list = (as: Address[]) => as.map((a) => escapeHtml(whoFull(a))).join('; ')

/**
 * Print messages (one, or a whole conversation newest first, as on screen) through the system print dialog, or save
 * them as a PDF. Each gets a From / Sent / To / Cc / Subject header, then its body. Images from the web
 * are included only where you loaded them (or always load them), as on screen.
 */
export async function printMessages(messages: MessageSummary[], opts: { pdf: boolean; loadRemoteImages: boolean }): Promise<boolean> {
  const sorted = [...messages].sort((a, b) => b.date - a.date)
  const bodies = await Promise.all(sorted.map((m) => api.getBody(m.key)))
  const remote = opts.loadRemoteImages || sorted.some((m) => imagesAllowed.has(m.key))
  const sections = sorted.map((m, i) => {
    const b = bodies[i]
    const files = b.attachments.filter((a) => !a.inline)
    const rows = [
      ['From', m.from ? escapeHtml(whoFull(m.from)) : ''],
      ['Sent', escapeHtml(new Date(m.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }))],
      ['To', list(m.to)],
      ['Cc', list(b.cc)],
      ['Subject', escapeHtml(m.subject)],
      ['Attachments', files.map((a) => `${escapeHtml(a.filename)} (${bytes(a.size)})`).join('; ')]
    ].filter(([, v]) => v)
    return `<section class="msg">
  <table class="head">${rows.map(([k, v]) => `<tr><th>${k}:</th><td>${v}</td></tr>`).join('')}</table>
  <div class="body">${cleanBody(b)}</div>
</section>`
  })
  const title = sorted[0]?.subject || 'Message'
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${remote ? ' https: http:' : ''}; font-src data:`
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 15mm; }
  body { margin: 0; font: 11pt/1.45 system-ui, 'Segoe UI', Arial, sans-serif; color: #000; background: #fff; overflow-wrap: anywhere; }
  h1 { font-size: 15pt; margin: 0 0 10pt; }
  .msg + .msg { border-top: 1.5pt solid #000; margin-top: 16pt; padding-top: 12pt; }
  .head { border-collapse: collapse; margin-bottom: 12pt; font-size: 10pt; break-inside: avoid; }
  .head th { text-align: left; vertical-align: top; padding: 1pt 10pt 1pt 0; white-space: nowrap; }
  .head td { padding: 1pt 0; }
  .body img { max-width: 100%; height: auto; }
  .body table { max-width: 100%; }
  pre.plain { white-space: pre-wrap; font: 10pt/1.45 ui-monospace, monospace; margin: 0; }
  blockquote { border-left: 2pt solid #999; margin: 0 0 0 4pt; padding-left: 10pt; color: #333; }
  a { color: #1a4fd6; }${remote ? '' : "\n  img[src^='http:'], img[src^='https:'] { display: none; }"}
</style></head><body><h1>${escapeHtml(title)}</h1>${sections.join('\n')}</body></html>`
  return api.printDocument(html, title, opts.pdf)
}

// For the screenshot harness (devcapture.ts), which drives the app from page scripts
;(globalThis as Record<string, unknown>).__letterwingPrint = printMessages
