# rBrowser changelog

What changes in each version. rBrowser reads this file from GitHub when an
update is out, and shows the new entries in Settings > About.

## 2.0.8b - 2026-11-24

- Far fewer page requests (thanks Ant9000).
- Node list sends only changes.
- Full screen button on phones.
- Sticker button names its pack.
- Fixed settings saved every 4 s.

## 2.0.7b - 2026-11-23

- Added Radio tab (radio-lxst).
- Radio: identity picker, guests allowed.
- Radio: sends your name to stations.
- Radio: station commands pane.
- Radio: shows subscribed stations.
- Radio: station state asked, not announced.
- Radio: station list scrolls in place.
- Radio: track bar and live text.
- Radio: Next and Random buttons.
- Radio: retries a station not found.
- Radio: quality applies at once.
- Radio: fewer gaps after Play.
- Added RRC Micron colours and art (thanks mmoyles87).
- Added RRC Markdown as NomadNet.
- Added RRC ASCII fonts and decorations.
- Added RRC stickers.
- Added Telegram sticker sets.
- Added recent stickers and previews.
- Fixed outline emoji on Windows.
- Fixed nodes asking link stamps.
- Link stamps on all CPU cores.
- Added RRC colours sent to NomadNet.
- Fixed RRC bold text.
- Fixed RRC mentions in reply quotes.
- Fixed NomadNet pages all in bold.
- Added light theme.
- Added identity hash in Saved identities.
- Added node links closed with their tab.
- Removed ephemeral identity.
- Added guest actions log.
- Added guest identity in NomadNet and BBS (thanks dr4kk4r).
- Added guest switches for favorites and history.
- Fixed guest mode switch off.
- Added guest identity in RRC.
- Added fixed RRC hub for guests.
- Added own identity for each guest.
- Added guest LXMF text log switch.
- Added unsaved changes reminder in Settings.
- Added guest theme switch.
- Added rB2 Monitor (MON tab).
- Fixed guests reading owner settings.
- Fixed false unsaved changes in Settings.
- Fixed splash screen switch.
- Changed NomadNet top bar icons.
- Added guests online list and count.
- Added notice when main instance stops.
- Added guest access log.
- Added guest notice when access closes.
- Added faster tooltips everywhere.
- Added tooltips on every menu item.
- Added RRC delivery check and Retry.
- Fixed Update now stuck on Windows.
- Added --set-password and --guest-setup.
- Added log out in the status bar.
- Added guest sessions kept across restarts.

## 2.0.6b - 2026-11-05

- Added app window mode (--app).
- Added Autostart on boot.
- Added desktop and menu shortcuts.
- Added splash screen and logo.
- Added download queue, speed and time left.
- Added File Downloads settings.
- Added RRC colours and effects.
- Added RRC chat text size.
- Added RRC emoji pages.
- Added /unban and /unkline.
- Added update button in top bar.
- Added version in top bar.
- Added running on addresses.
- Added battery in status bar.
- Added --info terminal view.
- Added Change password popup.
- Added FreeDNS domain option.
- Added internet check interval.
- Added RRC sound button.
- Added Reload button in Settings.
- Added open buttons for saved files.
- Screenshots follow File Downloads.
- Added flag emoji on Windows.
- Added install guide PDFs.
- Default RRC nick now on.
- Improved short status bar.
- Improved phone landscape layout.
- Battery shows the device in use.
- Fixed form fields named "name".
- Fixed Docker LXMF start and downloads.
- Fixed mobile address bar while typing.
- Fixed RRC retries on a dead path.
- Added hint for rnsd of another user.

## 2.0.5b - 2026-10-29

- Added Custom address generator.
- Added Restart and Shut down buttons.
- Added universal status bar.
- Added RRC timestamp options.
- Added Reticulum interface watch.
- Added time server internet check.
- Added installer venv option.
- Added Settings tab on phones.
- Improved terminal log layout.
- Fixed Termux cryptography install.
- Fixed RRC header on small windows.
- Fixed identity lists not refreshing.
- Fixed browser console warnings.
- Fixed hidden input bar on Kiwi.

## 2.0.4b - 2026-10-27

- Added Auto-check updates every N hours.
- Fixed restart on Linux updates.
- Fixed update button style. (cosmetic)
- Fixed install.bat blocking git pull auto-updates.
- Network disconnection log in terminal and webui.

## 2.0.3b - 2026-10-27

- Added Auto-Update on new releases.
- Fixed restart as a service.

## 2.0.2b - 2026-10-26

- RRC: green badge for new joins on rooms and tabs.

## 2.0.1b - 2026-10-26

- Links from rmap.world: "Open in rBrowser2" on the map, the node list and the services page opens NomadNet pages, RRC hubs and rooms, propagation nodes and RetiBBS straight in rBrowser.
- Links are on by default: `nomadnetwork://`, `rrc://` and `rbrowser://` are registered at start, only where no other program has them (Settings > System > Links turns them off).
- Links use NomadNet's own syntax: `<hash>:/page/...`, `lxmf@<hash>`, `lxmf.propagation@<hash>`, `retibbs.bbs@<hash>`, `rrc://<hub>/<room>`.
- Safer links from outside: only well formed links open; joining an RRC hub or a BBS, or changing the propagation node, is asked first.
- RRC chat: time stamps with the date (`[26/10 00:41:47]`).
- RRC chat on phones: each message is one flowing line, the text wraps under the whole line; the tab of the room you open scrolls into view.
- `rrc://<hub>:<dest>/<room>` links (NomadNet's form) are read correctly.
- What's new in an update is shown in Settings > About and in the update window (this file).
- NomadNet pages: a section heading takes the colours of its first text for the whole bar, as in NomadNet (headings starting with a colour code were hard to read).

## 2.0.0b - 2026-10-25

- First public beta of rBrowser 2.
