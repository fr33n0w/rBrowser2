# rBrowser changelog

What changes in each version. rBrowser reads this file from GitHub when an
update is out, and shows the new entries in Settings > About.

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
