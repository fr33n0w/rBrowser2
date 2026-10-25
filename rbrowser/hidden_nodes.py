"""
Nodes you do not want to see in the node list.

Hidden with the button on the node's card, brought back from Settings >
Hidden nodes. A hidden node is only left out of the list: its pages still
open from an address, a link or a favorite.

    settings/hidden_nodes.json   {"<node hash>": {"name": "...", "hidden_at": 1760000000.0}}
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Dict, List

HIDDEN_FILE = os.path.join("settings", "hidden_nodes.json")


def clean(node_hash: Any) -> str:
    text = str(node_hash or "").replace("<", "").replace(">", "").replace(":", "").strip().lower()
    return text if re.fullmatch(r"[0-9a-f]{32}", text) else ""


class HiddenNodes:
    def __init__(self, path: str = HIDDEN_FILE) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.data: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                self.data = {k: v for k, v in stored.items()
                             if clean(k) == k and isinstance(v, dict)}
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Ignoring unreadable hidden nodes ({exc})")

    def is_hidden(self, node_hash: str) -> bool:
        return str(node_hash).lower() in self.data

    def hide(self, node_hash: str, name: str = "") -> bool:
        key = clean(node_hash)
        if not key:
            return False
        with self.lock:
            self.data[key] = {"name": str(name or "")[:200], "hidden_at": time.time()}
            self._save()
        return True

    def unhide(self, node_hash: str) -> bool:
        key = clean(node_hash)
        with self.lock:
            if self.data.pop(key, None) is None:
                return False
            self._save()
        return True

    def listing(self) -> List[Dict[str, Any]]:
        """Newest first."""
        rows = [{"hash": k, "name": v.get("name", ""), "hidden_at": v.get("hidden_at", 0)}
                for k, v in self.data.items()]
        rows.sort(key=lambda r: r["hidden_at"], reverse=True)
        return rows

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(self.data, handle, indent=1)
            os.replace(tmp, self.path)
        except OSError as exc:
            print(f"Could not save hidden nodes: {exc}")


__all__ = ["HiddenNodes"]
