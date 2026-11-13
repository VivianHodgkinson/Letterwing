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
  | 'selectAll'
  | 'openMessage'
  | 'markRead'
  | 'markUnread'
  | 'toggleRead'
  | 'toggleFlag'
  | 'newMessage'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'delete'
  | 'archive'
  | 'moveToFolder'
  | 'send'
  | 'saveDraft'
  | 'closeCompose'
  | 'search'
  | 'clearSearch'
  | 'goInbox'
  | 'syncAll'
  | 'openSettings'
  | 'addAccount'
  | 'loadImages'
  | 'goToMail'
  | 'goToCalendar'
  | 'newEvent'
  | 'calendarDay'
  | 'calendarWorkWeek'
  | 'calendarWeek'
  | 'calendarMonth'
  | 'prevPeriod'
  | 'nextPeriod'
  | 'goToToday'

export interface ActionInfo {
  id: ActionId
  label: string
  group: 'Navigate' | 'Message' | 'Compose' | 'Search' | 'Calendar' | 'App'
  /**
   * Where the action works. Actions in different scopes may share a key (J is "next message" in
   * mail and "next week" in the calendar, as in Gmail and Google Calendar). Unset means everywhere.
   */
  scope?: 'mail' | 'calendar'
  /**
   * Can fire while focus is in a text field (only for combos with Ctrl/Alt/Meta, F-keys or Escape).
   * Off for anything that acts on the message list, so Ctrl+A in the editor still selects text.
   */
  whileTyping?: boolean
}

