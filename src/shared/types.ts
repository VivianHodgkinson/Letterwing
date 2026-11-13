import type { Keymap, PresetId } from './keys'

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
  /** Name shown to recipients, e.g. "Vivian Hodgkinson". The account `name` is only a label in Letterwing. */
  senderName?: string
  /** HTML signature for new messages */
  signature?: string
  /** Also add the signature to replies and forwards */
  signatureOnReplies?: boolean
  /** CalDAV server for IMAP accounts (Fastmail, iCloud, Nextcloud...). Microsoft and Google accounts don't need it. */
  caldavUrl?: string
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
  /** RFC 5322 Message-ID, used for threading and to de-duplicate copies across folders */
  messageId: string
  /** Conversation: Graph conversationId, Gmail thread ID, or the root of the References chain */
  threadId: string
  /** Set in conversation view: messages in this conversation across the account, and how many are unread */
  threadCount?: number
  threadUnread?: number
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
  /** For replies: the original's Message-ID, References chain and Reply-To */
  messageId: string
  references: string[]
  replyTo: Address[]
  /** Set when the message is a meeting invitation, update or cancellation */
  invite?: Invite
}

export type ResponseStatus = 'accepted' | 'tentative' | 'declined' | 'needsAction' | 'organizer' | 'none'

export interface Attendee extends Address {
  status: ResponseStatus
  optional?: boolean
}

export interface CalendarInfo {
  accountId: string
  id: string
  name: string
  color: string
  readOnly: boolean
  isDefault: boolean
}

/** One occurrence on the calendar. A repeating meeting appears once per occurrence. */
export interface CalendarEvent {
  key: string
  accountId: string
  calendarId: string
  /** Graph: the occurrence's event ID. CalDAV: the URL of the calendar object (shared by every occurrence of a series). */
  remoteId: string
  /** Graph: the series master, for responding to a whole series */
  seriesId?: string
  uid: string
  title: string
  start: number
  end: number
  allDay: boolean
  location: string
  description: string
  organizer: Address | null
  attendees: Attendee[]
  myStatus: ResponseStatus
  isOrganizer: boolean
  recurring: boolean
  cancelled: boolean
  showAs: 'free' | 'tentative' | 'busy' | 'oof' | 'elsewhere'
  /** Teams / Zoom / Meet link when there is one */
  joinUrl?: string
}

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'

/** What the event editor sends to create or change an event */
export interface EventInput {
  accountId: string
  calendarId: string
  /** Set when editing */
  key?: string
  title: string
  start: number
  end: number
  allDay: boolean
  location: string
  description: string
  attendees: Address[]
  repeat: Repeat
  /** Microsoft 365: make it a Teams meeting */
  online: boolean
}

/** A meeting request, update, reply or cancellation found in a message */
export interface Invite {
  method: 'REQUEST' | 'CANCEL' | 'REPLY' | 'COUNTER' | 'PUBLISH' | 'OTHER'
  uid: string
  title: string
  start: number
  end: number
  allDay: boolean
  location: string
  organizer: Address | null
  myStatus: ResponseStatus
  recurring: boolean
  /** Graph: the event in your calendar to respond to */
  eventId?: string
  /** iCalendar text, for replying by email (iMIP) on servers without a calendar API */
  ics?: string
}

export interface IcsSubscription {
  id: string
  name: string
  url: string
  color: string
}

export type CalendarView = 'day' | 'workweek' | 'week' | 'month'

/** A file to send: from disk, or an attachment of an existing message (forwarding, reopened drafts) */
export interface OutgoingAttachment {
  id: string
  filename: string
  contentType: string
  size: number
  source: { kind: 'file'; path: string } | { kind: 'message'; key: string; attachmentId: string }
}

/** A message being written. Saved to the server's Drafts folder and sent from the account in `accountId`. */
export interface Outgoing {
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  attachments: OutgoingAttachment[]
  /** Set on replies so the message threads correctly */
  inReplyTo?: { key: string; messageId: string; references: string[] }
  /** The server copy of this draft: replaced on every save, deleted when the message is sent */
  serverDraft?: { folderId: string; remoteId: string } | null
}

export interface Contact {
  name: string
  address: string
}

export type ReadingPane = 'right' | 'bottom' | 'off'
export type Density = 'compact' | 'comfortable' | 'spacious'

export interface Settings {
  readingPane: ReadingPane
  density: Density
  /** CSS variable overrides, e.g. { "--accent": "#ff8800" }. The whole look is driven by these. */
  themeVars: Record<string, string>
  /** Group messages into conversations */
  conversations: boolean
  /** Desktop notification for new mail in an inbox */
  notifications: boolean
  /** Load remote images without asking (privacy: off by default) */
  loadRemoteImages: boolean
  /** Base keyboard scheme; Classic unless the user picks another */
  keymapPreset: PresetId
  /** Per-action overrides on top of the preset. [] unbinds an action. */
  keybindings: Partial<Keymap>
  /** Read-only calendars from an ICS / webcal link (holidays, sports fixtures, other people's shared calendars) */
  icsSubscriptions: IcsSubscription[]
  /** Calendars unticked in the calendar sidebar, as "accountId\u0000calendarId" */
  hiddenCalendars: string[]
  calendarView: CalendarView
  /** Working hours: the time grid scrolls here and shades the rest */
  workDayStart: number
  workDayEnd: number
  /** Check GitHub for new versions */
  autoUpdate: boolean
  /** Closing the window keeps Letterwing running in the tray, so new mail and reminders still arrive */
  closeToTray: boolean
  /** Minutes before an event to show a reminder; 0 turns reminders off */
  reminderMinutes: number
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

export interface UpdateStatus {
  currentVersion: string
  /** auto: downloads and installs itself; notify: links to the release; disabled: dev build */
  mode: 'auto' | 'notify' | 'disabled'
  /** ready: auto-update downloaded, restart to install; downloaded: package saved to Downloads for the user to install */
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'downloaded' | 'up-to-date' | 'error'
  version?: string
  progress?: number
  error?: string
  releaseUrl?: string
  lastChecked?: number
  /** Release file matching this install (notify mode) */
  assetName?: string
  /** Where that file was downloaded */
  file?: string
  /** Command to install a downloaded Linux package */
  installCommand?: string
}
