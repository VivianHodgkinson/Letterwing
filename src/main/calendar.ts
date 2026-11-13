import { Notification } from 'electron'
import type { Account, CalendarEvent, CalendarInfo, EventInput } from '@shared/types'
import { CalDavCalendar, GraphCalendar, IcsCalendars, type Answer, type CalendarConnector } from './connectors/calendar'
import type { GraphConnector } from './connectors/graph'
import { compileInviteReply } from './compose'
import * as db from './db'
import { buildInviteReply } from './ical'
import { accessToken } from './oauth'
import { getAccounts, getSecret, getSettings } from './store'
import * as sync from './sync'

/** Pseudo account that owns ICS subscriptions */
export const ICS_ACCOUNT = 'ics'
/** The cached window: two months back, a bit over a year ahead. Outside it, events are fetched live. */
const BACK = 60 * 86_400_000
const AHEAD = 400 * 86_400_000

type Notify = (channel: 'calendar:changed' | 'sync:status' | 'open:event', payload: unknown) => void
let notify: Notify = () => {}
let focusWindow: () => void = () => {}
const connectors = new Map<string, CalendarConnector>()
const running = new Map<string, Promise<void>>()

export function init(send: Notify, focus: () => void): void {
  notify = send
  focusWindow = focus
  setInterval(checkReminders, 30_000)
}

/** Which calendar backend an account uses, if any */
export function connectorFor(account: Account): CalendarConnector | null {
  const hit = connectors.get(account.id)
  if (hit) return hit
  let c: CalendarConnector | null = null
  if (account.kind === 'microsoft') c = new GraphCalendar(account, sync.connector(account) as GraphConnector)
  else if (account.kind === 'google')
    c = new CalDavCalendar(account, 'https://apidata.googleusercontent.com/caldav/v2/', async () => ({ Authorization: `Bearer ${await accessToken(account)}` }))
  else if (account.caldavUrl)
    c = new CalDavCalendar(account, account.caldavUrl, async () => {
      if (account.auth === 'oauth') return { Authorization: `Bearer ${await accessToken(account)}` }
      const user = account.username || account.email
      return { Authorization: `Basic ${Buffer.from(`${user}:${getSecret(account.id) ?? ''}`).toString('base64')}` }
    })
  if (c) connectors.set(account.id, c)
  return c
}

export function forget(accountId: string): void {
  connectors.delete(accountId)
}

function ics(): IcsCalendars {
  return new IcsCalendars(getSettings().icsSubscriptions)
}

function connectorById(accountId: string): CalendarConnector {
  if (accountId === ICS_ACCOUNT) return ics()
  const a = getAccounts().find((x) => x.id === accountId)
  const c = a && connectorFor(a)
  if (!c) throw new Error('This account has no calendar')
  return c
}

async function syncOne(accountId: string, name: string, c: CalendarConnector, onlyCalendar?: string): Promise<void> {
  const key = accountId + (onlyCalendar ?? '')
  const existing = running.get(key)
  if (existing) return existing
  const p = (async () => {
    try {
      if (!onlyCalendar) db.saveCalendars(accountId, await c.listCalendars())
      const from = Date.now() - BACK
      const to = Date.now() + AHEAD
      for (const cal of db.listCalendars().filter((x) => x.accountId === accountId && (!onlyCalendar || x.id === onlyCalendar)))
        db.saveEvents(accountId, cal.id, from, to, await c.listEvents(cal.id, from, to))
      notify('calendar:changed', { accountId })
    } catch (e) {
      notify('sync:status', { accountId, state: 'error', message: `${name} calendar: ${(e as Error).message}`, at: Date.now() })
    } finally {
      running.delete(key)
    }
  })()
  running.set(key, p)
  return p
}

export async function syncAll(): Promise<void> {
  const jobs = getAccounts().flatMap((a) => {
    const c = connectorFor(a)
    return c ? [syncOne(a.id, a.name, c)] : []
  })
  const subs = getSettings().icsSubscriptions
  if (subs.length) jobs.push(syncOne(ICS_ACCOUNT, 'Subscribed', ics()))
  else db.saveCalendars(ICS_ACCOUNT, [])
  await Promise.all(jobs)
}

export function listCalendars(): CalendarInfo[] {
  return db.listCalendars().map(({ syncedFrom: _f, syncedTo: _t, ...c }) => c)
}

