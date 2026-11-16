import type { Address, MailtoRequest } from '@shared/types'

export type { MailtoRequest }

/** Percent-decoding only: in mailto links "+" is a plus sign (name+tag@gmail.com), never a space */
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function addresses(list: string): Address[] {
  return list
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter((a) => /^[^@\s<>]+@[^@\s<>]+$/.test(a))
    .map((address) => ({ name: '', address }))
}

/** Parse a mailto: link; null if it isn't one */
export function parseMailto(url: string): MailtoRequest | null {
  if (!/^mailto:/i.test(url)) return null
  const rest = url.slice(7)
  const q = rest.indexOf('?')
  const path = decode(q < 0 ? rest : rest.slice(0, q))
  const out: MailtoRequest = { to: addresses(path), cc: [], bcc: [], subject: '', body: '' }
  if (q >= 0) {
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=')
      const key = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase()
      const value = eq < 0 ? '' : pair.slice(eq + 1)
      if (key === 'to') out.to.push(...addresses(decode(value)))
      else if (key === 'cc') out.cc.push(...addresses(decode(value)))
      else if (key === 'bcc') out.bcc.push(...addresses(decode(value)))
      else if (key === 'subject') out.subject = decode(value)
      else if (key === 'body') out.body = decode(value)
    }
  }
  return out
}


/** The first mailto: link among command-line arguments (how Windows and Linux hand links to the app) */
export function mailtoFromArgs(argv: string[]): string | null {
  return argv.find((a) => /^mailto:/i.test(a)) ?? null
}
