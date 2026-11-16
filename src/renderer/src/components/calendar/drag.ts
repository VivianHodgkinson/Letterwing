import { useEffect, useRef, useState } from 'react'
import type { CalendarEvent } from '@shared/types'
import { HOUR } from './layout'

const SNAP = 15 * 60_000
/** Movement before a press becomes a drag, so a click still just selects */
const THRESHOLD = 4

type Mode = 'move' | 'resize'

/** Where the pointer is on the grid: a day, and in the time grid also the time under it */
function pointAt(x: number, y: number): { day: number; ms: number | null } | null {
  const el = document.elementFromPoint(x, y)
  const col = el?.closest<HTMLElement>('[data-day]')
  if (col) {
    const day = Number(col.dataset.day)
    const offset = ((y - col.getBoundingClientRect().top) / HOUR) * 3_600_000
    return { day, ms: day + Math.max(0, Math.min(24 * 3_600_000, offset)) }
  }
  const cell = el?.closest<HTMLElement>('[data-allday]')
  return cell ? { day: Number(cell.dataset.allday), ms: null } : null
}

const snap = (ms: number) => Math.round(ms / SNAP) * SNAP
/** Same wall-clock time `days` later (DST-safe) */
function addDaysKeepTime(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/**
 * Drag events to move them (to another time or day) or drag their bottom edge to change their length.
 * While dragging, `apply` returns the events with the dragged one at its new place, so the grid shows
 * it there live. `onCommit` gets the new times when the pointer is let go; Escape cancels.
 */
export function useEventDrag(opts: { canDrag(e: CalendarEvent): boolean; onCommit(e: CalendarEvent, start: number, end: number, at: { x: number; y: number }): void }) {
  const [preview, setPreview] = useState<{ key: string; start: number; end: number } | null>(null)
  const drag = useRef<{ e: CalendarEvent; mode: Mode; x: number; y: number; from: ReturnType<typeof pointAt>; active: boolean; start: number; end: number } | null>(null)
  /** Swallows the click that follows a drag, so dropping an event doesn't also open it */
  const justDragged = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.active) {
        if (Math.abs(ev.clientX - d.x) < THRESHOLD && Math.abs(ev.clientY - d.y) < THRESHOLD) return
        d.active = true
        document.body.classList.add(d.mode === 'resize' ? 'dragging-resize' : 'dragging')
      }
      const to = pointAt(ev.clientX, ev.clientY)
      if (!to || !d.from) return
      const { e } = d
      let start = e.start
      let end = e.end
      if (d.mode === 'resize') {
        if (to.ms === null) return
        end = Math.max(e.start + SNAP, snap(to.ms))
      } else if (to.ms !== null && d.from.ms !== null && !e.allDay) {
        const delta = snap(to.ms - d.from.ms)
        start = e.start + delta
        end = e.end + delta
      } else {
        // Between days (month view, all-day row): same time of day, another date
        const days = Math.round((to.day - d.from.day) / 86_400_000)
        start = addDaysKeepTime(e.start, days)
        end = addDaysKeepTime(e.end, days)
      }
      d.start = start
      d.end = end
      setPreview({ key: e.key, start, end })
    }
    const finish = (ev: PointerEvent | null) => {
      const d = drag.current
      drag.current = null
      document.body.classList.remove('dragging', 'dragging-resize')
      setPreview(null)
      if (!d?.active) return
      justDragged.current = true
      setTimeout(() => (justDragged.current = false), 0)
      if (ev && (d.start !== d.e.start || d.end !== d.e.end)) optsRef.current.onCommit(d.e, d.start, d.end, { x: ev.clientX, y: ev.clientY })
    }
    const up = (ev: PointerEvent) => finish(ev)
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && drag.current?.active) {
        ev.preventDefault()
        ev.stopPropagation()
        finish(null)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', () => finish(null))
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key, true)
    }
  }, [])

  return {
    preview,
    /** pointerdown on an event (mode 'move') or on its resize handle ('resize') */
    start(ev: React.PointerEvent, e: CalendarEvent, mode: Mode) {
      if (ev.button !== 0 || !optsRef.current.canDrag(e)) return
      ev.stopPropagation()
      if (mode === 'resize') ev.preventDefault()
      drag.current = { e, mode, x: ev.clientX, y: ev.clientY, from: pointAt(ev.clientX, ev.clientY), active: false, start: e.start, end: e.end }
    },
    /** The events with the one being dragged at its new place */
    apply(events: CalendarEvent[]): CalendarEvent[] {
      return preview ? events.map((e) => (e.key === preview.key ? { ...e, start: preview.start, end: preview.end } : e)) : events
    },
    wasDrag: () => justDragged.current
  }
}
