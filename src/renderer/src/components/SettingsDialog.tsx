import { useEffect, useRef, useState } from 'react'
import type { Account, Settings } from '@shared/types'
import { KeybindingsEditor } from './KeybindingsEditor'

interface Props {
  settings: Settings
  accounts: Account[]
  onChange(patch: Partial<Settings>): Promise<void>
  onAccountChange(id: string, patch: Partial<Account>): Promise<void>
  onRemoveAccount(id: string): Promise<void>
  onClose(): void
}

/** Variables exposed in the theme editor. Anything in styles.css :root can also be set via the raw JSON box. */
const THEME_VARS: [string, string][] = [
  ['--accent', 'Accent'],
  ['--bg-0', 'Window background'],
  ['--bg-1', 'Panels'],
  ['--bg-2', 'Hover / selection'],
  ['--text', 'Text'],
  ['--text-dim', 'Secondary text'],
  ['--unread', 'Unread marker']
]

const PRESETS: Record<string, Record<string, string>> = {
  Ink: {},
  Daylight: {
    '--bg-0': '#f4f5f7',
    '--bg-1': '#ffffff',
    '--bg-2': '#e8ebf0',
    '--bg-3': '#dde1e8',
    '--text': '#1a1d24',
    '--text-dim': '#5b6270',
    '--text-faint': '#8a91a0',
    '--border': '#dfe3ea'
  },
  Verdigris: {
    '--accent': '#3ddc84',
    '--bg-0': '#080c0a',
    '--bg-1': '#0d1411',
    '--bg-2': '#18241f',
    '--bg-3': '#1f2e27',
    '--border': '#1f2c26',
    '--unread': '#3ddc84'
  },
  Ember: { '--accent': '#ff8a3d', '--bg-0': '#120d0a', '--bg-1': '#1a1310', '--bg-2': '#2a1e18', '--unread': '#ff8a3d' }
}

