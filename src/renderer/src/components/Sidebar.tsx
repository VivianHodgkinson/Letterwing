import { useState } from 'react'
import type { Account, Folder, FolderRole, SyncStatus } from '@shared/types'
import type { View } from '../App'

const ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']
const ICON: Record<FolderRole, string> = { inbox: '📥', drafts: '📝', sent: '📤', archive: '🗄', junk: '⚠', trash: '🗑', other: '📁' }

interface Props {
  accounts: Account[]
  folders: Record<string, Folder[]>
  status: Record<string, SyncStatus>
  view: View
  onView(v: View): void
  onAddAccount(): void
}

export function Sidebar({ accounts, folders, status, view, onView, onAddAccount }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const totalUnread = accounts.reduce((n, a) => n + (folders[a.id]?.find((f) => f.role === 'inbox')?.unread ?? 0), 0)

  return (
    <nav className="sidebar">
      <button className={`folder unified ${view.folderId === '*inbox' ? 'active' : ''}`} onClick={() => onView({ accountId: null, folderId: '*inbox' })}>
        <span className="ficon">✉</span>
        <span className="fname">All inboxes</span>
        {totalUnread > 0 && <span className="count">{totalUnread}</span>}
      </button>

      {accounts.map((a) => {
        const list = sortFolders(folders[a.id] ?? [])
        const st = status[a.id]
        return (
          <section key={a.id} className="account" style={{ ['--acct' as string]: a.color }}>
            <button className="account-head" onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))}>
              <span className="badge">{a.label}</span>
              <span className="aname" title={a.email}>
                {a.name}
              </span>
              <span className={`dot ${st?.state ?? 'idle'}`} title={st?.message ?? st?.state ?? ''} />
            </button>
            {!collapsed[a.id] &&
              list.map(({ folder: f, depth }) => (
                <button
                  key={f.id}
                  className={`folder ${view.accountId === a.id && view.folderId === f.id ? 'active' : ''}`}
                  style={{ paddingLeft: 14 + depth * 14 }}
                  onClick={() => onView({ accountId: a.id, folderId: f.id })}
                >
                  <span className="ficon">{ICON[f.role]}</span>
                  <span className="fname">{f.name}</span>
                  {f.unread > 0 && f.role !== 'sent' && f.role !== 'trash' && <span className="count">{f.unread}</span>}
                </button>
              ))}
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
function sortFolders(folders: Folder[]): { folder: Folder; depth: number }[] {
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
