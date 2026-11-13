import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import type { Account, Outgoing } from '../src/shared/types'
import { compile, htmlToText } from '../src/main/compose'

const account: Account = { id: 'a', kind: 'imap', name: 'Issue', email: 'me@issue.co.za', label: 'ISS', color: '#000', auth: 'password', senderName: 'Me Myself' }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const out: Outgoing = {
  accountId: 'a',
  to: [{ name: 'Jo', address: 'jo@acme.co.za' }],
  cc: [],
  bcc: [{ name: '', address: 'secret@x.co.za' }],
  subject: 'Re: Invoice 42',
  html: `<p>Thanks &amp; regards</p><img src="data:image/png;base64,${png}"><img src="data:image/png;base64,${png}"><img data-ink-src="https://example.com/logo.png">`,
  attachments: [{ id: '1', filename: 'quote.pdf', contentType: 'application/pdf', size: 3, source: { kind: 'file', path: '/x' } }],
  inReplyTo: { key: 'k', messageId: '<orig@acme>', references: ['<root@acme>'] }
}
const load = async () => ({ filename: 'quote.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') })

const sent = await compile(account, out, load, { forDraft: false })
// keepCidLinks: otherwise mailparser turns cid: back into data: URIs while parsing
const p = await simpleParser(await sent.mime(), { keepCidLinks: true })
assert.equal((p.from as { value: { name: string }[] }).value[0].name, 'Me Myself')
assert.equal(p.inReplyTo, '<orig@acme>')
assert.deepEqual(p.references, ['<root@acme>', '<orig@acme>'])
assert.equal(p.bcc, undefined, 'Bcc not in headers when sending')
assert.deepEqual(sent.envelope.to.sort(), ['jo@acme.co.za', 'secret@x.co.za'], 'but Bcc still receives it')
const inline = p.attachments.filter((a) => a.cid)
assert.equal(inline.length, 1, 'the same pasted image is embedded once')
assert.ok(typeof p.html === 'string' && p.html.includes(`cid:${inline[0].cid}`) && !p.html.includes('data:image'))
assert.ok((p.html as string).includes('src="https://example.com/logo.png"'), 'quoted remote image restored')
assert.equal(p.attachments.find((a) => a.filename === 'quote.pdf')!.content.toString(), 'PDF')
assert.match(p.text ?? '', /Thanks & regards/)

const draft = await simpleParser(await (await compile(account, out, load, { forDraft: true })).mime())
assert.equal((draft.bcc as { value: { address: string }[] }).value[0].address, 'secret@x.co.za', 'Bcc kept in drafts')
const noFiles = await simpleParser(await sent.mimeWithoutAttachments())
assert.equal(noFiles.attachments.filter((a) => !a.cid).length, 0)

await assert.rejects(compile(account, { ...out, to: [], bcc: [] }, load, { forDraft: false }), /recipient/)
await compile(account, { ...out, to: [], bcc: [] }, load, { forDraft: true }) // drafts may have none

assert.equal(htmlToText('<p>a</p><ul><li>one</li></ul><a href="https://x.io">site</a>'), 'a\n\n• one\nsite <https://x.io>')
console.log('compose tests passed')
