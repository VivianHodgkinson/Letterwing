import type { Address, SecurityCheck } from '@shared/types'

/**
 * Is a message really from who it says? Your own mail server checks each incoming message (SPF: was it
 * sent from a server the domain allows; DKIM: is it signed by the domain; DMARC: do those match the
 * From address) and writes the outcome into an Authentication-Results header. We read the topmost one,
 * the one your server added on arrival (a sender can add fake ones, but only below it).
 *
 * Plus one check of our own: a sender name that is itself an email address on another domain
 * ("support@fnb.co.za" <x@elsewhere.ru>), a common phishing trick.
 */
export function assessMessage(authResults: string[], from: Address | null): SecurityCheck {
  const reasons: string[] = []
  let level: SecurityCheck['level'] = 'ok'
  const domain = from?.address.split('@')[1]?.toLowerCase() ?? ''
  const shown = domain || 'the sender'

  const top = authResults[0]
  if (top) {
    const result = (method: string) => new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, 'i').exec(top)?.[1]?.toLowerCase()
    const dmarc = result('dmarc')
    const spf = result('spf')
    const dkim = result('dkim')
    const compauth = result('compauth') // Microsoft's combined verdict
    if (dmarc === 'fail' || compauth === 'fail') {
      level = 'danger'
      reasons.push(`It failed the sender check: it may not really be from ${shown}.`)
    } else if (dmarc !== 'pass' && dmarc !== 'bestguesspass' && compauth !== 'pass' && (spf === 'fail' || spf === 'softfail') && dkim !== 'pass') {
      level = 'warn'
      reasons.push(`It wasn't sent from a server ${shown} allows, and isn't signed by ${shown}.`)
    }
  }

  // A name that looks like an address, on a different domain than the real one
  const named = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/.exec(from?.name ?? '')?.[1]?.toLowerCase()
  if (named && domain && named !== domain && !named.endsWith(`.${domain}`) && !domain.endsWith(`.${named}`)) {
    if (level === 'ok') level = 'warn'
    reasons.push(`The sender's name shows ${named}, but it was sent from ${domain}.`)
  }

  return reasons.length ? { level, reasons } : { level: top ? 'ok' : 'unknown', reasons: [] }
}

/** Header values as servers write them can be folded over several lines */
export function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, ' ').trim()
}
