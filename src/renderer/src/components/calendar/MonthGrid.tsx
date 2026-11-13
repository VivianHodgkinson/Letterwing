import type { CalendarEvent } from '@shared/types'
import { addDays, sameDay, startOfDay } from './dates'
import { EventChip } from './TimeGrid'

const MAX_PER_DAY = 4

interface Props {
  days: number[]
  month: number
  events: CalendarEvent[]
  colorOf(e: CalendarEvent): string
  selected: string | null
  onSelect(e: CalendarEvent): void
  onCreate(start: number, end: number, allDay: boolean): void
  onDay(day: number): void
}

export function MonthGrid({ days, month, events, colorOf, selected, onSelect, onCreate, onDay }: Props) {
  const today = startOfDay(Date.now())
  return (
    <div className="monthgrid">
      {days.slice(0, 7).map((d) => (
        <div key={d} className="mg-dow">
          {new Date(d).toLocaleDateString([], { weekday: 'short' })}
        </div>
      ))}
      {days.map((d) => {
        const list = events.filter((e) => e.start < addDays(d, 1) && e.end > d).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
        const outside = new Date(d).getMonth() !== new Date(month).getMonth()
        return (
          <div
            key={d}
            className={`mg-cell ${outside ? 'outside' : ''} ${sameDay(d, today) ? 'today' : ''}`}
            onDoubleClick={(e) => e.target === e.currentTarget && onCreate(d + 9 * 3_600_000, d + 9.5 * 3_600_000, false)}
          >
            <button className="mg-date" onClick={() => onDay(d)}>
              {new Date(d).getDate() === 1 ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' }) : new Date(d).getDate()}
            </button>
            {list.slice(0, MAX_PER_DAY).map((e) => (
              <EventChip key={e.key} e={e} color={colorOf(e)} selected={selected === e.key} onSelect={onSelect} compact />
            ))}
            {list.length > MAX_PER_DAY && (
              <button className="mg-more" onClick={() => onDay(d)}>
                +{list.length - MAX_PER_DAY} more
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
