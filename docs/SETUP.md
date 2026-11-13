# Connecting accounts

Inkwell signs in to Microsoft and Google with OAuth through your browser, so it never sees those passwords.
Each provider needs an "app registration" once. The IDs go in **Settings → Accounts**; they are not secrets in the
usual sense (desktop apps can't keep secrets), but don't commit them to a public repo anyway.

## Microsoft 365 / Exchange Online / personal Microsoft accounts

1. Entra admin center → **App registrations → New registration**
   - Name: `Inkwell`
   - Supported account types: **Accounts in any organizational directory (multitenant)**. Pick
     "...and personal Microsoft accounts" too if you want personal accounts as well.
   - Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost`
     (Microsoft allows any port on localhost for this platform, which Inkwell needs).
2. **Authentication** → *Allow public client flows*: **Yes**.
3. **API permissions** → Microsoft Graph → Delegated: `offline_access`, `User.Read`, `Mail.ReadWrite`,
   `Mail.Send`, `Calendars.ReadWrite`.
4. Copy the **Application (client) ID** into Settings → *Microsoft app (client) ID*.
5. In each **other** tenant (Vital, iMas, ...): the first sign-in as an admin shows a consent prompt. Tick
   *Consent on behalf of your organization* so other users there aren't blocked. Or grant it ahead of time:
   `https://login.microsoftonline.com/<tenant-domain>/adminconsent?client_id=<client-id>`

When adding the account, set *Tenant* to that tenant's domain (e.g. `contoso.co.za`) or leave `organizations`.

## Google / Gmail

1. Google Cloud console → new project → **APIs & Services → Enable** *Gmail API*, *Google Calendar API* and
   *CalDAV API* (Inkwell reads Google calendars over CalDAV).
2. **OAuth consent screen**: *Internal* if all accounts are in one Workspace org; otherwise *External* and add
   yourself as a test user. Scopes: `https://mail.google.com/`, `.../auth/calendar`, `openid`, `email`.
   - Note: External apps left in *Testing* mode get refresh tokens that expire after 7 days, so you'll have to
     sign in again weekly. Publishing the app (unverified is fine for personal use) avoids that.
3. **Credentials → Create OAuth client ID → Desktop app.** Copy the client ID and secret into Settings.

## Anything else (IMAP/SMTP)

Choose *Other (IMAP)*, enter the server details and password. The password is encrypted with your system
keyring (KWallet on Plasma, GNOME Keyring elsewhere). If neither is running, Inkwell refuses to save it rather
than storing it in plain text.

Common servers: Fastmail `imap.fastmail.com` / `smtp.fastmail.com`; iCloud `imap.mail.me.com` / `smtp.mail.me.com`
(app-specific password); cPanel hosts usually `mail.<domain>` on 993 / 465.

## Calendars

- **Microsoft 365** and **Google** accounts bring their calendars automatically (the sign-in already asks for
  calendar access). Invitations you send are delivered by Microsoft / Google.
- **IMAP accounts**: add the provider's CalDAV address in Settings → Accounts → *Name & signature*. It uses the
  same login. Fastmail `https://caldav.fastmail.com/`, iCloud `https://caldav.icloud.com/` (app-specific
  password), Nextcloud `https://<host>/remote.php/dav`. Servers with CalDAV scheduling (those three do) send
  invitations and replies for you.
- **Subscriptions**: Settings → Calendars takes any `.ics` / `webcal://` link (public holidays etc.). Read-only.
- **Answering invitations in mail**: Microsoft answers through Exchange. Elsewhere, if the event is already in
  your CalDAV calendar the answer goes through it; otherwise Inkwell emails a standard iCalendar reply to the
  organizer, which Classic, Google and others understand. Like Classic, the answered invitation is then deleted.
