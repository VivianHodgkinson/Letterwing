import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outgoing } from '../src/shared/types'
import * as outbox from '../src/main/outbox'

// Which failures wait in the Outbox (connection) and which are shown at once (real errors)
const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra)
assert.ok(outbox.isConnectionError(err('fetch failed', { cause: { code: 'ENOTFOUND' } })))
assert.ok(outbox.isConnectionError(err('getaddrinfo EAI_AGAIN smtp.gmail.com')))
assert.ok(outbox.isConnectionError(err('Connection timeout', { code: 'ETIMEDOUT' })))
assert.ok(outbox.isConnectionError(err('Microsoft Graph: Service unavailable (503)', { status: 503 })))
assert.ok(!outbox.isConnectionError(err('Invalid login: 535 Authentication failed', { code: 'EAUTH' })), 'a refused sign-in is a real error')
assert.ok(!outbox.isConnectionError(err('Microsoft Graph: The recipient address is invalid (400)', { status: 400 })))

// Queue a message with a file attachment: the file is copied in, so deleting the original is fine
const src = mkdtempSync(join(tmpdir(), 'lw-att-'))
const file = join(src, 'quote.pdf')
writeFileSync(file, 'PDF-DATA')
const msg: Outgoing = {
  accountId: 'a1', to: [{ name: 'Jo', address: 'jo@acme.test' }], cc: [], bcc: [{ name: '', address: 'boss@acme.test' }], subject: 'Quote', html: '<p>Hi</p>',
  attachments: [{ id: 'x', filename: 'quote.pdf', contentType: 'application/pdf', size: 8, source: { kind: 'file', path: file } }]
}
const item = await outbox.add(msg, 'No internet connection')
rmSync(src, { recursive: true })
assert.deepEqual(item.to, ['jo@acme.test', 'boss@acme.test'])
const [due] = outbox.due(false)
assert.equal(due.id, item.id)
const copied = (due.message.attachments[0].source as { path: string }).path
assert.equal(readFileSync(copied, 'utf8'), 'PDF-DATA', 'attachment kept in the Outbox')

// Survives a restart
outbox.reload()
assert.equal(outbox.list().length, 1)
assert.equal(outbox.list()[0].subject, 'Quote')

// Still offline: back off (not due again straight away), keep retrying by itself
outbox.failed(item.id, err('fetch failed', { cause: { code: 'ENETUNREACH' } }))
assert.equal(outbox.due(false).length, 0, 'waits before the next try')
assert.equal(outbox.due(true).length, 1, 'Send now tries anyway')
assert.equal(outbox.list()[0].stuck, false)
// A real error: stops retrying by itself and says why
outbox.failed(item.id, err('Invalid login', { code: 'EAUTH' }))
assert.equal(outbox.list()[0].stuck, true)
assert.equal(outbox.list()[0].error, 'Invalid login')

// Sent (or deleted): gone, files too
assert.ok(outbox.remove(item.id))
outbox.cleanUp(item.id)
assert.equal(outbox.count(), 0)
assert.ok(!existsSync(copied))
console.log('outbox tests passed')
