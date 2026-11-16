import assert from 'node:assert/strict'
import { assessMessage, unfold } from '../src/main/security'

const fnb = { name: 'FNB', address: 'alerts@fnb.co.za' }

// Real-world shapes: Gmail, Microsoft 365 (with compauth)
const gmailPass = 'mx.google.com; dkim=pass header.i=@fnb.co.za header.s=s1; spf=pass (google.com: domain of alerts@fnb.co.za designates 1.2.3.4 as permitted sender) smtp.mailfrom=alerts@fnb.co.za; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=fnb.co.za'
const msFail = 'spf=fail (sender IP is 6.6.6.6) smtp.mailfrom=fnb.co.za; dkim=none (message not signed) header.d=none;dmarc=fail action=quarantine header.from=fnb.co.za;compauth=fail reason=000'
const softWeak = 'mx.example; spf=softfail smtp.mailfrom=shop.test; dkim=none; dmarc=none header.from=shop.test'

assert.deepEqual(assessMessage([gmailPass], fnb), { level: 'ok', reasons: [] })
const bad = assessMessage([msFail], fnb)
assert.equal(bad.level, 'danger')
assert.match(bad.reasons[0], /may not really be from fnb\.co\.za/)
assert.equal(assessMessage([softWeak], { name: 'Shop', address: 'news@shop.test' }).level, 'warn')
// compauth alone (Microsoft's combined verdict) is enough
assert.equal(assessMessage(['spf=pass smtp.mailfrom=x.test; dkim=pass; dmarc=none; compauth=fail reason=601'], fnb).level, 'danger')
// Only the topmost header counts: a sender can add a fake "pass" further down, not above the server's own
assert.equal(assessMessage([msFail, gmailPass], fnb).level, 'danger')
assert.equal(assessMessage([gmailPass, msFail], fnb).level, 'ok')
// No header at all (internal mail, some servers): nothing to say
assert.deepEqual(assessMessage([], fnb), { level: 'unknown', reasons: [] })

// A name pretending to be another address
const fake = assessMessage([gmailPass.replace(/fnb\.co\.za/g, 'evil.test')], { name: 'support@fnb.co.za', address: 'x@evil.test' })
assert.equal(fake.level, 'warn')
assert.match(fake.reasons[0], /shows fnb\.co\.za, but it was sent from evil\.test/)
// ...but not when the name's address is the same domain or a subdomain
assert.equal(assessMessage([gmailPass], { name: 'alerts@fnb.co.za', address: 'alerts@fnb.co.za' }).level, 'ok')
assert.equal(assessMessage([gmailPass], { name: 'noreply@mail.fnb.co.za', address: 'alerts@fnb.co.za' }).level, 'ok')

assert.equal(unfold('spf=pass\r\n\tsmtp.mailfrom=a.test;\r\n dkim=pass'), 'spf=pass smtp.mailfrom=a.test; dkim=pass')
console.log('security tests passed')
