import { useEffect, useRef } from 'react'
import type { Account, MessageSummary } from '@shared/types'
import { hue, initials, shortDate, who } from '../format'

/** Drag payload when messages are dragged onto a folder */
export const DRAG_TYPE = 'application/x-letterwing-messages'

interface Props {
  messages: MessageSummary[]
  /** The message shown in the reader */
  primary: string | null
  selected: Set<string>
  accounts: Record<string, Account>
  /** Show the account badge on each row (unified inbox and search results) */
  showAccount: boolean
  loadingMore: boolean
  onSelect(m: MessageSummary, mode: 'single' | 'toggle' | 'range'): void
  onOpen(m: MessageSummary): void
  onFlag(m: MessageSummary): void
  onEndReached(): void
}

export function MessageList({ messages, primary, selected, accounts, showAccount, loadingMore, onSelect, onOpen, onFlag, onEndReached }: Props) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the keyboard selection in view
  useEffect(() => {
    listRef.current?.querySelector('.msg.primary')?.scrollIntoView({ block: 'nearest' })
  }, [primary])

  // A short list that doesn't fill the pane can't be scrolled, so ask for more straight away
  useEffect(() => {
    const el = listRef.current
    if (el && messages.length && el.scrollHeight <= el.clientHeight) onEndReached()
  }, [messages.length])

  if (!messages.length) return <div className="message-list empty">{loadingMore ? 'Loading…' : 'Nothing here.'}</div>

  return (
    <div
      className="message-list"
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) onEndReached()
      }}
    >
      {groupByDay(messages).map(([label, group]) => (
        <div key={label}>
          <div className="day">{label}</div>
          {group.map((m) => {
            const acct = accounts[m.accountId]
            const unread = m.threadUnread !== undefined ? m.threadUnread > 0 : m.unread
            return (
              <div
                key={m.key}
                className={`msg ${unread ? 'unread' : ''} ${selected.has(m.key) ? 'active' : ''} ${m.key === primary ? 'primary' : ''}`}
                draggable
                onDragStart={(e) => {
                  const keys = selected.has(m.key) ? [...selected] : [m.key]
                  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(keys))
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onClick={(e) => onSelect(m, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'single')}
                onDoubleClick={() => onOpen(m)}
              >
                <div className="avatar" style={{ ['--h' as string]: hue(m.from?.address ?? '') }}>
                  {initials(m.from)}
                </div>
                <div className="msg-main">
                  <div className="msg-top">
                    <span className="sender">{who(m.from)}</span>
                    {(m.threadCount ?? 1) > 1 && (
                      <span className="thread-count" title={`${m.threadCount} messages in this conversation`}>
                        {m.threadCount}
                      </span>
                    )}
                    {m.hasAttachments && <span title="Has attachments">📎</span>}
                    <span className="date">{shortDate(m.date)}</span>
                  </div>
                  <div className="subject">{m.subject}</div>
                  {m.preview && <div className="preview">{m.preview}</div>}
                </div>
                <div className="msg-side">
                  {showAccount && acct && (
                    <span className="badge small" style={{ ['--acct' as string]: acct.color }} title={acct.name}>
                      {acct.label}
                    </span>
                  )}
                  <button
                    className={`flag ${m.flagged ? 'on' : ''}`}
                    title={m.flagged ? 'Unflag' : 'Flag'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onFlag(m)
                    }}
                  >
                    ⚑
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ))}
      {loadingMore && <div className="day">Loading older messages…</div>}
    </div>
  )
}

function groupByDay(messages: MessageSummary[]): [string, MessageSummary[]][] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const t = today.getTime()
  const label = (ms: number): string => {
    if (ms >= t) return 'Today'
    if (ms >= t - 86_400_000) return 'Yesterday'
    if (ms >= t - 6 * 86_400_000) return 'This week'
    if (ms >= t - 30 * 86_400_000) return 'This month'
    return new Date(ms).toLocaleDateString([], { month: 'long', year: 'numeric' })
  }
  const out: [string, MessageSummary[]][] = []
  for (const m of messages) {
    const l = label(m.date)
    if (out.length && out[out.length - 1][0] === l) out[out.length - 1][1].push(m)
    else out.push([l, [m]])
  }
  return out
}
