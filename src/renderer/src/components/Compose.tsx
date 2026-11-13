import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Account, Address, Contact, Outgoing, OutgoingAttachment } from '@shared/types'
import { api } from '../api'
import { bytes, whoFull } from '../format'
import { swapSignature } from '../replies'

export interface ComposeHandle {
  /** Save as a draft if anything changed, then let the caller close the view */
  flush(): Promise<void>
  send(): void
  saveDraft(): void
}

interface Props {
  initial: Outgoing
  accounts: Account[]
  onClose(): void
  onSent(): void
  onStatus(message: string, error?: boolean): void
}

/** Idle time after the last change before the draft is saved to the server */
const AUTOSAVE_MS = 15_000

export const Compose = forwardRef<ComposeHandle, Props>(function Compose({ initial, accounts, onClose, onSent, onStatus }, ref) {
  const [out, setOut] = useState<Outgoing>(initial)
  const [showCc, setShowCc] = useState(initial.cc.length > 0)
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'sending'>('idle')
  const editor = useRef<HTMLDivElement>(null)
  const latest = useRef(out)
  const dirty = useRef(false)
  const saving = useRef<Promise<void>>(Promise.resolve())
  const timer = useRef<number>(0)
  const sending = useRef(false)
  latest.current = out

  // The editor is uncontrolled: set its HTML once, read it back on change
  useEffect(() => {
    if (editor.current) editor.current.innerHTML = initial.html
    const subjectEmpty = !initial.subject && initial.to.length > 0
    if (initial.to.length === 0) document.querySelector<HTMLInputElement>('.compose .recipients input')?.focus()
    else if (subjectEmpty) document.querySelector<HTMLInputElement>('.compose .subject-input')?.focus()
    else focusEditorStart()
  }, [])

  const current = (): Outgoing => ({ ...latest.current, html: editor.current?.innerHTML ?? latest.current.html })

  const change = (patch: Partial<Outgoing> = {}) => {
    dirty.current = true
    if (Object.keys(patch).length) setOut((o) => ({ ...o, ...patch }))
    setState('idle')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS)
  }

  /** Saves run one after another so each replaces the previous server copy */
  const save = (): Promise<void> => {
    window.clearTimeout(timer.current)
    if (!dirty.current || sending.current) return saving.current
    dirty.current = false
    saving.current = saving.current.then(async () => {
      setState('saving')
      try {
        const saved = await api.saveDraft(current())
        setOut((o) => ({ ...o, serverDraft: saved.serverDraft, attachments: saved.attachments }))
        latest.current = { ...latest.current, serverDraft: saved.serverDraft, attachments: saved.attachments }
        setState('saved')
      } catch (e) {
        dirty.current = true
        setState('idle')
        onStatus(`Couldn't save draft: ${(e as Error).message}`, true)
      }
    })
    return saving.current
  }

  const send = async () => {
    if (sending.current) return
    const msg = current()
    if (msg.to.length + msg.cc.length + msg.bcc.length === 0) {
      onStatus('Add at least one recipient.', true)
      return
    }
    const bad = [...msg.to, ...msg.cc, ...msg.bcc].filter((a) => !isEmail(a.address))
    if (bad.length) {
      onStatus(`Check these addresses: ${bad.map((a) => a.address).join(', ')}`, true)
      return
    }
    if (!msg.subject.trim() && !confirm('Send this message without a subject?')) return
    sending.current = true
    window.clearTimeout(timer.current)
    await saving.current
    setState('sending')
    try {
      // Use the latest server draft (an autosave may have just finished) so it gets removed after sending
      await api.sendMessage({ ...msg, serverDraft: latest.current.serverDraft })
      dirty.current = false
      onSent()
    } catch (e) {
      sending.current = false
      setState('idle')
      onStatus(`Not sent: ${(e as Error).message}`, true)
    }
  }

  useImperativeHandle(ref, () => ({
    flush: async () => {
      if (sending.current) return
      await save()
    },
    send: () => void send(),
    saveDraft: () => {
      dirty.current = true
      void save()
    }
  }))

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const discard = async () => {
    if (!confirm('Discard this message?')) return
    sending.current = true // stops any pending autosave
    window.clearTimeout(timer.current)
    await saving.current
    await api.discardDraft(latest.current).catch(() => {})
    onClose()
  }

  const close = async () => {
    await save()
    onClose()
    if (latest.current.serverDraft) onStatus('Saved to Drafts.')
  }

  const addAttachments = (list: OutgoingAttachment[]) => {
    if (list.length) change({ attachments: [...latest.current.attachments, ...list] })
  }

  const onDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => window.bridge.pathForFile(f)).filter(Boolean)
    addAttachments(await api.attachPaths(paths).catch((err: Error) => (onStatus(err.message, true), [])))
  }

  // Pasted screenshots go into the message as images; compose.ts turns them into proper inline attachments
  const onPaste = (e: React.ClipboardEvent) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    e.preventDefault()
    for (const f of images) {
      const r = new FileReader()
      r.onload = () => {
        document.execCommand('insertImage', false, r.result as string)
        change()
      }
      r.readAsDataURL(f)
    }
  }

  const exec = (cmd: string, value?: string) => {
    editor.current?.focus()
    document.execCommand(cmd, false, value)
    change()
  }

  const from = accounts.find((a) => a.id === out.accountId)
  const total = out.attachments.reduce((n, a) => n + a.size, 0)

  return (
    <div className="compose" onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()} onDrop={onDrop}>
      <div className="compose-bar">
        <button className="primary" onClick={() => void send()} disabled={state === 'sending'} title="Send (Ctrl+Enter)">
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <button className="ghost" onClick={async () => addAttachments(await api.pickFiles())}>
          📎 Attach
        </button>
        <span className="compose-state">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Draft saved' : ''}</span>
        <span className="grow" />
        <button className="ghost" onClick={() => void discard()}>
          Discard
        </button>
        <button className="ghost" onClick={() => void close()} title="Close and keep the draft">
          ✕
        </button>
      </div>

      <div className="compose-fields">
        <div className="field">
          <span className="field-label">From</span>
          <select
            value={out.accountId}
            onChange={(e) => {
              const next = accounts.find((a) => a.id === e.target.value)!
              if (editor.current) editor.current.innerHTML = swapSignature(editor.current.innerHTML, out.inReplyTo && !next.signatureOnReplies ? undefined : next.signature)
              // The draft lives in the old account's Drafts folder; drop it there and save fresh in the new one
              if (out.serverDraft) void api.discardDraft(out).catch(() => {})
              change({ accountId: next.id, serverDraft: null })
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.senderName ? `${a.senderName} <${a.email}>` : a.email} · {a.name}
              </option>
            ))}
          </select>
        </div>
        <RecipientField
          label="To"
          value={out.to}
          onChange={(to) => change({ to })}
          extra={
            <>
              {!showCc && (
                <button className="link" onClick={() => setShowCc(true)}>
                  Cc
                </button>
              )}
              {!showBcc && (
                <button className="link" onClick={() => setShowBcc(true)}>
                  Bcc
                </button>
              )}
            </>
          }
        />
        {showCc && <RecipientField label="Cc" value={out.cc} onChange={(cc) => change({ cc })} />}
        {showBcc && <RecipientField label="Bcc" value={out.bcc} onChange={(bcc) => change({ bcc })} />}
        <div className="field">
          <input className="subject-input" placeholder="Add a subject" value={out.subject} onChange={(e) => change({ subject: e.target.value })} />
        </div>
      </div>

      {out.attachments.length > 0 && (
        <div className="attachments compose-attachments">
          {out.attachments.map((a) => (
            <span key={a.id} className="chip">
              📎 {a.filename} <small>{bytes(a.size)}</small>
              <button className="chip-x" title="Remove" onClick={() => change({ attachments: out.attachments.filter((x) => x.id !== a.id) })}>
                ×
              </button>
            </span>
          ))}
          {total > 20 * 1024 * 1024 && <small className="warn-text">Over 20 MB: many mail servers will refuse this.</small>}
        </div>
      )}

      <div className="toolbar">
        <button title="Bold (Ctrl+B)" onMouseDown={(e) => (e.preventDefault(), exec('bold'))}>
          <b>B</b>
        </button>
        <button title="Italic (Ctrl+I)" onMouseDown={(e) => (e.preventDefault(), exec('italic'))}>
          <i>I</i>
        </button>
        <button title="Underline (Ctrl+U)" onMouseDown={(e) => (e.preventDefault(), exec('underline'))}>
          <u>U</u>
        </button>
        <button title="Bulleted list" onMouseDown={(e) => (e.preventDefault(), exec('insertUnorderedList'))}>
          •≡
        </button>
        <button title="Numbered list" onMouseDown={(e) => (e.preventDefault(), exec('insertOrderedList'))}>
          1≡
        </button>
        <button
          title="Link"
          onMouseDown={(e) => {
            e.preventDefault()
            const url = prompt('Link address', 'https://')
            if (url && /^(https?:|mailto:)/i.test(url)) exec('createLink', url)
          }}
        >
          🔗
        </button>
        <input type="color" title="Text colour" onChange={(e) => exec('foreColor', e.target.value)} />
        <button title="Clear formatting" onMouseDown={(e) => (e.preventDefault(), exec('removeFormat'))}>
          T̸
        </button>
      </div>

      <div
        ref={editor}
        className="editor"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={() => change()}
        onPaste={onPaste}
      />
      {from && !from.smtp && from.kind === 'imap' && <div className="warn-text">This account has no SMTP server, so it can't send.</div>}
    </div>
  )

  function focusEditorStart() {
    const el = editor.current
    if (!el) return
    el.focus()
    const range = document.createRange()
    range.setStart(el, 0)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
})

