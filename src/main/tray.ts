import { app, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Bundled icons: resources/icons in development, <resources>/icons in a packaged app (extraResources) */
export function iconPath(size: number): string | undefined {
  const base = app.isPackaged ? join(process.resourcesPath, 'icons') : join(__dirname, '../../resources/icons')
  const p = join(base, `${size}x${size}.png`)
  return existsSync(p) ? p : undefined
}

let tray: Tray | null = null

/**
 * Tray icon, so Letterwing keeps checking mail and showing reminders with the window closed (like
 * Classic in the notification area). On Linux this needs a tray (StatusNotifier) host: KDE, GNOME
 * with the AppIndicator extension, or waybar's tray module under Hyprland.
 */
export function createTray(actions: { show(): void; newMessage(): void; sync(): void; quit(): void }): void {
  if (tray) return
  const icon = iconPath(process.platform === 'darwin' ? 16 : 32)
  if (!icon) return
  tray = new Tray(nativeImage.createFromPath(icon))
  tray.setToolTip('Letterwing')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Letterwing', click: actions.show },
      { label: 'New message', click: actions.newMessage },
      { label: 'Send / receive', click: actions.sync },
      { type: 'separator' },
      { label: 'Quit Letterwing', click: actions.quit }
    ])
  )
  tray.on('click', actions.show)
}

export function setTrayUnread(count: number): void {
  tray?.setToolTip(count ? `Letterwing · ${count} unread` : 'Letterwing')
}

export const hasTray = (): boolean => tray !== null
