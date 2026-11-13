/**
 * End-to-end: the real ImapConnector against an in-memory IMAP server (hoodiecrow) and an SMTP
 * server (smtp-server). No network beyond localhost.
 */
import assert from 'node:assert/strict'
import hoodiecrow from 'hoodiecrow-imap'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import type { Account } from '../src/shared/types'
import { ImapConnector } from '../src/main/connectors/imap'
import { compile } from '../src/main/compose'

const mail = (id: string, subject: string, extra = '', body = 'Hello') =>
  `From: Jo Bloggs <jo@acme.test>\r\nTo: me@test.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@acme.test>\r\nDate: Thu, 12 Nov 2026 10:0${id.length}:00 +0200\r\n${extra}Content-Type: text/plain\r\n\r\n${body}\r\n`
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const withImage = [
  'From: Jo Bloggs <jo@acme.test>', 'To: me@test.test', 'Subject: Logo and file', 'Message-ID: <img@acme.test>', 'Date: Thu, 12 Nov 2026 11:00:00 +0200',
  'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: multipart/related; boundary="b2"', '', '--b2', 'Content-Type: text/html', '',
  '<p>Our logo: <img src="cid:logo@acme"></p>', '--b2', 'Content-Type: image/png', 'Content-ID: <logo@acme>', 'Content-Transfer-Encoding: base64', '', png, '--b2--',
  '--b1', 'Content-Type: application/pdf; name="quote.pdf"', 'Content-Disposition: attachment; filename="quote.pdf"', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('PDF-DATA').toString('base64'), '--b1--', ''
].join('\r\n')

const imap = hoodiecrow({
  plugins: ['IDLE', 'UIDPLUS', 'SPECIAL-USE', 'MOVE', 'ENABLE'],
  storage: {
    INBOX: { messages: [{ raw: mail('a', 'First'), flags: ['\\Seen'] }, { raw: mail('bb', 'Second') }, { raw: mail('ccc', 'Re: First', 'References: <a@acme.test>\r\nIn-Reply-To: <a@acme.test>\r\n') }, { raw: withImage }] },
    '': {
      separator: '/',
      folders: { Sent: { 'special-use': '\\Sent' }, Drafts: { 'special-use': '\\Drafts' }, Trash: { 'special-use': '\\Trash' }, Archive: { 'special-use': '\\Archive' }, Clients: {} }
    }
  }
})
const received: { from: string; to: string[]; raw: Buffer }[] = []
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth: (auth, _s, cb) => cb(auth.username === 'testuser' && auth.password === 'testpass' ? null : new Error('bad login'), { user: 'testuser' }),
  onData: (stream, session, cb) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => {
      received.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks) })
      cb()
    })
  }
})
await new Promise<void>((r) => imap.listen(0, '127.0.0.1', r))
await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r))
const smtpPort = (smtp.server.address() as { port: number }).port

const account: Account = {
  id: 't', kind: 'imap', name: 'Test', email: 'me@test.test', label: 'T', color: '#000', auth: 'password', username: 'testuser', senderName: 'Me',
  imap: { host: '127.0.0.1', port: imap.address().port, security: 'none' },
  smtp: { host: '127.0.0.1', port: smtpPort, security: 'none' }
}
const c = new ImapConnector(account, async () => ({ pass: 'testpass' }))
const timeout = setTimeout(() => {
  console.error('imap test timed out')
  process.exit(1)
}, 30_000)

