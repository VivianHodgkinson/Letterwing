import { useEffect, useRef } from 'react'
import { normaliseBinding, type ActionId, type Keymap } from '@shared/keys'
import { on } from './api'

const NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Esc: 'Escape',
  Del: 'Delete'
}

/** A KeyboardEvent, or the same fields forwarded from the main process */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'])

/**
 * One keydown as a combo string, e.g. "Ctrl+Shift+R", or null for a bare modifier.
 * Letters and digits use the physical key (e.code), so Ctrl+Shift+R is still "R" and works
 * the same on any layout. Symbols use the character typed, and Shift is left out when it only
 * produced that symbol: "/" rather than "Shift+7" on a German keyboard.
 */
export function comboFromEvent(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  let key: string
  let shiftCounts = e.shiftKey
  const letter = /^Key([A-Z])$/.exec(e.code)
  const digit = /^Digit(\d)$/.exec(e.code)
  if (letter) key = letter[1]
  else if (digit && !e.shiftKey) key = digit[1]
  else if (e.key.length === 1) {
    key = e.key.toUpperCase()
    shiftCounts = false
  } else key = NAMES[e.key] ?? e.key
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', shiftCounts && 'Shift', e.metaKey && 'Meta'].filter(Boolean)
  return [...mods, key].join('+')
}

/** In a text field, plain keys are typing. Only combos with Ctrl/Alt/Meta, F-keys and Escape count as shortcuts there. */
function allowedWhileTyping(combo: string): boolean {
  return /(^|\+)(Ctrl|Alt|Meta)\+/.test(combo) || /(^|\+)(F\d{1,2}|Escape)$/.test(combo)
}

const SEQUENCE_TIMEOUT = 1200

/**
 * Global shortcut listener. Handles sequences: after "G" it waits for the next key,
 * and if nothing matches it gives up and treats the new key as a fresh start.
 */
export function useKeymap(map: Keymap, handlers: Partial<Record<ActionId, () => void>>, enabled: boolean): void {
  const state = useRef({ map, handlers, enabled, pending: [] as string[], timer: 0 })
  state.current.map = map
  state.current.handlers = handlers
  state.current.enabled = enabled

  useEffect(() => {
    /** Returns true when the key was used (so the caller can preventDefault) */
    const handle = (e: KeyLike, typing: boolean): boolean => {
      const s = state.current
      if (!s.enabled) return false
      const combo = comboFromEvent(e)
      if (!combo) return false
      if (typing && !allowedWhileTyping(combo)) return false

      const bindings = (Object.entries(s.map) as [ActionId, string[]][]).flatMap(([action, list]) =>
        list.map((b) => ({ action, keys: normaliseBinding(b) }))
      )
      const tryWith = (pending: string[]): boolean => {
        const typed = [...pending, combo].join(' ')
        const exact = bindings.find((b) => b.keys === typed && s.handlers[b.action])
        if (exact) {
          s.pending = []
          s.handlers[exact.action]!()
          return true
        }
        if (bindings.some((b) => b.keys.startsWith(typed + ' '))) {
          s.pending = [...pending, combo]
          window.clearTimeout(s.timer)
          s.timer = window.setTimeout(() => (s.pending = []), SEQUENCE_TIMEOUT)
          return true
        }
        return false
      }
      if (tryWith(s.pending)) return true
      s.pending = []
      return tryWith([])
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return
      const t = e.target as HTMLElement
      const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
      if (handle(e, typing)) e.preventDefault()
    }
    // Keys pressed inside the mail iframe, forwarded by the main process. The mail can't contain
    // inputs (they're stripped), so treat it like the message list: plain keys count.
    const offForward = on('key:forward', (p) => {
      if (document.activeElement?.tagName === 'IFRAME') handle(p as KeyLike, false)
    })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      offForward()
    }
  }, [])
}
