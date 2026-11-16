import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { OutboxItem, Outgoing } from '@shared/types'

/**
 * Mail written without a connection waits here and sends itself when the connection is back.
 * Kept in the app's data folder (outbox.json, attachments copied next to it) so it survives a restart.
 */

const dir = () => join(app.getPath('userData'), 'outbox')
const file = () => join(dir(), 'outbox.json')

interface Stored extends OutboxItem {
  message: Outgoing
  /** Don't try again before this (ms); backs off after each failure */
  nextAt: number
}

let items: Stored[] | null = null

function load(): Stored[] {
  if (items) return items
  try {
    items = JSON.parse(readFileSync(file(), 'utf8')) as Stored[]
  } catch {
    items = []
  }
  return items
}

function save(): void {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(file() + '.tmp', JSON.stringify(load(), null, 2), { mode: 0o600 })
  renameSync(file() + '.tmp', file())
}

/** What the Outbox view shows */
export function list(): OutboxItem[] {
  return load().map(({ message: _m, nextAt: _n, ...item }) => item)
}

export function count(): number {
  return load().length
}

/**
 * Is this failure just "no connection right now"? Then the message waits in the Outbox. Anything else
 * (a refused address, a rejected sign-in) is shown straight away, because trying again won't help.
 */
export function isConnectionError(e: unknown): boolean {
  const err = e as { code?: string; message?: string; status?: number; cause?: { code?: string; message?: string } }
  const codes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'ESOCKET', 'ECONNECTION', 'EDNS', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']
  if (codes.includes(err?.code ?? '') || codes.includes(err?.cause?.code ?? '')) return true
  if (typeof err?.status === 'number' && (err.status === 429 || err.status >= 500)) return true
  return /fetch failed|network|getaddrinfo|socket hang up|timed? ?out|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection (closed|lost)/i.test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`)
}

/** Put a message in the Outbox. Attachments from disk are copied in, so moving or deleting the original doesn't matter. */
export async function add(message: Outgoing, error: string): Promise<OutboxItem> {
  const id = randomUUID()
  const own = join(dir(), id)
  mkdirSync(own, { recursive: true })
  const attachments = await Promise.all(
    message.attachments.map(async (a, i) => {
      if (a.source.kind !== 'file') return a
      const copy = join(own, `${i}-${basename(a.filename) || 'attachment'}`)
      await copyFile(a.source.path, copy)
      return { ...a, source: { kind: 'file' as const, path: copy } }
    })
  )
  const item: Stored = {
    id,
    accountId: message.accountId,
    to: [...message.to, ...message.cc, ...message.bcc].map((a) => a.address),
    subject: message.subject,
    queuedAt: Date.now(),
    attempts: 0,
    error,
    stuck: false,
    message: { ...message, attachments },
    nextAt: 0
  }
  load().push(item)
  save()
  return item
}

export function remove(id: string): Outgoing | null {
  const list = load()
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return null
  const [item] = list.splice(i, 1)
  save()
  return item.message
}

/** After the message has gone (or been taken back for editing): its copied attachments go too */
export function cleanUp(id: string): void {
  const own = join(dir(), id)
  if (existsSync(own)) rmSync(own, { recursive: true, force: true })
}

/** Messages to try now: not given up on, and past their back-off. `force` tries everything, stuck ones too. */
export function due(force: boolean): { id: string; message: Outgoing }[] {
  const now = Date.now()
  return load()
    .filter((x) => force || (!x.stuck && x.nextAt <= now))
    .map((x) => ({ id: x.id, message: x.message }))
}

/** A try failed: wait longer next time (30 s, 1, 2, 4... up to 15 minutes); stop retrying by itself on a real error */
export function failed(id: string, e: unknown): void {
  const item = load().find((x) => x.id === id)
  if (!item) return
  item.attempts++
  item.error = (e as Error)?.message ?? String(e)
  item.stuck = !isConnectionError(e)
  item.nextAt = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (item.attempts - 1))
  save()
}

/** For tests: forget the in-memory copy so the next call reads the file again */
export function reload(): void {
  items = null
}
