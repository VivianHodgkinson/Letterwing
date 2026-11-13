import { useEffect, useMemo, useState } from 'react'
import { ACTIONS, PRESETS, effectiveKeymap, findConflicts, normaliseBinding, type ActionId, type Keymap, type PresetId } from '@shared/keys'
import type { Settings } from '@shared/types'
import { comboFromEvent } from '../keymap'

interface Props {
  settings: Settings
  onChange(patch: Partial<Settings>): Promise<void>
}

/** How long recording waits for the next key of a sequence before finishing */
const SEQUENCE_PAUSE = 900

export function KeybindingsEditor({ settings, onChange }: Props) {
  const [recording, setRecording] = useState<ActionId | null>(null)
  const [captured, setCaptured] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const map = useMemo(() => effectiveKeymap(settings.keymapPreset, settings.keybindings), [settings])
  const preset = PRESETS[settings.keymapPreset]?.keys ?? PRESETS.classic.keys
  const conflicts = useMemo(() => findConflicts(map), [map])

  const setBindings = (action: ActionId, list: string[]) => {
    const next: Partial<Keymap> = { ...settings.keybindings }
    // Matching the preset again means "no override", so switching presets later still updates it
    if (sameList(list, preset[action])) delete next[action]
    else next[action] = list
    void onChange({ keybindings: next })
  }

  // Recording: capture every key (in the capture phase, before the app's shortcuts see it).
  // A pause finishes the binding, so "G" then "I" records the sequence "G I".
  useEffect(() => {
    if (!recording) return
    let timer = 0
    let keys: string[] = []
    const finish = () => {
      if (keys.length) {
        const binding = normaliseBinding(keys.join(' '))
        if (!map[recording].map(normaliseBinding).includes(binding)) setBindings(recording, [...map[recording], binding])
      }
      setRecording(null)
      setCaptured([])
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const combo = comboFromEvent(e)
      if (!combo) return
      keys = [...keys, combo].slice(0, 3)
      setCaptured(keys)
      window.clearTimeout(timer)
      timer = window.setTimeout(finish, SEQUENCE_PAUSE)
    }
    // Clicking anywhere finishes (or cancels, if nothing was pressed yet)
    const onMouse = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      window.clearTimeout(timer)
      finish()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onMouse, true)
      window.clearTimeout(timer)
    }
  }, [recording])

  const conflictFor = (action: ActionId, binding: string) =>
    conflicts.find((c) => c.actions.includes(action) && (c.binding === normaliseBinding(binding) || c.binding.startsWith(normaliseBinding(binding) + ' ')))

  const label = (id: ActionId) => ACTIONS.find((a) => a.id === id)?.label ?? id
  const shown = ACTIONS.filter((a) => {
    const q = filter.trim().toLowerCase()
    return !q || a.label.toLowerCase().includes(q) || map[a.id].some((b) => b.toLowerCase().includes(q))
  })
  const groups = [...new Set(shown.map((a) => a.group))]

  return (
    <div className="keys">
      <div className="row">
        <label>
          Scheme
          <select
            value={settings.keymapPreset}
            onChange={(e) => {
              const p = e.target.value as PresetId
              const hasOverrides = Object.keys(settings.keybindings).length > 0
              const keep = hasOverrides && confirm('Keep your custom shortcuts on top of the new scheme? Cancel discards them.')
              void onChange({ keymapPreset: p, keybindings: keep ? settings.keybindings : {} })
            }}
          >
            {(Object.keys(PRESETS) as PresetId[]).map((p) => (
              <option key={p} value={p}>
                {PRESETS[p].name}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Find
          <input placeholder="action or key, e.g. flag or Ctrl+Q" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <button className="ghost" disabled={!Object.keys(settings.keybindings).length} onClick={() => void onChange({ keybindings: {} })}>
          Reset all
        </button>
      </div>

      {conflicts.length > 0 && (
        <div className="error">
          {conflicts.map((c) => (
            <div key={c.binding + c.kind}>
              {c.kind === 'same'
                ? `${c.binding} is bound to ${c.actions.map(label).join(' and ')}; only the first will run.`
                : `${c.binding} can never fire because its first key is also ${label(c.actions[0])}.`}
            </div>
          ))}
        </div>
      )}

      {groups.map((g) => (
        <div key={g}>
          <h4>{g}</h4>
          {shown
            .filter((a) => a.group === g)
            .map((a) => {
              const changed = a.id in settings.keybindings
              return (
                <div key={a.id} className={`key-row ${changed ? 'changed' : ''}`}>
                  <span className="grow">{a.label}</span>
                  <span className="key-list">
                    {map[a.id].map((b) => (
                      <span key={b} className={`kbd-chip ${conflictFor(a.id, b) ? 'conflict' : ''}`}>
                        {b.split(' ').map((combo, i) => (
                          <kbd key={i}>{combo}</kbd>
                        ))}
                        <button title="Remove" onClick={() => setBindings(a.id, map[a.id].filter((x) => x !== b))}>
                          ×
                        </button>
                      </span>
                    ))}
                    {recording === a.id ? (
                      <span className="kbd-chip recording">{captured.length ? captured.map((c, i) => <kbd key={i}>{c}</kbd>) : 'Press keys…'}</span>
                    ) : (
                      <button className="ghost small" onClick={() => setRecording(a.id)}>
                        + Add
                      </button>
                    )}
                    {changed && (
                      <button
                        className="ghost small"
                        title={`Back to ${PRESETS[settings.keymapPreset].name}: ${preset[a.id].join(', ') || 'none'}`}
                        onClick={() => setBindings(a.id, preset[a.id])}
                      >
                        Reset
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
        </div>
      ))}
      <p className="hint">
        Click <b>+ Add</b> and press the keys. Press several keys one after another for a sequence (e.g. <kbd>G</kbd> <kbd>I</kbd>). Recording stops when
        you pause; click anywhere to cancel.
      </p>
    </div>
  )
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.map(normaliseBinding).includes(normaliseBinding(x)))
