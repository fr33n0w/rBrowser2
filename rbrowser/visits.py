"""
How many times you have opened pages of each node.

Counted by the server for every page shown in a tab, whether it came from
the node, from the cache or as an offline copy. Partials and auto-reloads
are not visits: a page refreshing itself every 30 seconds would otherwise
outweigh everything you actually read. Kept apart from the page cache, so
clearing the cache does not reset it.

    cache/visits.json   {"<node hash>": {"count": 12, "last": 1760000000.0}}
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Dict


class Visits:
    def __init__(self, path: str = os.path.join("cache", "visits.json")) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.data: Dict[str, Dict[str, float]] = {}
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                self.data = {k: v for k, v in stored.items()
                             if re.fullmatch(r"[0-9a-f]{32}", k) and isinstance(v, dict)}
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Ignoring unreadable visit counts ({exc})")

    def record(self, node_hash: str) -> int:
        clean = str(node_hash).replace("<", "").replace(">", "").replace(":", "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", clean):
            return 0
        with self.lock:
            entry = self.data.setdefault(clean, {"count": 0, "last": 0})
            entry["count"] = int(entry.get("count", 0)) + 1
            entry["last"] = time.time()
            self._save()
            return entry["count"]

    def count(self, node_hash: str) -> int:
        entry = self.data.get(str(node_hash).lower())
        return int(entry.get("count", 0)) if entry else 0

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(self.data, handle, indent=1)
            os.replace(tmp, self.path)
        except OSError as exc:
            print(f"Could not save visit counts: {exc}")


__all__ = ["Visits"]
