import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, MessageBody, MessageSummary, Settings } from '@shared/types'
import { api } from '../api'
import { bytes, fullDate, hue, initials, shortDate, who, whoFull } from '../format'
import type { ReplyKind } from '../replies'

export interface ReaderActions {
  reply(kind: ReplyKind, message: MessageSummary, body: MessageBody): void
  archive(): void
  remove(): void
  move(): void
  toggleFlag(): void
  toggleRead(): void
  editDraft(message: MessageSummary): void
}

interface Props {
  message: MessageSummary | null
  /** How many messages are selected in the list; the toolbar acts on all of them */
  selectedCount: number
  accounts: Record<string, Account>
  settings: Settings
  isDraft: boolean
  /** Bumped by the "Load remote images" shortcut */
  imagesRequest: number
  actions: ReaderActions
}

export function Reader({ message, selectedCount, accounts, settings, isDraft, imagesRequest, actions }: Props) {
  const [thread, setThread] = useState<MessageSummary[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [allowImages, setAllowImages] = useState(false)

  useEffect(() => {
    setAllowImages(false)
    if (!message) {
      setThread([])
      return
    }
    let live = true
    const load = settings.conversations ? api.getThread(message.key) : Promise.resolve([message])
    load.then((t) => {
      if (!live) return
      const list = t.length ? t : [message]
      setThread(list)
      // Open the selected message and anything unread; collapse the rest, like Classic
      setExpanded(new Set(list.filter((m) => m.key === message.key || m.unread).map((m) => m.key)))
    })
    return () => {
      live = false
    }
  }, [message?.key, message?.threadCount, settings.conversations])

  useEffect(() => {
    if (imagesRequest > 0) setAllowImages(true)
  }, [imagesRequest])

  if (!message) return <div className="reader empty">{selectedCount > 1 ? `${selectedCount} messages selected` : 'Select a message to read it.'}</div>

  const multi = selectedCount > 1
  return (
    <div className="reader">
      <div className="reader-toolbar">
        <button className="ghost" onClick={actions.archive} title="Archive">
          🗄 Archive
        </button>
        <button className="ghost" onClick={actions.remove} title="Delete">
          🗑 Delete
        </button>
        <button className="ghost" onClick={actions.move} title="Move to folder">
          📁 Move
        </button>
        <button className="ghost" onClick={actions.toggleRead}>
          {message.unread ? 'Mark read' : 'Mark unread'}
        </button>
        <button className={`ghost ${message.flagged ? 'flag-on' : ''}`} onClick={actions.toggleFlag}>
          ⚑ {message.flagged ? 'Unflag' : 'Flag'}
        </button>
        {multi && <span className="multi-note">{selectedCount} selected</span>}
      </div>
      <div className="reader-scroll">
        <h2 className="reader-subject">{message.subject}</h2>
        {isDraft && (
          <div className="notice">
            This is a draft.{' '}
            <button className="link" onClick={() => actions.editDraft(message)}>
              Continue editing
            </button>
          </div>
        )}
        {thread.map((m) => (
          <MessageCard
            key={m.key}
            message={m}
            account={accounts[m.accountId]}
            expanded={expanded.has(m.key)}
            onToggle={() =>
              setExpanded((s) => {
                const next = new Set(s)
                if (next.has(m.key)) next.delete(m.key)
                else next.add(m.key)
                return next
              })
            }
            remoteImages={settings.loadRemoteImages || allowImages}
            onAllowImages={() => setAllowImages(true)}
            onReply={actions.reply}
          />
        ))}
      </div>
    </div>
  )
}

function MessageCard(props: {
  message: MessageSummary
  account?: Account
  expanded: boolean
  onToggle(): void
  remoteImages: boolean
  onAllowImages(): void
  onReply(kind: ReplyKind, message: MessageSummary, body: MessageBody): void
}) {
  const { message: m, account, expanded, onToggle, remoteImages } = props
  const [body, setBody] = useState<MessageBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || body) return
    let live = true
    api.getBody(m.key).then(
      (b) => live && setBody(b),
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [expanded, m.key])

  if (!expanded)
    return (
      <div className="card collapsed" onClick={onToggle}>
        <div className="avatar" style={{ ['--h' as string]: hue(m.from?.address ?? '') }}>
          {initials(m.from)}
        </div>
        <span className={`card-from ${m.unread ? 'unread' : ''}`}>{who(m.from)}</span>
        <span className="card-preview">{m.preview}</span>
        <span className="date">{shortDate(m.date)}</span>
      </div>
    )

  const files = body?.attachments.filter((a) => !a.inline) ?? []
  return (
    <div className="card">
      <div className="card-head" onClick={onToggle}>
        <div className="avatar big" style={{ ['--h' as string]: hue(m.from?.address ?? '') }}>
          {initials(m.from)}
        </div>
        <div className="grow">
          <div className="from">{m.from ? whoFull(m.from) : '(unknown sender)'}</div>
          <div className="meta">
            To {m.to.map(whoFull).join(', ') || '(undisclosed)'}
            {body && body.cc.length > 0 && <> · Cc {body.cc.map(whoFull).join(', ')}</>}
          </div>
        </div>
        <div className="meta right">
          {account && (
            <span className="badge small" style={{ ['--acct' as string]: account.color }}>
              {account.label}
            </span>
          )}
          <div>{fullDate(m.date)}</div>
        </div>
      </div>
      {body && (
        <div className="card-actions">
          <button className="ghost small" onClick={() => props.onReply('reply', m, body)}>
            ↩ Reply
          </button>
          <button className="ghost small" onClick={() => props.onReply('replyAll', m, body)}>
            ↩↩ Reply all
          </button>
          <button className="ghost small" onClick={() => props.onReply('forward', m, body)}>
            ↪ Forward
          </button>
        </div>
      )}
      {body?.hasRemoteContent && !remoteImages && (
        <div className="notice">
          Remote images are blocked to stop senders tracking when you read this.{' '}
          <button className="link" onClick={props.onAllowImages}>
            Load images
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="attachments">
          {files.map((a) => (
            <span key={a.id} className="chip attachment" title={`${a.contentType} · click to open`}>
              <button className="chip-open" onClick={() => void api.openAttachment(m.key, a.id).catch((e: Error) => setError(e.message))}>
                📎 {a.filename} <small>{bytes(a.size)}</small>
              </button>
              <button className="chip-x" title="Save as…" onClick={() => void api.saveAttachment(m.key, a.id).catch((e: Error) => setError(e.message))}>
                ⤓
              </button>
            </span>
          ))}
        </div>
      )}
      {error ? (
        <div className="reader-error">Couldn't load this message: {error}</div>
      ) : !body ? (
        <div className="reader-loading">Loading…</div>
      ) : (
        <MailFrame body={body} remoteImages={remoteImages} />
      )}
    </div>
  )
}

