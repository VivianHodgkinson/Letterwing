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

export interface ActionInfo {
  id: ActionId
  label: string
  group: 'Navigate' | 'Message' | 'Compose' | 'Search' | 'App'
  /**
   * Can fire while focus is in a text field (only for combos with Ctrl/Alt/Meta, F-keys or Escape).
   * Off for anything that acts on the message list, so Ctrl+A in the editor still selects text.
   */
  whileTyping?: boolean
}

/** Every bindable action. New features add an entry here and a handler in the renderer. */
export const ACTIONS: ActionInfo[] = [
  { id: 'nextMessage', label: 'Next message', group: 'Navigate' },
  { id: 'prevMessage', label: 'Previous message', group: 'Navigate' },
  { id: 'firstMessage', label: 'First message', group: 'Navigate' },
  { id: 'lastMessage', label: 'Last message', group: 'Navigate' },
  { id: 'selectAll', label: 'Select all messages', group: 'Navigate' },
  { id: 'openMessage', label: 'Open (edit a draft)', group: 'Navigate' },
  { id: 'goInbox', label: 'Go to all inboxes', group: 'Navigate', whileTyping: true },
  { id: 'markRead', label: 'Mark as read', group: 'Message' },
  { id: 'markUnread', label: 'Mark as unread', group: 'Message' },
  { id: 'toggleRead', label: 'Toggle read / unread', group: 'Message' },
  { id: 'toggleFlag', label: 'Flag / unflag', group: 'Message' },
  { id: 'reply', label: 'Reply', group: 'Message' },
  { id: 'replyAll', label: 'Reply all', group: 'Message' },
  { id: 'forward', label: 'Forward', group: 'Message' },
  { id: 'delete', label: 'Delete', group: 'Message' },
  { id: 'archive', label: 'Archive', group: 'Message' },
  { id: 'moveToFolder', label: 'Move to folder…', group: 'Message' },
  { id: 'loadImages', label: 'Load remote images', group: 'Message' },
  { id: 'newMessage', label: 'New message', group: 'Compose', whileTyping: true },
  { id: 'send', label: 'Send', group: 'Compose', whileTyping: true },
  { id: 'saveDraft', label: 'Save draft', group: 'Compose', whileTyping: true },
  { id: 'closeCompose', label: 'Close message (keeps draft)', group: 'Compose', whileTyping: true },
  { id: 'search', label: 'Search', group: 'Search', whileTyping: true },
  { id: 'clearSearch', label: 'Clear search', group: 'Search', whileTyping: true },
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
