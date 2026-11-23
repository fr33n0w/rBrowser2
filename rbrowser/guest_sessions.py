"""Guest sessions in memory (Guests online): id in the cookie, polled every 5 s, kicks kept by auth.py."""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Dict, List, Optional

TIMEOUT = 30         # s with no contact: away (off the online count)
AWAY_KEEP = 300      # s an away session keeps its identity and place, unless a new guest needs the place
BYE_GRACE = 8        # s after a closed page: a reload is back before
LEAVING_PATHS = ("/api/guest/bye", "/api/nomadnet/tabs")    # beacons of a closing page: not a sign of life

CLIENT_PATHS = (("/api/fetch/", "NomadNet"), ("/api/download/", "NomadNet"), ("/api/rrc/", "RRC"),
                ("/api/retibbs/", "BBS"), ("/api/messenger/", "LXMF"), ("/api/rmap/", "RMAP"))


def new_id() -> str:
    return secrets.token_hex(4)


def client_of(path: str) -> str:
    for prefix, name in CLIENT_PATHS:
        if path.startswith(prefix):
            return name
    return ""


class GuestSessions:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.rows: Dict[str, Dict[str, Any]] = {}
        self.on_end = None          # called with each session id that ends (its identity goes)

    def _ended(self, rows: List[Dict[str, Any]]) -> None:
        if self.on_end:
            for row in rows:
                try:
                    self.on_end(row["id"])
                except Exception as exc:
                    print(f"⚠️ Guest session end {row.get('id')}: {exc}")

    def touch(self, gid: str, address: str, agent: str, path: str = "", device: str = "") -> bool:
        """A request of this guest session; True if the session is new to the list."""
        now = time.time()
        with self.lock:
            row = self.rows.get(gid)
            fresh = row is None
            if fresh:
                row = self.rows[gid] = {"id": gid, "address": address, "agent": agent,
                                        "since": now, "last": now, "clients": []}
            if path in LEAVING_PATHS:
                return fresh
            row["last"], row["address"] = now, address or row["address"]
            row.pop("bye", None)
            if row.pop("away", None) is not None:
                row["back"] = True                  # logged by the next sweep
            if device:
                row["device"] = device          # the browser cookie a Ban also takes
            client = client_of(path)
            if client and client not in row["clients"]:
                row["clients"].append(client)
        return fresh

    def end(self, gid: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            row = self.rows.pop(gid, None)
        self._ended([row] if row else [])
        return row

    def bye(self, gid: str) -> None:
        """The guest page closed: gone in BYE_GRACE s unless it comes back (a reload)."""
        with self.lock:
            row = self.rows.get(gid)
            if row is not None:
                row["bye"] = time.time()

    def end_all(self) -> List[Dict[str, Any]]:
        with self.lock:
            rows, self.rows = list(self.rows.values()), {}
        self._ended(rows)
        return rows

    def expired(self) -> List[Dict[str, Any]]:
        """What changed since the last sweep, each row with "event": away, back or gone.
        Gone (page closed, or away for AWAY_KEEP) are taken off the list."""
        now = time.time()
        events, gone = [], []
        with self.lock:
            for r in list(self.rows.values()):
                if now - r.get("bye", now) > BYE_GRACE or now - r["last"] > TIMEOUT + AWAY_KEEP:
                    del self.rows[r["id"]]
                    gone.append(r)
                    events.append(dict(r, event="gone"))
                elif now - r["last"] > TIMEOUT and "away" not in r:
                    r["away"] = now
                    events.append(dict(r, event="away"))
                elif r.pop("back", False):
                    events.append(dict(r, event="back"))
        self._ended(gone)
        return events

    def evict_away(self) -> Optional[Dict[str, Any]]:
        """A new guest and no place left: the session away the longest gives up its own."""
        now = time.time()
        with self.lock:
            away = [r for r in self.rows.values() if "away" in r or now - r["last"] > TIMEOUT]
            row = min(away, key=lambda r: r["last"]) if away else None
            if row is not None:
                del self.rows[row["id"]]
        self._ended([row] if row else [])
        return row

    def online(self, with_away: bool = False) -> List[Dict[str, Any]]:
        """In now; with_away adds the sessions away (marked "away": True) for the owner's list."""
        now = time.time()
        with self.lock:
            rows = []
            for r in self.rows.values():
                if "bye" in r:
                    continue
                away = now - r["last"] > TIMEOUT
                if away and not with_away:
                    continue
                row = {k: v for k, v in dict(r, clients=list(r["clients"])).items() if k not in ("device", "back")}
                row["away"] = away
                rows.append(row)
        return sorted(rows, key=lambda r: r["since"])

    def count(self) -> int:
        return len(self.online())
