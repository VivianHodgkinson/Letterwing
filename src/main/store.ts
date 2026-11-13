import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, Settings } from '@shared/types'

const dir = (): string => {
  const d = app.getPath('userData')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir(), file), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Write via a temp file so a crash mid-write can't leave half a JSON file */
function writeJson(file: string, value: unknown): void {
  const path = join(dir(), file)
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(path + '.tmp', path)
}

export const DEFAULT_SETTINGS: Settings = {
  readingPane: 'right',
  density: 'comfortable',
  themeVars: {},
  loadRemoteImages: false,
  conversations: true,
  icsSubscriptions: [],
  hiddenCalendars: [],
  calendarView: 'workweek',
  workDayStart: 8,
  workDayEnd: 17,
  reminderMinutes: 15,
  notifications: true,
  keymapPreset: 'classic',
  keybindings: {},
  syncInterval: 5,
  microsoftClientId: '',
  googleClientId: '',
  googleClientSecret: ''
}

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeJson('settings.json', next)
  return next
}

export function getAccounts(): Account[] {
  return readJson<Account[]>('accounts.json', [])
}

export function saveAccounts(accounts: Account[]): void {
  writeJson('accounts.json', accounts)
}

/**
 * Passwords and OAuth tokens, encrypted with the OS keyring (KWallet /
 * libsecret on Linux, DPAPI on Windows, Keychain on macOS). Refuses to store
 * anything if the keyring is unavailable rather than falling back to plain text.
 */
type SecretMap = Record<string, string>

function readSecrets(): SecretMap {
  const raw = readJson<SecretMap>('secrets.json', {})
  const out: SecretMap = {}
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = safeStorage.decryptString(Buffer.from(v, 'base64'))
    } catch {
      // Encrypted under a different keyring (e.g. profile copied between machines): treat as missing.
    }
  }
  return out
}

export function getSecret(accountId: string): string | null {
  return readSecrets()[accountId] ?? null
}

export function setSecret(accountId: string, value: string | null): void {
  if (value !== null && !safeStorage.isEncryptionAvailable()) {
    throw new Error('No OS keyring is available (KWallet or GNOME Keyring), so Inkwell cannot store passwords safely.')
  }
  const raw = readJson<SecretMap>('secrets.json', {})
  if (value === null) delete raw[accountId]
  else raw[accountId] = safeStorage.encryptString(value).toString('base64')
  writeJson('secrets.json', raw)
}

export function dataDir(): string {
  return dir()
}
