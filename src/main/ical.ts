import ICAL from 'ical.js'
import { randomUUID } from 'node:crypto'
import type { Address, Attendee, CalendarEvent, EventInput, Invite, Repeat, ResponseStatus } from '@shared/types'

/**
 * iCalendar (RFC 5545) for CalDAV calendars, ICS subscriptions and meeting invites in mail.
 * One place parses and writes it, so all three behave the same.
 */

export type RemoteEvent = Omit<CalendarEvent, 'key' | 'accountId' | 'calendarId'>

const PRODID = '-//Letterwing//Letterwing//EN'
/** A runaway RRULE (or one with no end) stops expanding here */
const MAX_OCCURRENCES = 2000

const JOIN_URL = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|[\w-]+\.zoom\.us|zoom\.us|meet\.google\.com|[\w-]+\.webex\.com)\/[^\s"<>)]+/i

function parse(data: string): ICAL.Component {
  const root = new ICAL.Component(ICAL.parse(data))
  // Times refer to these zones by TZID; ical.js needs them registered to convert to UTC
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz)
    } catch {
      // A malformed zone: those times are read as local time instead
    }
  }
  return root
}

const mailto = (v: unknown): string => String(v ?? '').replace(/^mailto:/i, '').trim().toLowerCase()

function partstat(p: string | undefined): ResponseStatus {
  switch ((p ?? '').toUpperCase()) {
    case 'ACCEPTED':
      return 'accepted'
    case 'TENTATIVE':
      return 'tentative'
    case 'DECLINED':
      return 'declined'
    case 'NEEDS-ACTION':
      return 'needsAction'
    default:
      return 'none'
  }
}

const PARTSTAT: Record<'accepted' | 'tentative' | 'declined', string> = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' }

function people(e: ICAL.Event, me: string): { organizer: Address | null; attendees: Attendee[]; myStatus: ResponseStatus; isOrganizer: boolean } {
  const orgProp = e.component.getFirstProperty('organizer')
  const organizer = orgProp ? { name: String(orgProp.getParameter('cn') ?? ''), address: mailto(orgProp.getFirstValue()) } : null
  const attendees: Attendee[] = e.attendees.map((p) => ({
    name: String(p.getParameter('cn') ?? ''),
    address: mailto(p.getFirstValue()),
    status: partstat(p.getParameter('partstat') as string | undefined),
    optional: String(p.getParameter('role') ?? '').toUpperCase() === 'OPT-PARTICIPANT'
  }))
  const isOrganizer = !organizer || organizer.address === me
  const mine = attendees.find((a) => a.address === me)
  return { organizer, attendees, isOrganizer, myStatus: isOrganizer && organizer ? 'organizer' : (mine?.status ?? 'none') }
}

