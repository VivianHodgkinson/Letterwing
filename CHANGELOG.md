# Changelog

## 0.1.13

- Signatures follow dark mode in the editor: text in the theme's colours, logos and pictures kept as they are.
- Signatures can include pictures: *Add picture…* in Settings → Accounts → Name & signature, or paste or drag one in. A whole signature made as a picture works too.

## 0.1.12

- The message editor follows dark mode too: your text, your signature and the quoted original all in dark colours, with pictures such as logos kept as they are. Recipients still get normal black on white.

## 0.1.11

**Emails follow your theme**
- In dark mode, emails are no longer bright white: plain emails use your theme's colours, and designed emails (newsletters, receipts) are turned dark with their pictures kept in their real colours.
- *Original colours* on any message shows it exactly as sent; Settings → General → *Email colours* can make that the default.

## 0.1.10

**Phishing warnings**
- A red banner on messages that fail your mail server's sender check (they may not really be from who they say), and an amber one for weaker signs, such as a sender name pretending to be another address.

**Block senders**
- Right-click a message → *Block* the sender, or everyone at their domain: their mail goes straight to Junk. Manage the list in Settings → General.
- On Microsoft 365, blocking an address also adds it to Microsoft's own blocked list, so it works on every device.

**Junk and phishing reports**
- *Report phishing* in the message menu.
- On Microsoft 365, *Not junk* uses Microsoft's own action (back to the Inbox, sender unblocked), and *Move to Junk* / *Report phishing* report to Microsoft's filter where available.
- Marking something *Not junk* also lifts a block on its sender.

## 0.1.9

**Printing**
- Print a message or a whole conversation (Ctrl+P, the Print button, or right-click), or save it as a PDF.
- Each message prints with its From / Sent / To / Cc / Subject header; web images only where you loaded them.

**Calendar**
- Drag events to move them to another time or day, or drag the bottom edge to change how long they are (month view too). Escape cancels.
- Repeating events ask whether to change just this event or the whole series when moving, editing or deleting.
- Repeating events on Google and other CalDAV calendars can now be edited, and single occurrences deleted.

**Outbox**
- Mail sent without a connection waits in the Outbox (in the sidebar) and sends itself when you're back online.
- Send now, edit or delete anything waiting there.

**Letterwing as your mail app**
- Settings → General → *Make Letterwing my default mail app*: clicking an email address anywhere opens a new message, filled in.

**Easier sign-in at other organisations**
- Cancel a sign-in that's waiting for the browser.
- If a Microsoft 365 organisation hasn't approved Letterwing yet, Letterwing gives you the exact link to send your IT admin.

## 0.1.8

Not published separately; everything is in 0.1.9.

## 0.1.7

- Messages stay unread while you read them and are marked read when you move off them. Settings → General → *Mark messages as read* offers: when I move off them, as soon as I open them, after 5 seconds, or only when I mark them (Ctrl+Q).
- Marking a message read or unread by hand is always respected.
- Fixed: some new Microsoft 365 messages showed as "(unknown sender)" / "(no subject)" with the wrong time. Affected messages are repaired automatically.

## 0.1.6

- Microsoft 365: new mail shows up within about 10 seconds while Letterwing is on screen (it used to check once a minute), every 30 seconds in the tray, and straight away when you bring the window back or wake the computer.
- The checks are quiet: no spinning sync icon every few seconds.
- Gmail and IMAP accounts, which already get mail instantly, react a little faster.

## 0.1.5

**Fits any window size**
- Adapts to whatever size you give it, for tiling window managers and split screens.
- Narrower windows tuck the folder list into a ☰ drawer; very narrow windows show the message list and the open message one at a time, with a Back button (or Esc).
- The calendar shows Day or Month in narrow windows, and event details float over the grid.
- Settings → General → Layout can force a layout. The window can be as small as 360×400.

**Favourite and colour-coded folders**
- Right-click a folder → *Add to favourites*: favourites from all accounts appear together at the top of the sidebar, and can be reordered.
- Right-click a folder → *Colour*, with 8 colours or any custom colour. Folders keep both when renamed.

**Calendar by account or side by side**
- Show all calendars together, one account at a time, or each account side by side.
- The calendar list is grouped by account, with one tick to show or hide a whole account; right-click a calendar to show only that one or give it your own colour.

**Light and dark mode**
- Switch with the sun/moon button at the top right, or choose Light, Dark or Match system in Settings. Custom theme colours are kept per mode.
- Sync, the light/dark switch and Settings are icons at the far right of the top bar.

## 0.1.4

Not published separately; everything is in 0.1.5.

## 0.1.3

- Microsoft 365 sign-in: work and school accounts, mail and calendar.
- Right-click menus for messages, folders, accounts, All inboxes, calendar events, attachments, and text and links.
- Folder management: mark all as read (on the server), empty Trash/Junk, new, rename and delete folders.
- Permanently deleting from Trash now asks first.

## 0.1.2

- Gmail: sending works.
- Each account's email address shows in the sidebar, so several accounts from the same provider can be told apart.

## 0.1.0 – 0.1.1

Not published (test builds).
