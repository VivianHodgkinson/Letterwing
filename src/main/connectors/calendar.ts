import { createAccount, createCalendarObject, deleteCalendarObject, fetchCalendarObjects, fetchCalendars, updateCalendarObject, type DAVCalendar } from 'tsdav'
import type { Account, Address, Attendee, CalendarEvent, CalendarInfo, EventInput, IcsSubscription, ResponseStatus } from '@shared/types'
import { buildEventIcs, eventsFromIcs, setMyResponse, updateEventIcs, type RemoteEvent } from '../ical'
import type { GraphConnector } from './graph'

export type Answer = 'accepted' | 'tentative' | 'declined'

/**
 * The contract every calendar backend implements, like MailConnector for mail.
 * listEvents returns occurrences (repeating events expanded) in the range.
 */
export interface CalendarConnector {
  listCalendars(): Promise<Omit<CalendarInfo, 'accountId'>[]>
  listEvents(calendarId: string, from: number, to: number): Promise<RemoteEvent[]>
  createEvent(input: EventInput): Promise<void>
  updateEvent(input: EventInput, existing: CalendarEvent): Promise<void>
  deleteEvent(existing: CalendarEvent): Promise<void>
  respond(existing: CalendarEvent, answer: Answer, comment?: string): Promise<void>
}

const me = (a: Account): Address => ({ name: a.senderName ?? '', address: a.email })

// ---------------------------------------------------------------- Microsoft Graph

type GTime = { dateTime: string; timeZone: string }
type GEvent = {
  id: string
  iCalUId: string
  subject?: string
  start: GTime
  end: GTime
  isAllDay: boolean
  location?: { displayName?: string }
  body?: { content?: string }
  organizer?: { emailAddress: { name: string; address: string } }
  attendees?: { type: string; status: { response: string }; emailAddress: { name: string; address: string } }[]
  responseStatus?: { response: string }
  type: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
  seriesMasterId?: string
  isOrganizer: boolean
  isCancelled: boolean
  showAs?: string
  onlineMeeting?: { joinUrl?: string } | null
}

const GRAPH_STATUS: Record<string, ResponseStatus> = {
  accepted: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
  notResponded: 'needsAction',
  organizer: 'organizer',
  none: 'none'
}

const GRAPH_COLORS: Record<string, string> = {
  lightBlue: '#4f9cf0', lightGreen: '#4cc38a', lightOrange: '#f0a04b', lightGray: '#9aa3b5', lightYellow: '#e6c84f',
  lightTeal: '#3cc0c0', lightPink: '#e07ab8', lightBrown: '#b08a6a', lightRed: '#e86a6a', maxColor: '#9a7cf0', auto: '#6c8cff'
}

/** Graph returns times in the zone we ask for; we ask for UTC */
const PREFER_UTC = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' }

