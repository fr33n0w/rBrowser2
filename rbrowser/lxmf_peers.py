"""
LXMF peers heard on the network: every lxmf.delivery announce, as real LXMF
clients list them (Sideband's announce stream), for the Messages tab's Peers
panel and New message's suggestions.

Passive: only announces that arrive, nothing is sent. Kept in memory, at
most MAX (the oldest heard drops out), and filled at start from the
announces Reticulum already remembers (Identity.known_destinations, last
PREFILL_HOURS), so the panel is not empty after a restart.

Each peer: its LXMF display name and stamp cost from the announce, when it
was heard, and the hash of the NomadNet node the same identity would run -
to tell people who also run a node from those who only use LXMF.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import RNS

MAX = 5000
PREFILL_HOURS = 48
LIST_LIMIT = 200


def _display_name(app_data: Optional[bytes]) -> str:
    try:
        from .nomadnet import decode_lxmf_display_name
        return decode_lxmf_display_name(app_data) or ""
    except Exception:
        return ""


def _stamp_cost(app_data: Optional[bytes]) -> Optional[int]:
    try:
        import LXMF
        return LXMF.stamp_cost_from_app_data(app_data)
    except Exception:
        return None


class LxmfPeers:
    aspect_filter = "lxmf.delivery"
    receive_path_responses = True

    def __init__(self, browser: Any = None) -> None:
        self.browser = browser
        self.lock = threading.Lock()
        self.peers: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        # Heard live since rBrowser started (not the prefill from Reticulum's
        # memory, not an answer to a path request): the status bar's number.
        self.live: set = set()
        self._registered = False
        self.revision = 0

    def register(self) -> None:
        if self._registered:
            return
        RNS.Transport.register_announce_handler(self)
        self._registered = True
        threading.Thread(target=self.prefill, name="lxmf-peers-prefill", daemon=True).start()

    def _add(self, dest_hash: bytes, identity: Any, app_data: Optional[bytes], heard: float) -> None:
        h = dest_hash.hex()
        try:
            node = RNS.Destination.hash(identity, "nomadnetwork", "node").hex()
        except Exception:
            node = ""
        entry = {"address": h, "name": _display_name(app_data), "stamp_cost": _stamp_cost(app_data),
                 "heard": heard, "node": node}
        with self.lock:
            old = self.peers.get(h)
            if old and old["heard"] > heard:
                return
            if old and not entry["name"]:
                entry["name"] = old["name"]
            self.peers[h] = entry
            self.peers.move_to_end(h)
            while len(self.peers) > MAX:
                self.peers.popitem(last=False)
            self.revision += 1

    def received_announce(self, destination_hash: bytes, announced_identity: Any,
                          app_data: Optional[bytes], *args: Any, **kwargs: Any) -> None:
        if announced_identity is None:
            return
        if not kwargs.get("is_path_response"):
            self.live.add(destination_hash.hex())
        self._add(destination_hash, announced_identity, app_data, time.time())

    def prefill(self) -> None:
        """The lxmf.delivery announces Reticulum remembers, heard within
        PREFILL_HOURS. A destination is one only if its hash, worked out
        from the identity and the name, is the same."""
        cutoff = time.time() - PREFILL_HOURS * 3600
        try:
            known = list(RNS.Identity.known_destinations.items())
        except Exception:
            return
        found = []
        for dest_hash, entry in known:
            try:
                heard, public_key, app_data = entry[0], entry[2], entry[3]
                if heard < cutoff or not public_key:
                    continue
                identity = RNS.Identity(create_keys=False)
                identity.load_public_key(public_key)
                if RNS.Destination.hash(identity, "lxmf", "delivery") == dest_hash:
                    found.append((heard, dest_hash, identity, app_data))
            except Exception:
                continue
        for heard, dest_hash, identity, app_data in sorted(found, key=lambda f: f[0]):
            self._add(dest_hash, identity, app_data, heard)

    def listing(self, query: str = "", own: Optional[str] = None, limit: int = LIST_LIMIT) -> Dict[str, Any]:
        """Newest first, split in LXMF only / also running a NomadNet node;
        at most `limit` of each, plus the totals."""
        words = [w for w in str(query or "").lower().split() if w]
        nodes = getattr(self.browser, "nomadnet_nodes", {}) if self.browser else {}
        with self.lock:
            rows = list(reversed(self.peers.values()))
        groups: Dict[str, List[Dict[str, Any]]] = {"lxmf_only": [], "with_nomad": []}
        totals = {"lxmf_only": 0, "with_nomad": 0}
        for p in rows:
            if own and p["address"] == own:
                continue
            if words:
                hay = f"{p['name']} {p['address']}".lower()
                if not all(w in hay for w in words):
                    continue
            node_key = RNS.prettyhexrep(bytes.fromhex(p["node"])) if p["node"] else ""
            group = "with_nomad" if node_key and node_key in nodes else "lxmf_only"
            totals[group] += 1
            if len(groups[group]) < limit:
                row = dict(p)
                if group == "with_nomad":
                    row["node_name"] = nodes[node_key].get("name", "")
                groups[group].append(row)
        # Hops only for the rows shown: one table lookup each.
        for row in groups["lxmf_only"] + groups["with_nomad"]:
            try:
                hops = RNS.Transport.hops_to(bytes.fromhex(row["address"]))
                row["hops"] = hops if hops != RNS.Transport.PATHFINDER_M else None
            except Exception:
                row["hops"] = None
        return {"status": "success", "total": len(rows), "totals": totals, "groups": groups,
                "revision": self.revision}


__all__ = ["LxmfPeers", "MAX", "PREFILL_HOURS"]
