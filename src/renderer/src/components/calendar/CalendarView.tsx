import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import type { Account, CalendarEvent, CalendarInfo, CalendarView as View, EventInput, Settings } from '@shared/types'
import { api, on } from '../../api'
import { addDays, addMonths, rangeLabel, sameDay, startOfDay, startOfMonth, startOfWeek, step, viewDays } from './dates'
import { EventEditor } from './EventEditor'
import { EventPanel } from './EventPanel'
import { MonthGrid } from './MonthGrid'
import { HOUR, TimeGrid } from './TimeGrid'

export interface CalendarHandle {
  setView(v: View): void
  prev(): void
  next(): void
  today(): void
  newEvent(): void
  open(eventKey: string): void
}

interface Props {
  settings: Settings
  accounts: Account[]
  onSettings(patch: Partial<Settings>): Promise<void>
  onStatus(message: string, error?: boolean): void
  /** True while a dialog/editor is open, so the app's shortcuts stay out of the way */
  onEditing(open: boolean): void
}

const calKey = (c: { accountId: string; calendarId?: string; id?: string }) => `${c.accountId}\u0000${c.calendarId ?? c.id}`

export const CalendarView = forwardRef<CalendarHandle, Props>(function CalendarView({ settings, accounts, onSettings, onStatus, onEditing }, ref) {
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()))
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ input: EventInput; occurrence: boolean } | null>(null)
  const view = settings.calendarView
  const days = useMemo(() => viewDays(view, anchor), [view, anchor])
  const hidden = useMemo(() => new Set(settings.hiddenCalendars), [settings.hiddenCalendars])
  const accountById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts])

  useEffect(() => onEditing(!!editing), [editing])

  const load = useCallback(async () => {
    const [cals, evs] = await Promise.all([api.listCalendars(), api.listEvents(days[0], addDays(days[days.length - 1], 1))])
    setCalendars(cals)
    setEvents(evs)
  }, [days])

  useEffect(() => {
    void load().catch((e: Error) => onStatus(e.message, true))
  }, [load])

  useEffect(() => on('calendar:changed', () => void load()), [load])

  const calById = useMemo(() => new Map(calendars.map((c) => [calKey(c), c])), [calendars])
  const visible = events.filter((e) => !hidden.has(calKey(e)))
  const colorOf = (e: CalendarEvent) => calById.get(calKey(e))?.color ?? 'var(--accent)'
  const current = events.find((e) => e.key === selected) ?? null

  const defaultCalendar = () => {
    const writable = calendars.filter((c) => !c.readOnly && !hidden.has(calKey(c)))
    return writable.find((c) => c.isDefault) ?? writable[0] ?? calendars.find((c) => !c.readOnly)
  }

  const create = (start: number, end: number, allDay: boolean) => {
    const cal = defaultCalendar()
    if (!cal) return onStatus('Add an account with a calendar first (Microsoft 365, Google, or a CalDAV server).', true)
    setEditing({ input: { accountId: cal.accountId, calendarId: cal.id, title: '', start, end, allDay, location: '', description: '', attendees: [], repeat: 'none', online: false }, occurrence: false })
  }

  const newAtNextSlot = () => {
    const now = new Date()
    const base = sameDay(anchor, now.getTime()) ? now.getTime() : anchor + settings.workDayStart * 3_600_000
    const start = Math.ceil(base / 1_800_000) * 1_800_000
    create(start, start + 1_800_000, false)
  }

  useImperativeHandle(ref, () => ({
    setView: (v) => void onSettings({ calendarView: v }),
    prev: () => setAnchor((a) => step(view, a, -1)),
    next: () => setAnchor((a) => step(view, a, 1)),
    today: () => setAnchor(startOfDay(Date.now())),
    newEvent: newAtNextSlot,
    open: (key) => {
      setSelected(key)
      const e = events.find((x) => x.key === key)
      if (e) setAnchor(startOfDay(e.start))
      else void api.listEvents(Date.now() - 86_400_000, Date.now() + 86_400_000).then((list) => {
        const hit = list.find((x) => x.key === key)
        if (hit) setAnchor(startOfDay(hit.start))
      })
    }
  }))

  const run = async (what: Promise<void>, done?: string) => {
    try {
      await what
      if (done) onStatus(done)
    } catch (e) {
      onStatus((e as Error).message, true)
    }
  }

  const editEvent = (ev: CalendarEvent) =>
    setEditing({
      input: {
        key: ev.key,
        accountId: ev.accountId,
        calendarId: ev.calendarId,
        title: ev.title,
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        location: ev.location,
        description: ev.description,
        attendees: ev.attendees.filter((a) => a.address !== ev.organizer?.address).map(({ name, address }) => ({ name, address })),
        repeat: 'none',
        online: !!ev.joinUrl
      },
      occurrence: ev.recurring
    })

  const isInvited = (ev: CalendarEvent) => !ev.isOrganizer && ev.attendees.length > 0

  const deleteEvent = async (ev: CalendarEvent) => {
    const invited = isInvited(ev)
    const what = ev.recurring && !ev.seriesId ? 'every occurrence of this repeating event' : 'this event'
    const ok = await api.confirm(
      invited
        ? { message: `Decline "${ev.title}"?`, detail: 'The organizer is told you are not coming.', ok: 'Decline' }
        : { message: `Delete ${what}?`, detail: ev.attendees.length ? 'Attendees will be told it is cancelled.' : undefined, ok: 'Delete' }
    )
    if (!ok) return
    if (selected === ev.key) setSelected(null)
    await run(api.deleteEvent(ev.key), invited ? 'Declined.' : 'Deleted.')
  }

  const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  /** Right-click on an event, or on empty space in the grid */
  const onMenu = async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const chip = target.closest<HTMLElement>('[data-event]')
    const col = target.closest<HTMLElement>('[data-day]')
    const allDay = target.closest<HTMLElement>('[data-allday]')
    if (!chip && !col && !allDay) return
    e.preventDefault()

    if (chip) {
      const ev = events.find((x) => x.key === chip.dataset.event)
      if (!ev) return
      setSelected(ev.key)
      const cal = calById.get(calKey(ev))
      const writable = !!cal && !cal.readOnly
      const invited = isInvited(ev)
      const answer = (a: string) => ev.myStatus === a
      const pick = await api.showMenu([
        { id: 'open', label: 'Open' },
        ...(writable ? [{ id: 'edit', label: invited ? 'Edit (only on your calendar)…' : 'Edit…' }] : []),
        ...(ev.joinUrl ? [{ id: 'join', label: 'Join online meeting' }] : []),
        { type: 'separator' as const },
        ...(invited && writable && !ev.cancelled
          ? [
              { id: 'accepted', label: 'Accept', checked: answer('accepted') },
              { id: 'tentative', label: 'Tentative', checked: answer('tentative') },
              { id: 'declined', label: 'Decline', checked: answer('declined') },
              { type: 'separator' as const }
            ]
          : []),
        { id: 'copy', label: 'Copy details' },
        ...(writable ? [{ type: 'separator' as const }, { id: 'delete', label: invited ? 'Decline and remove…' : 'Delete…' }] : [])
      ])
      switch (pick) {
        case 'edit':
          return editEvent(ev)
        case 'join':
          return void api.openExternal(ev.joinUrl!)
        case 'accepted':
        case 'tentative':
        case 'declined':
          return void run(api.respondToEvent(ev.key, pick), 'Response sent.')
        case 'copy': {
          const when = ev.allDay ? new Date(ev.start).toLocaleDateString() : `${new Date(ev.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} – ${fmtTime(ev.end)}`
          return void api.copyText([ev.title, when, ev.location, ev.joinUrl].filter(Boolean).join('\n'))
        }
        case 'delete':
          return void deleteEvent(ev)
      }
      return
    }

    // Empty space: a new event at the half hour under the mouse, or all day
    let start: number
    let end: number
    let whole: boolean
    if (col) {
      const day = Number(col.dataset.day)
      const y = e.clientY - col.getBoundingClientRect().top
      start = day + Math.max(0, Math.min(47, Math.floor((y / HOUR) * 2))) * 30 * 60_000
      end = start + 30 * 60_000
      whole = false
    } else {
      const day = Number(allDay!.dataset.allday)
      const month = allDay!.hasAttribute('data-month-cell')
      start = month ? day + settings.workDayStart * 3_600_000 : day
      end = month ? start + 30 * 60_000 : addDays(day, 1)
      whole = !month
    }
    const label = whole ? 'New all-day event' : `New event at ${fmtTime(start)}`
    const pick = await api.showMenu([{ id: 'new', label: `${label} on ${new Date(start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` }, ...(whole ? [] : [{ id: 'allday', label: 'New all-day event' }]), { type: 'separator' }, { id: 'today', label: 'Go to today' }])
    if (pick === 'new') create(start, end, whole)
    else if (pick === 'allday') create(startOfDay(start), addDays(startOfDay(start), 1), true)
    else if (pick === 'today') setAnchor(startOfDay(Date.now()))
  }

  const grouped = useMemo(() => {
    const g = new Map<string, CalendarInfo[]>()
    for (const c of calendars) g.set(c.accountId, [...(g.get(c.accountId) ?? []), c])
    return [...g.entries()]
  }, [calendars])

  return (
    <div className="calendar">
      <aside className="cal-side">
        <button className="primary" onClick={newAtNextSlot} disabled={!calendars.some((c) => !c.readOnly)}>
          + New event
        </button>
        <MiniMonth anchor={anchor} days={view === 'month' ? [] : days} onPick={setAnchor} />
        {grouped.map(([accountId, cals]) => (
          <section key={accountId} className="cal-group">
            <div className="cal-group-name">{accountById[accountId]?.name ?? (accountId === 'ics' ? 'Subscribed' : accountId)}</div>
            {cals.map((c) => (
              <label key={c.id} className="cal-item" style={{ ['--ev' as string]: c.color }}>
                <input
                  type="checkbox"
                  checked={!hidden.has(calKey(c))}
                  onChange={(e) => {
                    const next = new Set(settings.hiddenCalendars)
                    if (e.target.checked) next.delete(calKey(c))
                    else next.add(calKey(c))
                    void onSettings({ hiddenCalendars: [...next] })
                  }}
                />
                <span className="cal-name">{c.name}</span>
              </label>
            ))}
          </section>
        ))}
        {!calendars.length && <p className="hint">No calendars yet. Microsoft 365 and Google accounts bring theirs; IMAP accounts need a CalDAV address (Settings → Accounts).</p>}
      </aside>

      <div className="cal-main">
        <div className="cal-head">
          <button className="ghost" onClick={() => setAnchor(startOfDay(Date.now()))}>
            Today
          </button>
          <button className="ghost icon" title="Previous" onClick={() => setAnchor((a) => step(view, a, -1))}>
            ‹
          </button>
          <button className="ghost icon" title="Next" onClick={() => setAnchor((a) => step(view, a, 1))}>
            ›
          </button>
          <h2>{rangeLabel(view, days, anchor)}</h2>
          <span className="grow" />
          <div className="tabs view-tabs">
            {(
              [
                ['day', 'Day'],
                ['workweek', 'Work week'],
                ['week', 'Week'],
                ['month', 'Month']
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={view === v ? 'active' : ''} onClick={() => void onSettings({ calendarView: v })}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="cal-body" onContextMenu={(e) => void onMenu(e)}>
          {view === 'month' ? (
            <MonthGrid
              days={days}
              month={anchor}
              events={visible}
              colorOf={colorOf}
              selected={selected}
              onSelect={(e) => setSelected(e.key)}
              onCreate={create}
              onDay={(d) => {
                setAnchor(d)
                void onSettings({ calendarView: 'day' })
              }}
            />
          ) : (
            <TimeGrid
              days={days}
              events={visible}
              colorOf={colorOf}
              selected={selected}
              workStart={settings.workDayStart}
              workEnd={settings.workDayEnd}
              onSelect={(e) => setSelected(e.key)}
              onCreate={create}
              onDay={(d) => {
                setAnchor(d)
                void onSettings({ calendarView: 'day' })
              }}
            />
          )}
          {current && (
            <EventPanel
              event={current}
              calendar={calById.get(calKey(current))}
              accountName={accountById[current.accountId]?.name}
              onClose={() => setSelected(null)}
              onOpenUrl={(u) => void api.openExternal(u)}
              onEdit={() => editEvent(current)}
              onDelete={() => void deleteEvent(current)}
              onRespond={(a) => void run(api.respondToEvent(current.key, a), 'Response sent.')}
            />
          )}
        </div>
      </div>

      {editing && (
        <EventEditor
          initial={editing.input}
          occurrence={editing.occurrence}
          calendars={calendars}
          accounts={accountById}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await api.saveEvent(input)
            setEditing(null)
            onStatus(input.attendees.length ? 'Saved and invitations sent.' : 'Saved.')
          }}
        />
      )}
    </div>
  )
})