export function SettingsDialog({ settings, accounts, onChange, onAccountChange, onRemoveAccount, onClose }: Props) {
  const [raw, setRaw] = useState(JSON.stringify(settings.themeVars, null, 2))
  const [rawError, setRawError] = useState<string | null>(null)
  const [tab, setTab] = useState<'general' | 'theme' | 'keyboard' | 'accounts' | 'calendars'>('general')
  const css = getComputedStyle(document.documentElement)

  const setVar = (k: string, v: string) => {
    const next = { ...settings.themeVars, [k]: v }
    setRaw(JSON.stringify(next, null, 2))
    void onChange({ themeVars: next })
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide">
        <h2>Settings</h2>
        <div className="tabs">
          {(
            [
              ['general', 'General'],
              ['theme', 'Theme'],
              ['keyboard', 'Keyboard'],
              ['accounts', 'Accounts'],
              ['calendars', 'Calendars']
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>

        {tab === 'general' && (
          <>
            <h3>Layout</h3>
            <div className="row">
              <label>
                Reading pane
                <select value={settings.readingPane} onChange={(e) => void onChange({ readingPane: e.target.value as Settings['readingPane'] })}>
                  <option value="right">Right</option>
                  <option value="bottom">Bottom</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label>
                Density
                <select value={settings.density} onChange={(e) => void onChange({ density: e.target.value as Settings['density'] })}>
                  <option value="compact">Compact</option>
                  <option value="comfortable">Comfortable</option>
                  <option value="spacious">Spacious</option>
                </select>
              </label>
              <label>
                Sync every (min)
                <input
                  type="number"
                  min={1}
                  value={settings.syncInterval}
                  onChange={(e) => void onChange({ syncInterval: Math.max(1, Number(e.target.value)) })}
                />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={settings.loadRemoteImages} onChange={(e) => void onChange({ loadRemoteImages: e.target.checked })} />
              Always load remote images (lets senders see when you open their mail)
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.conversations} onChange={(e) => void onChange({ conversations: e.target.checked })} />
              Show messages as conversations
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.notifications} onChange={(e) => void onChange({ notifications: e.target.checked })} />
              Desktop notification for new mail
            </label>
          </>
        )}

        {tab === 'theme' && (
          <>
            <h3>Presets</h3>
            <div className="presets">
              {Object.entries(PRESETS).map(([name, vars]) => (
                <button
                  key={name}
                  className="ghost"
                  onClick={() => {
                    setRaw(JSON.stringify(vars, null, 2))
                    void onChange({ themeVars: vars })
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="theme-grid">
              {THEME_VARS.map(([k, label]) => (
                <label key={k} className="theme-var">
                  <input type="color" value={toHex(settings.themeVars[k] ?? css.getPropertyValue(k).trim())} onChange={(e) => setVar(k, e.target.value)} />
                  {label}
                </label>
              ))}
            </div>
            <details>
              <summary>Advanced: raw CSS variables</summary>
              <textarea
                className="raw"
                spellCheck={false}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                onBlur={() => {
                  try {
                    const parsed = JSON.parse(raw || '{}') as Record<string, string>
                    setRawError(null)
                    void onChange({ themeVars: parsed })
                  } catch (e) {
                    setRawError((e as Error).message)
                  }
                }}
              />
              {rawError && <div className="error">{rawError}</div>}
            </details>
          </>
        )}

        {tab === 'keyboard' && <KeybindingsEditor settings={settings} onChange={onChange} />}

        {tab === 'calendars' && <CalendarSettings settings={settings} onChange={onChange} />}

        {tab === 'accounts' && (
          <>
            <h3>Accounts</h3>
            {accounts.map((a) => (
              <AccountSettings key={a.id} account={a} onChange={(patch) => onAccountChange(a.id, patch)} onRemove={() => onRemoveAccount(a.id)} />
            ))}
            <h3>Sign-in apps</h3>
            <div className="row">
              <label className="grow">
                Microsoft app (client) ID
                <input
                  value={settings.microsoftClientId}
                  placeholder="from your Entra app registration"
                  onChange={(e) => void onChange({ microsoftClientId: e.target.value.trim() })}
                />
              </label>
            </div>
            <div className="row">
              <label className="grow">
                Google OAuth client ID
                <input value={settings.googleClientId} onChange={(e) => void onChange({ googleClientId: e.target.value.trim() })} />
              </label>
              <label className="grow">
                Google client secret
                <input type="password" value={settings.googleClientSecret} onChange={(e) => void onChange({ googleClientSecret: e.target.value.trim() })} />
              </label>
            </div>
          </>
        )}

        <div className="actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountSettings({ account: a, onChange, onRemove }: { account: Account; onChange(patch: Partial<Account>): Promise<void>; onRemove(): void }) {
  const [open, setOpen] = useState(false)
  const [senderName, setSenderName] = useState(a.senderName ?? '')
  const sig = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && sig.current) sig.current.innerHTML = a.signature ?? ''
  }, [open])

  return (
    <div className="account-block">
      <div className="account-row">
        <span className="badge small" style={{ ['--acct' as string]: a.color }}>
          {a.label}
        </span>
        <span className="grow">
          {a.name} <small>{a.email}</small>
        </span>
        <button className="ghost small" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Name & signature'}
        </button>
        <button
          className="ghost small danger"
          onClick={() => {
            if (confirm(`Remove ${a.name}? Its local cache is deleted; nothing on the server changes.`)) onRemove()
          }}
        >
          Remove
        </button>
      </div>
      {open && (
        <div className="account-detail">
          <label>
            Your name (what recipients see)
            <input value={senderName} placeholder="e.g. Jo Bloggs" onChange={(e) => setSenderName(e.target.value)} onBlur={() => void onChange({ senderName: senderName.trim() })} />
          </label>
          <label>
            Signature <small>(paste from Classic or Word to keep formatting and logos)</small>
          </label>
          <div ref={sig} className="editor signature-editor" contentEditable suppressContentEditableWarning onBlur={() => void onChange({ signature: sig.current?.innerHTML ?? '' })} />
          <label className="check">
            <input type="checkbox" checked={!!a.signatureOnReplies} onChange={(e) => void onChange({ signatureOnReplies: e.target.checked })} />
            Also add it to replies and forwards
          </label>
          {a.kind === 'imap' && (
            <label>
              Calendar (CalDAV) address <small>(optional; uses the same login)</small>
              <input
                defaultValue={a.caldavUrl ?? ''}
                placeholder="e.g. https://caldav.fastmail.com/ · https://caldav.icloud.com/ · https://cloud.example.com/remote.php/dav"
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v !== (a.caldavUrl ?? '')) void onChange({ caldavUrl: v || undefined })
                }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  )
}

const SUB_COLOURS = ['#4cc38a', '#e6c84f', '#e07ab8', '#3cc0c0', '#f0a04b', '#9a7cf0']

function CalendarSettings({ settings, onChange }: { settings: Settings; onChange(patch: Partial<Settings>): Promise<void> }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const hours = Array.from({ length: 25 }, (_, h) => h)
  return (
    <>
      <h3>Working hours</h3>
      <div className="row">
        <label>
          Day starts
          <select value={settings.workDayStart} onChange={(e) => void onChange({ workDayStart: Number(e.target.value) })}>
            {hours.slice(0, 24).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
        <label>
          Day ends
          <select value={settings.workDayEnd} onChange={(e) => void onChange({ workDayEnd: Number(e.target.value) })}>
            {hours.slice(1).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
        <label>
          Reminders
          <select value={settings.reminderMinutes} onChange={(e) => void onChange({ reminderMinutes: Number(e.target.value) })}>
            {[0, 5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Off' : `${m} minutes before`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3>Subscribed calendars</h3>
      <p className="hint">Read-only calendars from a link: public holidays, sports fixtures, someone's published calendar (.ics or webcal://).</p>
      {settings.icsSubscriptions.map((s) => (
        <div key={s.id} className="account-row">
          <span className="swatch on" style={{ background: s.color }} />
          <span className="grow">
            {s.name} <small>{s.url}</small>
          </span>
          <button className="ghost small danger" onClick={() => void onChange({ icsSubscriptions: settings.icsSubscriptions.filter((x) => x.id !== s.id) })}>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <input placeholder="Name, e.g. SA public holidays" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="grow" placeholder="https://… .ics or webcal://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button
          className="ghost"
          disabled={!/^(https?|webcals?):\/\//i.test(url.trim())}
          onClick={() => {
            const subs = settings.icsSubscriptions
            void onChange({
              icsSubscriptions: [...subs, { id: crypto.randomUUID(), name: name.trim() || 'Subscribed calendar', url: url.trim(), color: SUB_COLOURS[subs.length % SUB_COLOURS.length] }]
            })
            setName('')
            setUrl('')
          }}
        >
          Subscribe
        </button>
      </div>
    </>
  )
}

/** <input type=color> only takes #rrggbb */
function toHex(v: string): string {
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map((c) => c + c).join('')
  const c = document.createElement('canvas').getContext('2d')!
  c.fillStyle = v || '#000'
  return /^#[0-9a-f]{6}$/i.test(c.fillStyle) ? c.fillStyle : '#000000'
}