/** Events in a range: from the cache inside the synced window, fetched live outside it */
export async function listEvents(from: number, to: number): Promise<CalendarEvent[]> {
  const cals = db.listCalendars()
  const cached = db.listEvents(from, to)
  const outside = cals.filter((c) => c.syncedFrom === null || c.syncedTo === null || from < c.syncedFrom || to > c.syncedTo)
  if (!outside.length) return cached
  const hidden = new Set(getSettings().hiddenCalendars)
  const live = await Promise.all(
    outside
      .filter((c) => !hidden.has(`${c.accountId}\u0000${c.id}`))
      .map(async (c) => {
        try {
          return (await connectorById(c.accountId).listEvents(c.id, from, to)).map((e) => db.toCalendarEvent(c.accountId, c.id, e))
        } catch {
          return [] // offline: show what the cache has
        }
      })
  )
  const liveCals = new Set(outside.map((c) => c.accountId + c.id))
  return [...cached.filter((e) => !liveCals.has(e.accountId + e.calendarId)), ...live.flat()].sort((a, b) => a.start - b.start)
}

function existing(key: string): CalendarEvent {
  const e = db.getEvent(key)
  if (!e) throw new Error('That event is no longer in the calendar')
  return e
}

export async function saveEvent(input: EventInput): Promise<void> {
  if (input.end < input.start) throw new Error('The event ends before it starts')
  const c = connectorById(input.accountId)
  if (input.key) await c.updateEvent(input, existing(input.key))
  else await c.createEvent(input)
  await syncOne(input.accountId, '', c, input.calendarId)
}

export async function deleteEvent(key: string): Promise<void> {
  const e = existing(key)
  const c = connectorById(e.accountId)
  await c.deleteEvent(e)
  await syncOne(e.accountId, '', c, e.calendarId)
}

export async function respond(key: string, answer: Answer, comment?: string): Promise<void> {
  const e = existing(key)
  const c = connectorById(e.accountId)
  await c.respond(e, answer, comment)
  await syncOne(e.accountId, '', c, e.calendarId)
}

/**
 * Answer an invitation from the message itself. Microsoft: through Graph. Otherwise through the
 * calendar copy when the server already added one (it then tells the organizer), or failing that
 * with an iMIP reply by email, which every calendar system understands.
 */
export async function respondToInvite(messageKey: string, answer: Answer, comment?: string): Promise<void> {
  const m = db.getMessage(messageKey)
  const body = db.getCachedBody(messageKey)
  const invite = body?.invite
  if (!m || !invite) throw new Error('This message has no invitation to answer')
  const account = getAccounts().find((a) => a.id === m.accountId)
  if (!account) throw new Error('Account not found')
  const c = connectorFor(account)
  if (account.kind === 'microsoft' && invite.eventId) await (c as GraphCalendar).respondTo(invite.eventId, answer, comment)
  else {
    const inCalendar = c ? db.eventByUid(account.id, invite.uid) : null
    if (inCalendar && c) await c.respond(inCalendar, answer, comment)
    else {
      if (!invite.ics || !invite.organizer) throw new Error("This invitation doesn't say who to reply to")
      const word = { accepted: 'Accepted', tentative: 'Tentative', declined: 'Declined' }[answer]
      const msg = await compileInviteReply(
        account,
        invite.organizer,
        `${word}: ${invite.title}`,
        comment || `${account.senderName || account.email} has ${answer === 'tentative' ? 'tentatively accepted' : answer} this invitation.`,
        buildInviteReply(invite.ics, { name: account.senderName ?? '', address: account.email }, answer)
      )
      await sync.connector(account).send(msg, db.folderByRole(account.id, 'sent')?.id ?? null)
    }
  }
  // Remember the answer on the cached invite so the card shows it straight away
  db.cacheBody({ ...body, invite: { ...invite, myStatus: answer } })
  if (c) void syncOne(account.id, account.name, c)
}

// ---------------------------------------------------------------- reminders

const reminded = new Set<string>()

function checkReminders(): void {
  const minutes = getSettings().reminderMinutes
  if (!minutes || !Notification.isSupported()) return
  const now = Date.now()
  const hidden = new Set(getSettings().hiddenCalendars)
  for (const e of db.eventsStarting(now - 60_000, now + minutes * 60_000)) {
    if (e.allDay || e.cancelled || e.myStatus === 'declined' || reminded.has(e.key) || hidden.has(`${e.accountId}\u0000${e.calendarId}`)) continue
    reminded.add(e.key)
    const mins = Math.round((e.start - now) / 60_000)
    const n = new Notification({
      title: e.title,
      body: `${mins <= 0 ? 'Now' : `In ${mins} min`} · ${new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e.location ? ` · ${e.location}` : ''}`
    })
    n.on('click', () => {
      focusWindow()
      notify('open:event', { key: e.key })
    })
    n.show()
  }
}
