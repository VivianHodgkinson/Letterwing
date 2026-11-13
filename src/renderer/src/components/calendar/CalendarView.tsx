import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import type { Account, CalendarEvent, CalendarInfo, CalendarView as View, EventInput, Settings } from '@shared/types'
import { api, on } from '../../api'
import { addDays, addMonths, rangeLabel, sameDay, startOfDay, startOfMonth, startOfWeek, step, viewDays } from './dates'
import { EventEditor } from './EventEditor'
import { EventPanel } from './EventPanel'
import { MonthGrid } from './MonthGrid'
import { TimeGrid } from './TimeGrid'

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
        <div className="cal-body">
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
              onEdit={() =>
                setEditing({
                  input: {
                    key: current.key,
                    accountId: current.accountId,
                    calendarId: current.calendarId,
                    title: current.title,
                    start: current.start,
                    end: current.end,
                    allDay: current.allDay,
                    location: current.location,
                    description: current.description,
                    attendees: current.attendees.filter((a) => a.address !== current.organizer?.address).map(({ name, address }) => ({ name, address })),
                    repeat: 'none',
                    online: !!current.joinUrl
                  },
                  occurrence: current.recurring
                })
              }
              onDelete={() => {
                const invited = !current.isOrganizer && current.attendees.length > 0
                const what = current.recurring && !current.seriesId ? 'every occurrence of this repeating event' : 'this event'
                if (!confirm(invited ? `Decline "${current.title}" and tell the organizer?` : `Delete ${what}?${current.attendees.length ? ' Attendees will be told it is cancelled.' : ''}`)) return
                setSelected(null)
                void run(api.deleteEvent(current.key), invited ? 'Declined.' : 'Deleted.')
              }}
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
