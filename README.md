# Inkwell

A customisable desktop mail and calendar client: the parts of Classic worth keeping, without being stuck with it.
Built with Electron, React and TypeScript, the same stack as [Verdigit](../Verdigit).

```sh
npm install
npm run dev        # hot reload
npm test           # cache/search tests (runs in Electron's Node, real SQLite)
npm run typecheck
npm run dist:linux
```

First run: see [docs/SETUP.md](docs/SETUP.md) to register the Microsoft / Google apps, then **+ Add account**.

## Architecture

```
renderer (React)  ──IPC──▶  main process
                             ├─ db.ts          SQLite cache + FTS5 search (node:sqlite, no native modules)
                             ├─ sync.ts        background sync, one connector per account
                             ├─ oauth.ts       browser sign-in, PKCE + loopback, token refresh
                             ├─ store.ts       settings/accounts JSON; secrets via OS keyring (safeStorage)
                             └─ connectors/    one class per backend, all implementing MailConnector
                                 ├─ graph.ts   Microsoft 365 via Graph (delta sync)
                                 └─ imap.ts    any IMAP server; Gmail via XOAUTH2
```

The UI only reads from the local cache, so it's fast and works offline. **Adding a backend** (EWS, JMAP, POP3...)
means implementing `MailConnector` in `src/main/connectors/` and adding a case to `connectors/index.ts`.

**Customising:** every colour and size is a CSS variable. Settings → Theme has presets, a colour picker and a raw
JSON box for any variable in `styles.css`. Reading pane right/bottom/off, three densities, per-account badge colours.

Privacy: mail HTML is sanitised (DOMPurify) and shown in a sandboxed iframe with no scripts and its own CSP.
Remote images (tracking pixels) are blocked until you click *Load images*.

**Keyboard:** the classic shortcuts by default (`Ctrl+Q` read, `Ctrl+U` unread, `Insert` flag, `Ctrl+E`/`F3` search,
`F9` send/receive, `Ctrl+.`/`Ctrl+,` next/previous...). Settings → Keyboard switches to the Single-key scheme or rebinds any
action, including multi-key sequences like `G I`, with conflict warnings. Shortcuts live in `src/shared/keys.ts`: a new
action is one entry in `ACTIONS` plus a handler in `App.tsx`. `F12` opens devtools.

## Roadmap

- [x] **M1 - Read:** accounts (M365, Google, IMAP), folder tree, unified inbox, sync, offline cache, search, flags, themes
- [ ] **M2 - Write:** compose/reply/forward, HTML signatures per account, drafts, send (SMTP / Graph), move, delete,
      archive, open/save attachments, inline `cid:` images, IMAP IDLE push, desktop notifications, threading,
      virtualised list
- [ ] **M3 - Calendar:** Graph calendar, CalDAV (Google, iCloud, Fastmail, Nextcloud), ICS subscriptions;
      day/week/month views; meeting invites in mail with accept/decline
- [ ] **M4:** contacts and address autocomplete, rules, snooze, templates, keybinding editor, EWS (on-prem Exchange), JMAP
