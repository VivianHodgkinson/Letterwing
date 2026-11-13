import DOMPurify from 'dompurify'
import { useEffect, useMemo, useState } from 'react'
import type { Account, MessageBody, MessageSummary, Settings } from '@shared/types'
import { api } from '../api'
import { bytes, fullDate, hue, initials, whoFull } from '../format'

interface Props {
  message: MessageSummary | null
  account?: Account
  settings: Settings
  /** Bumped by the "Load remote images" shortcut */
  imagesRequest: number
}

export function Reader({ message, account, settings, imagesRequest }: Props) {
  const [body, setBody] = useState<MessageBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [allowImages, setAllowImages] = useState(false)

  useEffect(() => {
    setBody(null)
    setError(null)
    setAllowImages(false)
    if (!message) return
    let live = true
    api.getBody(message.key).then(
      (b) => live && setBody(b),
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [message?.key])

  useEffect(() => {
    if (imagesRequest > 0) setAllowImages(true)
  }, [imagesRequest])

  const remote = settings.loadRemoteImages || allowImages
  const doc = useMemo(() => (body ? renderDoc(body, remote) : ''), [body, remote])

  if (!message) return <div className="reader empty">Select a message to read it.</div>

  return (
    <div className="reader">
      <div className="reader-head">
        <h2>{message.subject}</h2>
        <div className="from-row">
          <div className="avatar big" style={{ ['--h' as string]: hue(message.from?.address ?? '') }}>
            {initials(message.from)}
          </div>
          <div>
            <div className="from">{message.from ? whoFull(message.from) : '(unknown sender)'}</div>
            <div className="meta">
              To {message.to.map(whoFull).join(', ') || '(undisclosed)'}
              {body && body.cc.length > 0 && <> · Cc {body.cc.map(whoFull).join(', ')}</>}
            </div>
          </div>
          <div className="meta right">
            {account && (
              <span className="badge small" style={{ ['--acct' as string]: account.color }}>
                {account.label}
              </span>
            )}
            <div>{fullDate(message.date)}</div>
          </div>
        </div>
        {body?.hasRemoteContent && !remote && (
          <div className="notice">
            Remote images are blocked to stop senders tracking when you read this.{' '}
            <button className="link" onClick={() => setAllowImages(true)}>
              Load images
            </button>
          </div>
        )}
        {body && body.attachments.filter((a) => !a.inline).length > 0 && (
          <div className="attachments">
            {body.attachments
              .filter((a) => !a.inline)
              .map((a) => (
                <span key={a.id} className="chip" title={a.contentType}>
                  📎 {a.filename} <small>{bytes(a.size)}</small>
                </span>
              ))}
          </div>
        )}
      </div>
      {error ? (
        <div className="reader-error">Couldn't load this message: {error}</div>
      ) : !body ? (
        <div className="reader-loading">Loading…</div>
      ) : (
        // No allow-scripts and no allow-same-origin: the mail can't run code or reach the app.
        // allow-popups lets links open, which the main process sends to the system browser.
        <iframe className="mail-frame" title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} />
      )}
    </div>
  )
}

function renderDoc(body: MessageBody, remoteImages: boolean): string {
  const content = body.html
    ? // <style> is kept (newsletters depend on it); the frame's CSP stops CSS from loading anything remote
      DOMPurify.sanitize(body.html, { FORCE_BODY: true, ADD_TAGS: ['style'], FORBID_TAGS: ['form', 'input', 'button'], ADD_ATTR: ['target'] })
    : `<pre class="plain">${escapeHtml(body.text ?? '')}</pre>`
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${remoteImages ? ' https: http:' : ''}; font-src data:`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  body { margin: 0; padding: 20px 24px; font: 14px/1.5 system-ui, sans-serif; color: #1a1d24; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  pre.plain { white-space: pre-wrap; font: 13px/1.5 ui-monospace, monospace; margin: 0; }
  blockquote { border-left: 3px solid #c8cdd6; margin: 0 0 0 4px; padding-left: 12px; color: #555; }
  a { color: #2563eb; }
</style></head><body>${content}</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