const fromGraphTime = (t: GTime, allDay: boolean): number => {
  if (allDay) {
    const [y, m, d] = t.dateTime.slice(0, 10).split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  return Date.parse(t.dateTime.endsWith('Z') ? t.dateTime : t.dateTime + 'Z')
}

const ymd = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class GraphCalendar implements CalendarConnector {
  constructor(
    private account: Account,
    private graph: GraphConnector
  ) {}

  async listCalendars() {
    type C = { id: string; name: string; hexColor?: string; color?: string; canEdit: boolean; isDefaultCalendar?: boolean }
    const out: Omit<CalendarInfo, 'accountId'>[] = []
    let next: string | undefined = '/me/calendars?$top=100&$select=id,name,hexColor,color,canEdit,isDefaultCalendar'
    while (next) {
      const page: { value: C[]; '@odata.nextLink'?: string } = await this.graph.call(next)
      for (const c of page.value)
        out.push({ id: c.id, name: c.name, color: c.hexColor || GRAPH_COLORS[c.color ?? 'auto'] || GRAPH_COLORS.auto, readOnly: !c.canEdit, isDefault: !!c.isDefaultCalendar })
      next = page['@odata.nextLink']
    }
    return out
  }

  async listEvents(calendarId: string, from: number, to: number): Promise<RemoteEvent[]> {
    const select = 'iCalUId,subject,start,end,isAllDay,location,body,organizer,attendees,responseStatus,type,seriesMasterId,isOrganizer,isCancelled,showAs,onlineMeeting'
    let next: string | undefined =
      `/me/calendars/${calendarId}/calendarView?startDateTime=${new Date(from).toISOString()}&endDateTime=${new Date(to).toISOString()}&$top=250&$select=${select}`
    const out: RemoteEvent[] = []
    while (next) {
      const page: { value: GEvent[]; '@odata.nextLink'?: string } = await this.graph.call(next, { headers: PREFER_UTC })
      for (const e of page.value) out.push(this.toEvent(e))
      next = page['@odata.nextLink']
    }
    return out
  }

  private toEvent(e: GEvent): RemoteEvent {
    const attendees: Attendee[] = (e.attendees ?? []).map((a) => ({
      name: a.emailAddress.name ?? '',
      address: (a.emailAddress.address ?? '').toLowerCase(),
      status: GRAPH_STATUS[a.status.response] ?? 'none',
      optional: a.type === 'optional'
    }))
    const text = `${e.location?.displayName ?? ''} ${e.body?.content ?? ''}`
    const join = e.onlineMeeting?.joinUrl ?? /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/.exec(text)?.[0]
    const showAs = e.showAs === 'workingElsewhere' ? 'elsewhere' : e.showAs
    return {
      remoteId: e.id,
      ...(e.seriesMasterId ? { seriesId: e.seriesMasterId } : {}),
      uid: e.iCalUId,
      title: e.subject || '(no title)',
      start: fromGraphTime(e.start, e.isAllDay),
      end: fromGraphTime(e.end, e.isAllDay),
      allDay: e.isAllDay,
      location: e.location?.displayName ?? '',
      description: (e.body?.content ?? '').trim(),
      organizer: e.organizer ? { name: e.organizer.emailAddress.name ?? '', address: (e.organizer.emailAddress.address ?? '').toLowerCase() } : null,
      attendees,
      myStatus: GRAPH_STATUS[e.responseStatus?.response ?? 'none'] ?? 'none',
      isOrganizer: e.isOrganizer,
      recurring: e.type !== 'singleInstance',
      cancelled: e.isCancelled,
      showAs: (['free', 'tentative', 'busy', 'oof', 'elsewhere'].includes(showAs ?? '') ? showAs : 'busy') as RemoteEvent['showAs'],
      ...(join ? { joinUrl: join } : {})
    }
  }

  private body(input: EventInput, withRepeat: boolean): Record<string, unknown> {
    const time = (ms: number) =>
      input.allDay ? { dateTime: `${ymd(ms)}T00:00:00`, timeZone: 'UTC' } : { dateTime: new Date(ms).toISOString().replace('Z', ''), timeZone: 'UTC' }
    const end = input.allDay && input.end <= input.start ? input.start + 86_400_000 : input.end
    const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(input.start).getDay()]
    const d = new Date(input.start)
    const patterns: Record<string, Record<string, unknown>> = {
      daily: { type: 'daily', interval: 1 },
      weekdays: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] },
      weekly: { type: 'weekly', interval: 1, daysOfWeek: [day] },
      monthly: { type: 'absoluteMonthly', interval: 1, dayOfMonth: d.getDate() },
      yearly: { type: 'absoluteYearly', interval: 1, dayOfMonth: d.getDate(), month: d.getMonth() + 1 }
    }
    return {
      subject: input.title,
      body: { contentType: 'text', content: input.description },
      start: time(input.start),
      end: time(end),
      isAllDay: input.allDay,
      location: { displayName: input.location },
      attendees: input.attendees.map((a) => ({ type: 'required', emailAddress: { address: a.address, name: a.name || a.address } })),
      ...(input.online ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
      ...(withRepeat && input.repeat !== 'none' ? { recurrence: { pattern: patterns[input.repeat], range: { type: 'noEnd', startDate: ymd(input.start) } } } : {})
    }
  }

  async createEvent(input: EventInput): Promise<void> {
    // Exchange sends the invitations itself
    await this.graph.call(`/me/calendars/${input.calendarId}/events`, { method: 'POST', body: JSON.stringify(this.body(input, true)) })
  }

  async updateEvent(input: EventInput, existing: CalendarEvent): Promise<void> {
    // On an occurrence ID this changes just that occurrence, like the classic "this event" option
    await this.graph.call(`/me/events/${existing.remoteId}`, { method: 'PATCH', body: JSON.stringify(this.body(input, false)) })
  }

  async deleteEvent(existing: CalendarEvent): Promise<void> {
    // An attendee "deleting" a meeting should decline it, so the organizer knows
    if (!existing.isOrganizer && existing.myStatus !== 'declined' && existing.attendees.length) await this.respond(existing, 'declined')
    else await this.graph.call(`/me/events/${existing.remoteId}`, { method: 'DELETE' })
  }

  async respond(existing: CalendarEvent, answer: Answer, comment?: string): Promise<void> {
    await this.respondTo(existing.seriesId ?? existing.remoteId, answer, comment)
  }

  async respondTo(eventId: string, answer: Answer, comment?: string): Promise<void> {
    const action = { accepted: 'accept', tentative: 'tentativelyAccept', declined: 'decline' }[answer]
    await this.graph.call(`/me/events/${eventId}/${action}`, { method: 'POST', body: JSON.stringify({ sendResponse: true, comment: comment ?? '' }) })
  }
}

// ---------------------------------------------------------------- CalDAV

/**
 * CalDAV: Google, iCloud, Fastmail, Nextcloud, Radicale... Servers with scheduling (RFC 6638)
 * send invitations and replies themselves when an event or a PARTSTAT changes.
 */
export class CalDavCalendar implements CalendarConnector {
  private calendars = new Map<string, DAVCalendar>()

