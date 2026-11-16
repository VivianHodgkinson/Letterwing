import assert from 'node:assert/strict'
import { blockEntry, isBlocked } from '../src/shared/blocking'

assert.equal(blockEntry(' Spam@Shop.TEST '), 'spam@shop.test')
assert.equal(blockEntry('shop.test'), '@shop.test')
assert.equal(blockEntry('@shop.test'), '@shop.test')
assert.equal(blockEntry('not an address'), null)
assert.equal(blockEntry('localhost'), null)

const list = ['spam@shop.test', '@casino.test']
assert.ok(isBlocked('SPAM@shop.test', list), 'case does not matter')
assert.ok(!isBlocked('sales@shop.test', list), 'an address block is just that address')
assert.ok(isBlocked('win@casino.test', list), 'a domain block covers everyone there')
assert.ok(isBlocked('win@mail.casino.test', list), 'and its subdomains')
assert.ok(!isBlocked('me@notcasino.test', list), 'but not look-alike domains')
assert.ok(!isBlocked(null, list))
assert.ok(!isBlocked('x@y.test', []))
console.log('blocking tests passed')
