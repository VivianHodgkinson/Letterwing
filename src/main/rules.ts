import type { Account, MailRule, RulesResult } from '@shared/types'
import { GraphConnector } from './connectors/graph'
import * as db from './db'
import { accessToken, adminConsentUrl, MICROSOFT_RULES_SCOPES, NeedsApprovalError, signIn } from './oauth'
import { getSecret, setSecret } from './store'

/**
 * Microsoft 365 server rules (Graph messageRules on the Inbox). They run on Microsoft's side, so they work
 * when Letterwing is closed and on every device. Needs the optional MailboxSettings.ReadWrite permission,
 * asked for only here.
 */

const RULES = '/me/mailFolders/inbox/messageRules'

type Addr = { emailAddress: { address: string; name?: string } }
interface GRule {
  id: string
  displayName: string
  sequence: number
  isEnabled: boolean
  isReadOnly?: boolean
  hasError?: boolean
  conditions?: Record<string, unknown> | null
  exceptions?: Record<string, unknown> | null
  actions?: Record<string, unknown> | null
}

function graph(account: Account): GraphConnector {
  return new GraphConnector(account, () => accessToken(account, MICROSOFT_RULES_SCOPES))
}

function supported(account: Account): boolean {
  return account.kind === 'microsoft'
}

export async function listRules(account: Account): Promise<RulesResult> {
  if (!supported(account)) return { state: 'unsupported' }
  try {
    return { state: 'ok', rules: (await fetchRules(account)).map((r) => toRule(account, r)) }
  } catch (e) {
    if (e instanceof NeedsApprovalError || isDenied(e)) return { state: 'needsApproval', adminLink: adminConsentUrl(account) }
    throw e
  }
}

/** Sign in again in the browser asking for the rules permission: works where users may approve it themselves */
export async function allowRules(account: Account): Promise<void> {
  const fresh = await signIn(account, MICROSOFT_RULES_SCOPES)
  const raw = getSecret(account.id)
  setSecret(account.id, JSON.stringify(raw ? { ...JSON.parse(raw), refreshToken: fresh.refreshToken } : fresh))
}

export async function saveRule(account: Account, rule: MailRule): Promise<void> {
  const g = graph(account)
  if (rule.id) {
    await g.call(`${RULES}/${rule.id}`, { method: 'PATCH', body: JSON.stringify(toGraph(rule)) })
    return
  }
  const existing = await fetchRules(account)
  const sequence = Math.max(0, ...existing.map((r) => r.sequence)) + 1
  await g.call(RULES, { method: 'POST', body: JSON.stringify({ ...toGraph(rule), sequence }) })
}

/** Just switch it on or off (works on rules this screen can't otherwise edit) */
export async function setRuleEnabled(account: Account, id: string, enabled: boolean): Promise<void> {
  await graph(account).call(`${RULES}/${id}`, { method: 'PATCH', body: JSON.stringify({ isEnabled: enabled }) })
}

export async function deleteRule(account: Account, id: string): Promise<void> {
  await graph(account).call(`${RULES}/${id}`, { method: 'DELETE' })
}

/** Swap a rule with its neighbour: rules run in order */
export async function moveRule(account: Account, id: string, direction: -1 | 1): Promise<void> {
  const rules = await fetchRules(account)
  const i = rules.findIndex((r) => r.id === id)
  const j = i + direction
  if (i < 0 || j < 0 || j >= rules.length) return
  const a = rules[i]
  const b = rules[j]
  // Equal numbers can't be swapped: give them distinct ones first
  const [sa, sb] = a.sequence === b.sequence ? [b.sequence + direction, a.sequence] : [b.sequence, a.sequence]
  const g = graph(account)
  await g.call(`${RULES}/${a.id}`, { method: 'PATCH', body: JSON.stringify({ sequence: sa }) })
  await g.call(`${RULES}/${b.id}`, { method: 'PATCH', body: JSON.stringify({ sequence: sb }) })
}

async function fetchRules(account: Account): Promise<GRule[]> {
  const page = await graph(account).call<{ value: GRule[] }>(RULES)
  return [...page.value].sort((a, b) => a.sequence - b.sequence)
}

function isDenied(e: unknown): boolean {
  const err = e as { status?: number; message?: string }
  return err.status === 403 || /AccessDenied|Access is denied|ErrorAccessDenied/i.test(err.message ?? '')
}

// ---- Graph <-> Letterwing ----

const isSet = (v: unknown): boolean => v !== null && v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const addrs = (v: unknown): string[] => (Array.isArray(v) ? (v as Addr[]).map((a) => a?.emailAddress?.address).filter((x): x is string => !!x) : [])
const list = (v: string[]): string => v.map((x) => `"${x}"`).join(' or ')
const isAddress = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

/** Plain words for the parts this screen doesn't edit */
const CONDITION_WORDS: Record<string, (v: unknown) => string> = {
  bodyContains: (v) => `Body contains ${list(strings(v))}`,
  headerContains: (v) => `Message header contains ${list(strings(v))}`,
  sentToMe: () => "I'm on the To line",
  sentOnlyToMe: () => "I'm the only recipient",
  sentCcMe: () => "I'm on the Cc line",
  sentToOrCcMe: () => "I'm on the To or Cc line",
  notSentToMe: () => "I'm not on the To line",
  importance: (v) => `Importance is ${v}`,
  sensitivity: (v) => `Sensitivity is ${v}`,
  categories: (v) => `Has category ${list(strings(v))}`,
  messageActionFlag: (v) => `Flagged for ${v}`,
  withinSizeRange: (v) => {
    const r = v as { minimumSize?: number; maximumSize?: number }
    return `Size between ${r.minimumSize ?? 0} and ${r.maximumSize ?? '∞'} KB`
  },
  isMeetingRequest: () => 'Is a meeting invitation',
  isMeetingResponse: () => 'Is a meeting response',
  isAutomaticReply: () => 'Is an automatic reply',
  isAutomaticForward: () => 'Is an automatic forward',
  isEncrypted: () => 'Is encrypted',
  isSigned: () => 'Is signed',
  isReadReceipt: () => 'Is a read receipt',
  isNonDeliveryReport: () => 'Is a delivery failure report',
  isVoicemail: () => 'Is a voicemail',
  isApprovalRequest: () => 'Is an approval request',
  isPermissionControlled: () => 'Is permission controlled'
}

