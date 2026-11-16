import assert from 'node:assert/strict'
import { adminConsentUrl } from '../src/main/oauth'

// The admin's approval link: their organisation (by domain), exactly the permissions Letterwing asks for
const url = new URL(adminConsentUrl({ kind: 'microsoft', email: 'jo@acme.co.za', clientId: 'test-client' })!)
assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/acme.co.za/oauth2/v2.0/authorize')
assert.equal(url.searchParams.get('client_id'), 'test-client')
assert.equal(url.searchParams.get('prompt'), 'admin_consent')
assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/callback')
assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), ['Calendars.ReadWrite', 'Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'])
assert.equal(adminConsentUrl({ kind: 'google', email: 'jo@gmail.com', clientId: 'x' }), null, 'Google needs no admin approval')
console.log('oauth tests passed')
