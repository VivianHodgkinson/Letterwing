import { useState } from 'react'
import { PALETTE } from '@shared/types'

interface Props {
  title: string
  initial?: string
  onPick(color: string): void
  onClose(): void
}

/** Pick any colour: the usual swatches plus the system colour picker */
export function ColorDialog({ title, initial, onPick, onClose }: Props) {
  const [color, setColor] = useState(initial && /^#[0-9a-f]{6}$/i.test(initial) ? initial : PALETTE[4].color)
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog color-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter') onPick(color)
        }}
      >
        <h2>{title}</h2>
        <div className="swatches">
          {PALETTE.map((p) => (
            <button key={p.color} className={`swatch ${p.color === color ? 'on' : ''}`} style={{ background: p.color }} title={p.name} onClick={() => setColor(p.color)} />
          ))}
        </div>
        <label className="check">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} autoFocus />
          Any colour
        </label>
        <div className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onPick(color)}>
            Use colour
          </button>
        </div>
      </div>
    </div>
  )
}
