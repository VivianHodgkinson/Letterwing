import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveKeymap, type ActionId } from '@shared/keys'
import type { Account, Folder, MessageSummary, Outgoing, Settings, SyncStatus } from '@shared/types'
import { api, on } from './api'
import { AccountDialog } from './components/AccountDialog'
import { Compose, type ComposeHandle } from './components/Compose'
import { MessageList } from './components/MessageList'
import { MoveDialog } from './components/MoveDialog'
import { Reader } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { useKeymap } from './keymap'
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
  const [compose, setCompose] = useState<{ initial: Outgoing; id: number } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [imagesRequest, setImagesRequest] = useState(0)
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
    // Clicking a new-mail notification
    const offOpen = on('open:message', (p) => {
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

  /** After a delete/archive/move, select the next message, like Classic */
  const removeAndAdvance = async (run: (keys: string[]) => Promise<void>, verb: string) => {
    const keys = selection()
    if (!keys.length) return
    const idx = Math.max(...keys.map((k) => messages.findIndex((m) => m.key === k)))
    const next = messages.slice(idx + 1).find((m) => !keys.includes(m.key)) ?? messages.slice(0, idx).reverse().find((m) => !keys.includes(m.key))
    setSelected(new Set(next ? [next.key] : []))
    setPrimary(next?.key ?? null)
    try {
      await run(await expand(keys))
    } catch (e) {
      say(`Couldn't ${verb}: ${(e as Error).message}`, true)
    }
  }

  const archive = () => void removeAndAdvance((k) => api.archiveMessages(k), 'archive')
  const remove = () => void removeAndAdvance((k) => api.deleteMessages(k), 'delete')
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
  const move = (to: (i: number) => number) => {
    const i = messages.findIndex((m) => m.key === primary)
    const m = messages[Math.max(0, Math.min(messages.length - 1, to(i)))]
    if (m) select(m)
  }
  const keys = () => selection()
  const handlers: Partial<Record<ActionId, () => void>> = {
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
    markRead: () => void expand(keys()).then((k) => api.setRead(k, true)).catch(fail),
    markUnread: () => void expand(keys()).then((k) => api.setRead(k, false)).catch(fail),
    toggleRead: () => current && void expand(keys()).then((k) => api.setRead(k, current.unread)).catch(fail),
    toggleFlag: () => current && void api.setFlagged(keys(), !current.flagged).catch(fail),
    reply: () => void reply('reply'),
    replyAll: () => void reply('replyAll'),
    forward: () => void reply('forward'),
    delete: remove,
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
  useKeymap(keymap ?? effectiveKeymap('classic', {}), handlers, !!keymap && dialog === null)

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
        <div className="brand">Inkwell</div>
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
        <button className="ghost" title="Send / receive" onClick={() => void api.syncNow().catch(fail)}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button className="ghost" onClick={() => setDialog('settings')}>
          Settings
        </button>
      </header>

      {(notice || errors.length > 0) && (
        <div className={`banner ${notice && !notice.error ? 'info' : ''}`} onClick={() => setNotice(null)}>
          {notice?.text ?? errors.map((s) => `${accountById[s.accountId]?.name ?? 'Account'}: ${s.message}`).join(' · ')}
        </div>
      )}

      <div className="body">
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
          onDropMessages={(dropped, accountId, folderId) => {
            const same = messages.filter((m) => dropped.includes(m.key) && m.accountId === accountId).map((m) => m.key)
            if (same.length < dropped.length) say('Messages can only be moved between folders of the same account.', true)
            if (same.length) void expand(same).then((k) => api.moveMessages(k, folderId)).catch(fail)
          }}
        />
        {accounts.length === 0 ? (
          <div className="empty-state">
            <h1>Welcome to Inkwell</h1>
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
                    remove,
                    move: openMove,
                    toggleFlag: () => current && void api.setFlagged(selection(), !current.flagged).catch(fail),
                    toggleRead: () => current && void expand(selection()).then((k) => api.setRead(k, current.unread)).catch(fail),
                    editDraft: (m) => void open(m)
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
      {dialog === 'settings' && (
        <SettingsDialog
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
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}
