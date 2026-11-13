import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Folder, MessageSummary, Settings, SyncStatus } from '@shared/types'
import { api, on } from './api'
import { AccountDialog } from './components/AccountDialog'
import { MessageList } from './components/MessageList'
import { Reader } from './components/Reader'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'

export interface View {
  accountId: string | null
  folderId: string
}

const UNIFIED: View = { accountId: null, folderId: '*inbox' }
const PAGE = 200

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [folders, setFolders] = useState<Record<string, Folder[]>>({})
  const [view, setView] = useState<View>(UNIFIED)
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Record<string, SyncStatus>>({})
  const [dialog, setDialog] = useState<'account' | 'settings' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const loadAccounts = useCallback(async () => {
    const accs = await api.listAccounts()
    setAccounts(accs)
    const entries = await Promise.all(accs.map(async (a) => [a.id, await api.listFolders(a.id)] as const))
    setFolders(Object.fromEntries(entries))
  }, [])

  const loadMessages = useCallback(async () => {
    const list = query.trim() ? await api.search(query, PAGE) : await api.listMessages(view.accountId, view.folderId, PAGE)
    setMessages(list)
  }, [view, query])

  useEffect(() => {
    api.getSettings().then(setSettings)
    void loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    void loadMessages().catch((e: Error) => setError(e.message))
  }, [loadMessages])

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
    return () => {
      offChanged()
      offStatus()
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

  const current = useMemo(() => messages.find((m) => m.key === selected) ?? null, [messages, selected])

  const select = useCallback(
    (m: MessageSummary) => {
      setSelected(m.key)
      if (m.unread) void api.setRead([m.key], true).catch((e: Error) => setError(e.message))
    },
    []
  )

  // Keyboard: j/k or arrows to move, / to search, u unread, s star (flag), Escape clears search
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || dialog) {
        if (e.key === 'Escape' && target === searchRef.current) {
          setQuery('')
          searchRef.current?.blur()
        }
        return
      }
      const i = messages.findIndex((m) => m.key === selected)
      if (e.key === 'j' || e.key === 'ArrowDown') {
        const next = messages[Math.min(messages.length - 1, i + 1)]
        if (next) select(next)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        const prev = messages[Math.max(0, i - 1)]
        if (prev) select(prev)
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'u' && current) void api.setRead([current.key], current.unread)
      else if (e.key === 's' && current) void api.setFlagged([current.key], !current.flagged)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [messages, selected, current, select, dialog])

  if (!settings) return null
  const accountById = Object.fromEntries(accounts.map((a) => [a.id, a]))
  const syncing = Object.values(status).some((s) => s.state === 'syncing')
  const errors = Object.values(status).filter((s) => s.state === 'error')

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Inkwell</div>
        <input
          ref={searchRef}
          className="search"
          placeholder="Search all mail  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="ghost" title="Sync now" onClick={() => void api.syncNow()}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <button className="ghost" onClick={() => setDialog('settings')}>
          Settings
        </button>
      </header>

      {(error || errors.length > 0) && (
        <div className="banner" onClick={() => setError(null)}>
          {error ?? errors.map((s) => `${accountById[s.accountId]?.name ?? 'Account'}: ${s.message}`).join(' · ')}
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
            setSelected(null)
          }}
          onAddAccount={() => setDialog('account')}
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
              selected={selected}
              accounts={accountById}
              showAccount={view.accountId === null || !!query}
              onSelect={select}
              onFlag={(m) => void api.setFlagged([m.key], !m.flagged)}
            />
            {settings.readingPane !== 'off' && <Reader message={current} account={current ? accountById[current.accountId] : undefined} settings={settings} />}
          </div>
        )}
      </div>

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
