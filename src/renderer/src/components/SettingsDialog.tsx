import { useEffect, useRef, useState } from 'react'
import type { Account, Settings } from '@shared/types'
import { KeybindingsEditor } from './KeybindingsEditor'
import { UpdateSettings } from './Updates'
import { api } from '../api'
import { blockEntry } from '@shared/blocking'

interface Props {
  settings: Settings
  accounts: Account[]
  onChange(patch: Partial<Settings>): Promise<void>
  onAccountChange(id: string, patch: Partial<Account>): Promise<void>
  onRemoveAccount(id: string): Promise<void>
  onClose(): void
  /** Open on this tab instead of General */
  initialTab?: 'general' | 'theme' | 'keyboard' | 'accounts' | 'calendars'
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

/** Starting points for each mode; "Standard" is the built-in palette */
const PRESETS: Record<'dark' | 'light', Record<string, Record<string, string>>> = {
  dark: {
    Standard: {},
    Verdigris: {
      '--accent': '#3ddc84',
      '--bg-0': '#080c0a',
      '--bg-1': '#0d1411',
      '--bg-2': '#18241f',
      '--bg-3': '#1f2e27',
      '--border': '#1f2c26',
      '--unread': '#3ddc84'
    }
  },
  light: {
    Standard: {},
    Verdigris: {
      '--accent': '#1e9e57',
      '--unread': '#1e9e57',
      '--bg-1': '#f3f8f5',
      '--bg-2': '#e5eee8',
      '--bg-3': '#d8e5dc',
      '--border': '#d3e0d7'
    }
  }
}

export function SettingsDialog({ settings, accounts, onChange, onAccountChange, onRemoveAccount, onClose, initialTab }: Props) {
  // Custom colours belong to a mode: the Theme tab edits the set for the mode showing now
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const varsKey = dark ? 'themeVars' : 'themeVarsLight'
  const themeVars = settings[varsKey]
  const [raw, setRaw] = useState(JSON.stringify(themeVars, null, 2))
  const [rawError, setRawError] = useState<string | null>(null)
  const [tab, setTab] = useState<'general' | 'theme' | 'keyboard' | 'accounts' | 'calendars'>(initialTab ?? 'general')
  const css = getComputedStyle(document.documentElement)

  const setVar = (k: string, v: string) => {
    const next = { ...themeVars, [k]: v }
    setRaw(JSON.stringify(next, null, 2))
    void onChange({ [varsKey]: next })
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
                Layout
                <select value={settings.layout} onChange={(e) => void onChange({ layout: e.target.value as Settings['layout'] })}>
                  <option value="auto">Fit the window</option>
                  <option value="wide">Always wide</option>
                  <option value="medium">Always medium (folders in a drawer)</option>
                  <option value="narrow">Always narrow (one pane at a time)</option>
                </select>
              </label>
              <label>
                Appearance
                <select value={settings.theme} onChange={(e) => void onChange({ theme: e.target.value as Settings['theme'] })}>
                  <option value="system">Match system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
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
            <label>
              Email colours
              <select value={settings.mailColors} onChange={(e) => void onChange({ mailColors: e.target.value as Settings['mailColors'] })}>
                <option value="theme">Match my theme (dark mode makes emails dark too)</option>
                <option value="original">As the sender designed them</option>
              </select>
            </label>
            <label>
              Mark messages as read
              <select value={settings.markRead} onChange={(e) => void onChange({ markRead: e.target.value as Settings['markRead'] })}>
                <option value="leave">When I move off them</option>
                <option value="open">As soon as I open them</option>
                <option value="delay">After 5 seconds</option>
                <option value="manual">Only when I mark them (Ctrl+Q)</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.notifications} onChange={(e) => void onChange({ notifications: e.target.checked })} />
              Desktop notification for new mail
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.closeToTray} onChange={(e) => void onChange({ closeToTray: e.target.checked })} />
              Keep running in the tray when the window is closed (new mail and reminders keep coming)
            </label>
            <h3>Blocked senders</h3>
            <BlockedSenders list={settings.blockedSenders} onChange={onChange} />
            <h3>Mail links</h3>
            <DefaultMailApp />
            <h3>Updates</h3>
            <UpdateSettings autoUpdate={settings.autoUpdate} onAutoUpdate={(v) => void onChange({ autoUpdate: v })} />
          </>
        )}

        {tab === 'theme' && (
          <>
            <p className="hint">
              These colours are for {dark ? 'dark' : 'light'} mode. Switch modes with the {dark ? '☀' : '☾'} button at the top right to change the other set.
            </p>
            <h3>Presets</h3>
            <div className="presets">
              {Object.entries(PRESETS[dark ? 'dark' : 'light']).map(([name, vars]) => (
                <button
                  key={name}
                  className="ghost"
                  onClick={() => {
                    setRaw(JSON.stringify(vars, null, 2))
                    void onChange({ [varsKey]: vars })
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="theme-grid">
              {THEME_VARS.map(([k, label]) => (
                <label key={k} className="theme-var">
                  <input type="color" value={toHex(themeVars[k] ?? css.getPropertyValue(k).trim())} onChange={(e) => setVar(k, e.target.value)} />
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
                    void onChange({ [varsKey]: parsed })
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
            <details className="advanced">
              <summary>Advanced: use your own sign-in app registration</summary>
              <p className="hint">Leave these empty to use the sign-in built into Letterwing. Only for testing a different Microsoft or Google app registration.</p>
              <div className="row">
                <label className="grow">
                  Microsoft app (client) ID
                  <input value={settings.microsoftClientId} onChange={(e) => void onChange({ microsoftClientId: e.target.value.trim() })} />
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
            </details>
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
  const [sigError, setSigError] = useState<string | null>(null)
  const saveSig = () => void onChange({ signature: sig.current?.innerHTML ?? '' })

  /** Put a picture where the cursor is (or at the end), no wider than a signature should be, and save */
  const insertPicture = async (url: string) => {
    const el = sig.current
    if (!el) return
    setSigError(null)
    const size = await new Promise<{ w: number }>((resolve) => {
      const probe = new Image()
      probe.onload = () => resolve({ w: probe.naturalWidth })
      probe.onerror = () => resolve({ w: 0 })
      probe.src = url
    })
    const img = document.createElement('img')
    img.src = url
    img.alt = ''
    if (size.w > 500) img.width = 500
    const sel = window.getSelection()
    if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(img)
    } else el.appendChild(img)
    saveSig()
  }

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
            Signature <small>(paste your existing signature to keep its formatting and logo)</small>
          </label>
          <div
            ref={sig}
            className="editor signature-editor"
            contentEditable
            suppressContentEditableWarning
            onBlur={saveSig}
            onPaste={(e) => {
              const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
              if (!file) return
              e.preventDefault()
              void fileToDataUrl(file)
                .then(insertPicture)
                .catch((err: Error) => setSigError(err.message))
            }}
            onDrop={(e) => {
              const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
              if (!file) return
              e.preventDefault()
              void fileToDataUrl(file)
                .then(insertPicture)
                .catch((err: Error) => setSigError(err.message))
            }}
          />
          <div className="row">
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                void api
                  .pickImage()
                  .then((url) => {
                    if (url) void insertPicture(url)
                  })
                  .catch((e: Error) => setSigError(e.message))
              }
            >
              Add picture…
            </button>
            <span className="hint">A logo, or a whole signature made as a picture. You can also paste or drag one in.</span>
          </div>
          {sigError && <div className="error">{sigError}</div>}
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

/** Make clicking an email address anywhere (browser, documents) open a new message here */
function DefaultMailApp() {
  const [status, setStatus] = useState<{ isDefault: boolean; canSet: boolean } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    void api.mailAppStatus().then(setStatus)
  }, [])
  if (!status) return null
  if (status.isDefault) return <p className="hint">Letterwing opens email links (mailto:) on this computer.</p>
  return (
    <div className="row">
      <button
        className="ghost"
        disabled={!status.canSet}
        onClick={async () => {
          const ok = await api.setDefaultMailApp()
          setStatus(await api.mailAppStatus())
          setNote(ok ? null : "Your system didn't let Letterwing change this itself. Choose Letterwing as the email app in your system's default apps settings.")
        }}
      >
        Make Letterwing my default mail app
      </button>
      {!status.canSet && <span className="hint">Available in the installed app.</span>}
      {note && <span className="hint">{note}</span>}
    </div>
  )
}

/** Addresses and domains whose mail goes straight to Junk */
function BlockedSenders({ list, onChange }: { list: string[]; onChange(patch: Partial<Settings>): Promise<void> }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    const entry = blockEntry(input)
    if (!entry) return setError('Type an email address (jo@example.com) or a domain (example.com).')
    setError(null)
    try {
      await api.blockSender(entry)
      setInput('')
      await onChange({})
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <p className="hint">
        Mail from these goes to Junk as it arrives, while Letterwing is running. Blocking an address from a Microsoft 365 message (right-click → Block) also
        adds it to Microsoft's own blocked list, which works on every device; unblock it there in your Microsoft 365 web mail's junk email settings, or with
        Not junk on one of its messages.
      </p>
      {list.length > 0 && (
        <div className="blocked-list">
          {list.map((b) => (
            <span key={b} className="chip">
              {b}
              <button className="chip-x" title={`Unblock ${b}`} onClick={() => void api.unblockSender(b).then(() => onChange({}))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <input
          placeholder="Block an address or domain"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
        />
        <button className="ghost" onClick={() => void add()} disabled={!input.trim()}>
          Block
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 1_500_000) return reject(new Error('That picture is over 1.5 MB. Use a smaller one.'))
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
