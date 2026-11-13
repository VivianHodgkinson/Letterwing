# Connecting accounts

People using Letterwing just type their email address and click **Sign in with Google / Microsoft**. For that to work,
whoever builds Letterwing registers a sign-in app with Google and Microsoft **once**, and puts the IDs in `.env.local`
(git-ignored; copy `.env.example`). They are built into the app; nobody else ever sees a client-ID box.
(Settings → Accounts → *Advanced* can override them, for testing another registration.)

Desktop apps can't keep secrets, so these IDs identify the app rather than protect anything: sign-in is protected by
PKCE, the user's own Google/Microsoft login (with MFA), and tokens kept in the OS keyring. Still, keep them out of
public repositories.

After editing `.env.local`, restart `npm run dev` (or rebuild). For CI builds, put the same values in the repository
secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` and `MICROSOFT_TENANT`.

## Microsoft 365 / Exchange Online / personal Microsoft accounts

1. Entra admin center → **App registrations → New registration**
   - Name: `Letterwing`
   - Supported account types: **Accounts in any organizational directory (multitenant)**. Pick
     "...and personal Microsoft accounts" too if you want personal accounts as well.
   - Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost`
     (Microsoft allows any port on localhost for this platform, which Letterwing needs).
2. **Authentication** → *Allow public client flows*: **Yes**.
3. **API permissions** → Microsoft Graph → Delegated: `offline_access`, `User.Read`, `Mail.ReadWrite`,
   `Mail.Send`, `Calendars.ReadWrite`.
4. Put the **Application (client) ID** in `.env.local` as `MAIN_VITE_MICROSOFT_CLIENT_ID`. Use `MAIN_VITE_MICROSOFT_TENANT=common`
   if you ticked personal Microsoft accounts too, otherwise leave it as `organizations`.
5. In each **other** tenant (Vital, iMas, ...): the first sign-in as an admin shows a consent prompt. Tick
   *Consent on behalf of your organization* so other users there aren't blocked. Or grant it ahead of time:
   `https://login.microsoftonline.com/<tenant-domain>/adminconsent?client_id=<client-id>`


## Google / Gmail

1. [Google Cloud console](https://console.cloud.google.com/) → create a project (e.g. "Letterwing").
2. **APIs & Services → Library**: enable *Gmail API*, *Google Calendar API* and *CalDAV API*.
3. **Google Auth Platform → Branding / Audience** (the OAuth consent screen):
   - App name `Letterwing`, your support email.
   - **Audience** – this is the important choice:
     - **Internal**: only if every account is in *one* Google Workspace organisation that owns this project. No
       verification, no warnings, no limits. Not possible for personal @gmail.com accounts.
     - **External**: needed for @gmail.com (or several organisations). Full mailbox access is a *restricted* scope,
       so Google wants a paid security review before it lets the general public in. For yourself and colleagues you
       don't need that:
       - *Testing*: add each person under **Test users** (up to 100). They see a "Google hasn't verified this app"
         screen once. **Sign-ins expire after 7 days** in this mode, so people re-sign weekly.
       - *In production, unverified*: fill in **Branding** (homepage `https://vivianhodgkinson.github.io/Letterwing/`,
         privacy policy `https://vivianhodgkinson.github.io/Letterwing/privacy.html`, authorised domain
         `vivianhodgkinson.github.io`), then click **Publish app** and skip verification. Same warning screen, up to 100
         users, but sign-ins don't expire. This is the practical choice for a small team.
4. **Data access → Add scopes**: `https://mail.google.com/`, `https://www.googleapis.com/auth/calendar`, `openid`,
   `email`.
5. **Clients → Create client → Desktop app**, name `Letterwing`. Put the client ID and secret in `.env.local` as
   `MAIN_VITE_GOOGLE_CLIENT_ID` and `MAIN_VITE_GOOGLE_CLIENT_SECRET`. (Google calls it a secret, but for Desktop
   clients it's documented as not confidential; PKCE is what protects the sign-in.)

## Anything else (IMAP/SMTP)

Addresses that aren't Google or Microsoft (detected from the domain and its MX records) ask for a password, with
server settings filled in where known. The password is encrypted with your system
keyring (KWallet on Plasma, GNOME Keyring elsewhere). If neither is running, Letterwing refuses to save it rather
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
  your CalDAV calendar the answer goes through it; otherwise Letterwing emails a standard iCalendar reply to the
  organizer, which Classic, Google and others understand. Like Classic, the answered invitation is then deleted.