const isEmail = (s: string) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(s)

/** "Jo <jo@x.com>; sam@y.com, ..." -> addresses */
export function parseAddresses(text: string): Address[] {
  return text
    .split(/[;,\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(p)
      return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: p }
    })
}

export function RecipientField({ label, value, onChange, extra }: { label: string; value: Address[]; onChange(v: Address[]): void; extra?: React.ReactNode }) {
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const [active, setActive] = useState(0)

  useEffect(() => {
    const t = text.trim()
    if (t.length < 2) {
      setSuggestions([])
      return
    }
    let live = true
    const h = window.setTimeout(() => {
      api.suggestContacts(t).then((s) => {
        if (!live) return
        setSuggestions(s.filter((c) => !value.some((v) => v.address.toLowerCase() === c.address)))
        setActive(0)
      })
    }, 120)
    return () => {
      live = false
      window.clearTimeout(h)
    }
  }, [text])

  const commit = (list: Address[]) => {
    const fresh = list.filter((a) => a.address && !value.some((v) => v.address.toLowerCase() === a.address.toLowerCase()))
    if (fresh.length) onChange([...value, ...fresh])
    setText('')
    setSuggestions([])
  }

  return (
    <div className="field recipients">
      <span className="field-label">{label}</span>
      <div className="chips">
        {value.map((a) => (
          <span key={a.address} className={`chip ${isEmail(a.address) ? '' : 'invalid'}`} title={a.address}>
            {a.name || a.address}
            <button className="chip-x" onClick={() => onChange(value.filter((v) => v !== a))}>
              ×
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => {
            const v = e.target.value
            // Typing a separator commits what's there
            if (/[;,]$/.test(v)) commit(parseAddresses(v))
            else setText(v)
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text')
            if (/[;,\n]/.test(t)) {
              e.preventDefault()
              commit(parseAddresses(t))
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault()
              setActive((i) => Math.min(suggestions.length - 1, i + 1))
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            } else if ((e.key === 'Enter' || e.key === 'Tab') && (suggestions.length || text.trim())) {
              // Tab commits and then moves on to the next field as usual
              if (e.key === 'Enter') e.preventDefault()
              commit(suggestions.length ? [suggestions[active]] : parseAddresses(text))
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
            else if (e.key === 'Escape' && suggestions.length) {
              e.stopPropagation()
              setSuggestions([])
            }
          }}
          onBlur={() => text.trim() && commit(parseAddresses(text))}
        />
      </div>
      {extra}
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((c, i) => (
            <div
              key={c.address}
              className={`suggestion ${i === active ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                commit([c])
              }}
            >
              {whoFull(c)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
