import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACTIONS, effectiveKeymap, type ActionId } from '@shared/keys'
import type { MenuItem } from '@shared/api'
import type { Account, Folder, FolderRole, MessageSummary, Outgoing, Settings, SyncStatus } from '@shared/types'
import { api, on } from './api'
import { AccountDialog } from './components/AccountDialog'
import { CalendarView, type CalendarHandle } from './components/calendar/CalendarView'
import { Compose, type ComposeHandle } from './components/Compose'
import { MessageList } from './components/MessageList'
import { MoveDialog } from './components/MoveDialog'
import { Reader } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { PromptDialog } from './components/PromptDialog'
import { Sidebar, sortFolders } from './components/Sidebar'
import { useKeymap } from './keymap'
import { UpdatePill } from './components/Updates'
import { buildReply, newMessage, type ReplyKind } from './replies'

export interface View {
  accountId: string | null
  folderId: string
}

const UNIFIED: View = { accountId: null, folderId: '*inbox' }
const PAGE = 100

type Notice = { text: string; error: boolean } | null

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [folders, setFolders] = useState<Record<string, Folder[]>>({})
  const [view, setView] = useState<View>(UNIFIED)
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [primary, setPrimary] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Record<string, SyncStatus>>({})
  const [dialog, setDialog] = useState<'account' | 'settings' | 'move' | null>(null)
  const [settingsTab, setSettingsTab] = useState<'accounts' | undefined>(undefined)
  const [prompt, setPrompt] = useState<{ title: string; label: string; initial?: string; ok: string; onSubmit(v: string): Promise<void> } | null>(null)
  const [compose, setCompose] = useState<{ initial: Outgoing; id: number } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [imagesRequest, setImagesRequest] = useState(0)
  const [mode, setMode] = useState<'mail' | 'calendar'>('mail')
  const [calEditing, setCalEditing] = useState(false)
  const calRef = useRef<CalendarHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const composeRef = useRef<ComposeHandle>(null)
  const anchor = useRef<string | null>(null)
  const shown = useRef(0)
  shown.current = messages.length

  const say = useCallback((text: string, error = false) => setNotice({ text, error }), [])
  const fail = useCallback((e: Error) => say(e.message, true), [say])

  // Info messages fade; errors stay until clicked
  useEffect(() => {
    if (!notice || notice.error) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const loadAccounts = useCallback(async () => {
    const accs = await api.listAccounts()
    setAccounts(accs)
    const entries = await Promise.all(accs.map(async (a) => [a.id, await api.listFolders(a.id)] as const))
    setFolders(Object.fromEntries(entries))
  }, [])

  /** Reload the list, keeping as many rows as are showing so the scroll position holds */
  const loadMessages = useCallback(async () => {
    const limit = Math.max(PAGE, shown.current)
    const list = query.trim() ? await api.search(query, 200) : await api.listMessages(view.accountId, view.folderId, limit)
    setMessages(list)
    if (query.trim()) setHasMore(false)
  }, [view, query])

  useEffect(() => {
    api.getSettings().then(setSettings)
    void loadAccounts()
    api.syncStatus().then((list) => setStatus((prev) => ({ ...Object.fromEntries(list.map((s) => [s.accountId, s])), ...prev })))
  }, [loadAccounts])

  // New folder or search: start from the top
  useEffect(() => {
    shown.current = 0
    setHasMore(true)
    void loadMessages().catch(fail)
  }, [view, query, settings?.conversations])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || query.trim() || !messages.length) return
    setLoadingMore(true)
    try {
      const last = messages[messages.length - 1]
      const cursor = { date: last.date, key: last.key }
      let more = await api.listMessages(view.accountId, view.folderId, PAGE, cursor)
      if (more.length < PAGE) {
        // The cache has run out: fetch older mail from the server(s), then read again
        const targets =
          view.folderId === '*inbox'
            ? accounts.flatMap((a) => (folders[a.id] ?? []).filter((f) => f.role === 'inbox').map((f) => [a.id, f.id] as const))
            : [[view.accountId!, view.folderId] as const]
        const any = (await Promise.all(targets.map(([a, f]) => api.loadOlder(a, f).catch(() => false)))).some(Boolean)
        if (any) more = await api.listMessages(view.accountId, view.folderId, PAGE, cursor)
        else setHasMore(more.length > 0)
      }
      if (more.length) setMessages((m) => [...m, ...more.filter((x) => !m.some((y) => y.key === x.key))])
      else setHasMore(false)
    } catch (e) {
      fail(e as Error)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, query, messages, view, accounts, folders, fail])

  // Live updates from the sync engine. Debounced: a big sync fires many events.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const offChanged = on('mail:changed', () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        void loadMessages()
        void loadAccounts()
      }, 250)
    })
    const offStatus = on('sync:status', (p) => {
      const s = p as SyncStatus
      setStatus((prev) => ({ ...prev, [s.accountId]: s }))
    })
    // Tray menu "New message"
    const offCompose = on('compose:new', () => {
      setMode('mail')
      setTimeout(() => document.querySelector<HTMLButtonElement>('.new-mail')?.click(), 0)
    })
    // Clicking a reminder
    const offEvent = on('open:event', (p) => {
      setMode('calendar')
      setTimeout(() => calRef.current?.open((p as { key: string }).key), 0)
    })
    // Clicking a new-mail notification
    const offOpen = on('open:message', (p) => {
      setMode('mail')
      const { key } = p as { key: string }
      setQuery('')
      setView(UNIFIED)
      setPrimary(key)
      setSelected(new Set([key]))
    })
    return () => {
      offChanged()
      offStatus()
      offOpen()
      offEvent()
      offCompose()
      if (t) clearTimeout(t)
    }
  }, [loadMessages, loadAccounts])

  // The whole look is CSS variables; user overrides from Settings go on :root
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    root.dataset.density = settings.density
    root.dataset.pane = settings.readingPane
    const applied = Object.entries(settings.themeVars)
    for (const [k, v] of applied) root.style.setProperty(k, v)
    return () => {
      for (const [k] of applied) root.style.removeProperty(k)
    }
  }, [settings])

  const accountById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts])
  const current = useMemo(() => messages.find((m) => m.key === primary) ?? null, [messages, primary])
  const folderOf = (m: MessageSummary | null) => (m ? folders[m.accountId]?.find((f) => f.id === m.folderId) : undefined)

  /** Mark what's being shown as read: the message, or in conversation view its unread siblings too */
  const markShownRead = useCallback(
    async (m: MessageSummary) => {
      const unread = settings?.conversations ? (await api.getThread(m.key)).filter((t) => t.unread).map((t) => t.key) : m.unread ? [m.key] : []
      if (unread.length) await api.setRead(unread, true)
    },
    [settings?.conversations]
  )

  const select = useCallback(
    (m: MessageSummary, mode: 'single' | 'toggle' | 'range' = 'single') => {
      if (mode === 'toggle') {
        setSelected((s) => {
          const next = new Set(s)
          if (next.has(m.key)) next.delete(m.key)
          else next.add(m.key)
          return next
        })
        anchor.current = m.key
        setPrimary(m.key)
        return
      }
      if (mode === 'range' && anchor.current) {
        const a = messages.findIndex((x) => x.key === anchor.current)
        const b = messages.findIndex((x) => x.key === m.key)
        if (a >= 0 && b >= 0) {
          setSelected(new Set(messages.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.key)))
          setPrimary(m.key)
          return
        }
      }
      anchor.current = m.key
      setSelected(new Set([m.key]))
      setPrimary(m.key)
      void markShownRead(m).catch(fail)
    },
    [messages, markShownRead, fail]
  )

  /** In conversation view an action on a row covers the whole conversation in that folder */
  const expand = useCallback(
    async (keys: string[]): Promise<string[]> => {
      if (!settings?.conversations) return keys
      const rows = messages.filter((m) => keys.includes(m.key))
      const all = await Promise.all(rows.map(async (r) => (await api.getThread(r.key)).filter((t) => t.folderId === r.folderId).map((t) => t.key)))
      return [...new Set([...keys, ...all.flat()])]
    },
    [settings?.conversations, messages]
  )

  const selection = (): string[] => (selected.size ? [...selected] : primary ? [primary] : [])

  /** After a delete/archive/move, select the next message */
  const removeAndAdvance = async (run: (keys: string[]) => Promise<void>, verb: string, keys = selection()) => {
    if (!keys.length) return
    const idx = Math.max(...keys.map((k) => messages.findIndex((m) => m.key === k)))
    const next =
      messages.slice(idx + 1).find((m) => !keys.includes(m.key)) ??
      messages
        .slice(0, idx)
        .reverse()
        .find((m) => !keys.includes(m.key))
    setSelected(new Set(next ? [next.key] : []))
    setPrimary(next?.key ?? null)
    try {
      await run(await expand(keys))
    } catch (e) {
      say(`Couldn't ${verb}: ${(e as Error).message}`, true)
    }
  }

  const archive = () => void removeAndAdvance((k) => api.archiveMessages(k), 'archive')
  /** Delete moves to Trash; in Trash itself it is permanent, so ask first */
  const remove = async (keys = selection()) => {
    if (!keys.length) return
    const inTrash = messages.filter((m) => keys.includes(m.key)).some((m) => folderOf(m)?.role === 'trash')
    if (inTrash && !(await api.confirm({ message: `Permanently delete ${keys.length === 1 ? 'this message' : `${keys.length} messages`}?`, detail: "This can't be undone.", ok: 'Delete' }))) return
    await removeAndAdvance((k) => api.deleteMessages(k), 'delete', keys)
  }
  const moveTo = (folderId: string) => void removeAndAdvance((k) => api.moveMessages(k, folderId), 'move')

  const openMove = () => {
    const keys = selection()
    const accs = new Set(messages.filter((m) => keys.includes(m.key)).map((m) => m.accountId))
    if (accs.size !== 1) return say(keys.length ? 'Select messages from one account to move them.' : 'Select a message first.', !!keys.length)
    setDialog('move')
  }

  const startCompose = async (out: Outgoing) => {
    // Opening another message: save the one being written first
    await composeRef.current?.flush()
    setCompose({ initial: out, id: Date.now() })
  }

  const defaultAccount = (): Account | undefined => accountById[view.accountId ?? ''] ?? (current ? accountById[current.accountId] : undefined) ?? accounts[0]

  const reply = async (kind: ReplyKind, m: MessageSummary | null = current) => {
    if (!m) return
    const acc = accountById[m.accountId]
    if (!acc) return
    try {
      await startCompose(buildReply(kind, m, await api.getBody(m.key), acc))
    } catch (e) {
      fail(e as Error)
    }
  }

  const open = async (m: MessageSummary | null = current) => {
    if (!m) return
    if (folderOf(m)?.role === 'drafts') {
      try {
        await startCompose(await api.openDraft(m.key))
      } catch (e) {
        fail(e as Error)
      }
    }
  }

  const keymap = useMemo(() => (settings ? effectiveKeymap(settings.keymapPreset, settings.keybindings) : null), [settings])
  const sc = (id: ActionId): string | undefined => keymap?.[id]?.[0]
  const SEP: MenuItem = { type: 'separator' }
  const report = (verb: string) => (e: Error) => say(`Couldn't ${verb}: ${e.message}`, true)

  /** Right-click on a message: acts on the selection if the message is part of it, otherwise on that message alone */
  const messageMenu = async (m: MessageSummary, at?: { x: number; y: number }) => {
    const keys = selected.has(m.key) ? [...selected] : [m.key]
    if (!selected.has(m.key)) {
      // Select it without marking it read, as a click would
      anchor.current = m.key
      setSelected(new Set([m.key]))
      setPrimary(m.key)
    }
    const rows = messages.filter((x) => keys.includes(x.key))
    if (!rows.length) return
    const single = rows.length === 1 ? rows[0] : null
    const accountId = new Set(rows.map((r) => r.accountId)).size === 1 ? rows[0].accountId : null
    const accFolders = accountId ? (folders[accountId] ?? []) : []
    const roleOf = (r: MessageSummary): FolderRole | undefined => folderOf(r)?.role
    const everyAccountHas = (role: FolderRole) => rows.every((r) => folders[r.accountId]?.some((f) => f.role === role))
    const isUnread = (r: MessageSummary) => (r.threadUnread !== undefined ? r.threadUnread > 0 : r.unread)
    const allFlagged = rows.every((r) => r.flagged)
    const inJunk = rows.every((r) => roleOf(r) === 'junk')
    const inTrash = rows.some((r) => roleOf(r) === 'trash')
    const sameFolder = rows.every((r) => r.folderId === rows[0].folderId) ? rows[0].folderId : null
    const inbox = accFolders.find((f) => f.role === 'inbox')

    const items: MenuItem[] = [
      ...(single && roleOf(single) === 'drafts'
        ? [{ id: 'edit', label: 'Edit draft', shortcut: sc('openMessage') }]
        : single
          ? [
              { id: 'reply', label: 'Reply', shortcut: sc('reply') },
              { id: 'replyAll', label: 'Reply all', shortcut: sc('replyAll') },
              { id: 'forward', label: 'Forward', shortcut: sc('forward') }
            ]
          : []),
      SEP,
      { id: 'read', label: 'Mark as read', enabled: rows.some(isUnread), shortcut: sc('markRead') },
      { id: 'unread', label: 'Mark as unread', enabled: rows.some((r) => !isUnread(r)), shortcut: sc('markUnread') },
      { id: allFlagged ? 'unflag' : 'flag', label: allFlagged ? 'Clear flag' : 'Flag', shortcut: sc('toggleFlag') },
      SEP,
      accountId
        ? {
            label: 'Move to',
            submenu: [
              ...sortFolders(accFolders)
                .filter(({ folder }) => folder.id !== sameFolder)
                .map(({ folder, depth }) => ({ id: `move:${folder.id}`, label: `${'    '.repeat(depth)}${folder.name}` })),
              SEP,
              { id: 'moveOther', label: 'Choose folder…', shortcut: sc('moveToFolder') }
            ]
          }
        : { label: 'Move to (select messages from one account)', enabled: false },
      { id: 'archive', label: 'Archive', enabled: everyAccountHas('archive') && rows.every((r) => roleOf(r) !== 'archive'), shortcut: sc('archive') },
      inJunk ? { id: 'notJunk', label: 'Not junk (move to Inbox)', enabled: !!(accountId && inbox) } : { id: 'junk', label: 'Move to Junk', enabled: everyAccountHas('junk') },
      { id: 'delete', label: inTrash ? 'Delete permanently…' : 'Delete', shortcut: sc('delete') },
      SEP,
      ...(single
        ? [
            { id: 'copyFrom', label: 'Copy sender address', enabled: !!single.from?.address },
            { id: 'copySubject', label: 'Copy subject' }
          ]
        : []),
      { id: 'selectAll', label: 'Select all', shortcut: sc('selectAll') }
    ]
    const pick = await api.showMenu(items, at)
    if (!pick) return
    const all = () => expand(keys)
    if (pick.startsWith('move:')) return void removeAndAdvance((k) => api.moveMessages(k, pick.slice(5)), 'move', keys)
    switch (pick) {
      case 'edit':
        return void open(single)
      case 'reply':
      case 'replyAll':
      case 'forward':
        return void reply(pick, single)
      case 'read':
      case 'unread':
        return void all()
          .then((k) => api.setRead(k, pick === 'read'))
          .catch(report(`mark as ${pick}`))
      case 'flag':
      case 'unflag':
        return void api.setFlagged(keys, pick === 'flag').catch(report('change the flag'))
      case 'moveOther':
        return openMove()
      case 'archive':
        return void removeAndAdvance((k) => api.archiveMessages(k), 'archive', keys)
      case 'junk':
        return void removeAndAdvance((k) => api.junkMessages(k), 'move to Junk', keys)
      case 'notJunk':
        return void removeAndAdvance((k) => api.moveMessages(k, inbox!.id), 'move to Inbox', keys)
      case 'delete':
        return void remove(keys)
      case 'copyFrom':
        return void api.copyText(single!.from!.address)
      case 'copySubject':
        return void api.copyText(single!.subject)
      case 'selectAll':
        return setSelected(new Set(messages.map((x) => x.key)))
    }
  }

  const leaveIfShowing = (accountId: string, folderId?: string) => {
    if (view.accountId === accountId && (!folderId || view.folderId === folderId)) {
      setView(UNIFIED)
      setPrimary(null)
      setSelected(new Set())
    }
  }

  const markFolderRead = (accountId: string | null, folderId: string, name: string) =>
    void api
      .markFolderRead(accountId, folderId)
      .then(() => say(`${name}: all marked as read.`))
      .catch(report('mark everything as read'))

  const newFolderPrompt = (a: Account, parent: Folder | null) =>
    setPrompt({
      title: parent ? `New folder in ${parent.name}` : `New folder in ${a.email}`,
      label: 'Folder name',
      ok: 'Create',
      onSubmit: async (name) => {
        await api.createFolder(a.id, parent?.id ?? null, name)
        setPrompt(null)
        say(`Created ${name}.`)
      }
    })

  const folderMenu = async (e: React.MouseEvent, a: Account, f: Folder) => {
    e.preventDefault()
    const special = f.role !== 'other'
    const emptyable = f.role === 'trash' || f.role === 'junk'
    const pick = await api.showMenu([
      { id: 'read', label: 'Mark all as read' },
      { id: 'sync', label: 'Sync now', shortcut: sc('syncAll') },
      SEP,
      ...(emptyable ? [{ id: 'empty', label: `Empty ${f.name}…`, enabled: f.total > 0 || messages.some((m) => m.folderId === f.id) }, SEP] : []),
      { id: 'new', label: 'New subfolder…' },
      { id: 'rename', label: 'Rename…', enabled: !special },
      { id: 'delete', label: 'Delete folder…', enabled: !special }
    ])
    switch (pick) {
      case 'read':
        return markFolderRead(a.id, f.id, f.name)
      case 'sync':
        return void api.syncNow(a.id).catch(report('sync'))
      case 'empty':
        if (!(await api.confirm({ message: `Permanently delete everything in ${f.name}?`, detail: `${a.email}\nThis can't be undone.`, ok: `Empty ${f.name}` }))) return
        return void api
          .emptyFolder(a.id, f.id)
          .then(() => say(`${f.name} emptied.`))
          .catch(report(`empty ${f.name}`))
      case 'new':
        return newFolderPrompt(a, f)
      case 'rename':
        return setPrompt({
          title: `Rename ${f.name}`,
          label: 'New name',
          initial: f.name,
          ok: 'Rename',
          onSubmit: async (name) => {
            // On IMAP servers a renamed folder gets a new ID, so step out of it first
            leaveIfShowing(a.id, f.id)
            await api.renameFolder(a.id, f.id, name)
            setPrompt(null)
          }
        })
      case 'delete': {
        const detail =
          a.kind === 'microsoft'
            ? 'The folder and everything in it go to Deleted Items.'
            : "The folder, its subfolders and every message in them are deleted from the server. This can't be undone."
        if (!(await api.confirm({ message: `Delete the folder ${f.name}?`, detail, ok: 'Delete folder' }))) return
        leaveIfShowing(a.id, f.id)
        return void api
          .deleteFolder(a.id, f.id)
          .then(() => say(`Deleted ${f.name}.`))
          .catch(report(`delete ${f.name}`))
      }
    }
  }

  const accountMenu = async (e: React.MouseEvent, a: Account) => {
    e.preventDefault()
    const inbox = folders[a.id]?.find((f) => f.role === 'inbox')
    const pick = await api.showMenu([
      { id: 'sync', label: 'Sync now' },
      { id: 'read', label: 'Mark inbox as read', enabled: !!inbox },
      { id: 'new', label: 'New folder…' },
      SEP,
      { id: 'settings', label: 'Account settings…' },
      { id: 'copy', label: 'Copy address' },
      SEP,
      { id: 'remove', label: 'Remove account…' }
    ])
    switch (pick) {
      case 'sync':
        return void api.syncNow(a.id).catch(report('sync'))
      case 'read':
        return markFolderRead(a.id, inbox!.id, `${a.email} inbox`)
      case 'new':
        return newFolderPrompt(a, null)
      case 'settings':
        setSettingsTab('accounts')
        return setDialog('settings')
      case 'copy':
        return void api.copyText(a.email)
      case 'remove':
        if (!(await api.confirm({ message: `Remove ${a.email} from Letterwing?`, detail: 'Your mail stays on the server. The copy on this computer and the saved sign-in are deleted.', ok: 'Remove account' })))
          return
        leaveIfShowing(a.id)
        try {
          await api.removeAccount(a.id)
          await loadAccounts()
          await loadMessages()
        } catch (err) {
          report('remove the account')(err as Error)
        }
    }
  }

  const unifiedMenu = async (e: React.MouseEvent) => {
    e.preventDefault()
    const pick = await api.showMenu([
      { id: 'read', label: 'Mark all inboxes as read' },
      { id: 'sync', label: 'Sync all accounts', shortcut: sc('syncAll') }
    ])
    if (pick === 'read') markFolderRead(null, '*inbox', 'All inboxes')
    else if (pick === 'sync') void api.syncNow().catch(report('sync'))
  }

  // The menu key and Shift+F10 open the menu for the current message, under its row
  const menuKey = useRef<() => void>(() => {})
  menuKey.current = () => {
    if (mode !== 'mail' || dialog || prompt || !current) return
    const row = document.querySelector(`.msg[data-key="${CSS.escape(current.key)}"]`)
    const r = row?.getBoundingClientRect()
    void messageMenu(current, r ? { x: r.left + 48, y: r.bottom } : undefined)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      menuKey.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const move = (to: (i: number) => number) => {
    const i = messages.findIndex((m) => m.key === primary)
    const m = messages[Math.max(0, Math.min(messages.length - 1, to(i)))]
    if (m) select(m)
  }
  const keys = () => selection()
  const respondInvite = (m: MessageSummary, answer: 'accepted' | 'tentative' | 'declined') =>
    void removeAndAdvance(() => api.respondToInvite(m.key, answer), 'send your response').then(() => say('Response sent.'))
  const calendarHandlers: Partial<Record<ActionId, () => void>> = {
    newEvent: () => calRef.current?.newEvent(),
    calendarDay: () => calRef.current?.setView('day'),
    calendarWorkWeek: () => calRef.current?.setView('workweek'),
    calendarWeek: () => calRef.current?.setView('week'),
    calendarMonth: () => calRef.current?.setView('month'),
    prevPeriod: () => calRef.current?.prev(),
    nextPeriod: () => calRef.current?.next(),
    goToToday: () => calRef.current?.today()
  }
  const mailHandlers: Partial<Record<ActionId, () => void>> = {
    nextMessage: () => move((i) => i + 1),
    prevMessage: () => move((i) => (i < 0 ? 0 : i - 1)),
    firstMessage: () => move(() => 0),
    lastMessage: () => move(() => messages.length - 1),
    selectAll: () => setSelected(new Set(messages.map((m) => m.key))),
    openMessage: () => void open(),
    goInbox: () => {
      setView(UNIFIED)
      setQuery('')
      setPrimary(null)
      setSelected(new Set())
    },
    markRead: () =>
      void expand(keys())
        .then((k) => api.setRead(k, true))
        .catch(fail),
    markUnread: () =>
      void expand(keys())
        .then((k) => api.setRead(k, false))
        .catch(fail),
    toggleRead: () =>
      current &&
      void expand(keys())
        .then((k) => api.setRead(k, current.unread))
        .catch(fail),
    toggleFlag: () => current && void api.setFlagged(keys(), !current.flagged).catch(fail),
    reply: () => void reply('reply'),
    replyAll: () => void reply('replyAll'),
    forward: () => void reply('forward'),
    delete: () => void remove(),
    archive,
    moveToFolder: openMove,
    loadImages: () => setImagesRequest((n) => n + 1),
    newMessage: () => {
      const a = defaultAccount()
      if (a) void startCompose(newMessage(a))
    },
    search: () => {
      searchRef.current?.focus()
      searchRef.current?.select()
    },
    clearSearch: () => {
      setQuery('')
      searchRef.current?.blur()
    },
    syncAll: () => void api.syncNow().catch(fail),
    openSettings: () => setDialog('settings'),
    addAccount: () => setDialog('account'),
    // Only while writing; otherwise the key does whatever it normally does
    ...(compose
      ? {
          send: () => composeRef.current?.send(),
          saveDraft: () => composeRef.current?.saveDraft(),
          closeCompose: () => void composeRef.current?.flush().then(() => setCompose(null))
        }
      : {})
  }
  // Only the current mode's actions (plus the everywhere ones) respond, so J can mean different things in each
  const scopeOf = new Map(ACTIONS.map((a) => [a.id, a.scope]))
  const handlers: Partial<Record<ActionId, () => void>> = Object.fromEntries(
    Object.entries({ ...mailHandlers, ...calendarHandlers, goToMail: () => setMode('mail'), goToCalendar: () => setMode('calendar') }).filter(
      ([id]) => !scopeOf.get(id as ActionId) || scopeOf.get(id as ActionId) === mode
    )
  )
  useKeymap(keymap ?? effectiveKeymap('classic', {}), handlers, !!keymap && dialog === null && !prompt && !calEditing)

  if (!settings) return null
  const syncing = Object.values(status).some((s) => s.state === 'syncing')
  const errors = Object.values(status).filter((s) => s.state === 'error')
  const moveAccount = current ? current.accountId : null

  const composeView = compose && (
    <Compose
      key={compose.id}
      ref={composeRef}
      initial={compose.initial}
      accounts={accounts}
      onClose={() => setCompose(null)}
      onSent={() => {
        setCompose(null)
        say('Sent.')
      }}
      onStatus={say}
    />
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Letterwing</div>
        <div className="tabs mode-tabs">
          <button className={mode === 'mail' ? 'active' : ''} onClick={() => setMode('mail')} title="Mail (Ctrl+1)">
            ✉ Mail
          </button>
          <button className={mode === 'calendar' ? 'active' : ''} onClick={() => setMode('calendar')} title="Calendar (Ctrl+2)">
            📅 Calendar
          </button>
        </div>
        {mode === 'mail' && (
          <>
            <button
              className="primary new-mail"
              onClick={() => {
                const a = defaultAccount()
                if (a) void startCompose(newMessage(a))
              }}
              disabled={!accounts.length}
            >
              ✎ New mail
            </button>
            <input ref={searchRef} className="search" placeholder="Search all mail" value={query} onChange={(e) => setQuery(e.target.value)} />
          </>
        )}
        {mode === 'calendar' && <span className="grow" />}
        <UpdatePill />
        <button className="ghost" title="Send / receive" onClick={() => void api.syncNow().catch(fail)}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button className="ghost" onClick={() => setDialog('settings')}>
          Settings
        </button>
      </header>

      {(notice || errors.length > 0) && (
        <div className={`banner ${notice && !notice.error ? 'info' : ''}`} onClick={() => setNotice(null)}>
          {notice?.text ?? errors
              .map((s) => {
                // Connector messages usually start with the account name already
                const name = accountById[s.accountId]?.name ?? 'Account'
                return s.message?.startsWith(name) ? s.message : `${name}: ${s.message}`
              })
              .join(' · ')}
        </div>
      )}

      {mode === 'calendar' && (
        <CalendarView
          ref={calRef}
          settings={settings}
          accounts={accounts}
          onSettings={async (patch) => setSettings(await api.saveSettings(patch))}
          onStatus={say}
          onEditing={setCalEditing}
        />
      )}
      <div className="body" hidden={mode !== 'mail'}>
        <Sidebar
          accounts={accounts}
          folders={folders}
          status={status}
          view={view}
          onView={(v) => {
            setView(v)
            setQuery('')
            setPrimary(null)
            setSelected(new Set())
          }}
          onAddAccount={() => setDialog('account')}
          onFolderMenu={(e, a, f) => void folderMenu(e, a, f)}
          onAccountMenu={(e, a) => void accountMenu(e, a)}
          onUnifiedMenu={(e) => void unifiedMenu(e)}
          onDropMessages={(dropped, accountId, folderId) => {
            const same = messages.filter((m) => dropped.includes(m.key) && m.accountId === accountId).map((m) => m.key)
            if (same.length < dropped.length) say('Messages can only be moved between folders of the same account.', true)
            if (same.length)
              void expand(same)
                .then((k) => api.moveMessages(k, folderId))
                .catch(fail)
          }}
        />
        {accounts.length === 0 ? (
          <div className="empty-state">
            <h1>Welcome to Letterwing</h1>
            <p>Add a Microsoft 365, Gmail or any IMAP account to get started.</p>
            <button className="primary" onClick={() => setDialog('account')}>
              Add account
            </button>
          </div>
        ) : (
          <div className="panes">
            <MessageList
              messages={messages}
              primary={primary}
              selected={selected}
              accounts={accountById}
              showAccount={view.accountId === null || !!query}
              loadingMore={loadingMore}
              onSelect={select}
              onOpen={(m) => void open(m)}
              onFlag={(m) => void api.setFlagged([m.key], !m.flagged).catch(fail)}
              onMenu={(e, m) => {
                e.preventDefault()
                void messageMenu(m)
              }}
              onEndReached={() => void loadMore()}
            />
            {settings.readingPane !== 'off' &&
              (composeView ?? (
                <Reader
                  message={current}
                  selectedCount={selected.size}
                  accounts={accountById}
                  settings={settings}
                  isDraft={folderOf(current)?.role === 'drafts'}
                  imagesRequest={imagesRequest}
                  actions={{
                    reply: (kind, m) => void reply(kind, m),
                    archive,
                    remove: () => void remove(),
                    move: openMove,
                    toggleFlag: () => current && void api.setFlagged(selection(), !current.flagged).catch(fail),
                    toggleRead: () =>
                      current &&
                      void expand(selection())
                        .then((k) => api.setRead(k, current.unread))
                        .catch(fail),
                    editDraft: (m) => void open(m),
                    respondInvite
                  }}
                />
              ))}
          </div>
        )}
      </div>

      {/* With the reading pane off, writing happens in a full-size overlay */}
      {settings.readingPane === 'off' && composeView && <div className="compose-overlay">{composeView}</div>}

      {dialog === 'move' && moveAccount && (
        <MoveDialog
          folders={folders[moveAccount] ?? []}
          currentFolderId={current?.folderId ?? ''}
          onPick={(f) => {
            setDialog(null)
            moveTo(f.id)
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'account' && (
        <AccountDialog
          onClose={() => setDialog(null)}
          onAdded={() => {
            setDialog(null)
            void loadAccounts()
          }}
        />
      )}
      {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} />}
      {dialog === 'settings' && (
        <SettingsDialog
          initialTab={settingsTab}
          settings={settings}
          accounts={accounts}
          onChange={async (patch) => setSettings(await api.saveSettings(patch))}
          onAccountChange={async (id, patch) => {
            await api.updateAccount(id, patch)
            await loadAccounts()
          }}
          onRemoveAccount={async (id) => {
            await api.removeAccount(id)
            if (view.accountId === id) setView(UNIFIED)
            await loadAccounts()
            await loadMessages()
          }}
          onClose={() => {
            setDialog(null)
            setSettingsTab(undefined)
          }}
        />
      )}
    </div>
  )
}
