import type { Account, OutboxItem } from '@shared/types'
import { api } from '../api'

interface Props {
  items: OutboxItem[]
  accounts: Record<string, Account>
  onEdit(id: string): void
  onStatus(message: string, error?: boolean): void
}

const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** Messages waiting to be sent: they go by themselves when the connection is back */
export function OutboxView({ items, accounts, onEdit, onStatus }: Props) {
  if (!items.length) return <div className="outbox empty">The Outbox is empty: everything has been sent.</div>
  return (
    <div className="outbox">
      <p className="hint">These send themselves when Letterwing can reach your mail server again. You can also send now, change them, or delete them.</p>
      {items.map((m) => {
        const acc = accounts[m.accountId]
        return (
          <div key={m.id} className={`outbox-item ${m.stuck ? 'stuck' : ''}`}>
            <div className="outbox-main">
              <div className="outbox-subject">{m.subject || '(no subject)'}</div>
              <div className="dim">
                To {m.to.join(', ')}
                {acc && <> · from {acc.email}</>}
              </div>
              <div className={m.stuck ? 'error' : 'dim'}>
                {m.stuck ? `Couldn't send: ${m.error}` : m.attempts ? `Waiting for a connection (last try: ${m.error})` : 'Waiting for a connection'} · since {when(m.queuedAt)}
              </div>
            </div>
            <div className="outbox-actions">
              <button
                className="ghost"
                onClick={() =>
                  void api
                    .retryOutbox(m.id)
                    .then(() => api.listOutbox())
                    .then((left) => (left.some((x) => x.id === m.id) ? onStatus("Still couldn't send it; it stays in the Outbox.", true) : onStatus('Sent.')))
                }
              >
                Send now
              </button>
              <button className="ghost" onClick={() => onEdit(m.id)}>
                Edit
              </button>
              <button
                className="ghost danger"
                onClick={async () => {
                  if (await api.confirm({ message: `Delete "${m.subject || '(no subject)'}" without sending it?`, ok: 'Delete' })) await api.removeFromOutbox(m.id)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
