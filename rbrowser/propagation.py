"""
LXMF propagation nodes heard on the network, for the messenger.

A propagation node keeps messages for recipients that are offline: a message
handed to it waits there, and the recipient collects it with a sync. Nodes
announce themselves on "lxmf.propagation" with app data that LXMF defines:

    [legacy, timebase, node_active, transfer_limit_kb, sync_limit_kb,
     [stamp_cost, stamp_flexibility, peering_cost], metadata]

It is validated with LXMF's own pn_announce_data_is_valid() and read field by
field the same way LXMF and NomadNet read it. Nothing here sends anything:
the list is built from announces that arrive anyway, and kept on disk so it
is there at the next start.

"Automatic" picks the nearest node that says it is active and has a path,
fewest hops first (NomadNet's rule, which it applies to the nodes you marked
as trusted; rBrowser has no trust list, so every heard node counts).
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Dict, List, Optional

import RNS

FILE = os.path.join("settings", "messenger", "propagation_nodes.json")
FORGET_AFTER = 30 * 86400        # not heard for a month: dropped from the list


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace").replace("\x00", "").strip()
        except Exception:
            return ""
    return str(value).strip() if value is not None else ""


def parse_announce(app_data: Optional[bytes]) -> Optional[Dict[str, Any]]:
    """The fields of a propagation node announce, or None when LXMF itself
    would not accept it."""
    try:
        import LXMF
        from LXMF import LXMF as lxmf_mod
        import RNS.vendor.umsgpack as msgpack
        if not LXMF.pn_announce_data_is_valid(app_data):
            return None
        data = msgpack.unpackb(app_data)
        meta = data[6] if isinstance(data[6], dict) else {}
        return {
            "active": bool(data[2]),
            "timebase": int(data[1]),
            "transfer_limit_kb": int(data[3]),
            "sync_limit_kb": int(data[4]),
            "stamp_cost": int(data[5][0]),
            "stamp_flexibility": int(data[5][1]),
            "peering_cost": int(data[5][2]),
            "name": _text(meta.get(lxmf_mod.PN_META_NAME)),
            "software": _text(meta.get(lxmf_mod.PN_META_IMPL_NAME)),
            "version": _text(meta.get(lxmf_mod.PN_META_VERSION)),
        }
    except Exception:
        return None


class PropagationNodes:
    """Announce handler for lxmf.propagation, and the list it builds."""

    aspect_filter = "lxmf.propagation"
    receive_path_responses = True

    def __init__(self, on_change: Optional[Any] = None) -> None:
        self.lock = threading.Lock()
        self.nodes: Dict[str, Dict[str, Any]] = {}
        # Heard live since rBrowser started (not the prefill from Reticulum's
        # memory, not an answer to a path request): the status bar's number.
        self.live: set = set()
        self.on_change = on_change
        self._registered = False
        self._load()

    # Disk ----------------------------------------------------------------

    def _load(self) -> None:
        try:
            with open(FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            print(f"⚠️ Could not read {FILE}: {exc}")
            return
        now = time.time()
        if isinstance(stored, dict):
            for h, node in stored.items():
                if (isinstance(node, dict) and len(h) == 32
                        and now - float(node.get("heard") or 0) < FORGET_AFTER):
                    self.nodes[h] = node

    def _save(self) -> None:
        from .fileio import atomic_write_json
        try:
            atomic_write_json(FILE, self.nodes, indent=1)
        except OSError as exc:
            print(f"⚠️ Could not save the propagation nodes: {exc}")

    # Announces -----------------------------------------------------------

    def register(self) -> None:
        if not self._registered:
            RNS.Transport.register_announce_handler(self)
            self._registered = True

    def received_announce(self, destination_hash: bytes, announced_identity: Any,
                          app_data: Optional[bytes], *args: Any, **kwargs: Any) -> None:
        info = parse_announce(app_data)
        if info is None:
            return
        h = destination_hash.hex()
        if not kwargs.get("is_path_response"):
            self.live.add(h)
        try:
            info["operator_lxmf"] = RNS.Destination.hash(announced_identity, "lxmf", "delivery").hex()
            info["node"] = RNS.Destination.hash(announced_identity, "nomadnetwork", "node").hex()
        except Exception:
            pass
        info["heard"] = time.time()
        with self.lock:
            fresh = h not in self.nodes
            self.nodes[h] = info
            self._save()
        # Only active ones are worth a line: clients announce theirs as off.
        if fresh and info["active"]:
            label = info["name"] or RNS.prettyhexrep(destination_hash)
            print(f"📮 LXMF propagation node heard: {label}")
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    # Reading -------------------------------------------------------------

    def get(self, h: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            node = self.nodes.get(h)
            return self._describe(h, node) if node else None

    @staticmethod
    def _describe(h: str, node: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(node, hash=h)
        dest = bytes.fromhex(h)
        out["has_path"] = RNS.Transport.has_path(dest)
        out["hops"] = RNS.Transport.hops_to(dest) if out["has_path"] else None
        return out

    def listing(self) -> List[Dict[str, Any]]:
        with self.lock:
            rows = [self._describe(h, n) for h, n in self.nodes.items()]
        rows.sort(key=lambda r: (not r["active"], r["hops"] is None,
                                 r["hops"] if r["hops"] is not None else 99, -(r.get("heard") or 0)))
        return rows

    def nearest(self, exclude: Any = ()) -> Optional[str]:
        """Active, with a path, fewest hops; the most recently heard on a tie.
        exclude: nodes not to pick (the ones that did not answer lately)."""
        best = None
        for row in self.listing():
            if row["active"] and row["has_path"] and row["hash"] not in exclude:
                if best is None or (row["hops"], -(row.get("heard") or 0)) < (best["hops"], -(best.get("heard") or 0)):
                    best = row
        return best["hash"] if best else None

    def freshest(self, exclude: Any = ()) -> Optional[str]:
        """Active, with a path, the most recently heard (the rotation)."""
        rows = [r for r in self.listing() if r["active"] and r["has_path"] and r["hash"] not in exclude]
        return max(rows, key=lambda r: r.get("heard") or 0)["hash"] if rows else None

    def usable(self, h: str) -> bool:
        row = self.get(h)
        return bool(row and row["active"] and row["has_path"])


__all__ = ["PropagationNodes", "parse_announce"]