/**
 * The email itself, in a sandboxed iframe sized to its content. No allow-scripts, so the mail can
 * never run code; allow-same-origin only lets us measure its height. Links open in the browser.
 */
function MailFrame({ body, remoteImages }: { body: MessageBody; remoteImages: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const doc = useMemo(() => renderDoc(body, remoteImages), [body, remoteImages])
  const [height, setHeight] = useState(120)

  useEffect(() => {
    const f = frame.current
    if (!f) return
    let ro: ResizeObserver | null = null
    const measure = () => {
      const d = f.contentDocument
      if (d?.documentElement) setHeight(Math.max(60, d.documentElement.scrollHeight))
    }
    const onLoad = () => {
      measure()
      const d = f.contentDocument
      if (d?.body) {
        ro = new ResizeObserver(measure)
        ro.observe(d.body)
      }
    }
    f.addEventListener('load', onLoad)
    return () => {
      f.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [doc])

  return <iframe ref={frame} className="mail-frame" title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height }} />
}

function renderDoc(body: MessageBody, remoteImages: boolean): string {
  const content = body.html
    ? // <style> is kept (newsletters depend on it); the frame's CSP stops CSS from loading anything remote
      DOMPurify.sanitize(body.html, { FORCE_BODY: true, ADD_TAGS: ['style'], FORBID_TAGS: ['form', 'input', 'button'], ADD_ATTR: ['target'] })
    : `<pre class="plain">${escapeHtml(body.text ?? '')}</pre>`
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${remoteImages ? ' https: http:' : ''}; font-src data:`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html { overflow-y: hidden; overflow-x: auto; }
  body { margin: 0; padding: 16px 20px; font: 14px/1.5 system-ui, sans-serif; color: #1a1d24; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  pre.plain { white-space: pre-wrap; font: 13px/1.5 ui-monospace, monospace; margin: 0; }
  blockquote { border-left: 3px solid #c8cdd6; margin: 0 0 0 4px; padding-left: 12px; color: #555; }
  a { color: #2563eb; }${remoteImages ? '' : "\n  img[src^='http:'], img[src^='https:'] { visibility: hidden; }"}
</style></head><body>${content}</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
