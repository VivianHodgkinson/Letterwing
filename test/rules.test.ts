import assert from 'node:assert/strict'
import type { Account } from '@shared/types'
import * as db from '../src/main/db'
import { forTesting } from '../src/main/rules'

const { toRule, toGraph } = forTesting
db.openDb(':memory:')
const acc = { id: 'a', kind: 'microsoft', name: 'Work', email: 'me@example.com' } as Account
db.saveFolders(acc.id, [
  { id: 'F1', name: 'Helpdesk', parentId: null, role: 'other', unread: 0, total: 0 },
  { id: 'F2', name: 'Archive copies', parentId: null, role: 'other', unread: 0, total: 0 }
])

// A simple rule made on the web: exact sender, move, stop
const simple = toRule(acc, {
  id: 'r1',
  displayName: 'Helpdesk',
  sequence: 1,
  isEnabled: true,
  conditions: { fromAddresses: [{ emailAddress: { name: 'ISSUE Helpdesk', address: 'helpdesk@example.com' } }], subjectContains: [], hasAttachments: null },
  exceptions: null,
  actions: { moveToFolder: 'F1', stopProcessingRules: true, forwardTo: [], markAsRead: false }
})
assert.deepEqual(simple.from, ['helpdesk@example.com'])
assert.equal(simple.moveTo, 'F1')
assert.equal(simple.stop, true)
assert.equal(simple.markRead, false)
assert.deepEqual(simple.other, [], 'empty and false values from Graph are not "other" parts')

// Saving it back: whole addresses stay an exact-sender condition; only what's set is sent (Microsoft
// replaces conditions and actions whole on update, and refuses empty lists)
const body = toGraph(simple) as { conditions: Record<string, unknown>; actions: Record<string, unknown>; displayName: string }
assert.deepEqual(body.conditions, { fromAddresses: [{ emailAddress: { address: 'helpdesk@example.com' } }] })
assert.deepEqual(body.actions, { stopProcessingRules: true, moveToFolder: 'F1' })

const fresh = toGraph({ ...simple, id: '', from: ['@example.com', 'billing'], moveTo: null, markRead: true, stop: false }) as typeof body
assert.deepEqual(fresh.conditions, { senderContains: ['@example.com', 'billing'] }, 'any partial address: all become "contains", so they stay either-or')
assert.deepEqual(fresh.actions, { stopProcessingRules: false, markAsRead: true })

// Parts this screen can't edit are described, which makes the rule read-only here
const fancy = toRule(acc, {
  id: 'r2',
  displayName: 'Boss',
  sequence: 2,
  isEnabled: false,
  conditions: { senderContains: ['boss'], sentToMe: true, importance: 'high' },
  exceptions: { subjectContains: ['lunch'] },
  actions: { copyToFolder: 'F2', forwardTo: [{ emailAddress: { address: 'phone@example.com' } }], markImportance: 'high' }
})
assert.deepEqual(fancy.from, ['boss'])
assert.deepEqual(fancy.other, [
  "I'm on the To line",
  'Importance is high',
  'Has exceptions ("except if…")',
  'Copy to Archive copies',
  'Forward to phone@example.com',
  'Mark as high importance'
])

// Exact sender AND sender-contains together can't be shown as one either-or list
const both = toRule(acc, {
  id: 'r3',
  displayName: 'Both',
  sequence: 3,
  isEnabled: true,
  conditions: { fromAddresses: [{ emailAddress: { address: 'x@example.com' } }], senderContains: ['example'] },
  actions: { delete: true }
})
assert.deepEqual(both.from, [])
assert.equal(both.other.length, 2)
assert.equal(both.delete, true)

// A contact chosen by name only (no address) is described, so the rule can't be saved without it
const named = toRule(acc, {
  id: 'r4',
  displayName: 'Willem',
  sequence: 4,
  isEnabled: true,
  conditions: { fromAddresses: [{ emailAddress: { name: 'Willem D' } } as never] },
  actions: { moveToFolder: 'F1', stopProcessingRules: true }
})
assert.deepEqual(named.from, [])
assert.deepEqual(named.other, ['From Willem D'])

console.log('rules tests passed')
