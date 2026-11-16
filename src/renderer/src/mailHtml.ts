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

/** The colours an email is drawn in when it follows the theme; null means exactly as the sender made it */
export interface MailLook {
  dark: boolean
  bg: string
  text: string
  link: string
  muted: string
  border: string
}

/**
 * Does the email set its own colours (newsletters, receipts, most mail from business software)?
 * Those can't simply be given a dark background: their own dark text would vanish. They get inverted instead.
 */
const OWN_COLOURS = /\bbgcolor\s*=|\bbackground(-color)?\s*:|(^|[\s;"'{])color\s*:|<font[^>]+\bcolor\s*=|\btext\s*=\s*["']?#/i

export function hasOwnColours(html: string | null): boolean {
  return !!html && OWN_COLOURS.test(html)
}

/** The colour that becomes `css` after invert(1) hue-rotate(180deg), near enough: so an inverted email sits on the theme's background */
export function preInverted(css: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim())?.[1]
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(css.trim())
  let c: number[] | null = null
  if (hex) c = (hex.length === 3 ? hex.split('').map((h) => h + h) : hex.match(/../g)!).map((h) => parseInt(h, 16))
  else if (rgb) c = rgb.slice(1, 4).map(Number)
  if (!c) return '#ffffff'
  // invert, then swap the hue back by mirroring each channel around the grey of the colour
  const inv = c.map((v) => 255 - v)
  const grey = (inv[0] + inv[1] + inv[2]) / 3
  return `rgb(${inv.map((v) => Math.round(Math.max(0, Math.min(255, 2 * grey - v)))).join(', ')})`
}

/** CSS that makes an email follow the theme, given what kind of email it is */
export function lookCss(look: MailLook | null, html: string | null): string {
  if (!look) return ''
  const plain = `
  body { background: ${look.bg}; color: ${look.text}; }
  a { color: ${look.link}; }
  blockquote { color: ${look.muted}; border-left-color: ${look.border}; }`
  if (!hasOwnColours(html)) return plain
  // Designed emails: dark mode flips them (pictures flipped back so they keep their real colours); light mode leaves them alone
  if (!look.dark) return ''
  return `
  html { filter: invert(1) hue-rotate(180deg); background: ${preInverted(look.bg)}; }
  body { background: transparent; }
  img, video, picture, canvas, svg, [style*='background-image'], [background] { filter: invert(1) hue-rotate(180deg); }`
}
