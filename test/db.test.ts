import assert from 'node:assert/strict'
import * as db from '../src/main/db'

db.openDb(':memory:')
const A = 'acct'
db.saveFolders(A, [
  { id: 'INBOX', name: 'Inbox', parentId: null, role: 'inbox', unread: 2, total: 3 },
  { id: 'Sent', name: 'Sent', parentId: null, role: 'sent', unread: 0, total: 0 },
  { id: 'Trash', name: 'Trash', parentId: null, role: 'trash', unread: 0, total: 0 },
  { id: 'Work', name: 'Work', parentId: null, role: 'other', unread: 0, total: 0 }
])
const msg = (id: string, subject: string, date: number, unread = true, thread?: string) => ({
  remoteId: id, subject, from: { name: 'Jo Bloggs', address: 'jo@acme.co.za' }, to: [{ name: 'Me', address: 'me@x.co.za' }], date, preview: 'see attached',
  unread, flagged: false, hasAttachments: false, messageId: `<${id}@x>`, threadId: thread ?? `<${id}@x>`
})
const sync = (folder: string, s: Partial<Parameters<typeof db.applySync>[2]>) =>
  db.applySync(A, folder, { upserts: [], flagUpdates: [], deletes: [], reset: false, state: 's', ...s })

sync('INBOX', { upserts: [msg('1', 'Invoice 42 from ACME', 1000), msg('2', 'Lunch?', 2000), msg('3', 'Old', 500, false)], reset: true, state: '7:3:1:0' })
assert.equal(db.getFolderState(A, 'INBOX'), '7:3:1:0')
const ids = (l: { remoteId: string }[]) => l.map((m) => m.remoteId)
assert.deepEqual(ids(db.listMessages(A, 'INBOX', 10)), ['2', '1', '3'])
assert.deepEqual(ids(db.listMessages(null, '*inbox', 10)), ['2', '1', '3'], 'unified inbox')
const first = db.listMessages(A, 'INBOX', 1)[0]
assert.deepEqual(ids(db.listMessages(A, 'INBOX', 10, { date: first.date, key: first.key })), ['1', '3'], 'cursor paging')

// prefix search across subject + sender
assert.deepEqual(ids(db.search('inv acme', 10)), ['1'])
assert.equal(db.search('bloggs', 10).length, 3)

// marking read adjusts server unread count by the change, not a recount; repeat is a no-op
const k1 = db.messageKey(A, 'INBOX', '1')
db.setLocalFlags([k1], { read: true })
db.setLocalFlags([k1], { read: true })
assert.equal(db.getFolder(A, 'INBOX')!.unread, 1)

// incremental sync: flag update + delete
sync('INBOX', { flagUpdates: [{ remoteId: '2', unread: false, flagged: true }], deletes: ['3'] })
const two = db.getMessage(db.messageKey(A, 'INBOX', '2'))!
assert.equal(two.unread, false)
assert.equal(two.flagged, true)
assert.equal(db.getMessage(db.messageKey(A, 'INBOX', '3')), null)
assert.equal(db.search('old', 10).length, 0, 'deleted message leaves search index')

// "existing" list: anything not in it is gone from the server
sync('INBOX', { upserts: [msg('4', 'New', 3000)], existing: ['1', '4'] })
assert.deepEqual(ids(db.listMessages(A, 'INBOX', 10)), ['4', '1'])

// body caching indexes full text
db.cacheBody({ key: k1, html: '<p>Payment due <b>Friday</b></p>', text: null, cc: [], attachments: [], hasRemoteContent: false, messageId: '<1@x>', references: [], replyTo: [] })
assert.deepEqual(ids(db.search('friday', 10)), ['1'])

// optimistic move: removed now, restored (with body) if the server refuses
const removed = db.removeLocal([k1])
assert.equal(db.getMessage(k1), null)
db.restoreLocal(removed)
assert.equal(db.getMessage(k1)!.subject, 'Invoice 42 from ACME')
assert.ok(db.getCachedBody(k1))

// conversations: a reply in Inbox and my answer in Sent form one thread; the list shows it once
sync('INBOX', { upserts: [msg('5', 'Re: Invoice 42', 4000, true, '<1@x>')] })
sync('Sent', { upserts: [{ ...msg('s1', 'Re: Invoice 42', 3500, false, '<1@x>'), from: { name: 'Me', address: 'me@x.co.za' }, to: [{ name: 'Jo Bloggs', address: 'jo@acme.co.za' }] }], reset: true })
const conv = db.listMessages(A, 'INBOX', 10, undefined, true)
assert.deepEqual(ids(conv), ['5', '4'])
assert.equal(conv[0].threadCount, 3, 'inbox original + reply + my sent answer')
assert.equal(conv[0].threadUnread, 1)
assert.deepEqual(ids(db.thread(db.messageKey(A, 'INBOX', '5'))), ['1', 's1', '5'], 'thread oldest first, across folders')
// copies of the same message in two folders count once
sync('Work', { upserts: [msg('w1', 'Re: Invoice 42', 4000, false, '<1@x>')].map((m) => ({ ...m, messageId: '<5@x>' })), reset: true })
assert.equal(db.listMessages(A, 'INBOX', 10, undefined, true)[0].threadCount, 3)
assert.equal(db.thread(db.messageKey(A, 'INBOX', '5')).length, 3)
// trash is hidden from a thread read elsewhere
sync('Trash', { upserts: [msg('t1', 'Re: Invoice 42', 3800, false, '<1@x>')], reset: true })
assert.equal(db.thread(db.messageKey(A, 'INBOX', '5')).length, 3)

// contacts: people I write to outrank people who write to me
sync('INBOX', { upserts: [{ ...msg('6', 'Hi', 100), from: { name: 'Joanne Smith', address: 'joanne@other.co.za' } }] })
assert.deepEqual(db.suggestContacts('jo', 5).map((c) => c.address), ['jo@acme.co.za', 'joanne@other.co.za'])
assert.deepEqual(db.suggestContacts('smi', 5).map((c) => c.address), ['joanne@other.co.za'], 'matches a later word of the name')
sync('INBOX', { upserts: [{ ...msg('7', 'Spam', 100), from: { name: 'Robot', address: 'no-reply@shop.com' } }] })
assert.equal(db.suggestContacts('no', 5).length, 0, 'no-reply senders are not contacts')

// older mail paged in
db.applyOlder(A, 'INBOX', [msg('0', 'Ancient', 10, false)], '7:4:0:1')
assert.equal(db.getFolderState(A, 'INBOX'), '7:4:0:1')
assert.equal(ids(db.listMessages(A, 'INBOX', 20)).at(-1), '0')

// UIDVALIDITY reset wipes the folder first
sync('INBOX', { upserts: [msg('9', 'Fresh', 3000)], reset: true })
assert.deepEqual(ids(db.listMessages(A, 'INBOX', 10)), ['9'])
assert.equal(db.getCachedBody(k1), null)

// folder removed on server -> its messages go too
db.saveFolders(A, [{ id: 'INBOX', name: 'Inbox', parentId: null, role: 'inbox', unread: 0, total: 1 }])
assert.equal(db.search('re invoice', 10).length, 0)

db.removeAccountData(A)
assert.equal(db.listFolders(A).length, 0)
console.log('db tests passed')
