import DOMPurify from 'dompurify'
import type { MessageBody } from '@shared/types'

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** A message body made safe to show or print: no scripts or forms; <style> kept since newsletters need it */
export function cleanBody(body: MessageBody): string {
  return body.html
    ? DOMPurify.sanitize(body.html, { FORCE_BODY: true, ADD_TAGS: ['style'], FORBID_TAGS: ['form', 'input', 'button'], ADD_ATTR: ['target'] })
    : `<pre class="plain">${escapeHtml(body.text ?? '')}</pre>`
}

/** Messages whose web images were loaded by request; printing them includes those images too */
export const imagesAllowed = new Set<string>()
