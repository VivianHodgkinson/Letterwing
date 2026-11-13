import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { api, on } from '../api'

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    api.getUpdateStatus().then(setStatus, () => {})
    return on('update:status', (s) => setStatus(s as UpdateStatus))
  }, [])
  return status
}

/** Top-bar button; only shown when there's something to act on */
export function UpdatePill() {
  const status = useUpdateStatus()
  if (!status) return null
  const pill = (label: string, title: string) => (
    <button className="update-pill" title={title} onClick={() => void api.installUpdate()}>
      {label}
    </button>
  )
  if (status.state === 'ready') return pill('↻ Restart to update', `Version ${status.version} has been downloaded`)
  if (status.state === 'available') return pill(`⤓ v${status.version} available`, status.assetName ? `Download ${status.assetName}` : 'Open the release page')
  if (status.state === 'downloaded') return pill(`✓ Install v${status.version}`, `Open ${status.file}`)
  if (status.state === 'downloading') return <span className="update-pill quiet">Updating {status.progress ?? 0}%</span>
  return null
}

function describe(s: UpdateStatus): string {
  if (s.mode === 'disabled') return 'Updates are off in development builds.'
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading version ${s.version}… ${s.progress ?? 0}%`
    case 'ready':
      return `Version ${s.version} is ready. Restart to install it.`
    case 'available':
      return s.error ?? (s.assetName ? `Version ${s.version} is available: ${s.assetName}.` : `Version ${s.version} is available on the release page.`)
    case 'downloaded':
      return `Version ${s.version} downloaded to ${s.file}. Open it to install, or run the command below.`
    case 'up-to-date':
      return `You're up to date.${s.lastChecked ? ` Last checked ${new Date(s.lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}`
    case 'error':
      return `Couldn't check for updates: ${s.error}`
    default:
      return s.mode === 'auto' ? 'Updates download in the background and install when you restart.' : "You'll be told when a new version is released."
  }
}

export function UpdateSettings({ autoUpdate, onAutoUpdate }: { autoUpdate: boolean; onAutoUpdate(v: boolean): void }) {
  const status = useUpdateStatus()
  if (!status) return null
  const busy = status.state === 'checking' || status.state === 'downloading'
  return (
    <>
      <div className="row">
        <span className="grow">
          Letterwing <b>{status.currentVersion}</b>
          {status.releaseUrl && status.version && (
            <button className="link" style={{ marginLeft: 10 }} onClick={() => void api.openReleasePage()}>
              What's new in {status.version}
            </button>
          )}
        </span>
        {status.state === 'downloaded' ? (
          <>
            <button className="ghost small" onClick={() => void api.showUpdateFile()}>
              Show in folder
            </button>
            <button className="primary" onClick={() => void api.installUpdate()}>
              Open installer
            </button>
          </>
        ) : status.state === 'ready' || status.state === 'available' ? (
          <button className="primary" onClick={() => void api.installUpdate()}>
            {status.state === 'ready' ? 'Restart & update' : status.assetName ? `Download ${status.version}` : 'Open release page'}
          </button>
        ) : (
          <button className="ghost small" disabled={busy || status.mode === 'disabled'} onClick={() => void api.checkForUpdates()}>
            {busy ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
      <p className="hint" style={status.state === 'error' ? { color: 'var(--danger)' } : undefined}>
        {describe(status)}
      </p>
      {status.state === 'downloaded' && status.installCommand && (
        <div className="row">
          <input className="grow" readOnly value={status.installCommand} onFocus={(e) => e.target.select()} />
          <button className="ghost small" onClick={() => void navigator.clipboard.writeText(status.installCommand!)}>
            Copy
          </button>
        </div>
      )}
      {status.mode !== 'disabled' && (
        <label className="check">
          <input type="checkbox" checked={autoUpdate} onChange={(e) => onAutoUpdate(e.target.checked)} />
          Check for updates automatically
        </label>
      )}
    </>
  )
}
