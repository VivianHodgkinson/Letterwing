import type { Account } from '@shared/types'
import { accessToken } from '../oauth'
import { getSecret } from '../store'
import { GraphConnector } from './graph'
import { ImapConnector } from './imap'
import type { MailConnector } from './types'

/** Server presets so most accounts only need an email address */
export const GOOGLE_IMAP = { host: 'imap.gmail.com', port: 993, security: 'tls' } as const
export const GOOGLE_SMTP = { host: 'smtp.gmail.com', port: 465, security: 'tls' } as const

/** The one place that maps an account kind to its connector. Register new backends here. */
export function connectorFor(account: Account): MailConnector {
  switch (account.kind) {
    case 'microsoft':
      return new GraphConnector(account, () => accessToken(account))
    case 'google':
      return new ImapConnector({ ...account, imap: account.imap ?? { ...GOOGLE_IMAP }, smtp: account.smtp ?? { ...GOOGLE_SMTP } }, async () => ({ accessToken: await accessToken(account) }))
    case 'imap':
      return new ImapConnector(account, async () => {
        const pass = getSecret(account.id)
        if (pass === null) throw new Error(`${account.name}: no password saved. Edit the account to enter it.`)
        return account.auth === 'oauth' ? { accessToken: await accessToken(account) } : { pass }
      })
  }
}
