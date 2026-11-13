import { useEffect, useRef } from 'react'
import type { Account, MessageSummary } from '@shared/types'
import { hue, initials, shortDate, who } from '../format'

interface Props {
  messages: MessageSummary[]
  selected: string | null
  accounts: Record<string, Account>
  /** Show the account badge on each row (unified inbox and search results) */
  showAccount: boolean
  onSelect(m: MessageSummary): void
  onFlag(m: MessageSummary): void
}

export function MessageList({ messages, selected, accounts, showAccount, onSelect, onFlag }: Props) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the keyboard selection in view
  useEffect(() => {
    listRef.current?.querySelector('.msg.active')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!messages.length) return <div className="message-list empty">Nothing here.</div>

  return (
    <div className="message-list" ref={listRef}>
      {groupByDay(messages).map(([label, group]) => (
        <div key={label}>
          <div className="day">{label}</div>
          {group.map((m) => {
            const acct = accounts[m.accountId]
            return (
              <div key={m.key} className={`msg ${m.unread ? 'unread' : ''} ${m.key === selected ? 'active' : ''}`} onClick={() => onSelect(m)}>
                <div className="avatar" style={{ ['--h' as string]: hue(m.from?.address ?? '') }}>
                  {initials(m.from)}
                </div>
                <div className="msg-main">
                  <div className="msg-top">
                    <span className="sender">{who(m.from)}</span>
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
                    title={m.flagged ? 'Unflag (s)' : 'Flag (s)'}
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
