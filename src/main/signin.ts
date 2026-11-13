import { resolveMx } from 'node:dns/promises'
import type { AccountKind } from '@shared/types'
import { getSettings } from './store'

/**
 * The sign-in apps built into this copy of Letterwing (from .env.local at build time). A value in
 * Settings → Advanced overrides them, for someone testing their own registration.
 */
export function oauthClients() {
  const s = getSettings()
  const env = import.meta.env ?? {}
  return {
    microsoft: { clientId: s.microsoftClientId || env.MAIN_VITE_MICROSOFT_CLIENT_ID || '', tenant: env.MAIN_VITE_MICROSOFT_TENANT || 'organizations' },
    google: { clientId: s.googleClientId || env.MAIN_VITE_GOOGLE_CLIENT_ID || '', clientSecret: s.googleClientSecret || env.MAIN_VITE_GOOGLE_CLIENT_SECRET || '' }
  }
}

export interface Detected {
  kind: AccountKind
  /** How we know, for the "Not right?" hint */
  reason: string
  /** Whether this build can sign in to that provider */
  signInAvailable: boolean
  imap?: { host: string; port: number; security: 'tls' }
  smtp?: { host: string; port: number; security: 'tls' }
}

const GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com'])
const MICROSOFT_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.co.za', 'hotmail.co.uk'])
/** Well-known IMAP providers that work with an (app) password */
const KNOWN: Record<string, [string, string]> = {
  'icloud.com': ['imap.mail.me.com', 'smtp.mail.me.com'],
  'me.com': ['imap.mail.me.com', 'smtp.mail.me.com'],
  'fastmail.com': ['imap.fastmail.com', 'smtp.fastmail.com'],
  'yahoo.com': ['imap.mail.yahoo.com', 'smtp.mail.yahoo.com'],
  'zoho.com': ['imap.zoho.com', 'smtp.zoho.com']
}

/**
 * Work out who hosts an address: the domain for the big free providers, otherwise its MX
 * records (a company on Google Workspace or Microsoft 365 points its mail there).
 */
export async function detectProvider(email: string): Promise<Detected> {
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? ''
  const clients = oauthClients()
  const google = (reason: string): Detected => ({ kind: 'google', reason, signInAvailable: !!clients.google.clientId })
  const microsoft = (reason: string): Detected => ({ kind: 'microsoft', reason, signInAvailable: !!clients.microsoft.clientId })
  if (GOOGLE_DOMAINS.has(domain)) return google('Gmail address')
  if (MICROSOFT_DOMAINS.has(domain)) return microsoft('Microsoft account')
  if (KNOWN[domain]) {
    const [i, s] = KNOWN[domain]
    return { kind: 'imap', reason: domain, signInAvailable: true, imap: { host: i, port: 993, security: 'tls' }, smtp: { host: s, port: 465, security: 'tls' } }
  }
  try {
    const mx = (await resolveMx(domain)).map((r) => r.exchange.toLowerCase())
    if (mx.some((h) => /(^|\.)(google\.com|googlemail\.com)$/.test(h))) return google(`${domain} uses Google Workspace`)
    if (mx.some((h) => h.endsWith('.mail.protection.outlook.com') || h.endsWith('.outlook.com'))) return microsoft(`${domain} uses Microsoft 365`)
  } catch {
    // No DNS (offline) or no MX: fall through to IMAP with guessed servers
  }
  return { kind: 'imap', reason: 'other provider', signInAvailable: true, imap: { host: `mail.${domain}`, port: 993, security: 'tls' }, smtp: { host: `mail.${domain}`, port: 465, security: 'tls' } }
}