/** Every bindable action. New features add an entry here and a handler in the renderer. */
export const ACTIONS: ActionInfo[] = [
  { id: 'nextMessage', label: 'Next message', group: 'Navigate', scope: 'mail' },
  { id: 'prevMessage', label: 'Previous message', group: 'Navigate', scope: 'mail' },
  { id: 'firstMessage', label: 'First message', group: 'Navigate', scope: 'mail' },
  { id: 'lastMessage', label: 'Last message', group: 'Navigate', scope: 'mail' },
  { id: 'selectAll', label: 'Select all messages', group: 'Navigate', scope: 'mail' },
  { id: 'openMessage', label: 'Open (edit a draft)', group: 'Navigate', scope: 'mail' },
  { id: 'goInbox', label: 'Go to all inboxes', group: 'Navigate', whileTyping: true, scope: 'mail' },
  { id: 'markRead', label: 'Mark as read', group: 'Message', scope: 'mail' },
  { id: 'markUnread', label: 'Mark as unread', group: 'Message', scope: 'mail' },
  { id: 'toggleRead', label: 'Toggle read / unread', group: 'Message', scope: 'mail' },
  { id: 'toggleFlag', label: 'Flag / unflag', group: 'Message', scope: 'mail' },
  { id: 'reply', label: 'Reply', group: 'Message', scope: 'mail' },
  { id: 'replyAll', label: 'Reply all', group: 'Message', scope: 'mail' },
  { id: 'forward', label: 'Forward', group: 'Message', scope: 'mail' },
  { id: 'delete', label: 'Delete', group: 'Message', scope: 'mail' },
  { id: 'archive', label: 'Archive', group: 'Message', scope: 'mail' },
  { id: 'moveToFolder', label: 'Move to folder…', group: 'Message', scope: 'mail' },
  { id: 'loadImages', label: 'Load remote images', group: 'Message', scope: 'mail' },
  { id: 'newMessage', label: 'New message', group: 'Compose', whileTyping: true, scope: 'mail' },
  { id: 'send', label: 'Send', group: 'Compose', whileTyping: true },
  { id: 'saveDraft', label: 'Save draft', group: 'Compose', whileTyping: true },
  { id: 'closeCompose', label: 'Close message (keeps draft)', group: 'Compose', whileTyping: true },
  { id: 'search', label: 'Search', group: 'Search', whileTyping: true, scope: 'mail' },
  { id: 'clearSearch', label: 'Clear search', group: 'Search', whileTyping: true, scope: 'mail' },
  { id: 'newEvent', label: 'New event', group: 'Calendar', scope: 'calendar', whileTyping: true },
  { id: 'calendarDay', label: 'Day view', group: 'Calendar', scope: 'calendar' },
  { id: 'calendarWorkWeek', label: 'Work week view', group: 'Calendar', scope: 'calendar' },
  { id: 'calendarWeek', label: 'Week view', group: 'Calendar', scope: 'calendar' },
  { id: 'calendarMonth', label: 'Month view', group: 'Calendar', scope: 'calendar' },
  { id: 'prevPeriod', label: 'Previous day / week / month', group: 'Calendar', scope: 'calendar' },
  { id: 'nextPeriod', label: 'Next day / week / month', group: 'Calendar', scope: 'calendar' },
  { id: 'goToToday', label: 'Go to today', group: 'Calendar', scope: 'calendar' },
  { id: 'goToMail', label: 'Switch to Mail', group: 'App', whileTyping: true },
  { id: 'goToCalendar', label: 'Switch to Calendar', group: 'App', whileTyping: true },
  { id: 'syncAll', label: 'Send / receive all', group: 'App', whileTyping: true },
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
      selectAll: ['Ctrl+A'],
      openMessage: ['Enter', 'Ctrl+O'],
      goInbox: ['Ctrl+Shift+I'],
      markRead: ['Ctrl+Q'],
      markUnread: ['Ctrl+U'],
      toggleRead: [],
      toggleFlag: ['Insert'],
      reply: ['Ctrl+R'],
      replyAll: ['Ctrl+Shift+R'],
      forward: ['Ctrl+F'],
      delete: ['Delete', 'Ctrl+D'],
      archive: ['Backspace'],
      moveToFolder: ['Ctrl+Shift+V'],
      loadImages: [],
      newMessage: ['Ctrl+N', 'Ctrl+Shift+M'],
      send: ['Ctrl+Enter', 'Alt+S'],
      saveDraft: ['Ctrl+S'],
      // Escape belongs to Clear search; Classic closes a message with the window's close button
      closeCompose: [],
      search: ['Ctrl+E', 'F3'],
      clearSearch: ['Escape'],
      syncAll: ['F9'],
      openSettings: [],
      addAccount: [],
      goToMail: ['Ctrl+1'],
      goToCalendar: ['Ctrl+2'],
      newEvent: ['Ctrl+N', 'Ctrl+Shift+A'],
      calendarDay: ['Ctrl+Alt+1'],
      calendarWorkWeek: ['Ctrl+Alt+2'],
      calendarWeek: ['Ctrl+Alt+3'],
      calendarMonth: ['Ctrl+Alt+4'],
      prevPeriod: ['Alt+Up', 'Left'],
      nextPeriod: ['Alt+Down', 'Right'],
      // Classic has no single key for this (it's on the ribbon); T matches Google Calendar
      goToToday: ['T']
    }
  },
  singlekey: {
    name: 'Single-key',
    keys: {
      nextMessage: ['J', 'Down'],
      prevMessage: ['K', 'Up'],
      firstMessage: ['Home'],
      lastMessage: ['End'],
      selectAll: ['* A'],
      openMessage: ['O', 'Enter'],
      goInbox: ['G I'],
      markRead: ['Shift+I'],
      markUnread: ['Shift+U'],
      toggleRead: [],
      toggleFlag: ['S'],
      reply: ['R'],
      replyAll: ['A'],
      forward: ['F'],
      delete: ['#'],
      archive: ['E'],
      moveToFolder: ['V'],
      loadImages: [],
      newMessage: ['C'],
      send: ['Ctrl+Enter'],
      saveDraft: ['Ctrl+S'],
      closeCompose: [],
      search: ['/'],
      clearSearch: ['Escape'],
      syncAll: [],
      openSettings: ['G S'],
      addAccount: [],
      goToMail: ['G M'],
      goToCalendar: ['G C'],
      // single-key calendar keys
      newEvent: ['C'],
      calendarDay: ['D'],
      calendarWorkWeek: ['X'],
      calendarWeek: ['W'],
      calendarMonth: ['M'],
      prevPeriod: ['K', 'P'],
      nextPeriod: ['J', 'N'],
      goToToday: ['T']
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
  const scopeOf = new Map(ACTIONS.map((a) => [a.id, a.scope]))
  // Two actions clash only if they can be active at the same time
  const overlap = (a: ActionId, b: ActionId) => {
    const x = scopeOf.get(a)
    const y = scopeOf.get(b)
    return !x || !y || x === y
  }
  const entries = (Object.entries(map) as [ActionId, string[]][]).flatMap(([action, list]) => list.map((b) => ({ action, binding: normaliseBinding(b) })))
  const out: Conflict[] = []
  const seen = new Set<string>()
  for (const a of entries)
    for (const b of entries) {
      if (a.action === b.action || !overlap(a.action, b.action)) continue
      const kind = a.binding === b.binding ? 'same' : b.binding.startsWith(a.binding + ' ') ? 'prefix' : null
      if (!kind) continue
      const id = kind === 'same' ? [a.binding, ...[a.action, b.action].sort()].join('|') : `${b.binding}|${a.action}|${b.action}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ binding: kind === 'same' ? a.binding : b.binding, actions: kind === 'same' ? [a.action, b.action].sort() : [a.action, b.action], kind })
    }
  return out
}
