// @tz Africa/Johannesburg
import assert from 'node:assert/strict'
import { buildEventIcs, buildInviteReply, eventsFromIcs, parseInvite, setMyResponse, updateEventIcs } from '../src/main/ical'

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
console.log('ical tests passed')
