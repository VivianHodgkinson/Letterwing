import { useState } from 'react'

interface Props {
  title: string
  label: string
  initial?: string
  ok: string
  /** Throwing keeps the dialog open and shows the error, so a refused name can be fixed */
  onSubmit(value: string): Promise<void>
  onClose(): void
}

/** Asks for one line of text, such as a folder name */
export function PromptDialog({ title, label, initial = '', ok, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value.trim())
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog prompt-dialog">
        <h2>{title}</h2>
        <label>
          {label}
          <input
            autoFocus
            value={value}
            disabled={busy}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              else if (e.key === 'Escape' && !busy) onClose()
              else return
              e.preventDefault()
            }}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !value.trim() || value.trim() === initial}>
            {busy ? 'Working…' : ok}
          </button>
        </div>
      </div>
    </div>
  )
}
