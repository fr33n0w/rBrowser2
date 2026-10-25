"""
History: the pages you opened, newest first, kept in settings/history.json.

Recorded by the server where a visit is counted (routes.py, count_visit):
every page shown in a tab, from the node, the cache or as an offline copy.
Partials and auto-reloads are not history, as they are not visits. A page
opened again moves to the top instead of appearing twice.

    settings/history.json
        {"settings": {"enabled": true, "max_entries": 200, "max_age_days": 0},
         "entries": [{"url": "<hash>:/page/index.mu", "node_hash": "<hash>",
                      "path": "/page/index.mu", "name": "Node", "time": 1760000000.0}]}

max_entries: how many pages are kept, the oldest dropped first.
max_age_days: entries older than this are deleted on their own; 0 = never.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Dict, List

HISTORY_FILE = os.path.join("settings", "history.json")

# Off until switched on in Settings: a list of where you went is worth
# keeping only if you want it.
DEFAULT_SETTINGS = {"enabled": False, "max_entries": 200, "max_age_days": 0}
MAX_ENTRIES_CHOICES = (50, 100, 200, 500, 1000)
MAX_AGE_CHOICES = (0, 1, 7, 30)


class History:
    def __init__(self, path: str = HISTORY_FILE) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.settings: Dict[str, Any] = dict(DEFAULT_SETTINGS)
        self.entries: List[Dict[str, Any]] = []
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Ignoring unreadable history ({exc})")
            return
        if not isinstance(stored, dict):
            return
        self.settings = self._clean_settings(stored.get("settings") or {})
        entries = stored.get("entries")
        if isinstance(entries, list):
            self.entries = [e for e in entries if isinstance(e, dict)
                            and isinstance(e.get("url"), str) and isinstance(e.get("time"), (int, float))]

    @staticmethod
    def _clean_settings(incoming: Dict[str, Any]) -> Dict[str, Any]:
        settings = dict(DEFAULT_SETTINGS)
        if "enabled" in incoming:
            settings["enabled"] = bool(incoming["enabled"])
        try:
            if int(incoming.get("max_entries")) in MAX_ENTRIES_CHOICES:
                settings["max_entries"] = int(incoming["max_entries"])
        except (TypeError, ValueError):
            pass
        try:
            if int(incoming.get("max_age_days")) in MAX_AGE_CHOICES:
                settings["max_age_days"] = int(incoming["max_age_days"])
        except (TypeError, ValueError):
            pass
        return settings

    def _prune(self) -> bool:
        """Apply the limits. True when something was dropped."""
        before = len(self.entries)
        days = self.settings.get("max_age_days", 0)
        if days:
            cutoff = time.time() - days * 86400
            self.entries = [e for e in self.entries if e["time"] >= cutoff]
        del self.entries[self.settings.get("max_entries", 200):]
        return len(self.entries) != before

    def record(self, node_hash: str, path: str, name: str = "") -> None:
        clean = str(node_hash).replace("<", "").replace(">", "").replace(":", "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", clean):
            return
        path = str(path or "/page/index.mu")
        url = f"{clean}:{path}"
        with self.lock:
            if not self.settings.get("enabled", False):
                return
            self.entries = [e for e in self.entries if e.get("url") != url]
            self.entries.insert(0, {"url": url, "node_hash": clean, "path": path,
                                    "name": str(name or ""), "time": time.time()})
            self._prune()
            self._save()

    def snapshot(self) -> Dict[str, Any]:
        """Entries and settings, with the age limit applied first."""
        with self.lock:
            if self._prune():
                self._save()
            return {"settings": dict(self.settings), "entries": list(self.entries)}

    def save_settings(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            merged = dict(self.settings)
            merged.update(incoming or {})
            self.settings = self._clean_settings(merged)
            self._prune()
            self._save()
            return dict(self.settings)

    def remove(self, url: str) -> int:
        with self.lock:
            before = len(self.entries)
            self.entries = [e for e in self.entries if e.get("url") != url]
            removed = before - len(self.entries)
            if removed:
                self._save()
            return removed

    def clear(self) -> int:
        with self.lock:
            removed = len(self.entries)
            self.entries = []
            self._save()
            return removed

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump({"settings": self.settings, "entries": self.entries}, handle, indent=1)
            os.replace(tmp, self.path)
        except OSError as exc:
            print(f"Could not save the history: {exc}")


__all__ = ["History", "MAX_ENTRIES_CHOICES", "MAX_AGE_CHOICES"]
