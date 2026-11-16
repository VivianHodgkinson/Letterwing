// @tz Africa/Johannesburg
import assert from 'node:assert/strict'
import { buildEventIcs, buildInviteReply, eventsFromIcs, parseInvite, removeOccurrenceIcs, setMyResponse, updateEventIcs, updateOccurrenceIcs, updateSeriesIcs } from '../src/main/ical'

const me = { name: 'Test User', address: 'me@issue.test' }

// Exchange-style invite: Windows zone name with its own VTIMEZONE, weekly series, one moved and one cancelled occurrence
const exchangeInvite = `BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:South Africa Standard Time
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0200
TZOFFSETTO:+0200
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN=Sam Naidoo:mailto:sam@issue.test
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Test User:mailto:Me@Issue.test
ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Jo:mailto:jo@acme.test
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=South Africa Standard Time:20261123T090000
UID:040000008200E00074C5B7101A82E008000000001
SUMMARY:Stand-up
DTSTART;TZID=South Africa Standard Time:20261109T090000
DTEND;TZID=South Africa Standard Time:20261109T093000
LOCATION:Microsoft Teams Meeting
DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x
SEQUENCE:2
X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE
END:VEVENT
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E008000000001
RECURRENCE-ID;TZID=South Africa Standard Time:20261116T090000
SUMMARY:Stand-up (moved)
DTSTART;TZID=South Africa Standard Time:20261116T140000
DTEND;TZID=South Africa Standard Time:20261116T143000
ORGANIZER;CN=Sam Naidoo:mailto:sam@issue.test
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n')

const from = Date.parse('2026-11-01T00:00:00+02:00')
const to = Date.parse('2026-12-01T00:00:00+02:00')
const occ = eventsFromIcs(exchangeInvite, '/cal/1.ics', from, to, 'me@issue.test')
const local = (ms: number) => new Date(ms).toISOString()
assert.deepEqual(occ.map((e) => [local(e.start), e.title]), [
  ['2026-11-09T07:00:00.000Z', 'Stand-up'],
  ['2026-11-16T12:00:00.000Z', 'Stand-up (moved)'],
  // 23rd is cancelled (EXDATE)
  ['2026-11-30T07:00:00.000Z', 'Stand-up']
])
const first = occ[0]
assert.equal(first.recurring, true)
assert.equal(first.myStatus, 'needsAction', 'my address matched case-insensitively')
assert.equal(first.isOrganizer, false)
assert.equal(first.organizer!.name, 'Sam Naidoo')
assert.equal(first.attendees.find((a) => a.address === 'jo@acme.test')!.optional, true)
assert.match(first.joinUrl!, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//)
assert.equal(first.showAs, 'tentative')
assert.equal(first.end - first.start, 30 * 60_000)

// Invite in mail, and the iMIP reply
const invite = parseInvite(exchangeInvite, 'me@issue.test')!
assert.equal(invite.method, 'REQUEST')
assert.equal(invite.title, 'Stand-up')
assert.equal(invite.recurring, true)
const reply = buildInviteReply(exchangeInvite, me, 'accepted')
assert.match(reply, /METHOD:REPLY/)
assert.match(reply, /UID:040000008200E00074C5B7101A82E008000000001/)
assert.match(reply, /SEQUENCE:2/)
assert.match(reply, /ATTENDEE;CN=Test User;PARTSTAT=ACCEPTED:mailto:me@issue.test/)
assert.match(reply, /BEGIN:VTIMEZONE/, 'zones the times refer to are included')
assert.doesNotMatch(reply, /jo@acme/, 'only my own attendee line')
const parsedReply = parseInvite(reply, 'sam@issue.test')!
assert.equal(parsedReply.method, 'REPLY')
assert.equal(parsedReply.start, invite.start, 'times survive the round trip')

// Answering in a CalDAV calendar: every instance gets my PARTSTAT
const answered = setMyResponse(exchangeInvite, me, 'tentative')
const after = eventsFromIcs(answered, 'x', from, to, 'me@issue.test')
assert.equal(after[0].myStatus, 'tentative')
assert.equal(after[1].attendees.find((a) => a.address === 'me@issue.test')!.status, 'tentative', 'exception got an attendee line added')

// Google: all-day event + Meet link in X-GOOGLE-CONFERENCE
const google = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc@google.com
DTSTART;VALUE=DATE:20261216
DTEND;VALUE=DATE:20261217
SUMMARY:Day of Reconciliation
TRANSP:TRANSPARENT
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n')
const [holiday] = eventsFromIcs(google, 'g', Date.parse('2026-12-01'), Date.parse('2027-01-01'), 'me@issue.test')
assert.equal(holiday.allDay, true)
assert.equal(new Date(holiday.start).getDate(), 16)
assert.equal(new Date(holiday.start).getHours(), 0, 'all-day starts at local midnight')
assert.equal(holiday.end - holiday.start, 86_400_000)
assert.equal(holiday.showAs, 'free')
assert.equal(holiday.joinUrl, 'https://meet.google.com/abc-defg-hij')
assert.equal(holiday.isOrganizer, true, 'no organizer means it is my own event')

// Create, read back, edit (keeping attendee answers)
const start = Date.parse('2026-11-20T10:00:00+02:00')
const input = { accountId: 'a', calendarId: 'c', title: 'Quote review', start, end: start + 3600_000, allDay: false, location: 'Boardroom', description: 'Bring numbers', attendees: [{ name: 'Jo', address: 'jo@acme.test' }], repeat: 'weekdays' as const, online: false }
const { ics, uid } = buildEventIcs(input, me)
const created = eventsFromIcs(ics, 'n', start - 1, start + 7 * 86_400_000, 'me@issue.test')
assert.equal(created[0].uid, uid)
assert.deepEqual(created.map((e) => new Date(e.start).getDay()), [5, 1, 2, 3, 4], 'weekdays only: Fri, Mon-Thu')
assert.equal(created[0].myStatus, 'organizer')
assert.equal(created[0].attendees[0].status, 'needsAction')
const jo = setMyResponse(ics, { name: 'Jo', address: 'jo@acme.test' }, 'accepted')
const edited = updateEventIcs(jo, { ...input, title: 'Quote review v2', repeat: 'none', attendees: [...input.attendees, { name: '', address: 'boss@issue.test' }] }, me)
const [e2] = eventsFromIcs(edited, 'n', start - 1, start + 3600_000, 'me@issue.test')
assert.equal(e2.title, 'Quote review v2')
assert.deepEqual(e2.attendees.map((a) => [a.address, a.status]), [['jo@acme.test', 'accepted'], ['boss@issue.test', 'needsAction']])
assert.match(edited, /SEQUENCE:1/)

// All-day create: DTEND is the following day
const allDay = buildEventIcs({ ...input, allDay: true, repeat: 'none', attendees: [], start: Date.parse('2026-12-24T00:00:00+02:00'), end: Date.parse('2026-12-24T00:00:00+02:00') }, me).ics
assert.match(allDay, /DTSTART;VALUE=DATE:20261224/)
assert.match(allDay, /DTEND;VALUE=DATE:20261225/)
{
// ---------------------------------------------------------------- repeating events (CalDAV editing)
// Weekly on Mondays 09:00 New York time, across the November DST change
const ny = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:standup@test', 'DTSTAMP:20261001T000000Z', 'SEQUENCE:0', 'SUMMARY:Standup',
  'DTSTART;TZID=America/New_York:20261026T090000', 'DTEND;TZID=America/New_York:20261026T093000', 'RRULE:FREQ=WEEKLY;COUNT=4',
  'END:VEVENT', 'END:VCALENDAR'
].join('\r\n')
const range = [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z')] as const
const occ = (data: string) => eventsFromIcs(data, 'obj', range[0], range[1], 'me@x.co.za')
const series = occ(ny)
assert.equal(series.length, 4)
assert.equal(series[0].start, Date.parse('2026-10-26T13:00:00Z'), '09:00 EDT')
assert.equal(series[1].start, Date.parse('2026-11-02T14:00:00Z'), '09:00 EST after the change')
assert.equal(series[1].recurrenceId, series[1].start, 'occurrences know their place in the series')
const asInput = (e: (typeof series)[0], patch: Partial<Parameters<typeof updateOccurrenceIcs>[2]>) => ({
  accountId: 'a', calendarId: 'c', title: e.title, start: e.start, end: e.end, allDay: false, location: '', description: '', attendees: [], repeat: 'none' as const, online: false, ...patch
})

// This event only: the second Monday moves an hour later, the others stay
const hour = 3_600_000
const one = updateOccurrenceIcs(ny, series[1].recurrenceId!, asInput(series[1], { start: series[1].start + hour, end: series[1].end + hour, title: 'Standup (moved)' }), me)
assert.match(one, /RECURRENCE-ID;TZID=America\/New_York:20261102T090000/)
let after = occ(one)
assert.equal(after.length, 4, 'still four occurrences')
assert.equal(after[1].start, series[1].start + hour)
assert.equal(after[1].title, 'Standup (moved)')
assert.equal(after[2].start, series[2].start, 'the next one is untouched')
// Editing the same occurrence again updates that exception rather than adding another
const again = updateOccurrenceIcs(one, series[1].recurrenceId!, asInput(after[1], { title: 'Standup (moved twice)' }), me)
assert.equal((again.match(/RECURRENCE-ID/g) ?? []).length, 1)

// All events: drag one occurrence from 09:00 to 10:00 and the series follows, in local time across DST
const all = updateSeriesIcs(one, series[2].recurrenceId!, asInput(series[2], { start: series[2].start + hour, end: series[2].end + hour, title: 'Team standup' }), me)
assert.match(all, /DTSTART;TZID=America\/New_York:20261026T100000/)
assert.match(all, /RRULE:FREQ=WEEKLY;COUNT=4/, 'still repeats')
after = occ(all)
assert.deepEqual(after.map((e) => new Date(e.start).toISOString()), ['2026-10-26T14:00:00.000Z', '2026-11-02T15:00:00.000Z', '2026-11-09T15:00:00.000Z', '2026-11-16T15:00:00.000Z'])
assert.equal(after[0].title, 'Team standup')
assert.equal(after[1].title, 'Standup (moved)', 'the occurrence changed by hand keeps its own time and title, still in its place in the series')

// Delete one occurrence: three left, and its changed copy is gone too
const fewer = removeOccurrenceIcs(one, series[1].recurrenceId!)
assert.match(fewer, /EXDATE;TZID=America\/New_York:20261102T090000/)
after = occ(fewer)
assert.equal(after.length, 3)
assert.ok(!after.some((e) => e.title === 'Standup (moved)'))

}
console.log('ical tests passed')
