import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACTIONS, effectiveKeymap, type ActionId } from '@shared/keys'
import type { MenuItem } from '@shared/api'
import type { MailtoRequest, OutboxItem } from '@shared/types'
import {
  prefKey,
  type Account,
  type Folder,
  type FolderPref,
  type FolderRole,
  type MessageSummary,
  type Outgoing,
  type Settings,
  type SyncStatus
} from '@shared/types'
import { api, on } from './api'
import { AccountDialog } from './components/AccountDialog'
import { CalendarView, type CalendarHandle } from './components/calendar/CalendarView'
import { Compose, type ComposeHandle } from './components/Compose'
import { MessageList } from './components/MessageList'
import { MoveDialog } from './components/MoveDialog'
import { Reader } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { ColorDialog } from './components/ColorDialog'
import { GearIcon, MenuIcon, MoonIcon, SunIcon, SyncIcon } from './components/Icons'
import { OutboxView } from './components/OutboxView'
import { PromptDialog } from './components/PromptDialog'
import { colourMenu } from './menus'
import { Sidebar, sortFolders } from './components/Sidebar'
import { useKeymap } from './keymap'
import { UpdatePill } from './components/Updates'
import { isBlocked } from '@shared/blocking'
import { printMessages } from './print'
import { buildReply, messageFromLink, newMessage, type ReplyKind } from './replies'

export interface View {
  accountId: string | null
  folderId: string
}