try {
  await c.verify()

  // folders and roles
  const folders = await c.listFolders()
  const role = (r: string) => folders.find((f) => f.role === r)?.id
  assert.equal(role('inbox'), 'INBOX')
  assert.equal(role('sent'), 'Sent')
  assert.equal(role('drafts'), 'Drafts')
  assert.equal(role('trash'), 'Trash')
  assert.equal(role('archive'), 'Archive')
  assert.equal(folders.find((f) => f.id === 'INBOX')!.unread, 3)

  // first sync takes only the newest `limit`
  let s = await c.syncFolder('INBOX', null, 3)
  assert.equal(s.reset, true)
  assert.deepEqual(s.upserts.map((u) => u.subject), ['Second', 'Re: First', 'Logo and file'])
  assert.match(s.state, /:4:2:0$/, 'high 4, low 2, not done')
  const reply = s.upserts.find((u) => u.subject === 'Re: First')!
  assert.equal(reply.threadId, '<a@acme.test>', 'thread root from References')
  assert.equal(s.upserts.find((u) => u.subject === 'Logo and file')!.hasAttachments, true)

  // older mail pages in
  const older = await c.fetchOlder('INBOX', s.state, 3)
  assert.deepEqual(older.upserts.map((u) => u.subject), ['First'])
  assert.equal(older.done, true)
  assert.equal(older.upserts[0].threadId, '<a@acme.test>', 'the original joins its replies')
  assert.equal(older.upserts[0].unread, false)
  let state = older.state

  // new mail + IDLE push on a second connection
  let pushed = 0
  const stop = c.watch('INBOX', () => pushed++)
  await new Promise((r) => setTimeout(r, 800))
  imap.appendMessage(imap.getMailbox('INBOX'), [], new Date(), mail('dddd', 'Brand new'))
  for (let i = 0; i < 40 && !pushed; i++) await new Promise((r) => setTimeout(r, 100))
  stop()
  assert.ok(pushed > 0, 'IDLE reported new mail')
  s = await c.syncFolder('INBOX', state, 3)
  assert.deepEqual(s.upserts.map((u) => u.subject), ['Brand new'])
  assert.equal(s.reset, false)
  state = s.state

  // flags: set on the server, seen by the next sync
  await c.setFlags('INBOX', ['2'], { read: true, flagged: true })
  s = await c.syncFolder('INBOX', state, 3)
  assert.deepEqual(s.flagUpdates.find((f) => f.remoteId === '2'), { remoteId: '2', unread: false, flagged: true })

  // move and delete show up as missing from "existing"
  await c.move('INBOX', ['2'], 'Archive')
  await c.move('INBOX', ['1'], 'Trash')
  await c.remove('Trash', ['1'])
  s = await c.syncFolder('INBOX', state, 3)
  assert.deepEqual(s.existing!.sort(), ['3', '4', '5'])
  const archive = await c.syncFolder('Archive', null, 10)
  assert.deepEqual(archive.upserts.map((u) => u.subject), ['Second'])
  assert.equal((await c.syncFolder('Trash', null, 10)).upserts.length, 0, 'deleted for good from Trash')

  // body: cid image inlined as data:, PDF stays an attachment and can be fetched
  const body = await c.fetchBody('INBOX', '4')
  assert.match(body.html!, /src="data:image\/png;base64,/)
  assert.equal(body.messageId, '<img@acme.test>')
  const pdf = body.attachments.find((a) => a.filename === 'quote.pdf')!
  assert.equal(pdf.inline, false)
  assert.equal(body.attachments.find((a) => a.contentType === 'image/png')!.inline, true)
  const data = await c.fetchAttachment('INBOX', '4', pdf.id)
  assert.equal(data.content.toString(), 'PDF-DATA')

  // send over SMTP with login; Bcc gets it but isn't in the headers; a copy lands in Sent
  const msg = await compile(
    account,
    { accountId: 't', to: [{ name: 'Jo', address: 'jo@acme.test' }], cc: [], bcc: [{ name: '', address: 'boss@test.test' }], subject: 'Re: First', html: '<p>Got it</p>', attachments: [], inReplyTo: { key: '', messageId: '<a@acme.test>', references: [] } },
    async () => {
      throw new Error('no files')
    },
    { forDraft: false }
  )
  await c.send(msg, 'Sent')
  assert.equal(received.length, 1)
  assert.deepEqual(received[0].to.sort(), ['boss@test.test', 'jo@acme.test'])
  const out = await simpleParser(received[0].raw)
  assert.equal(out.bcc, undefined)
  assert.equal(out.inReplyTo, '<a@acme.test>')
  const sent = await c.syncFolder('Sent', null, 10)
  assert.deepEqual(sent.upserts.map((u) => u.subject), ['Re: First'], 'copy filed in Sent')
  assert.equal(sent.upserts[0].threadId, '<a@acme.test>', 'and threads with the conversation')

  // drafts: saving again replaces the previous copy
  const draft = await compile(account, { accountId: 't', to: [], cc: [], bcc: [], subject: 'Draft', html: '<p>v1</p>', attachments: [] }, async () => ({ filename: '', contentType: '', content: Buffer.alloc(0) }), { forDraft: true })
  const d1 = await c.saveDraft(draft, 'Drafts', null)
  assert.ok(d1, 'UIDPLUS gives the new UID')
  const d2 = await c.saveDraft(draft, 'Drafts', d1)
  const drafts = await c.syncFolder('Drafts', null, 10)
  assert.deepEqual(drafts.upserts.map((u) => u.remoteId), [d2!.remoteId], 'only the newest draft copy remains')

  // a wrong password is a readable error, not a hang
  const bad = new ImapConnector(account, async () => ({ pass: 'nope' }))
  await assert.rejects(bad.verify())
  console.log('imap tests passed')
} finally {
  clearTimeout(timeout)
  await c.close()
  imap.close()
  smtp.close()
}
