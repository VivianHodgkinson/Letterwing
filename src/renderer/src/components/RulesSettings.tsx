import { useEffect, useState } from 'react'
import type { Account, Folder, MailRule, RulesResult } from '@shared/types'
import { api } from '../api'

/** A rule to start from, e.g. "Create rule from this message" */
export interface RuleDraft {
  accountId: string
  rule: Partial<MailRule>
}

const EMPTY: MailRule = {
  id: '',
  name: '',
  enabled: true,
  from: [],
  sentTo: [],
  subjectContains: [],
  bodyOrSubjectContains: [],
  hasAttachments: false,
  moveTo: null,
  markRead: false,
  delete: false,
  stop: false,
  other: [],
  readOnly: false,
  hasError: false
}

/** Settings → Rules: the account's server rules (Microsoft 365), in order */
export function RulesSettings({ accounts, draft }: { accounts: Account[]; draft?: RuleDraft }) {
  const [accountId, setAccountId] = useState(draft?.accountId ?? accounts.find((a) => a.kind === 'microsoft')?.id ?? accounts[0]?.id ?? '')
  const [result, setResult] = useState<RulesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [folders, setFolders] = useState<Folder[]>([])
  const [editing, setEditing] = useState<MailRule | null>(draft ? { ...EMPTY, ...draft.rule } : null)
  const account = accounts.find((a) => a.id === accountId)

  const load = async () => {
    if (!accountId) return
    setError(null)
    try {
      setResult(await api.listRules(accountId))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    setResult(null)
    void load()
    if (accountId) void api.listFolders(accountId).then(setFolders)
  }, [accountId])

  /** Run a change, then show the rules as the server now has them */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const folderName = (id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? 'a deleted folder') : '')

  return (
    <>
      <p className="hint">
        Rules sort new mail as it arrives in your Inbox. They're kept on your mail server, so they keep working when Letterwing is closed and on your other devices.
      </p>
      {accounts.length > 1 && (
        <label>
          Account
          <select value={accountId} onChange={(e) => (setEditing(null), setAccountId(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.email})
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="error">{error}</div>}
      {!accounts.length && <p className="hint">Add an account first.</p>}
      {accounts.length > 0 && !result && !error && <p className="hint">Loading rules…</p>}
      {result?.state === 'unsupported' && <p className="hint">Rules aren't available for {account?.email ?? 'this account'} yet. For now they work with Microsoft 365 accounts.</p>}
      {result?.state === 'needsApproval' && account && <NeedsApproval account={account} adminLink={result.adminLink} onAllowed={() => void load()} />}
      {result?.state === 'ok' &&
        (editing ? (
          <RuleEditor
            rule={editing}
            folders={folders}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(rule) =>
              void run(async () => {
                await api.saveRule(accountId, rule)
                setEditing(null)
              })
            }
          />
        ) : (
          <>
            {result.rules.length === 0 && <p className="hint">No rules yet.</p>}
            <div className="rules">
              {result.rules.map((r, i) => {
                const editable = !r.readOnly && r.other.length === 0
                return (
                  <div key={r.id} className={`rule ${r.enabled ? '' : 'off'}`}>
                    <input
                      type="checkbox"
                      title={r.enabled ? 'On: click to switch off' : 'Off: click to switch on'}
                      checked={r.enabled}
                      disabled={busy || r.readOnly}
                      onChange={(e) => void run(() => api.setRuleEnabled(accountId, r.id, e.target.checked))}
                    />
                    <div className="grow">
                      <div className="rule-name">
                        {r.name}
                        {r.hasError && <span className="rule-warn"> · not working: the server reports a problem (often a deleted folder)</span>}
                      </div>
                      <div className="rule-summary">{summary(r, folderName)}</div>
                    </div>
                    <button className="ghost small" title="Run earlier" disabled={busy || i === 0} onClick={() => void run(() => api.moveRule(accountId, r.id, -1))}>
                      ↑
                    </button>
                    <button className="ghost small" title="Run later" disabled={busy || i === result.rules.length - 1} onClick={() => void run(() => api.moveRule(accountId, r.id, 1))}>
                      ↓
                    </button>
                    <button
                      className="ghost small"
                      disabled={busy || !editable}
                      title={editable ? 'Change this rule' : 'Made elsewhere with options Letterwing can’t edit. You can switch it on or off, reorder or delete it.'}
                      onClick={() => setEditing(r)}
                    >
                      Edit
                    </button>
                    <button
                      className="ghost small danger"
                      disabled={busy || r.readOnly}
                      onClick={async () => {
                        if (await api.confirm({ message: `Delete the rule "${r.name}"?`, detail: 'Mail it already sorted stays where it is.', ok: 'Delete' }))
                          void run(() => api.deleteRule(accountId, r.id))
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="row">
              <button className="ghost" disabled={busy} onClick={() => setEditing({ ...EMPTY })}>
                New rule
              </button>
              {result.rules.length > 1 && <span className="hint">Rules run from the top down.</span>}
            </div>
          </>
        ))}
    </>
  )
}

function NeedsApproval({ account, adminLink, onAllowed }: { account: Account; adminLink: string | null; onAllowed(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="admin-help">
      <p>
        To manage rules, Letterwing needs one more permission from Microsoft: <b>read and write your mailbox settings</b>. Mail and calendar keep working without
        it.
      </p>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await api.allowRules(account.id)
              onAllowed()
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Waiting for the browser…' : 'Allow in the browser…'}
        </button>
        {busy && (
          <button className="ghost" onClick={() => void api.cancelSignIn()}>
            Cancel
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {adminLink && (
        <>
          <p className="hint">
            If the browser says <b>Need admin approval</b>, send this link to your IT administrator. Once they accept, come back here: it works without signing in
            again.
          </p>
          <div className="row">
            <input readOnly value={adminLink} onFocus={(e) => e.currentTarget.select()} />
            <button className="ghost" onClick={() => void api.copyText(adminLink)}>
              Copy
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** "From helpdesk@… → Move to Helpdesk, mark as read" */
function summary(r: MailRule, folderName: (id: string | null) => string): string {
  const when = [
    r.from.length && `from ${r.from.join(' or ')}`,
    r.sentTo.length && `sent to ${r.sentTo.join(' or ')}`,
    r.subjectContains.length && `subject has ${quoted(r.subjectContains)}`,
    r.bodyOrSubjectContains.length && `subject or body has ${quoted(r.bodyOrSubjectContains)}`,
    r.hasAttachments && 'has attachments'
  ].filter(Boolean)
  const then = [r.moveTo && `move to ${folderName(r.moveTo)}`, r.markRead && 'mark as read', r.delete && 'delete', r.stop && 'stop here'].filter(Boolean)
  // With conditions only in `other`, it isn't "all new mail"
  const main = `${when.length ? `When ${when.join(', ')}` : r.other.length ? 'When (see below)' : 'All new mail'} → ${then.join(', ') || '(see below)'}`
  return r.other.length ? `${main}. Also: ${r.other.join('; ')}` : main
}

const quoted = (v: string[]) => v.map((x) => `"${x}"`).join(' or ')
/** Lists are typed comma (or semicolon) separated */
const split = (s: string) =>
  s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)

function RuleEditor({ rule, folders, busy, onSave, onCancel }: { rule: MailRule; folders: Folder[]; busy: boolean; onSave(r: MailRule): void; onCancel(): void }) {
  const [name, setName] = useState(rule.name)
  const [from, setFrom] = useState(rule.from.join(', '))
  const [sentTo, setSentTo] = useState(rule.sentTo.join(', '))
  const [subject, setSubject] = useState(rule.subjectContains.join(', '))
  const [any, setAny] = useState(rule.bodyOrSubjectContains.join(', '))
  const [hasAttachments, setHasAttachments] = useState(rule.hasAttachments)
  const [move, setMove] = useState(!!rule.moveTo)
  const [moveTo, setMoveTo] = useState(rule.moveTo ?? '')
  const [markRead, setMarkRead] = useState(rule.markRead)
  const [del, setDel] = useState(rule.delete)
  const [stop, setStop] = useState(rule.stop)

  const noAction = !(move && moveTo) && !markRead && !del
  const noCondition = !split(from).length && !split(sentTo).length && !split(subject).length && !split(any).length && !hasAttachments
  const problem = move && !moveTo ? 'Choose the folder to move to.' : noAction ? 'Choose at least one thing to do.' : null

  return (
    <div className="rule-editor">
      <label>
        Name
        <input value={name} placeholder="e.g. Helpdesk notes" onChange={(e) => setName(e.target.value)} autoFocus={!rule.name} />
      </label>
      <h3>When a new message matches all of these</h3>
      <p className="hint">Separate several with commas: any one of them matches. Leave a box empty to ignore it.</p>
      <label>
        From
        <input value={from} placeholder="helpdesk@example.com, or part of an address like @example.com" onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        Sent to
        <input value={sentTo} placeholder="an address, or part of one" onChange={(e) => setSentTo(e.target.value)} />
      </label>
      <label>
        Subject contains
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label>
        Subject or body contains
        <input value={any} onChange={(e) => setAny(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={hasAttachments} onChange={(e) => setHasAttachments(e.target.checked)} />
        Has attachments
      </label>
      {noCondition && <p className="hint">With nothing filled in, the rule acts on all new mail.</p>}
      <h3>Do this</h3>
      <div className="row rule-move">
        <label className="check">
          <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
          Move to
        </label>
        <select value={moveTo} disabled={!move} onChange={(e) => setMoveTo(e.target.value)}>
          <option value="">Choose a folder…</option>
          {folderOptions(folders).map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {'  '.repeat(depth)}
              {folder.name}
            </option>
          ))}
        </select>
      </div>
      <label className="check">
        <input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} />
        Mark as read
      </label>
      <label className="check">
        <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} />
        Delete (to Deleted Items)
      </label>
      <label className="check">
        <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />
        Stop: don't run the rules below on this message
      </label>
      {problem && <div className="error">{problem}</div>}
      <div className="actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !!problem}
          onClick={() =>
            onSave({
              ...rule,
              name: name.trim() || autoName(split(from), split(subject)),
              from: split(from),
              sentTo: split(sentTo),
              subjectContains: split(subject),
              bodyOrSubjectContains: split(any),
              hasAttachments,
              moveTo: move ? moveTo : null,
              markRead,
              delete: del,
              stop
            })
          }
        >
          {busy ? 'Saving…' : rule.id ? 'Save rule' : 'Create rule'}
        </button>
      </div>
    </div>
  )
}

function autoName(from: string[], subject: string[]): string {
  if (from.length) return `From ${from[0]}`
  if (subject.length) return `Subject "${subject[0]}"`
  return 'New rule'
}

/** Folders in tree order, each with how deep it sits */
function folderOptions(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = []
  const ids = new Set(folders.map((f) => f.id))
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => (x.parentId && ids.has(x.parentId) ? x.parentId : null) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
