import assert from 'node:assert/strict'
import { mailtoFromArgs, parseMailto } from '../src/main/mailto'

const r = parseMailto('mailto:jo@acme.test,sam+work@gmail.com?cc=boss@acme.test&subject=Quote%20for%20Q4&body=Hi%20Jo%2C%0A%0AThanks!%20A+B')!
assert.deepEqual(r.to.map((a) => a.address), ['jo@acme.test', 'sam+work@gmail.com'], '+ stays a plus in addresses')
assert.deepEqual(r.cc.map((a) => a.address), ['boss@acme.test'])
assert.equal(r.subject, 'Quote for Q4')
assert.equal(r.body, 'Hi Jo,\n\nThanks! A+B', 'line breaks kept, + not turned into a space')

// Extra recipients in ?to=, encoded @, odd casing, junk ignored
const r2 = parseMailto('MAILTO:?to=a%40b.test&TO=c@d.test&Subject=Hi&foo=bar')!
assert.deepEqual(r2.to.map((a) => a.address), ['a@b.test', 'c@d.test'])
assert.equal(r2.subject, 'Hi')
assert.deepEqual(parseMailto('mailto:not-an-address')!.to, [])
assert.equal(parseMailto('https://example.com'), null)
assert.equal(parseMailto('mailto:x@y.test?subject=%E0%A4%A')!.subject, '%E0%A4%A', 'broken encoding is kept as typed, not an error')

// How Windows/Linux hand the link over
assert.equal(mailtoFromArgs(['/opt/Letterwing/letterwing', '--no-sandbox', 'mailto:jo@acme.test']), 'mailto:jo@acme.test')
assert.equal(mailtoFromArgs(['/opt/Letterwing/letterwing']), null)
console.log('mailto tests passed')
