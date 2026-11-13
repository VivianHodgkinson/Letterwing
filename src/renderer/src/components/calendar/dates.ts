import type { CalendarView } from '@shared/types'

export const DAY = 86_400_000

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Calendar arithmetic in local days (DST-safe: never adds 24h blindly) */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

export function addMonths(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  return d.getTime()
}

/** Weeks start on Monday */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms))
  return addDays(d.getTime(), -((d.getDay() + 6) % 7))
}

export function startOfMonth(ms: number): number {
  const d = new Date(startOfDay(ms))
  d.setDate(1)
  return d.getTime()
}

/** The days a view shows around `anchor` */
export function viewDays(view: CalendarView, anchor: number): number[] {
  if (view === 'day') return [startOfDay(anchor)]
  if (view === 'workweek') return Array.from({ length: 5 }, (_, i) => addDays(startOfWeek(anchor), i))
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))
  // Month: whole weeks covering the month, always 6 rows so the grid doesn't jump
  const first = startOfWeek(startOfMonth(anchor))
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
}

export function step(view: CalendarView, anchor: number, dir: 1 | -1): number {
  if (view === 'day') return addDays(anchor, dir)
  if (view === 'month') return addMonths(anchor, dir)
  return addDays(anchor, 7 * dir)
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b)

export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function rangeLabel(view: CalendarView, days: number[], anchor: number): string {
  if (view === 'month') return new Date(anchor).toLocaleDateString([], { month: 'long', year: 'numeric' })
  if (view === 'day') return new Date(days[0]).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const a = new Date(days[0])
  const b = new Date(days[days.length - 1])
  const sameMonth = a.getMonth() === b.getMonth()
  return `${a.getDate()}${sameMonth ? '' : ' ' + a.toLocaleDateString([], { month: 'short' })} – ${b.getDate()} ${b.toLocaleDateString([], { month: 'long', year: 'numeric' })}`
}

export function whenLabel(start: number, end: number, allDay: boolean): string {
  const day = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  if (allDay) {
    const last = addDays(end, -1)
    return sameDay(start, last) || last < start ? `${day(start)} · all day` : `${day(start)} – ${day(last)} · all day`
  }
  return sameDay(start, end) ? `${day(start)} · ${time(start)} – ${time(end)}` : `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`
}

/** "2026-11-13T09:30" for <input type=datetime-local>, and back */
export function toInput(ms: number, allDay: boolean): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return allDay ? date : `${date}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromInput(v: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  return new Date(v).getTime()
}
