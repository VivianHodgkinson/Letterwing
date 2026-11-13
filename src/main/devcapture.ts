import { app, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

/**
 * Development aid, off unless INKWELL_CAPTURE is set: runs steps against a hidden window and
 * saves screenshots, so UI changes can be checked without clicking through by hand.
 *   INKWELL_PROFILE=/tmp/p  INKWELL_CAPTURE=/tmp/shots  INKWELL_STEPS='[["js", "..."], ["shot", "name"], ["wait", 500]]'
 */
export const captureMode = !!process.env.INKWELL_CAPTURE

export function useProfileOverride(): void {
  if (process.env.INKWELL_PROFILE) app.setPath('userData', process.env.INKWELL_PROFILE)
}

export async function runCapture(win: BrowserWindow): Promise<void> {
  const out = process.env.INKWELL_CAPTURE!
  const steps = JSON.parse(process.env.INKWELL_STEPS ?? '[["wait", 1500], ["shot", "main"]]') as [string, string | number][]
  win.setSize(1400, 860)
  await new Promise((r) => setTimeout(r, 1200))
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message))
  win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason))
  win.webContents.on('unresponsive', () => console.log('[renderer unresponsive]'))
  for (const [kind, arg] of steps) {
    console.log('[capture step]', kind, String(arg).slice(0, 60))
    try {
      if (kind === 'wait') await new Promise((r) => setTimeout(r, Number(arg)))
      else if (kind === 'js') console.log('[capture js]', JSON.stringify(await win.webContents.executeJavaScript(String(arg), true)))
      else if (kind === 'shot') {
        // Offscreen rendering (set on the window in capture mode) hands over each painted frame
        const img = await new Promise<Electron.NativeImage | null>((resolve) => {
          const t = setTimeout(() => resolve(null), 5000)
          win.webContents.once('paint', (_e, _dirty, image) => {
            clearTimeout(t)
            resolve(image)
          })
          win.webContents.invalidate()
        })
        if (img) writeFileSync(`${out}/${arg}.png`, img.toPNG())
        else console.log('[capture error] screenshot timed out')
      }
    } catch (e) {
      console.log('[capture error]', kind, (e as Error).message)
    }
  }
  app.exit(0)
}
