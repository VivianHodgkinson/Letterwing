import type { CalendarEvent, CalendarInfo, ResponseStatus } from '@shared/types'
import { whoFull } from '../../format'
import { whenLabel } from './dates'

const STATUS: Record<ResponseStatus, string> = {
  accepted: 'Accepted',
  tentative: 'Tentative',
  declined: 'Declined',
  needsAction: 'Not answered',
  organizer: 'Organizer',
  none: ''
}

interface Props {
  event: CalendarEvent
  calendar?: CalendarInfo
  accountName?: string
  onClose(): void
  onEdit(): void
  onDelete(): void
  onRespond(answer: 'accepted' | 'tentative' | 'declined'): void
  onOpenUrl(url: string): void
}

/** Details of the selected event, with the actions that make sense for it */
export function EventPanel({ event: e, calendar, accountName, onClose, onEdit, onDelete, onRespond, onOpenUrl }: Props) {
  const invited = !e.isOrganizer && e.attendees.length > 0
  const writable = calendar && !calendar.readOnly
  return (
    <aside className="event-panel">
      <div className="ep-head" style={{ ['--ev' as string]: calendar?.color ?? 'var(--accent)' }}>
        <span className="ep-swatch" />
        <h3>{e.title}</h3>
        <button className="ghost small" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      {e.cancelled && <div className="notice">This event was cancelled.</div>}
      <div className="ep-row">🕒 {whenLabel(e.start, e.end, e.allDay)}</div>
      {e.recurring && <div className="ep-row dim">↻ Repeats</div>}
      {e.location && <div className="ep-row">📍 {e.location}</div>}
      {e.joinUrl && (
        <button className="primary join" onClick={() => onOpenUrl(e.joinUrl!)}>
          Join {/teams/.test(e.joinUrl) ? 'Teams meeting' : /zoom/.test(e.joinUrl) ? 'Zoom' : /meet\.google/.test(e.joinUrl) ? 'Google Meet' : 'online meeting'}
        </button>
      )}
      <div className="ep-row dim">
        {calendar?.name}
        {accountName ? ` · ${accountName}` : ''}
      </div>

      {invited && writable && !e.cancelled && (
        <div className="ep-respond">
          <span className="dim">Going? {e.myStatus !== 'none' && <b>{STATUS[e.myStatus]}</b>}</span>
          <div className="row">
            {(['accepted', 'tentative', 'declined'] as const).map((a) => (
              <button key={a} className={`ghost small ${e.myStatus === a ? 'chosen' : ''}`} onClick={() => onRespond(a)}>
                {a === 'accepted' ? '✓ Yes' : a === 'tentative' ? '? Maybe' : '✕ No'}
              </button>
            ))}
          </div>
        </div>
      )}

      {(e.organizer || e.attendees.length > 0) && (
        <div className="ep-people">
          {e.organizer && (
            <div className="ep-person">
              <b>{whoFull(e.organizer)}</b> <small>organizer</small>
            </div>
          )}
          {e.attendees
            .filter((a) => a.address !== e.organizer?.address)
            .map((a) => (
              <div key={a.address} className={`ep-person ${a.status}`}>
                <span className="ep-status" title={STATUS[a.status]} />
                {whoFull(a)}
                {a.optional && <small> optional</small>}
              </div>
            ))}
        </div>
      )}
      {e.description && <div className="ep-desc">{e.description}</div>}

      {writable && (
        <div className="actions">
          {e.isOrganizer && (
            <button className="ghost" onClick={onEdit}>
              Edit
            </button>
          )}
          <button className="ghost danger" onClick={onDelete}>
            {invited ? 'Decline & remove' : 'Delete'}
          </button>
        </div>
      )}
    </aside>
  )
}
