import type { MenuItem } from '@shared/api'
import { PALETTE } from '@shared/types'

/** The Colour submenu for folders and calendars. Picks come back as "color:#rrggbb", "color:custom" or "color:none". */
export function colourMenu(current: string | undefined, noneLabel = 'No colour'): MenuItem[] {
  const cur = current?.toLowerCase()
  const custom = !!cur && !PALETTE.some((p) => p.color === cur)
  return [
    ...PALETTE.map((p) => ({ id: `color:${p.color}`, label: `${p.swatch}  ${p.name}`, checked: cur === p.color })),
    { type: 'separator' },
    { id: 'color:custom', label: 'Custom colour…', checked: custom },
    { id: 'color:none', label: noneLabel, enabled: !!cur }
  ]
}