function MiniMonth({ anchor, days, onPick }: { anchor: number; days: number[]; onPick(d: number): void }) {
  const [month, setMonth] = useState(startOfMonth(anchor))
  useEffect(() => setMonth(startOfMonth(anchor)), [anchor])
  const first = startOfWeek(month)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i))
  const inView = new Set(days.map(startOfDay))
  return (
    <div className="minimonth">
      <div className="mm-head">
        <button className="ghost icon" onClick={() => setMonth(addMonths(month, -1))}>
          ‹
        </button>
        <span>{new Date(month).toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
        <button className="ghost icon" onClick={() => setMonth(addMonths(month, 1))}>
          ›
        </button>
      </div>
      <div className="mm-grid">
        {cells.slice(0, 7).map((d) => (
          <span key={'h' + d} className="mm-dow">
            {new Date(d).toLocaleDateString([], { weekday: 'narrow' })}
          </span>
        ))}
        {cells.map((d) => (
          <button
            key={d}
            className={`mm-day ${new Date(d).getMonth() !== new Date(month).getMonth() ? 'outside' : ''} ${sameDay(d, Date.now()) ? 'today' : ''} ${inView.has(d) ? 'in-view' : ''}`}
            onClick={() => onPick(d)}
          >
            {new Date(d).getDate()}
          </button>
        ))}
      </div>
    </div>
  )
}
