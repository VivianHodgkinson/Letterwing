import assert from 'node:assert/strict'
import * as pace from '../src/main/pace'

// Faster while the window shows, slower in the tray
assert.equal(pace.pollMs(), pace.VISIBLE_MS)
pace.setVisible(false)
assert.equal(pace.pollMs(), pace.BACKGROUND_MS)
assert.ok(pace.VISIBLE_MS <= 15_000, 'new mail within seconds while the window is up')

// Bringing the window back checks at once, and a burst of focus changes only checks once
let checks = 0
const stop = pace.poll(() => checks++)
assert.equal(checks, 0, 'no check until the first interval')
pace.setVisible(true)
assert.equal(checks, 1, 'showing the window checks now')
pace.wake()
pace.wake()
assert.equal(checks, 1, 'focus flicks right after are ignored')

// Stopping really stops: no more checks on wake
stop()
await new Promise((r) => setTimeout(r, 3100))
pace.wake()
assert.equal(checks, 1)
console.log('pace tests passed')
