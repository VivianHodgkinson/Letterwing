import type { Address } from '@shared/types'

export function shortDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = (now.getTime() - ms) / 86_400_000
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return d.toLocaleDateString()
}

export const fullDate = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })

export const who = (a: Address | null): string => (a ? a.name || a.address : '(unknown sender)')

export const whoFull = (a: Address): string => (a.name ? `${a.name} <${a.address}>` : a.address)

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

export function initials(a: Address | null): string {
  const s = who(a).replace(/[^\p{L}\s]/gu, ' ').trim()
  const parts = s.split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Stable colour per sender, so the same person always gets the same avatar colour */
export function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
