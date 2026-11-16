/**
 * How often to check for new mail on servers that can't push it to us (Microsoft Graph has no push a
 * desktop app can receive). An empty check is one tiny request, so while the window is showing we check
 * every few seconds; in the tray, less often. Bringing the window back or waking the computer checks at once.
 */
export const VISIBLE_MS = 10_000
export const BACKGROUND_MS = 30_000
/** Don't re-check on every focus change when someone flicks between windows */
const WAKE_GAP_MS = 3_000

let visible = true
let lastWake = 0
const wakers = new Set<() => void>()

export function pollMs(): number {
  return visible ? VISIBLE_MS : BACKGROUND_MS
}

export function setVisible(v: boolean): void {
  const was = visible
  visible = v
  if (v && !was) wake()
}

/** Check now (window shown or focused, computer resumed) */
export function wake(): void {
  const now = Date.now()
  if (now - lastWake < WAKE_GAP_MS) return
  lastWake = now
  for (const fn of wakers) fn()
}

export function onWake(fn: () => void): () => void {
  wakers.add(fn)
  return () => wakers.delete(fn)
}

/**
 * Call `check` every pollMs() (re-read each time, so the pace follows the window) and right away on wake.
 * Returns a function that stops it.
 */
export function poll(check: () => void): () => void {
  let stopped = false
  let timer: NodeJS.Timeout
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, pollMs())
  }
  const tick = () => {
    if (stopped) return
    check()
    schedule()
  }
  const off = onWake(() => {
    clearTimeout(timer)
    tick()
  })
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
    off()
  }
}
