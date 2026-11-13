import { useEffect, useRef, useState } from 'react'
import type { CalendarEvent } from '@shared/types'
import { addDays, sameDay, time } from './dates'
import { layout } from './layout'

const HOUR = 48 // px per hour

interface Props {
  days: number[]
  events: CalendarEvent[]
  colorOf(e: CalendarEvent): string
  selected: string | null
  workStart: number
  workEnd: number
  onSelect(e: CalendarEvent): void
  onCreate(start: number, end: number, allDay: boolean): void
  onDay(day: number): void
}

export function TimeGrid({ days, events, colorOf, selected, workStart, workEnd, onSelect, onCreate, onDay }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())

  // Open at the start of the working day
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (workStart - 0.5) * HOUR)
  }, [days[0]])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const allDay = events.filter((e) => e.allDay || e.end - e.start >= 86_400_000)
  const timed = events.filter((e) => !allDay.includes(e))

  return (
    <div className="timegrid" style={{ ['--days' as string]: days.length }}>
      <div className="tg-head">
        <div className="tg-gutter" />
        {days.map((d) => (
          <button key={d} className={`tg-day-head ${sameDay(d, now) ? 'today' : ''}`} onClick={() => onDay(d)}>
            <span className="dow">{new Date(d).toLocaleDateString([], { weekday: 'short' })}</span>
            <span className="dom">{new Date(d).getDate()}</span>
          </button>
        ))}
      </div>
      <div className="tg-allday">
        <div className="tg-gutter">all day</div>
        {days.map((d) => (
          <div key={d} className="tg-allday-cell" onDoubleClick={(e) => e.target === e.currentTarget && onCreate(d, addDays(d, 1), true)}>
            {allDay
              .filter((e) => e.start < addDays(d, 1) && e.end > d)
              .map((e) => (
                <EventChip key={e.key} e={e} color={colorOf(e)} selected={selected === e.key} onSelect={onSelect} compact />
              ))}
          </div>
        ))}
      </div>
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ height: 24 * HOUR }}>
          <div className="tg-gutter hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="tg-hour-label" style={{ top: h * HOUR }}>
                {h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const dayEnd = addDays(d, 1)
            const segs = layout(
              timed
                .filter((e) => e.start < dayEnd && e.end > d)
                .map((e) => ({ e, s: Math.max(e.start, d), t: Math.min(Math.max(e.end, e.start + 15 * 60_000), dayEnd) }))
            )
            return (
              <div
                key={d}
                className="tg-col"
                onDoubleClick={(ev) => {
                  if (ev.target !== ev.currentTarget) return
                  const y = ev.nativeEvent.offsetY
                  const start = d + Math.floor((y / HOUR) * 2) * 30 * 60_000
                  onCreate(start, start + 30 * 60_000, false)
                }}
              >
                {/* Outside working hours is shaded */}
                <div className="tg-off" style={{ top: 0, height: workStart * HOUR }} />
                <div className="tg-off" style={{ top: workEnd * HOUR, height: (24 - workEnd) * HOUR }} />
                {segs.map(({ e, s, t, col, cols }) => (
                  <div
                    key={e.key}
                    className="tg-event-wrap"
                    style={{ top: ((s - d) / 3_600_000) * HOUR, height: Math.max(18, ((t - s) / 3_600_000) * HOUR - 2), left: `${(col / cols) * 100}%`, width: `${100 / cols}%` }}
                  >
                    {/* Under 45 minutes there's room for one line: title and time side by side */}
                    <EventChip e={e} color={colorOf(e)} selected={selected === e.key} onSelect={onSelect} short={t - s < 45 * 60_000} />
                  </div>
                ))}
                {sameDay(d, now) && <div className="tg-now" style={{ top: ((now - d) / 3_600_000) * HOUR }} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function EventChip(props: { e: CalendarEvent; color: string; selected: boolean; onSelect(e: CalendarEvent): void; compact?: boolean; short?: boolean }) {
  const { e, color, selected, onSelect, compact, short } = props
  const cls = ['ev', e.myStatus === 'declined' || e.cancelled ? 'declined' : '', e.myStatus === 'tentative' || e.showAs === 'tentative' ? 'tentative' : '', e.myStatus === 'needsAction' ? 'pending' : '', selected ? 'selected' : '', compact ? 'compact' : '', short ? 'short' : '']
  return (
    <div
      className={cls.filter(Boolean).join(' ')}
      style={{ ['--ev' as string]: color }}
      title={`${e.title}\n${e.allDay ? 'All day' : `${time(e.start)} – ${time(e.end)}`}${e.location ? `\n${e.location}` : ''}`}
      onClick={(ev) => {
        ev.stopPropagation()
        onSelect(e)
      }}
      onDoubleClick={(ev) => ev.stopPropagation()}
    >
      <span className="ev-title">{e.title}</span>
      {!compact && !e.allDay && <span className="ev-time">{time(e.start)}</span>}
      {!compact && !short && e.location && <span className="ev-loc">{e.location}</span>}
    </div>
  )
}