const UNIFIED: View = { accountId: null, folderId: '*inbox' }
/** Shared mail services: "block everyone at" these would block half the world */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'webmail.co.za', 'vodamail.co.za', 'mweb.co.za', 'telkomsa.net'])
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
  const [colorPick, setColorPick] = useState<{ title: string; initial?: string; onPick(color: string): void } | null>(null)
  const [prompt, setPrompt] = useState<{ title: string; label: string; initial?: string; ok: string; onSubmit(v: string): Promise<void> } | null>(null)
  const [compose, setCompose] = useState<{ initial: Outgoing; id: number } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const inOutbox = view.folderId === '*outbox'
  const [imagesRequest, setImagesRequest] = useState(0)
  const [mode, setMode] = useState<'mail' | 'calendar'>('mail')
  const [calEditing, setCalEditing] = useState(false)
  const calRef = useRef<CalendarHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const composeRef = useRef<ComposeHandle>(null)
  const anchor = useRef<string | null>(null)
  const shown = useRef(0)
  shown.current = messages.length

  // Whether the app is showing dark colours right now (the setting, or the system's when set to follow it)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [settings?.theme])

  // Layout follows the window width: tiling window managers resize freely
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const layout: 'wide' | 'medium' | 'narrow' =
    settings && settings.layout !== 'auto' ? settings.layout : width >= 1200 ? 'wide' : width >= 760 ? 'medium' : 'narrow'
  const singlePane = layout === 'narrow'
  /** The folder sidebar (or calendar list) slid in over the content, when the layout has no room for it */
  const [drawer, setDrawer] = useState(false)
  /** One pane at a time: showing the open message instead of the list */
  const [readerOpen, setReaderOpen] = useState(false)
  useEffect(() => {
    document.documentElement.dataset.layout = layout
    if (layout === 'wide') setDrawer(false)
    if (!singlePane) setReaderOpen(false)
  }, [layout])

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
    if (view.folderId === '*outbox') return setMessages([])
    const limit = Math.max(PAGE, shown.current)
    const list = query.trim() ? await api.search(query, 200) : await api.listMessages(view.accountId, view.folderId, limit)
    setMessages(list)
    if (query.trim()) setHasMore(false)
  }, [view, query])

  useEffect(() => {
    const load = () => void api.listOutbox().then(setOutbox)
    load()
    return on('outbox:changed', load)
  }, [])

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
    // Narrow windows always show one pane at a time, whatever the reading pane setting
    root.dataset.pane = singlePane ? 'right' : settings.readingPane
    // The message editor follows the theme unless emails are set to show as sent
    root.dataset.mailcolors = settings.mailColors
    const applied = Object.entries(dark ? settings.themeVars : settings.themeVarsLight)
    for (const [k, v] of applied) root.style.setProperty(k, v)
    return () => {
      for (const [k] of applied) root.style.removeProperty(k)
    }
  }, [settings, dark, singlePane])

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
    },
    [messages]
  )

  /**
   * Marking as read follows Settings → General: by default a message turns read when you move off it
   * (another message, another folder, the calendar, Back), not the moment it opens. Changing its read
   * state by hand while it's open (Ctrl+Q, Ctrl+U, the menu) takes it out of this.
   */
  const openNow = useRef<MessageSummary | null>(null)
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showing = mode === 'mail' && current && selected.size <= 1 && (!singlePane || readerOpen) ? current : null
  useEffect(() => {
    const policy = settings?.markRead ?? 'leave'
    const prev = openNow.current
    clearTimeout(readTimer.current)
    // The message left may have been deleted or moved meanwhile; then there's nothing to mark
    if (prev && prev.key !== showing?.key && policy === 'leave') void markShownRead(prev).catch(() => {})
    openNow.current = showing
    if (!showing) return
    if (policy === 'open') {
      void markShownRead(showing).catch(fail)
      openNow.current = null
    } else if (policy === 'delay')
      readTimer.current = setTimeout(() => {
        if (openNow.current?.key !== showing.key) return
        void markShownRead(showing).catch(fail)
        openNow.current = null
      }, 5000)
  }, [showing?.key, settings?.markRead])
  useEffect(() => () => clearTimeout(readTimer.current), [])

  /** A read/unread change by hand wins over the automatic marking */
  const handMarked = (keys: string[]) => {
    if (openNow.current && keys.includes(openNow.current.key)) {
      openNow.current = null
      clearTimeout(readTimer.current)
    }
  }

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
    if (
      inTrash &&
      !(await api.confirm({
        message: `Permanently delete ${keys.length === 1 ? 'this message' : `${keys.length} messages`}?`,
        detail: "This can't be undone.",
        ok: 'Delete'
      }))
    )
      return
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
    // Blocking applies when every selected message is from the same sender
    const senders = new Set(rows.map((r) => r.from?.address.toLowerCase() ?? ''))
    const sender = senders.size === 1 && [...senders][0] ? [...senders][0] : null
    const senderDomain = sender?.split('@')[1] ?? null
    const blockList = settings?.blockedSenders ?? []
    const senderBlocked = sender ? blockList.find((b) => isBlocked(sender, [b])) : undefined
    const inTrash = rows.some((r) => roleOf(r) === 'trash')
    const sameFolder = rows.every((r) => r.folderId === rows[0].folderId) ? rows[0].folderId : null

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
      inJunk
        ? { id: 'notJunk', label: 'Not junk (move to Inbox)', enabled: rows.every((r) => folders[r.accountId]?.some((f) => f.role === 'inbox')) }
        : { id: 'junk', label: 'Move to Junk', enabled: everyAccountHas('junk') },
      ...(!inJunk ? [{ id: 'phish', label: 'Report phishing', enabled: everyAccountHas('junk') }] : []),
      ...(sender
        ? senderBlocked
          ? [{ id: 'unblock', label: `Unblock ${senderBlocked}` }]
          : [
              { id: 'block', label: `Block ${sender}` },
              // Blocking all of gmail.com etc. would be a mistake waiting to happen
              ...(senderDomain && !FREE_MAIL.has(senderDomain) ? [{ id: 'blockDomain', label: `Block everyone at @${senderDomain}` }] : [])
            ]
        : []),
      { id: 'delete', label: inTrash ? 'Delete permanently…' : 'Delete', shortcut: sc('delete') },
      SEP,
      ...(single
        ? [
            { id: 'print', label: 'Print…', shortcut: sc('print') },
            { id: 'printPdf', label: 'Save as PDF…' },
            SEP,
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
        handMarked(keys)
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
        // Not junk also lifts a block on that sender, or their next message would go straight back
        if (senderBlocked) void api.unblockSender(senderBlocked).then(async () => setSettings(await api.getSettings()))
        return void removeAndAdvance((k) => api.notJunkMessages(k), 'move to Inbox', keys)
      case 'phish':
        return void removeAndAdvance((k) => api.reportPhishing(k), 'report phishing', keys).then(() => say('Reported as phishing and moved to Junk.'))
      case 'block':
      case 'blockDomain': {
        const entry = pick === 'block' ? sender! : `@${senderDomain}`
        return void api
          .blockSender(entry, pick === 'block' ? single?.key : undefined)
          .then(async (n) => {
            setSettings(await api.getSettings())
            say(`Blocked ${entry}${n ? `; ${n} message${n === 1 ? '' : 's'} moved to Junk` : ''}. Their mail now goes to Junk (undo in Settings → General).`)
          })
          .catch(report('block the sender'))
      }
      case 'unblock':
        return void api
          .unblockSender(senderBlocked!)
          .then(async () => {
            setSettings(await api.getSettings())
            say(`Unblocked ${senderBlocked}.`)
          })
          .catch(report('unblock'))
      case 'delete':
        return void remove(keys)
      case 'print':
      case 'printPdf':
        return void printMessages([single!], { pdf: pick === 'printPdf', loadRemoteImages: !!settings?.loadRemoteImages }).catch(report('print'))
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

  /** Change (or with null, clear) a folder's favourite/colour preference */
  const setFolderPref = async (a: Account, f: Folder, patch: Partial<FolderPref>) => {
    const all = { ...(await api.getSettings()).folderPrefs }
    const k = prefKey(a.id, f.id)
    const next: FolderPref = { ...all[k], ...patch }
    for (const key of Object.keys(next) as (keyof FolderPref)[]) if (next[key] === undefined) delete next[key]
    if (Object.keys(next).length) all[k] = next
    else delete all[k]
    setSettings(await api.saveSettings({ folderPrefs: all }))
  }

  /** Swap a favourite with its neighbour */
  const moveFavourite = async (a: Account, f: Folder, by: -1 | 1) => {
    const all = { ...(await api.getSettings()).folderPrefs }
    const favs = Object.entries(all)
      .filter(([, v]) => v.favourite !== undefined)
      .sort((x, y) => x[1].favourite! - y[1].favourite!)
    const i = favs.findIndex(([k]) => k === prefKey(a.id, f.id))
    const j = i + by
    if (i < 0 || j < 0 || j >= favs.length) return
    ;[favs[i], favs[j]] = [favs[j], favs[i]]
    // Renumber so the order is stable whatever the old numbers were
    favs.forEach(([k, v], n) => (all[k] = { ...v, favourite: n + 1 }))
    setSettings(await api.saveSettings({ folderPrefs: all }))
  }

  const folderMenu = async (e: React.MouseEvent, a: Account, f: Folder) => {
    e.preventDefault()
    const special = f.role !== 'other'
    const emptyable = f.role === 'trash' || f.role === 'junk'
    const pref = settings?.folderPrefs[prefKey(a.id, f.id)]
    const favs = Object.values(settings?.folderPrefs ?? {})
      .map((p) => p.favourite)
      .filter((n): n is number => n !== undefined)
      .sort((x, y) => x - y)
    const isFav = pref?.favourite !== undefined
    const pick = await api.showMenu([
      ...(isFav
        ? [
            { id: 'unfav', label: '★ Remove from favourites' },
            { id: 'favUp', label: 'Move up in favourites', enabled: pref!.favourite! > favs[0] },
            { id: 'favDown', label: 'Move down in favourites', enabled: pref!.favourite! < favs[favs.length - 1] }
          ]
        : [{ id: 'fav', label: '☆ Add to favourites' }]),
      { label: 'Colour', submenu: colourMenu(pref?.color) },
      SEP,
      { id: 'read', label: 'Mark all as read' },
      { id: 'sync', label: 'Sync now', shortcut: sc('syncAll') },
      SEP,
      ...(emptyable ? [{ id: 'empty', label: `Empty ${f.name}…`, enabled: f.total > 0 || messages.some((m) => m.folderId === f.id) }, SEP] : []),
      { id: 'new', label: 'New subfolder…' },
      { id: 'rename', label: 'Rename…', enabled: !special },
      { id: 'delete', label: 'Delete folder…', enabled: !special }
    ])
    if (pick?.startsWith('color:')) {
      const c = pick.slice(6)
      if (c === 'none') return void setFolderPref(a, f, { color: undefined })
      if (c === 'custom') return setColorPick({ title: `Colour for ${f.name}`, initial: pref?.color, onPick: (color) => void setFolderPref(a, f, { color }) })
      return void setFolderPref(a, f, { color: c })
    }
    switch (pick) {
      case 'fav':
        return void setFolderPref(a, f, { favourite: (favs[favs.length - 1] ?? 0) + 1 })
      case 'unfav':
        return void setFolderPref(a, f, { favourite: undefined })
      case 'favUp':
      case 'favDown':
        return void moveFavourite(a, f, pick === 'favUp' ? -1 : 1)
      case 'read':
        return markFolderRead(a.id, f.id, f.name)
      case 'sync':
        return void api.syncNow(a.id).catch(report('sync'))
      case 'empty':
        if (
          !(await api.confirm({ message: `Permanently delete everything in ${f.name}?`, detail: `${a.email}\nThis can't be undone.`, ok: `Empty ${f.name}` }))
        )
          return
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
        if (
          !(await api.confirm({
            message: `Remove ${a.email} from Letterwing?`,
            detail: 'Your mail stays on the server. The copy on this computer and the saved sign-in are deleted.',
            ok: 'Remove account'
          }))
        )
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

  /** A mail link clicked anywhere (Letterwing as the default mail app): a new message, filled in */
  const fromLink = useRef<(link: MailtoRequest) => void>(() => {})
  fromLink.current = (link) => {
    const a = defaultAccount()
    if (!a) return say('Add an account first, then click the link again.', true)
    setMode('mail')
    void startCompose(messageFromLink(a, link))
  }
  const accountsLoaded = accounts.length > 0
  useEffect(() => {
    if (!accountsLoaded) return
    const off = on('compose:mailto', (p) => fromLink.current(p as MailtoRequest))
    // Links that started Letterwing, or came in while it was loading
    void api.takePendingMailto().then((list) => list.forEach((l) => fromLink.current(l)))
    return off
  }, [accountsLoaded])

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
    openMessage: () => {
      if (singlePane && current) setReaderOpen(true)
      void open()
    },
    goInbox: () => {
      setView(UNIFIED)
      setQuery('')
      setPrimary(null)
      setSelected(new Set())
    },
    markRead: () => {
      handMarked(keys())
      void expand(keys())
        .then((k) => api.setRead(k, true))
        .catch(fail)
    },
    markUnread: () => {
      handMarked(keys())
      void expand(keys())
        .then((k) => api.setRead(k, false))
        .catch(fail)
    },
    toggleRead: () => {
      if (!current) return
      handMarked(keys())
      void expand(keys())
        .then((k) => api.setRead(k, current.unread))
        .catch(fail)
    },
    toggleFlag: () => current && void api.setFlagged(keys(), !current.flagged).catch(fail),
    reply: () => void reply('reply'),
    replyAll: () => void reply('replyAll'),
    forward: () => void reply('forward'),
    delete: () => void remove(),
    archive,
    moveToFolder: openMove,
    loadImages: () => setImagesRequest((n) => n + 1),
    print: () => {
      if (current) void printMessages([current], { pdf: false, loadRemoteImages: !!settings?.loadRemoteImages }).catch(fail)
    },
    newMessage: () => {
      const a = defaultAccount()
      if (a) void startCompose(newMessage(a))
    },
    search: () => {
      searchRef.current?.focus()
      searchRef.current?.select()
    },
    clearSearch: () => {
      // Escape steps back: close the drawer, then the open message, then clear the search
      if (drawer) return setDrawer(false)
      if (singlePane && readerOpen && !compose) return setReaderOpen(false)
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
  useKeymap(keymap ?? effectiveKeymap('classic', {}), handlers, !!keymap && dialog === null && !prompt && !colorPick && !calEditing)

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
      onSent={(queued) => {
        setCompose(null)
        say(queued ? "No connection right now: it's in the Outbox and will send itself when you're back online." : 'Sent.')
      }}
      onStatus={say}
    />
  )

  return (
    <div className="app">
      <header className="topbar">
        {layout !== 'wide' && (
          <button
            className="icon-btn menu-btn"
            title={mode === 'mail' ? 'Folders' : 'Calendars'}
            aria-label="Show folders"
            onClick={() => setDrawer((d) => !d)}
          >
            <span>
              <MenuIcon />
            </span>
          </button>
        )}
        <div className="brand">Letterwing</div>
        <div className="tabs mode-tabs">
          <button className={mode === 'mail' ? 'active' : ''} onClick={() => setMode('mail')} title="Mail (Ctrl+1)">
            ✉ <span className="label">Mail</span>
          </button>
          <button className={mode === 'calendar' ? 'active' : ''} onClick={() => setMode('calendar')} title="Calendar (Ctrl+2)">
            📅 <span className="label">Calendar</span>
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
              ✎ <span className="label">New mail</span>
            </button>
            <input ref={searchRef} className="search" placeholder="Search all mail" value={query} onChange={(e) => setQuery(e.target.value)} />
          </>
        )}
        <div className="topbar-right">
          <UpdatePill />
          <button
            className={`icon-btn ${syncing ? 'busy' : ''}`}
            title={`${syncing ? 'Syncing…' : 'Send / receive'}${sc('syncAll') ? ` (${sc('syncAll')})` : ''}`}
            aria-label="Send / receive"
            onClick={() => void api.syncNow().catch(fail)}
          >
            <span>
              <SyncIcon />
            </span>
          </button>
          <button
            className="icon-btn"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={async () => setSettings(await api.saveSettings({ theme: dark ? 'light' : 'dark' }))}
          >
            <span>{dark ? <SunIcon /> : <MoonIcon />}</span>
          </button>
          <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setDialog('settings')}>
            <span>
              <GearIcon />
            </span>
          </button>
        </div>
      </header>

      {(notice || errors.length > 0) && (
        <div className={`banner ${notice && !notice.error ? 'info' : ''}`} onClick={() => setNotice(null)}>
          {notice?.text ??
            errors
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
          layout={layout}
          drawerOpen={drawer}
          onCloseDrawer={() => setDrawer(false)}
        />
      )}
      <div className="body" hidden={mode !== 'mail'}>
        <Sidebar
          accounts={accounts}
          folders={folders}
          status={status}
          prefs={settings.folderPrefs}
          view={view}
          drawerOpen={drawer}
          outboxCount={outbox.length}
          onView={(v) => {
            setDrawer(false)
            setReaderOpen(false)
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
        ) : inOutbox ? (
          <div className="panes">
            {/* Narrow windows: the editor (after Edit) takes the whole space */}
            {!(singlePane && composeView) && (
              <OutboxView
                items={outbox}
                accounts={accountById}
                onStatus={say}
                onEdit={(id) =>
                  void api
                    .editFromOutbox(id)
                    .then((m) => startCompose(m))
                    .catch(fail)
                }
              />
            )}
            {(singlePane || settings.readingPane !== 'off') && composeView}
          </div>
        ) : (
          <div className="panes" data-show={singlePane ? (readerOpen || composeView ? 'detail' : 'list') : 'both'}>
            <MessageList
              messages={messages}
              primary={primary}
              selected={selected}
              accounts={accountById}
              showAccount={view.accountId === null || !!query}
              loadingMore={loadingMore}
              onSelect={(m, how) => {
                select(m, how)
                if (singlePane && how === 'single') setReaderOpen(true)
              }}
              onOpen={(m) => void open(m)}
              onFlag={(m) => void api.setFlagged([m.key], !m.flagged).catch(fail)}
              onMenu={(e, m) => {
                e.preventDefault()
                void messageMenu(m)
              }}
              onEndReached={() => void loadMore()}
            />
            {(singlePane || settings.readingPane !== 'off') &&
              (composeView ?? (
                <Reader
                  onBack={singlePane ? () => setReaderOpen(false) : undefined}
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
                    toggleRead: () => {
                      if (!current) return
                      handMarked(selection())
                      void expand(selection())
                        .then((k) => api.setRead(k, current.unread))
                        .catch(fail)
                    },
                    editDraft: (m) => void open(m),
                    status: say,
                    respondInvite
                  }}
                />
              ))}
          </div>
        )}
      </div>

      {/* With the reading pane off, writing happens in a full-size overlay */}
      {settings.readingPane === 'off' && !singlePane && composeView && <div className="compose-overlay">{composeView}</div>}
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}

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
      {colorPick && (
        <ColorDialog
          title={colorPick.title}
          initial={colorPick.initial}
          onPick={(c) => {
            colorPick.onPick(c)
            setColorPick(null)
          }}
          onClose={() => setColorPick(null)}
        />
      )}
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