function describe(e: ICAL.Event, start: Date, end: Date, me: string, remoteId: string): RemoteEvent {
  const c = e.component
  const location = e.location ?? ''
  const description = e.description ?? ''
  const conference = String(c.getFirstPropertyValue('x-google-conference') ?? c.getFirstPropertyValue('url') ?? '')
  const join = [conference, location, description].map((t) => JOIN_URL.exec(t)?.[0]).find(Boolean)
  const busy = String(c.getFirstPropertyValue('x-microsoft-cdo-busystatus') ?? '').toUpperCase()
  return {
    remoteId,
    uid: e.uid,
    title: e.summary || '(no title)',
    start: start.getTime(),
    end: Math.max(end.getTime(), start.getTime()),
    allDay: e.startDate.isDate,
    location,
    description,
    ...people(e, me),
    recurring: e.isRecurring() || e.isRecurrenceException(),
    cancelled: String(c.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED',
    showAs:
      busy === 'OOF' ? 'oof' : busy === 'TENTATIVE' ? 'tentative' : busy === 'FREE' || String(c.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT' ? 'free' : 'busy',
    ...(join ? { joinUrl: join } : {})
  }
}

/** Every occurrence between `from` and `to` (ms) in an iCalendar object, repeating events expanded */
export function eventsFromIcs(data: string, remoteId: string, from: number, to: number, me: string): RemoteEvent[] {
  const root = parse(data)
  const byUid = new Map<string, ICAL.Component[]>()
  for (const v of root.getAllSubcomponents('vevent')) {
    const uid = String(v.getFirstPropertyValue('uid') ?? randomUUID())
    byUid.set(uid, [...(byUid.get(uid) ?? []), v])
  }
  const out: RemoteEvent[] = []
  for (const comps of byUid.values()) {
    const master = comps.find((c) => !c.hasProperty('recurrence-id'))
    const exceptions = comps.filter((c) => c.hasProperty('recurrence-id'))
    if (!master) {
      // Invited to single occurrences only: each stands alone
      for (const x of exceptions) {
        const e = new ICAL.Event(x)
        const s = e.startDate.toJSDate()
        const end = (e.endDate ?? e.startDate).toJSDate()
        if (end.getTime() > from && s.getTime() < to) out.push(describe(e, s, end, me, remoteId))
      }
      continue
    }
    const event = new ICAL.Event(master)
    for (const x of exceptions) event.relateException(x)
    if (!event.isRecurring()) {
      const s = event.startDate.toJSDate()
      const end = (event.endDate ?? event.startDate).toJSDate()
      if (end.getTime() > from && s.getTime() < to) out.push(describe(event, s, end, me, remoteId))
      continue
    }
    const it = event.iterator()
    for (let i = 0, next = it.next(); next && i < MAX_OCCURRENCES; i++, next = it.next()) {
      if (next.toJSDate().getTime() >= to) break
      const d = event.getOccurrenceDetails(next)
      const s = d.startDate.toJSDate()
      const end = d.endDate.toJSDate()
      if (end.getTime() > from) out.push(describe(d.item, s, end, me, remoteId))
    }
  }
  return out
}

// ---------------------------------------------------------------- writing

function dateValue(ms: number, allDay: boolean): ICAL.Time {
  if (!allDay) return ICAL.Time.fromJSDate(new Date(ms), true)
  const d = new Date(ms)
  return ICAL.Time.fromDateString(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
}

const pad = (n: number) => String(n).padStart(2, '0')

const RRULE: Record<Exclude<Repeat, 'none'>, string> = {
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY'
}

function setText(v: ICAL.Component, name: string, value: string): void {
  v.removeAllProperties(name)
  if (value) v.addPropertyWithValue(name, value)
}

function writeFields(v: ICAL.Component, input: EventInput, me: Address, previous: Attendee[]): void {
  setText(v, 'summary', input.title)
  setText(v, 'location', input.location)
  setText(v, 'description', input.description)
  v.removeAllProperties('dtstart')
  v.removeAllProperties('dtend')
  v.removeAllProperties('duration')
  v.addPropertyWithValue('dtstart', dateValue(input.start, input.allDay))
  // All-day DTEND is the day after the last day (exclusive)
  v.addPropertyWithValue('dtend', dateValue(input.allDay && input.end <= input.start ? input.start + 86_400_000 : input.end, input.allDay))
  v.removeAllProperties('organizer')
  v.removeAllProperties('attendee')
  if (input.attendees.length) {
    const org = v.addPropertyWithValue('organizer', `mailto:${me.address}`)
    if (me.name) org.setParameter('cn', me.name)
    for (const a of input.attendees) {
      const p = v.addPropertyWithValue('attendee', `mailto:${a.address}`)
      if (a.name) p.setParameter('cn', a.name)
      p.setParameter('role', 'REQ-PARTICIPANT')
      // Keep answers people already gave when the event is edited
      const before = previous.find((x) => x.address === a.address.toLowerCase())
      p.setParameter('partstat', before && before.status !== 'none' && before.status !== 'needsAction' ? PARTSTAT[before.status as 'accepted'] ?? 'NEEDS-ACTION' : 'NEEDS-ACTION')
      p.setParameter('rsvp', 'TRUE')
    }
  }
}

export function buildEventIcs(input: EventInput, me: Address): { ics: string; uid: string } {
  const uid = `${randomUUID()}@letterwing`
  const cal = new ICAL.Component(['vcalendar', [], []])
  cal.addPropertyWithValue('prodid', PRODID)
  cal.addPropertyWithValue('version', '2.0')
  cal.addPropertyWithValue('calscale', 'GREGORIAN')
  const v = new ICAL.Component('vevent')
  v.addPropertyWithValue('uid', uid)
  v.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  v.addPropertyWithValue('sequence', 0)
  writeFields(v, input, me, [])
  if (input.repeat !== 'none') v.addPropertyWithValue('rrule', ICAL.Recur.fromString(RRULE[input.repeat]))
  cal.addSubcomponent(v)
  return { ics: cal.toString(), uid }
}

/** Apply edits to an existing (non-repeating) event, keeping everything we don't edit */
export function updateEventIcs(data: string, input: EventInput, me: Address): string {
  const root = parse(data)
  const v = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'))
  if (!v) throw new Error('Event not found in calendar data')
  const previous = people(new ICAL.Event(v), me.address.toLowerCase()).attendees
  writeFields(v, input, me, previous)
  bump(v)
  return root.toString()
}

function bump(v: ICAL.Component): void {
  v.updatePropertyWithValue('sequence', Number(v.getFirstPropertyValue('sequence') ?? 0) + 1)
  v.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
}

/** Set my answer on every instance in the object (a series and its exceptions) */
export function setMyResponse(data: string, me: Address, status: 'accepted' | 'tentative' | 'declined'): string {
  const root = parse(data)
  for (const v of root.getAllSubcomponents('vevent')) {
    let mine = v.getAllProperties('attendee').find((p) => mailto(p.getFirstValue()) === me.address.toLowerCase())
    if (!mine) {
      // Invited through a group or alias: add ourselves so the answer is recorded
      mine = v.addPropertyWithValue('attendee', `mailto:${me.address}`)
      if (me.name) mine.setParameter('cn', me.name)
    }
    mine.setParameter('partstat', PARTSTAT[status])
    mine.removeParameter('rsvp')
  }
  return root.toString()
}

// ---------------------------------------------------------------- invites in mail

export function parseInvite(ics: string, me: string): Invite | null {
  const root = parse(ics)
  const v = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id')) ?? root.getFirstSubcomponent('vevent')
  if (!v) return null
  const method = String(root.getFirstPropertyValue('method') ?? 'PUBLISH').toUpperCase()
  const e = new ICAL.Event(v)
  const d = describe(e, e.startDate.toJSDate(), (e.endDate ?? e.startDate).toJSDate(), me.toLowerCase(), '')
  return {
    method: (['REQUEST', 'CANCEL', 'REPLY', 'COUNTER', 'PUBLISH'].includes(method) ? method : 'OTHER') as Invite['method'],
    uid: d.uid,
    title: d.title,
    start: d.start,
    end: d.end,
    allDay: d.allDay,
    location: d.location,
    organizer: d.organizer,
    myStatus: d.myStatus,
    recurring: d.recurring,
    ics
  }
}

/**
 * The iMIP reply (RFC 6047) an organizer's calendar understands: METHOD:REPLY with only my
 * attendee line. Works with Classic, Google and anything else that sends standard invites.
 */
export function buildInviteReply(ics: string, me: Address, status: 'accepted' | 'tentative' | 'declined'): string {
  const root = parse(ics)
  const v = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id')) ?? root.getFirstSubcomponent('vevent')
  if (!v) throw new Error('The invitation has no event in it')
  const cal = new ICAL.Component(['vcalendar', [], []])
  cal.addPropertyWithValue('prodid', PRODID)
  cal.addPropertyWithValue('version', '2.0')
  cal.addPropertyWithValue('method', 'REPLY')
  // Zones the copied times refer to
  for (const tz of root.getAllSubcomponents('vtimezone')) cal.addSubcomponent(tz)
  const reply = new ICAL.Component('vevent')
  for (const name of ['uid', 'sequence', 'dtstart', 'dtend', 'duration', 'recurrence-id', 'summary', 'organizer']) {
    const p = v.getFirstProperty(name)
    if (p) reply.addProperty(ICAL.Property.fromString(p.toICALString()))
  }
  reply.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  const a = reply.addPropertyWithValue('attendee', `mailto:${me.address}`)
  if (me.name) a.setParameter('cn', me.name)
  a.setParameter('partstat', PARTSTAT[status])
  cal.addSubcomponent(reply)
  return cal.toString()
}
