/**
 * GraphConnector against a fake Graph (global fetch replaced): partial delta entries must be fetched
 * in full, never stored as blank messages.
 */
import assert from 'node:assert/strict'
import type { Account } from '../src/shared/types'
import { GraphConnector } from '../src/main/connectors/graph'

const full = (id: string, subject: string) => ({
  id, subject, from: { emailAddress: { name: 'MrVeee', address: 'mr@veee.test' } }, toRecipients: [],
  receivedDateTime: '2026-11-16T09:09:00Z', bodyPreview: 'Testing more', isRead: false, flag: { flagStatus: 'notFlagged' },
  hasAttachments: false, internetMessageId: `<${id}@veee.test>`, conversationId: 'c1'
})
const calls: string[] = []
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push(`${init?.method ?? 'GET'} ${url}`)
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  if (url.includes('/messages/delta') || url.includes('deltatoken')) {
    // A new message arrives as only its read state, another one in full, one deleted
    return json({ value: [{ id: 'new1', isRead: false }, full('ok1', 'Complete'), { id: 'del1', '@removed': { reason: 'deleted' } }, { id: 'gone1', isRead: true }], '@odata.deltaLink': 'https://graph.test/delta?deltatoken=2' })
  }
  if (url.endsWith('/$batch')) {
    const { requests } = JSON.parse(String(init!.body)) as { requests: { id: string; url: string }[] }
    return json({ responses: requests.map((r) => (r.id === 'gone1' ? { id: r.id, status: 404 } : { id: r.id, status: 200, body: full(r.id, 'Hello from Gmail') })) })
  }
  return json({ value: [] })
}) as typeof fetch

const account = { id: 'm', kind: 'microsoft', name: 'Work', email: 'me@work.test', label: 'W', color: '#000', auth: 'oauth' } as Account
const c = new GraphConnector(account, async () => 'token')
const state = JSON.stringify({ delta: 'https://graph.test/delta?deltatoken=1', oldest: 0, done: false })
const r = await c.syncFolder('inbox', state, 50)

const byId = new Map(r.upserts.map((u) => [u.remoteId, u]))
assert.equal(byId.get('new1')?.subject, 'Hello from Gmail', 'partial entry fetched in full')
assert.equal(byId.get('new1')?.from?.name, 'MrVeee')
assert.equal(byId.get('new1')?.date, Date.parse('2026-11-16T09:09:00Z'), 'real received time, not "now"')
assert.equal(byId.get('ok1')?.subject, 'Complete')
assert.ok(!byId.has('gone1'), 'a message deleted before we could fetch it is not stored')
assert.deepEqual(r.deletes.sort(), ['del1', 'gone1'])
assert.ok(r.upserts.every((u) => u.subject !== '(no subject)' && u.from), 'nothing blank')
assert.equal(calls.filter((x) => x.includes('$batch')).length, 1, 'one batch for the partial entries')
assert.equal(JSON.parse(r.state).delta, 'https://graph.test/delta?deltatoken=2')
console.log('graph tests passed')
