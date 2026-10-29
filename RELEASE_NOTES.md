# rBrowser release notes

Everything that changed in each version, in full. The short list is in
[CHANGELOG.md](CHANGELOG.md).

## 2.0.5b - 2026-10-29

### New

- **Custom address generator** - Settings > Identity > Generate vanity address: a new identity whose LXMF address (or, for RRC, its identity hash) starts or ends with characters you choose (`c0ffee…`, `…c0ffee`). It runs in the background on the computer that runs rBrowser and shows the attempts, the speed and the expected time; each character more takes 16 times longer, so keep it short on a Raspberry Pi. Save it, use it, or export it.
- **Restart and Shut down** - two buttons at the foot of the Settings categories, each asks first (not shown to guests).
- **One status bar for the whole window** - out of the node list, one line across the window whatever client is open, also in the clients' own windows. Settings > System > Status bar: at the top (default) or at the bottom.
  - Connection state, then icons with their numbers: all the announces received (every kind), NomadNet nodes, and for each client that is on: LXMF peers, propagation nodes, RRC hubs, BBS servers, RMAP nodes. The numbers are what was heard live since rBrowser started; the tooltip adds how many the client knows (also from Reticulum's memory). A client switched off takes its icon away.
  - CPU, RAM and the page's memory at the right end, then a small clock (local time, the date on hover).
  - On a phone the same line, icons only, scrolling sideways when it does not fit.
- **RRC timestamps** - Settings > RRC Client: timestamps in the rooms on or off, separately on a computer and on a phone, and short (hh:mm) on a computer as on a phone. The hub tab always keeps the full time, for drops and modes.
- **Auto-close the NomadNet list on small screens** - Settings > RRC Client, on by default: in a window under 1200 px, opening RRC closes the node list to give the chat room; the » button opens it again, and leaving RRC brings it back.

- **Reticulum interfaces watched** - always on, nothing sent: an interface to the network going down (a TCP link lost, a phone out of coverage) or coming back is a line in the terminal; with none up the status bar says "Reticulum interface disconnected" in red, with a notification. An RNode on the air keeps Reticulum connected.
- **Internet check with a time server** - Settings > System > Internet check: check with a time server (NTP, one small UDP packet, the default: `pool.ntp.org`) or with a connection to hosts you choose. A **Test** button asks each server in the list at once, so a dead server is not taken for a dead line. When it fails the status bar says "No internet connection".

### Changed

- RRC: "Compact joins and parts" is off by default on new installs (an existing setting is kept).
- Terminal log: the lines of `=` are gone, blocks are set apart by one blank line; every line has its time, also the startup ones; the title line and its link fit a phone's terminal.
- Internet check: still off by default. An existing setting keeps checking its hosts.
- Installer (`install.sh`): on Debian 12+, Ubuntu and Pi OS it asks whether to install in a venv inside the rBrowser folder or for your user with `--break-system-packages`; in a venv you have activated it installs there without asking. On Termux it uses the prebuilt `python-cryptography`, so nothing is compiled (Python 3.14 failed asking for `ANDROID_API_LEVEL`). Thanks to Ant9000.
- Phones: the Settings icon is in the tab bar too, as small as the "+".

### Fixed

- RRC: in a narrow window (or with the browser's developer tools open) the hub and room header squeezed its name and hashes to a letter a line and the chat got no room at all. The buttons now go to the line below, and become icons when the column is narrow.
- Identity lists in Messenger, RRC and BBS settings did not show an identity imported, renamed or deleted while Settings were open.
- Browser console: no more "form field without label" issues, and the sound unlock waits for a real tap (on phones the first touch did not unlock the sounds).
- A rare error in the console when Settings were closed while the remote access state was being read.
- Phones: the node list cards have the info and favourite buttons again, next to hide, all the same size.
- Phones: on Kiwi Browser the bottom of the window, with the text box of Messenger, RRC and BBS, was hidden behind Android's buttons. The page now takes the height the browser really shows.

### Tested on

Windows 10, Linux Mint 21 (Python 3.12.3), Raspberry Pi Zero 2 W (fresh install: ~52 MB of RAM with NomadNet only; installer in a venv and as a system service), Android Termux 0.118.0 (Python 3.14).

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

- Links from rmap.world: "Open in rBrowser2" opens NomadNet pages, RRC hubs and rooms, propagation nodes and RetiBBS straight in rBrowser.
- `nomadnetwork://`, `rrc://` and `rbrowser://` links registered at start (Settings > System > Links turns them off).
- RRC chat: time stamps with the date, better layout on phones.
- What's new in an update is shown in Settings > About and in the update window.

## 2.0.0b - 2026-10-25

First public beta of rBrowser2: a web browser for NomadNet over Reticulum,
rewritten from scratch. Runs on Windows, Linux, Raspberry Pi, macOS,
Android (Termux) and Docker.

**What's in it**
- NomadNet browser: tabs, favourites, forms, file downloads, inline images,
  page cache and a local search over the pages you have visited
- LXMF messenger: several identities, attachments, voice messages,
  propagation nodes, stamps, automatic replies
- RRC chat client, RetiBBS client, RMAP map of the network
- Access password, guest mode, remote access through a Cloudflare tunnel
- No background crawler: rBrowser only requests the pages you open

**Install**
- Linux, Raspberry Pi, macOS, Termux: `bash install.sh`
- Windows: `install.bat`
- Docker: `bash docker.sh`

On the first start only the NomadNet browser is on: the LXMF, RRC, BBS
and RMAP clients are switched on in Settings.

Read complete info on the full README.MD.

This is a beta: please report bugs by opening an issue.
