import { shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Account } from '@shared/types'
import { getSecret, getSettings, setSecret } from './store'

/**
 * OAuth 2.0 for desktop apps: authorization code + PKCE, signing in through
 * the system browser with a loopback redirect (RFC 8252). No embedded login
 * window, so password managers, MFA and passkeys all work as normal.
 */

interface Provider {
  authorize: string
  token: string
  scopes: string[]
  clientId: string
  clientSecret?: string
  extra?: Record<string, string>
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function provider(account: Pick<Account, 'kind' | 'clientId' | 'tenant'>): Provider {
  const s = getSettings()
  if (account.kind === 'microsoft') {
    const tenant = account.tenant || 'organizations'
    const clientId = account.clientId || s.microsoftClientId
    if (!clientId) throw new Error('Set the Microsoft app (client) ID in Settings → Accounts first. See docs/SETUP.md.')
    return {
      authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scopes: ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'],
      clientId,
      extra: { prompt: 'select_account' }
    }
  }
  if (account.kind === 'google') {
    const clientId = account.clientId || s.googleClientId
    if (!clientId) throw new Error('Set the Google OAuth client ID in Settings → Accounts first. See docs/SETUP.md.')
    return {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      scopes: ['https://mail.google.com/', 'https://www.googleapis.com/auth/calendar', 'openid', 'email'],
      clientId,
      // Google issues "installed app" clients with a secret that isn't actually secret; PKCE is what protects the flow.
      clientSecret: s.googleClientSecret || undefined,
      extra: { access_type: 'offline', prompt: 'consent' }
    }
  }
  throw new Error(`Accounts of kind "${account.kind}" don't use OAuth`)
}

const b64url = (b: Buffer): string => b.toString('base64url')

/** Opens the browser, waits for the redirect and returns the tokens. Times out after 5 minutes. */
export async function signIn(account: Pick<Account, 'kind' | 'clientId' | 'tenant' | 'email'>): Promise<TokenSet> {
  const p = provider(account)
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error_description') || url.searchParams.get('error')
      const ok = !error && url.searchParams.get('state') === state && url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>Inkwell</title><body style="font-family:system-ui;padding:3em">
        <h2>${ok ? 'Signed in.' : 'Sign-in failed.'}</h2><p>${ok ? 'You can close this tab and return to Inkwell.' : 'Return to Inkwell for details.'}</p>`)
      clearTimeout(timer)
      server.close()
      if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri })
      else reject(new Error(error ? `Sign-in failed: ${error}` : 'Sign-in failed: the response did not match this request.'))
    })
    let redirectUri = ''
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Sign-in timed out after 5 minutes.'))
    }, 5 * 60_000)
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://${account.kind === 'microsoft' ? 'localhost' : '127.0.0.1'}:${(server.address() as AddressInfo).port}/callback`
      const url = new URL(p.authorize)
      const params: Record<string, string> = {
        client_id: p.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: p.scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        login_hint: account.email,
        ...p.extra
      }
      for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
      shell.openExternal(url.toString())
    })
  })

  return exchange(p, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, null)
}

async function exchange(p: Provider, body: Record<string, string>, previousRefresh: string | null): Promise<TokenSet> {
  const form = new URLSearchParams({ client_id: p.clientId, ...body })
  if (p.clientSecret) form.set('client_secret', p.clientSecret)
  if (p.token.includes('microsoftonline')) form.set('scope', p.scopes.join(' '))
  const res = await fetch(p.token, { method: 'POST', body: form })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) throw new Error(`Token request failed: ${json.error_description ?? json.error ?? res.status}`)
  return {
    accessToken: json.access_token as string,
    // Google omits the refresh token on refresh; keep the one we had.
    refreshToken: (json.refresh_token as string) ?? previousRefresh ?? '',
    expiresAt: Date.now() + ((json.expires_in as number) ?? 3600) * 1000
  }
}

/** A valid access token for the account, refreshing (and saving) it when it is about to expire */
export async function accessToken(account: Account): Promise<string> {
  const raw = getSecret(account.id)
  if (!raw) throw new Error(`${account.name}: not signed in. Remove and re-add the account.`)
  const tokens = JSON.parse(raw) as TokenSet
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken
  const fresh = await exchange(provider(account), { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, tokens.refreshToken)
  setSecret(account.id, JSON.stringify(fresh))
  return fresh.accessToken
}
