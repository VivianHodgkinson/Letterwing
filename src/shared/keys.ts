/**
 * Keyboard shortcuts. A binding is one or more combos separated by spaces:
 * "Ctrl+Shift+R" is a combo, "G I" is a sequence (press G, then I).
 * Modifiers are written in the order Ctrl, Alt, Shift, Meta.
 *
 * The effective keymap is a preset (Classic by default) with the user's
 * per-action overrides on top. An override replaces that action's bindings;
 * an empty list unbinds it.
 */

export type ActionId =
  | 'nextMessage'
  | 'prevMessage'
  | 'firstMessage'
  | 'lastMessage'
  | 'markRead'
  | 'markUnread'
  | 'toggleRead'
  | 'toggleFlag'
  | 'search'
  | 'clearSearch'
  | 'goInbox'
  | 'syncAll'
  | 'openSettings'
  | 'addAccount'
  | 'loadImages'

export interface ActionInfo {
  id: ActionId
  label: string
  group: 'Navigate' | 'Message' | 'Search' | 'App'
}

/** Every bindable action. New features add an entry here and a handler in the renderer. */
export const ACTIONS: ActionInfo[] = [
  { id: 'nextMessage', label: 'Next message', group: 'Navigate' },
  { id: 'prevMessage', label: 'Previous message', group: 'Navigate' },
  { id: 'firstMessage', label: 'First message', group: 'Navigate' },
  { id: 'lastMessage', label: 'Last message', group: 'Navigate' },
  { id: 'goInbox', label: 'Go to all inboxes', group: 'Navigate' },
  { id: 'markRead', label: 'Mark as read', group: 'Message' },
  { id: 'markUnread', label: 'Mark as unread', group: 'Message' },
  { id: 'toggleRead', label: 'Toggle read / unread', group: 'Message' },
  { id: 'toggleFlag', label: 'Flag / unflag', group: 'Message' },
  { id: 'loadImages', label: 'Load remote images', group: 'Message' },
  { id: 'search', label: 'Search', group: 'Search' },
  { id: 'clearSearch', label: 'Clear search', group: 'Search' },
  { id: 'syncAll', label: 'Send / receive all', group: 'App' },
  { id: 'openSettings', label: 'Settings', group: 'App' },
  { id: 'addAccount', label: 'Add account', group: 'App' }
]

export type Keymap = Record<ActionId, string[]>

export const PRESETS: Record<'classic' | 'singlekey', { name: string; keys: Keymap }> = {
  classic: {
    name: 'Classic',
    keys: {
      nextMessage: ['Down', 'Ctrl+.'],
      prevMessage: ['Up', 'Ctrl+,'],
      firstMessage: ['Home'],
      lastMessage: ['End'],
      goInbox: ['Ctrl+Shift+I'],
      markRead: ['Ctrl+Q'],
      markUnread: ['Ctrl+U'],
      toggleRead: [],
      toggleFlag: ['Insert'],
      loadImages: [],
      search: ['Ctrl+E', 'F3'],
      clearSearch: ['Escape'],
      syncAll: ['F9'],
      openSettings: [],
      addAccount: []
    }
  },
  singlekey: {
    name: 'Single-key',
    keys: {
      nextMessage: ['J', 'Down'],
      prevMessage: ['K', 'Up'],
      firstMessage: ['Home'],
      lastMessage: ['End'],
      goInbox: ['G I'],
      markRead: ['Shift+I'],
      markUnread: ['Shift+U'],
      toggleRead: [],
      toggleFlag: ['S'],
      loadImages: [],
      search: ['/'],
      clearSearch: ['Escape'],
      syncAll: [],
      openSettings: ['G S'],
      addAccount: []
    }
  }
}

export type PresetId = keyof typeof PRESETS

export function effectiveKeymap(preset: PresetId, overrides: Partial<Keymap>): Keymap {
  return { ...(PRESETS[preset] ?? PRESETS.classic).keys, ...overrides }
}

/** Sort modifiers into canonical order so "shift+ctrl+r" and "Ctrl+Shift+R" compare equal */
export function normaliseBinding(binding: string): string {
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta']
  return binding
    .trim()
    .split(/\s+/)
    .map((combo) => {
      const parts = combo.split('+').filter(Boolean)
      // "Ctrl++" means Ctrl and the plus key
      if (combo.endsWith('++')) parts.push('+')
      const key = parts.pop() ?? ''
      const mods = order.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()))
      return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+')
    })
    .join(' ')
}

export interface Conflict {
  binding: string
  actions: ActionId[]
  /** 'same' = two actions on one binding; 'prefix' = one binding is the start of another sequence, so the longer one can never fire */
  kind: 'same' | 'prefix'
}

export function findConflicts(map: Keymap): Conflict[] {
  const owners = new Map<string, ActionId[]>()
  for (const [action, list] of Object.entries(map) as [ActionId, string[]][])
    for (const b of list) owners.set(normaliseBinding(b), [...(owners.get(normaliseBinding(b)) ?? []), action])
  const out: Conflict[] = []
  for (const [binding, actions] of owners) if (actions.length > 1) out.push({ binding, actions, kind: 'same' })
  const all = [...owners.keys()]
  for (const short of all)
    for (const long of all)
      if (long !== short && long.startsWith(short + ' ')) out.push({ binding: long, actions: [...owners.get(short)!, ...owners.get(long)!], kind: 'prefix' })
  return out
}
