import { useState } from 'react'
import type { Account, CalendarInfo, EventInput, Repeat } from '@shared/types'
import { RecipientField } from '../Compose'
import { fromInput, toInput } from './dates'

interface Props {
  initial: EventInput
  calendars: CalendarInfo[]
  accounts: Record<string, Account>
  /** Editing one occurrence of a repeating event: no repeat options */
  occurrence: boolean
  onSave(input: EventInput): Promise<void>
  onClose(): void
}

export function EventEditor({ initial, calendars, accounts, occurrence, onSave, onClose }: Props) {
  const [ev, setEv] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writable = calendars.filter((c) => !c.readOnly)
  const account = accounts[ev.accountId]
  const set = (patch: Partial<EventInput>) => setEv((e) => ({ ...e, ...patch }))

  const save = async () => {
    if (!ev.title.trim()) return setError('Give the event a title.')
    if (ev.end < ev.start) return setError('The event ends before it starts.')
    setBusy(true)
    setError(null)
    try {
      await onSave(ev)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog wide event-editor"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) void save()
          if (e.key === 'Escape' && !busy) onClose()
        }}
      >
        <input className="title-input" placeholder="Add a title" value={ev.title} onChange={(e) => set({ title: e.target.value })} autoFocus />
        <label>
          Calendar
          <select
            value={`${ev.accountId}\u0000${ev.calendarId}`}
            disabled={!!ev.key}
            onChange={(e) => {
              const [accountId, calendarId] = e.target.value.split('\u0000')
              set({ accountId, calendarId })
            }}
          >
            {writable.map((c) => (
              <option key={c.accountId + c.id} value={`${c.accountId}\u0000${c.id}`}>
                {c.name} · {accounts[c.accountId]?.name ?? c.accountId}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label className="grow">
            Starts
            <input
              type={ev.allDay ? 'date' : 'datetime-local'}
              value={toInput(ev.start, ev.allDay)}
              onChange={(e) => {
                const start = fromInput(e.target.value)
                if (Number.isNaN(start)) return
                // Moving the start keeps the length, as in Classic
                set({ start, end: start + (ev.end - ev.start) })
              }}
            />
          </label>
          <label className="grow">
            Ends
            <input
              type={ev.allDay ? 'date' : 'datetime-local'}
              // All-day end is exclusive internally; show the last day
              value={toInput(ev.allDay ? ev.end - 1 : ev.end, ev.allDay)}
              onChange={(e) => {
                const v = fromInput(e.target.value)
                if (Number.isNaN(v)) return
                set({ end: ev.allDay ? v + 86_400_000 : v })
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={ev.allDay}
              onChange={(e) => {
                const allDay = e.target.checked
                const day = new Date(ev.start)
                day.setHours(0, 0, 0, 0)
                set(allDay ? { allDay, start: day.getTime(), end: day.getTime() + 86_400_000 } : { allDay, start: day.getTime() + 9 * 3_600_000, end: day.getTime() + 9.5 * 3_600_000 })
              }}
            />
            All day
          </label>
        </div>
        {!occurrence && (
          <label>
            Repeat
            <select value={ev.repeat} disabled={!!ev.key} onChange={(e) => set({ repeat: e.target.value as Repeat })}>
              <option value="none">Doesn't repeat</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Every weekday (Mon–Fri)</option>
              <option value="weekly">Every week on {new Date(ev.start).toLocaleDateString([], { weekday: 'long' })}</option>
              <option value="monthly">Every month on day {new Date(ev.start).getDate()}</option>
              <option value="yearly">Every year</option>
            </select>
          </label>
        )}
        <label>
          Location
          <input value={ev.location} onChange={(e) => set({ location: e.target.value })} placeholder="Room or address" />
        </label>
        <div className="field attendees-field">
          <RecipientField label="Invite" value={ev.attendees} onChange={(attendees) => set({ attendees })} />
        </div>
        {account?.kind === 'microsoft' && (
          <label className="check">
            <input type="checkbox" checked={ev.online} onChange={(e) => set({ online: e.target.checked })} />
            Teams meeting
          </label>
        )}
        <label>
          Notes
          <textarea rows={5} value={ev.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        {ev.attendees.length > 0 && <p className="hint">Saving sends the invitation{ev.key ? ' update' : ''} to everyone invited.</p>}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : ev.attendees.length && !ev.key ? 'Send' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
