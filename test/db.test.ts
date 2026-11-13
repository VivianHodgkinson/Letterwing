import assert from 'node:assert/strict'
import * as db from '../src/main/db'

db.openDb(':memory:')
const A = 'acct'
db.saveFolders(A, [
  { id: 'INBOX', name: 'Inbox', parentId: null, role: 'inbox', unread: 2, total: 3 },
  { id: 'Work', name: 'Work', parentId: null, role: 'other', unread: 0, total: 0 }
])
const msg = (id: string, subject: string, date: number, unread = true) => ({
  remoteId: id, subject, from: { name: 'Jo Bloggs', address: 'jo@acme.co.za' }, to: [], date, preview: 'see attached', unread, flagged: false, hasAttachments: false
})
db.applySync(A, 'INBOX', { upserts: [msg('1', 'Invoice 42 from ACME', 1000), msg('2', 'Lunch?', 2000), msg('3', 'Old', 500, false)], flagUpdates: [], deletes: [], reset: true, state: '7:3' })
assert.equal(db.getFolderState(A, 'INBOX'), '7:3')
assert.deepEqual(db.listMessages(A, 'INBOX', 10).map((m) => m.remoteId), ['2', '1', '3'])
assert.deepEqual(db.listMessages(null, '*inbox', 10).map((m) => m.remoteId), ['2', '1', '3'], 'unified inbox')
assert.deepEqual(db.listMessages(A, 'INBOX', 10, 2000).map((m) => m.remoteId), ['1', '3'], 'paging')

// prefix search across subject + sender
assert.deepEqual(db.search('inv acme', 10).map((m) => m.remoteId), ['1'])
assert.deepEqual(db.search('bloggs', 10).length, 3)

// marking read adjusts server unread count by the change, not a recount; repeat is a no-op
const k1 = db.messageKey(A, 'INBOX', '1')
db.setLocalFlags([k1], { read: true })
db.setLocalFlags([k1], { read: true })
assert.equal(db.listFolders(A).find((f) => f.id === 'INBOX')!.unread, 1)

// incremental sync: flag update + delete
db.applySync(A, 'INBOX', { upserts: [], flagUpdates: [{ remoteId: '2', unread: false, flagged: true }], deletes: ['3'], reset: false, state: '7:3' })
const two = db.getMessage(db.messageKey(A, 'INBOX', '2'))!
assert.equal(two.unread, false); assert.equal(two.flagged, true)
assert.equal(db.getMessage(db.messageKey(A, 'INBOX', '3')), null)
assert.equal(db.search('old', 10).length, 0, 'deleted message leaves search index')

// body caching indexes full text
db.cacheBody({ key: k1, html: '<p>Payment due <b>Friday</b></p>', text: null, cc: [], attachments: [], hasRemoteContent: false })
assert.deepEqual(db.search('friday', 10).map((m) => m.remoteId), ['1'])

// UIDVALIDITY reset wipes the folder first
db.applySync(A, 'INBOX', { upserts: [msg('9', 'Fresh', 3000)], flagUpdates: [], deletes: [], reset: true, state: '8:9' })
assert.deepEqual(db.listMessages(A, 'INBOX', 10).map((m) => m.remoteId), ['9'])
assert.equal(db.getCachedBody(k1), null)

// folder removed on server -> its messages go too
db.applySync(A, 'Work', { upserts: [msg('5', 'Spec', 100)], flagUpdates: [], deletes: [], reset: true, state: '1:5' })
db.saveFolders(A, [{ id: 'INBOX', name: 'Inbox', parentId: null, role: 'inbox', unread: 0, total: 1 }])
assert.equal(db.search('spec', 10).length, 0)

db.removeAccountData(A)
assert.equal(db.listFolders(A).length, 0)
console.log('db tests passed')
