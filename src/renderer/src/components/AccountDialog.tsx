import { useState } from 'react'
import type { AccountKind, NewAccount, ServerSettings } from '@shared/types'
import { api } from '../api'

interface Props {
  onClose(): void
  onAdded(): void
}

const COLOURS = ['#1E88E5', '#8E24AA', '#2E7D32', '#E65100', '#C62828', '#00838F', '#6D4C41', '#546E7A']

type Detected = Awaited<ReturnType<typeof api.detectProvider>>

const PROVIDER: Record<AccountKind, string> = { google: 'Google', microsoft: 'Microsoft', imap: 'your mail provider' }

/**
 * Add an account: type your address, Letterwing works out who hosts it,
 * and Google / Microsoft accounts sign in through the browser. Server settings only appear
 * for other providers (or if you ask for them).
 */
export function AccountDialog({ onClose, onAdded }: Props) {
  const [email, setEmail] = useState('')
  const [senderName, setSenderName] = useState('')
  const [detected, setDetected] = useState<Detected | null>(null)
  const [kind, setKind] = useState<AccountKind>('imap')
  const [manual, setManual] = useState(false)
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(COLOURS[0])
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [servers, setServers] = useState<{ imap: ServerSettings; smtp: ServerSettings } | null>(null)
  const [busy, setBusy] = useState<'detecting' | 'signing-in' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const domain = email.split('@')[1] ?? ''
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  async function detect(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy('detecting')
    setError(null)
    try {
      const d = await api.detectProvider(email.trim())
      setDetected(d)
      setKind(d.kind)
      if (d.imap && d.smtp) setServers({ imap: d.imap, smtp: d.smtp })
      // A sensible label and colour: the company part of the domain
      const company = domain.split('.')[0]
      if (!name) setName(d.kind === 'google' && domain === 'gmail.com' ? 'Gmail' : company.charAt(0).toUpperCase() + company.slice(1))
      if (!label) setLabel((domain === 'gmail.com' ? 'GML' : company.slice(0, 3)).toUpperCase())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy('signing-in')
    setError(null)
    const acc: NewAccount = {
      kind,
      email: email.trim(),
      name: name.trim() || domain,
      label: (label.trim() || domain.slice(0, 3)).toUpperCase().slice(0, 4),
      color,
      senderName: senderName.trim() || undefined,
      auth: kind === 'imap' ? 'password' : 'oauth',
      ...(kind === 'imap' && servers ? { imap: servers.imap, smtp: servers.smtp, password, username: username.trim() || undefined } : {})
    }
    try {
      await api.addAccount(acc)
      onAdded()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const srv = servers ?? { imap: { host: `mail.${domain}`, port: 993, security: 'tls' as const }, smtp: { host: `mail.${domain}`, port: 465, security: 'tls' as const } }
  const server = (which: 'imap' | 'smtp') => (
    <fieldset>
      <legend>{which === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}</legend>
      <div className="row">
        <input placeholder="host" value={srv[which].host} onChange={(e) => setServers({ ...srv, [which]: { ...srv[which], host: e.target.value } })} required />
        <input className="port" type="number" value={srv[which].port} onChange={(e) => setServers({ ...srv, [which]: { ...srv[which], port: Number(e.target.value) } })} />
        <select value={srv[which].security} onChange={(e) => setServers({ ...srv, [which]: { ...srv[which], security: e.target.value as ServerSettings['security'] } })}>
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None</option>
        </select>
      </div>
    </fieldset>
  )

  // Step 1: just the address
  if (!detected)
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <form className="dialog" onSubmit={detect}>
          <h2>Add account</h2>
          <label>
            Email address
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.co.za" required autoFocus />
          </label>
          <label>
            Your name <small>(what people see when you send)</small>
            <input placeholder="e.g. Jo Bloggs" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="actions">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={!valid || !!busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    )

  const oauth = kind !== 'imap'
  const unavailable = oauth && kind === detected.kind && !detected.signInAvailable

  // Step 2: sign in (Google / Microsoft) or server details (anything else)
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog" onSubmit={add}>
        <h2>{email}</h2>
        {!manual && (
          <p className="hint">
            {kind === detected.kind ? `${detected.reason}.` : ''}{' '}
            <button type="button" className="link" onClick={() => setManual(true)}>
              Not right?
            </button>
          </p>
        )}
        {manual && (
          <div className="tabs">
            {(
              [
                ['microsoft', 'Microsoft 365 / Microsoft account'],
                ['google', 'Google'],
                ['imap', 'Other (IMAP)']
              ] as const
            ).map(([k, l]) => (
              <button type="button" key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
        )}

        {oauth && (
          <>
            <p className="signin-blurb">
              Your browser opens so you can sign in with {PROVIDER[kind]}, including two-step verification. Letterwing never sees your password; it gets a
              revocable token, kept in your system keyring.
            </p>
            {unavailable && (
              <div className="error">This copy of Letterwing wasn't built with {PROVIDER[kind]} sign-in yet. Whoever builds it sets that up once (docs/SETUP.md).</div>
            )}
          </>
        )}

        {kind === 'imap' && (
          <>
            <label>
              Password <small>(or app password; stored in your system keyring)</small>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </label>
            <details open={manual}>
              <summary>Server settings</summary>
              <label>
                User name <small>(only if it isn't your email address)</small>
                <input value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              {server('imap')}
              {server('smtp')}
            </details>
          </>
        )}

        <details>
          <summary>How it looks in Letterwing</summary>
          <div className="row">
            <label className="grow">
              Account label
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Badge
              <input className="badge-input" maxLength={4} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>
          <div className="swatches">
            {COLOURS.map((c) => (
              <button type="button" key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Custom colour" />
          </div>
        </details>

        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={() => (busy ? undefined : setDetected(null))} disabled={!!busy}>
            Back
          </button>
          <button className={`primary ${oauth ? `signin ${kind}` : ''}`} disabled={!!busy || unavailable}>
            {busy ? (oauth ? 'Waiting for you in the browser…' : 'Connecting…') : oauth ? `Sign in with ${PROVIDER[kind]}` : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  )
}
