"""
Which NomadNet links the open pages still need.

A node open in a page tab keeps its link while that tab is looked at. The
tab closed, or not looked at for IDLE seconds, the link is torn down and the
next page of that node opens a new one. NomadNet keeps one link to the node
on screen and closes it when another node is opened; without this rBrowser
kept every link until it stopped, and nodes saw visitors for minutes after
they had gone.

Each open page reports its tabs (POST /api/nomadnet/tabs) every few seconds:
the nodes open in them and the one on screen. Several browsers can be open
on the same rBrowser, so a node counts as open if any of them has it.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import RNS

IDLE = 60          # a tab not looked at for this long loses its link
GRACE = 20         # a link no tab has reported yet (page just loaded)
CLIENT_GONE = 45   # a page silent for this long is closed (reports every 15 s)
SWEEP_EVERY = 5


def _hex_set(values: Any) -> Set[str]:
    out = set()
    for v in values if isinstance(values, (list, tuple, set)) else []:
        h = str(v or "").strip().lower()[:32]
        if len(h) == 32 and all(c in "0123456789abcdef" for c in h):
            out.add(h)
    return out


def link_busy(link: Any) -> bool:
    """A request, a file or an image still moving on this link."""
    for attr in ("pending_requests", "incoming_resources", "outgoing_resources"):
        try:
            if getattr(link, attr, None):
                return True
        except Exception:
            pass
    return False


class LinkWatch:
    def __init__(self, links: Dict[bytes, Any], name_of=None,
                 idle: float = IDLE, grace: float = GRACE):
        self.links = links
        self.name_of = name_of
        self.idle = idle
        self.grace = grace
        self.lock = threading.Lock()
        self.clients: Dict[str, Tuple[float, Set[str]]] = {}
        self.watched_at: Dict[str, float] = {}
        self.used_at: Dict[str, float] = {}
        self.closed_now: Set[str] = set()

    def start(self) -> None:
        threading.Thread(target=self._loop, name="link-watch", daemon=True).start()

    def _loop(self) -> None:
        while True:
            time.sleep(SWEEP_EVERY)
            try:
                self.sweep()
            except Exception as exc:
                print(f"⚠️ Link check failed: {exc}")

    def touch(self, dest: bytes, now: Optional[float] = None) -> None:
        """A page or file asked for on this node's link."""
        with self.lock:
            self.used_at[dest.hex()] = now or time.time()

    def report(self, client: str, open_nodes: Iterable, watched: Iterable,
               closed: Iterable = (), gone: bool = False,
               now: Optional[float] = None) -> List[str]:
        now = now or time.time()
        client = str(client or "")[:64] or "?"
        with self.lock:
            if gone:
                self.clients.pop(client, None)
            else:
                self.clients[client] = (now, _hex_set(open_nodes))
            for h in _hex_set(watched):
                self.watched_at[h] = now
            # A page that goes away (closed or reloaded) is only forgotten:
            # its links last GRACE seconds, enough for a reload to report again.
            self.closed_now |= _hex_set(closed)
        return self.sweep(now)

    def _why_close(self, h: str, open_any: Set[str], now: float) -> Optional[str]:
        last = max(self.watched_at.get(h, 0), self.used_at.get(h, 0))
        if h not in open_any:
            if h in self.closed_now or now - last > self.grace:
                return "tab closed"
            return None
        if now - last > self.idle:
            return f"not looked at for {int(self.idle)} s"
        return None

    def sweep(self, now: Optional[float] = None) -> List[str]:
        now = now or time.time()
        drop: List[Tuple[bytes, Any, str]] = []
        with self.lock:
            for c, (seen, _) in list(self.clients.items()):
                if now - seen > CLIENT_GONE:
                    self.clients.pop(c, None)
            open_any: Set[str] = set()
            for _, nodes in self.clients.values():
                open_any |= nodes
            for dest, link in list(self.links.items()):
                h = dest.hex()
                status = getattr(link, "status", None)
                if status == RNS.Link.CLOSED:
                    self.links.pop(dest, None)
                    continue
                if status != RNS.Link.ACTIVE:
                    continue
                if link_busy(link):
                    self.used_at[h] = now
                    continue
                why = self._why_close(h, open_any, now)
                if why:
                    self.links.pop(dest, None)
                    drop.append((dest, link, why))
            self.closed_now.clear()
        closed = []
        for dest, link, why in drop:
            try:
                link.teardown()
            except Exception:
                pass
            name = ""
            try:
                name = self.name_of(dest.hex()) if self.name_of else ""
            except Exception:
                pass
            print(f"🔌 Link to {name or dest.hex()[:16]} closed ({why})")
            closed.append(dest.hex())
        return closed


__all__ = ["LinkWatch", "link_busy", "IDLE", "GRACE"]
