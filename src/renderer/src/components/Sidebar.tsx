import { useState } from 'react'
import { prefKey, type Account, type Folder, type FolderPref, type FolderRole, type SyncStatus } from '@shared/types'
import type { View } from '../App'
import { DRAG_TYPE } from './MessageList'

const ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']
const ICON: Record<FolderRole, string> = { inbox: '📥', drafts: '📝', sent: '📤', archive: '🗄', junk: '⚠', trash: '🗑', other: '📁' }

interface Props {
  accounts: Account[]
  folders: Record<string, Folder[]>
  status: Record<string, SyncStatus>
  /** Favourites and colours */
  prefs: Record<string, FolderPref>
  /** Narrower layouts: the sidebar is a drawer, slid in when this is true */
  drawerOpen: boolean
  view: View
  onView(v: View): void
  onAddAccount(): void
  /** Messages dropped onto a folder */
  onDropMessages(keys: string[], accountId: string, folderId: string): void
  /** Right-click (or the menu key) on a folder, an account heading or All inboxes */
  onFolderMenu(e: React.MouseEvent, account: Account, folder: Folder): void
  onAccountMenu(e: React.MouseEvent, account: Account): void
  onUnifiedMenu(e: React.MouseEvent): void
}

export function Sidebar({ accounts, folders, status, prefs, drawerOpen, view, onView, onAddAccount, onDropMessages, onFolderMenu, onAccountMenu, onUnifiedMenu }: Props) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const totalUnread = accounts.reduce((n, a) => n + (folders[a.id]?.find((f) => f.role === 'inbox')?.unread ?? 0), 0)

  // Favourites from every account, in the order they were added (or rearranged)
  const favourites = accounts
    .flatMap((a) => (folders[a.id] ?? []).map((f) => ({ a, f, order: prefs[prefKey(a.id, f.id)]?.favourite })))
    .filter((x): x is { a: Account; f: Folder; order: number } => x.order !== undefined)
    .sort((x, y) => x.order - y.order)

  const folderButton = (a: Account, f: Folder, depth: number, where: 'fav' | 'tree') => {
    const id = `${where}${a.id}${f.id}`
    const color = prefs[prefKey(a.id, f.id)]?.color
    return (
      <button
        key={id}
        className={`folder ${view.accountId === a.id && view.folderId === f.id ? 'active' : ''} ${dropTarget === id ? 'drop' : ''} ${color ? 'colored' : ''}`}
        style={{ paddingLeft: 14 + depth * 14, ...(color ? { ['--fc' as string]: color } : {}) }}
        title={where === 'fav' ? `${f.name} · ${a.email}` : undefined}
        onClick={() => onView({ accountId: a.id, folderId: f.id })}
        onContextMenu={(e) => onFolderMenu(e, a, f)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropTarget(id)
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          setDropTarget(null)
          const raw = e.dataTransfer.getData(DRAG_TYPE)
          if (raw) onDropMessages(JSON.parse(raw) as string[], a.id, f.id)
        }}
      >
        <span className="ficon">{ICON[f.role]}</span>
        <span className="fname">{f.name}</span>
        {where === 'fav' && accounts.length > 1 && (
          <span className="badge small" style={{ ['--acct' as string]: a.color }}>
            {a.label}
          </span>
        )}
        {f.unread > 0 && f.role !== 'sent' && f.role !== 'trash' && <span className="count">{f.unread}</span>}
      </button>
    )
  }

  return (
    <nav className={`sidebar ${drawerOpen ? 'open' : ''}`}>
      <button className={`folder unified ${view.folderId === '*inbox' ? 'active' : ''}`} onClick={() => onView({ accountId: null, folderId: '*inbox' })} onContextMenu={onUnifiedMenu}>
        <span className="ficon">✉</span>
        <span className="fname">All inboxes</span>
        {totalUnread > 0 && <span className="count">{totalUnread}</span>}
      </button>

      {favourites.length > 0 && (
        <section className="favourites">
          <div className="section-head">★ Favourites</div>
          {favourites.map(({ a, f }) => folderButton(a, f, 0, 'fav'))}
        </section>
      )}

      {accounts.map((a) => {
        const list = sortFolders(folders[a.id] ?? [])
        const st = status[a.id]
        return (
          <section key={a.id} className="account" style={{ ['--acct' as string]: a.color }}>
            <button className="account-head" onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))} onContextMenu={(e) => onAccountMenu(e, a)}>
              <span className="badge">{a.label}</span>
              {/* The address tells accounts apart (three Gmail accounts would all be called "Gmail") */}
              <span className="aname" title={a.name}>
                {a.email}
              </span>
              <span className={`dot ${st?.state ?? 'idle'}`} title={st?.message ?? st?.state ?? ''} />
            </button>
            {!collapsed[a.id] && list.map(({ folder: f, depth }) => folderButton(a, f, depth, 'tree'))}
          </section>
        )
      })}

      <button className="add-account" onClick={onAddAccount}>
        + Add account
      </button>
    </nav>
  )
}

/** Special folders first in a fixed order, then the rest as a tree */
export function sortFolders(folders: Folder[]): { folder: Folder; depth: number }[] {
  const special = ORDER.flatMap((r) => folders.filter((f) => f.role === r))
  const rest = folders.filter((f) => f.role === 'other')
  const children = new Map<string | null, Folder[]>()
  const ids = new Set(rest.map((f) => f.id))
  for (const f of rest) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), f])
  }
  const out: { folder: Folder; depth: number }[] = special.map((f) => ({ folder: f, depth: 0 }))
  const walk = (parent: string | null, depth: number): void => {
    for (const f of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
