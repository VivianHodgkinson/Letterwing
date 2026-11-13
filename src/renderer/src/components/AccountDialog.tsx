import { useState } from 'react'
import type { AccountKind, NewAccount, ServerSettings } from '@shared/types'
import { api } from '../api'

interface Props {
  onClose(): void
  onAdded(): void
}

const COLOURS = ['#1E88E5', '#8E24AA', '#2E7D32', '#E65100', '#C62828', '#00838F', '#6D4C41', '#546E7A']

/** Guess IMAP/SMTP servers from the domain; the user can override everything */
function guessServers(email: string): { imap: ServerSettings; smtp: ServerSettings } {
  const domain = email.split('@')[1] ?? ''
  return { imap: { host: domain ? `mail.${domain}` : '', port: 993, security: 'tls' }, smtp: { host: domain ? `mail.${domain}` : '', port: 465, security: 'tls' } }
}

export function AccountDialog({ onClose, onAdded }: Props) {
  const [kind, setKind] = useState<AccountKind>('microsoft')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(COLOURS[0])
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [tenant, setTenant] = useState('organizations')
  const [servers, setServers] = useState<{ imap: ServerSettings; smtp: ServerSettings } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const srv = servers ?? guessServers(email)
  const domain = email.split('@')[1] ?? ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const acc: NewAccount = {
      kind,
      email: email.trim(),
      name: name.trim() || domain || email,
      label: (label.trim() || (name || domain).slice(0, 3)).toUpperCase(),
      color,
      auth: kind === 'imap' ? 'password' : 'oauth',
      ...(kind === 'imap' ? { imap: srv.imap, smtp: srv.smtp, password, username: username.trim() || undefined } : {}),
      ...(kind === 'microsoft' ? { tenant: tenant.trim() || 'organizations' } : {})
    }
    try {
      await api.addAccount(acc)
      onAdded()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const server = (which: 'imap' | 'smtp') => (
    <fieldset>
      <legend>{which === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}</legend>
      <div className="row">
        <input placeholder="host" value={srv[which].host} onChange={(e) => setServers({ ...srv, [which]: { ...srv[which], host: e.target.value } })} required />
        <input
          className="port"
          type="number"
          value={srv[which].port}
          onChange={(e) => setServers({ ...srv, [which]: { ...srv[which], port: Number(e.target.value) } })}
        />
        <select value={srv[which].security} onChange={(e) => setServers({ ...srv, [which]: { ...srv[which], security: e.target.value as ServerSettings['security'] } })}>
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None</option>
        </select>
      </div>
    </fieldset>
  )

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog" onSubmit={submit}>
        <h2>Add account</h2>
        <div className="tabs">
          {(
            [
              ['microsoft', 'Microsoft 365'],
              ['google', 'Google'],
              ['imap', 'Other (IMAP)']
            ] as const
          ).map(([k, l]) => (
            <button type="button" key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>

        <label>
          Email address
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <div className="row">
          <label className="grow">
            Display name
            <input placeholder={domain || 'Work'} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Badge
            <input className="badge-input" maxLength={4} placeholder="ISS" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
        </div>
        <div className="swatches">
          {COLOURS.map((c) => (
            <button type="button" key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Custom colour" />
        </div>

        {kind === 'microsoft' && (
          <label>
            Tenant <small>(organizations, a tenant domain or ID; use "common" for personal Microsoft accounts)</small>
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} />
          </label>
        )}
        {kind !== 'imap' && <p className="hint">Your browser will open so you can sign in. Inkwell never sees your password.</p>}

        {kind === 'imap' && (
          <>
            <label>
              Password <small>(stored in your system keyring)</small>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <label>
              User name <small>(only if it isn't your email address)</small>
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            {server('imap')}
            {server('smtp')}
          </>
        )}

        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? (kind === 'imap' ? 'Connecting…' : 'Waiting for sign-in…') : kind === 'imap' ? 'Connect' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  )
}
