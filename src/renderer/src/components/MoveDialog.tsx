import { useState } from 'react'
import type { Folder } from '@shared/types'

interface Props {
  folders: Folder[]
  /** The folder the messages are in now, left out of the list */
  currentFolderId: string
  onPick(folder: Folder): void
  onClose(): void
}

/** Ctrl+Shift+V: type to filter, Enter moves to the highlighted folder */
export function MoveDialog({ folders, currentFolderId, onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const list = folders.filter((f) => f.id !== currentFolderId && f.name.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog move-dialog">
        <h2>Move to folder</h2>
        <input
          autoFocus
          placeholder="Folder name"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((i) => Math.min(list.length - 1, i + 1))
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
            else if (e.key === 'Enter' && list[active]) onPick(list[active])
            else if (e.key === 'Escape') onClose()
            else return
            e.preventDefault()
          }}
        />
        <div className="folder-pick">
          {list.map((f, i) => (
            <button key={f.id} className={`folder ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => onPick(f)}>
              <span className="fname">{f.name}</span>
              {f.parentId && <small>{folders.find((p) => p.id === f.parentId)?.name}</small>}
            </button>
          ))}
          {!list.length && <div className="hint">No folder matches.</div>}
        </div>
      </div>
    </div>
  )
}