function toRule(account: Account, r: GRule): MailRule {
  const c = r.conditions ?? {}
  const a = r.actions ?? {}
  const other: string[] = []
  const folderName = (id: unknown) => (typeof id === 'string' ? (db.getFolder(account.id, id)?.name ?? 'a folder') : 'a folder')

  const pick = (addrKey: string, containsKey: string, words: string): string[] => {
    const entries = Array.isArray(c[addrKey]) ? (c[addrKey] as Addr[]) : []
    const exact = addrs(entries)
    const parts = strings(c[containsKey])
    // A contact picked by name with no address (Graph gives only the name): describe it, never drop it
    if (entries.some((e) => !e?.emailAddress?.address)) {
      other.push(`${words} ${entries.map((e) => e?.emailAddress?.address || e?.emailAddress?.name || 'a contact').join(' or ')}`)
      if (parts.length) other.push(`${words} contains ${list(parts)}`)
      return []
    }
    // Both set means both must match on the server: not something this screen can show as one list
    if (exact.length && parts.length) {
      other.push(`${words} ${list(exact)}`, `${words} contains ${list(parts)}`)
      return []
    }
    return exact.length ? exact : parts
  }
  const from = pick('fromAddresses', 'senderContains', 'From')
  const sentTo = pick('sentToAddresses', 'recipientContains', 'Sent to')

  const handled = new Set(['fromAddresses', 'senderContains', 'sentToAddresses', 'recipientContains', 'subjectContains', 'bodyOrSubjectContains', 'hasAttachments'])
  for (const [k, v] of Object.entries(c)) {
    if (handled.has(k) || !isSet(v)) continue
    other.push(CONDITION_WORDS[k]?.(v) ?? `Condition: ${k}`)
  }
  if (Object.values(r.exceptions ?? {}).some(isSet)) other.push('Has exceptions ("except if…")')

  const handledActions = new Set(['moveToFolder', 'markAsRead', 'delete', 'stopProcessingRules'])
  const actionWords: Record<string, (v: unknown) => string> = {
    copyToFolder: (v) => `Copy to ${folderName(v)}`,
    forwardTo: (v) => `Forward to ${addrs(v).join(', ')}`,
    forwardAsAttachmentTo: (v) => `Forward as an attachment to ${addrs(v).join(', ')}`,
    redirectTo: (v) => `Redirect to ${addrs(v).join(', ')}`,
    assignCategories: (v) => `Add category ${list(strings(v))}`,
    markImportance: (v) => `Mark as ${v} importance`,
    permanentDelete: () => 'Delete permanently'
  }
  for (const [k, v] of Object.entries(a)) {
    if (handledActions.has(k) || !isSet(v)) continue
    other.push(actionWords[k]?.(v) ?? `Action: ${k}`)
  }

  return {
    id: r.id,
    name: r.displayName,
    enabled: r.isEnabled,
    from,
    sentTo,
    subjectContains: strings(c.subjectContains),
    bodyOrSubjectContains: strings(c.bodyOrSubjectContains),
    hasAttachments: c.hasAttachments === true,
    moveTo: typeof a.moveToFolder === 'string' ? a.moveToFolder : null,
    markRead: a.markAsRead === true,
    delete: a.delete === true,
    stop: a.stopProcessingRules === true,
    other,
    readOnly: !!r.isReadOnly,
    hasError: !!r.hasError
  }
}

/**
 * The Graph body for a rule. Entries that are all whole addresses become an exact-address condition;
 * otherwise "contains" (one condition each, since two different ones would both have to match). Only
 * what's set is sent: Microsoft replaces a rule's conditions and actions as a whole on update (and
 * refuses empty lists), so leaving a part out removes it.
 */
function toGraph(rule: MailRule): Record<string, unknown> {
  const words = (v: string[]) => v.map((x) => x.trim()).filter(Boolean)
  const people = (entries: string[], addrKey: string, containsKey: string): Record<string, unknown> => {
    const clean = words(entries)
    if (!clean.length) return {}
    return clean.every(isAddress) ? { [addrKey]: clean.map((address) => ({ emailAddress: { address } })) } : { [containsKey]: clean }
  }
  const conditions: Record<string, unknown> = {
    ...people(rule.from, 'fromAddresses', 'senderContains'),
    ...people(rule.sentTo, 'sentToAddresses', 'recipientContains')
  }
  const subject = words(rule.subjectContains)
  const any = words(rule.bodyOrSubjectContains)
  if (subject.length) conditions.subjectContains = subject
  if (any.length) conditions.bodyOrSubjectContains = any
  if (rule.hasAttachments) conditions.hasAttachments = true

  const actions: Record<string, unknown> = { stopProcessingRules: rule.stop }
  if (rule.moveTo) actions.moveToFolder = rule.moveTo
  if (rule.markRead) actions.markAsRead = true
  if (rule.delete) actions.delete = true

  return { displayName: rule.name.trim() || 'Rule', isEnabled: rule.enabled, conditions, actions }
}

export const forTesting = { toRule, toGraph }
