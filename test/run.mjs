// Runs each bundled test file in Electron's Node (where node:sqlite matches the app), one process
// per file. A "// @tz Area/City" line in a test sets its time zone; it has to be set before the
// process starts to work on Windows.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import electron from 'electron'

const dir = 'out/test'
let failed = 0
for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  const src = readFileSync(join('test', file.replace('.mjs', '.ts')), 'utf8')
  const tz = /^\/\/ @tz (\S+)/m.exec(src)?.[1]
  const r = spawnSync(electron, [join(dir, file)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(tz ? { TZ: tz } : {}) } })
  if (r.status !== 0) {
    failed++
    console.error(`✗ ${file} failed`)
  }
}
process.exit(failed ? 1 : 0)
