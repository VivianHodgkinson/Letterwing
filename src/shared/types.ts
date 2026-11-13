/** How an account connects. Each kind maps to one connector in src/main/connectors. */
export type AccountKind = 'imap' | 'microsoft' | 'google'

/** How a connector proves who it is: a password or an OAuth token set. */
export type AuthKind = 'password' | 'oauth'

export interface ServerSettings {
  host: string
  port: number
  /** 'tls' = implicit TLS (993/465), 'starttls' = upgrade (143/587), 'none' = plain (local testing only) */
  security: 'tls' | 'starttls' | 'none'
}

export interface Account {
  id: string
  kind: AccountKind
  /** Shown in the sidebar, e.g. "Issue Software" */
  name: string
  email: string
  /** Short badge text (2-4 chars) and colour, like the Teams launchers */
  label: string
  color: string
  auth: AuthKind
  /** Login user name when it differs from the email address */
  username?: string
  imap?: ServerSettings
  smtp?: ServerSettings
  /** OAuth app (client) ID override for this account; blank uses the app default */
  clientId?: string
  /** Microsoft tenant: 'common', 'organizations' or a tenant GUID/domain */
  tenant?: string
}

/** What the renderer sends to create an account. The secret goes to the keyring, never to disk in plain text. */
export interface NewAccount extends Omit<Account, 'id'> {
  password?: string
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other'

export interface Folder {
  accountId: string
  /** Provider-side ID: the mailbox path for IMAP, the folder ID for Graph */
  id: string
  name: string
  parentId: string | null
  role: FolderRole
  unread: number
  total: number
}

export interface Address {
  name: string
  address: string
}

export interface MessageSummary {
  /** Local key: accountId + folderId + provider message ID */
  key: string
  accountId: string
  folderId: string
  /** Provider-side ID: UID for IMAP, message ID for Graph */
  remoteId: string
  subject: string
  from: Address | null
  to: Address[]
  date: number
  preview: string
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
}

export interface Attachment {
  id: string
  filename: string
  contentType: string
  size: number
  inline: boolean
}

export interface MessageBody {
  key: string
  html: string | null
  text: string | null
  cc: Address[]
  attachments: Attachment[]
  /** True when the HTML references remote images, so the UI can offer "Load images" */
  hasRemoteContent: boolean
}

export type ReadingPane = 'right' | 'bottom' | 'off'
export type Density = 'compact' | 'comfortable' | 'spacious'

export interface Settings {
  readingPane: ReadingPane
  density: Density
  /** CSS variable overrides, e.g. { "--accent": "#ff8800" }. The whole look is driven by these. */
  themeVars: Record<string, string>
  /** Load remote images without asking (privacy: off by default) */
  loadRemoteImages: boolean
  /** Minutes between background syncs */
  syncInterval: number
  /** Default OAuth client IDs; per-account overrides live on the account */
  microsoftClientId: string
  googleClientId: string
  googleClientSecret: string
}

export interface SyncStatus {
  accountId: string
  state: 'idle' | 'syncing' | 'error'
  message?: string
  at: number
}