  constructor(
    private account: Account,
    private serverUrl: string,
    private headers: () => Promise<Record<string, string>>
  ) {}

  async listCalendars() {
    const headers = await this.headers()
    const account = await createAccount({ account: { serverUrl: this.serverUrl, accountType: 'caldav' }, headers })
    const cals = (await fetchCalendars({ account, headers })).filter((c) => !c.components || c.components.includes('VEVENT'))
    this.calendars = new Map(cals.map((c) => [c.url, c]))
    return cals.map((c, i) => ({
      id: c.url,
      name: typeof c.displayName === 'string' && c.displayName ? c.displayName : `Calendar ${i + 1}`,
      color: (c.calendarColor ?? '').slice(0, 7) || '#4f9cf0',
      readOnly: false,
      isDefault: i === 0
    }))
  }

  private cal(id: string): DAVCalendar {
    return this.calendars.get(id) ?? { url: id }
  }

  async listEvents(calendarId: string, from: number, to: number): Promise<RemoteEvent[]> {
    const objects = await fetchCalendarObjects({
      calendar: this.cal(calendarId),
      headers: await this.headers(),
      timeRange: { start: new Date(from).toISOString(), end: new Date(to).toISOString() }
    })
    const mine = this.account.email.toLowerCase()
    return objects.flatMap((o) => {
      try {
        return o.data ? eventsFromIcs(String(o.data), o.url, from, to, mine) : []
      } catch {
        return [] // one broken event shouldn't hide the whole calendar
      }
    })
  }

  private async object(existing: CalendarEvent): Promise<{ url: string; data: string; etag?: string }> {
    const [o] = await fetchCalendarObjects({ calendar: this.cal(existing.calendarId), objectUrls: [existing.remoteId], headers: await this.headers() })
    if (!o?.data) throw new Error('That event is no longer on the server')
    return { url: o.url, data: String(o.data), etag: o.etag }
  }

  private async check(res: Response, what: string): Promise<void> {
    if (!res.ok) throw new Error(`Couldn't ${what}: the calendar server said ${res.status} ${res.statusText}`)
  }

  async createEvent(input: EventInput): Promise<void> {
    const { ics, uid } = buildEventIcs(input, me(this.account))
    const res = await createCalendarObject({ calendar: this.cal(input.calendarId), filename: `${uid.replace(/[^\w.-]/g, '')}.ics`, iCalString: ics, headers: await this.headers() })
    await this.check(res, 'create the event')
  }

  async updateEvent(input: EventInput, existing: CalendarEvent): Promise<void> {
    if (existing.recurring) throw new Error('Editing repeating events on CalDAV calendars is not supported yet. Edit it in the calendar\'s own app.')
    const o = await this.object(existing)
    const res = await updateCalendarObject({ calendarObject: { ...o, data: updateEventIcs(o.data, input, me(this.account)) }, headers: await this.headers() })
    await this.check(res, 'save the event')
  }

  async deleteEvent(existing: CalendarEvent): Promise<void> {
    if (!existing.isOrganizer && existing.attendees.length) return this.respond(existing, 'declined')
    const o = await this.object(existing)
    await this.check(await deleteCalendarObject({ calendarObject: o, headers: await this.headers() }), 'delete the event')
  }

  async respond(existing: CalendarEvent, answer: Answer): Promise<void> {
    const o = await this.object(existing)
    const res = await updateCalendarObject({ calendarObject: { ...o, data: setMyResponse(o.data, me(this.account), answer) }, headers: await this.headers() })
    await this.check(res, 'send your response')
  }
}

// ---------------------------------------------------------------- ICS subscriptions

/** Read-only calendars from a link. Downloaded at most every 30 minutes. */
export class IcsCalendars implements CalendarConnector {
  private cache = new Map<string, { at: number; data: string }>()

  constructor(private subs: IcsSubscription[]) {}

  async listCalendars() {
    return this.subs.map((s) => ({ id: s.id, name: s.name, color: s.color, readOnly: true, isDefault: false }))
  }

  private async data(sub: IcsSubscription): Promise<string> {
    const hit = this.cache.get(sub.id)
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.data
    const res = await fetch(sub.url.replace(/^webcals?:/i, 'https:'), { headers: { Accept: 'text/calendar' } })
    if (!res.ok) throw new Error(`${sub.name}: download failed (${res.status})`)
    const data = await res.text()
    if (!/BEGIN:VCALENDAR/i.test(data)) throw new Error(`${sub.name}: that link isn't an iCalendar (.ics) feed`)
    this.cache.set(sub.id, { at: Date.now(), data })
    return data
  }

  async listEvents(calendarId: string, from: number, to: number): Promise<RemoteEvent[]> {
    const sub = this.subs.find((s) => s.id === calendarId)
    return sub ? eventsFromIcs(await this.data(sub), sub.url, from, to, '') : []
  }

  async createEvent(): Promise<void> {
    throw new Error('Subscribed calendars are read-only')
  }
  updateEvent = this.createEvent
  deleteEvent = this.createEvent
  respond = this.createEvent
}
