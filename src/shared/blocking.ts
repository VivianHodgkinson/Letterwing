/** Blocked senders: exact addresses, or "@domain" for everyone at a domain (and its subdomains) */
export function isBlocked(address: string | undefined | null, blocked: string[]): boolean {
  if (!address || !blocked.length) return false
  const a = address.toLowerCase()
  const domain = a.split('@')[1] ?? ''
  return blocked.some((b) => (b.startsWith('@') ? domain === b.slice(1) || domain.endsWith(`.${b.slice(1)}`) : a === b))
}

/** How a block entry is stored: lower case; a bare domain gets its "@" */
export function blockEntry(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return s
  const domain = s.replace(/^@/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? `@${domain}` : null
}
