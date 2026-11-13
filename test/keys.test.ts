import assert from 'node:assert/strict'
import { ACTIONS, PRESETS, effectiveKeymap, findConflicts, normaliseBinding } from '../src/shared/keys'
import { comboFromEvent } from '../src/renderer/src/keymap'

// every preset binds every action (possibly to nothing) and has no conflicts of its own
for (const [id, p] of Object.entries(PRESETS)) {
  assert.deepEqual(Object.keys(p.keys).sort(), ACTIONS.map((a) => a.id).sort(), `${id} covers all actions`)
  assert.deepEqual(findConflicts(p.keys), [], `${id} has no conflicts`)
}

assert.equal(normaliseBinding('shift+ctrl+r'), 'Ctrl+Shift+R')
assert.equal(normaliseBinding('  g   i '), 'G I')
assert.equal(normaliseBinding('Ctrl++'), 'Ctrl++')

// overrides replace one action; [] unbinds
const m = effectiveKeymap('classic', { toggleFlag: ['F'], markRead: [] })
assert.deepEqual(m.toggleFlag, ['F'])
assert.deepEqual(m.markRead, [])
assert.deepEqual(m.markUnread, ['Ctrl+U'])

assert.deepEqual(findConflicts({ ...PRESETS.classic.keys, markRead: ['Ctrl+U'] }).map((c) => c.kind), ['same'])
assert.deepEqual(findConflicts({ ...PRESETS.singlekey.keys, toggleFlag: ['G'] }).map((c) => c.kind).sort(), ['prefix', 'prefix'])

const ev = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
assert.equal(comboFromEvent(ev('q', 'KeyQ', { ctrlKey: true })), 'Ctrl+Q')
assert.equal(comboFromEvent(ev('I', 'KeyI', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+I')
// non-Latin layout: physical key still reads as the letter
assert.equal(comboFromEvent(ev('й', 'KeyQ', { ctrlKey: true })), 'Ctrl+Q')
// symbols: shift is part of the character, not a modifier
assert.equal(comboFromEvent(ev('/', 'Digit7', { shiftKey: true })), '/')
assert.equal(comboFromEvent(ev('?', 'Slash', { shiftKey: true })), '?')
assert.equal(comboFromEvent(ev('.', 'Period', { ctrlKey: true })), 'Ctrl+.')
assert.equal(comboFromEvent(ev('ArrowDown', 'ArrowDown')), 'Down')
assert.equal(comboFromEvent(ev('F9', 'F9')), 'F9')
assert.equal(comboFromEvent(ev('Control', 'ControlLeft', { ctrlKey: true })), null)
// every preset binding is reachable: it equals what comboFromEvent produces once normalised
for (const p of Object.values(PRESETS)) for (const list of Object.values(p.keys)) for (const b of list) assert.equal(normaliseBinding(b), b, `${b} is canonical`)
console.log('keys tests passed')
