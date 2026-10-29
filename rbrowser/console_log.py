"""
What rBrowser writes to the terminal.

Every line belongs to one category, and each category is shown or not,
chosen in Settings > Notifications and log (no restart):

  errors      errors and warnings                          on by default
  connection  Reticulum connection, restarts               on by default
  identity    switching to another identity                on by default
  ephemeral   every new ephemeral identity, "kept as"      off
  announces   one line per NomadNet announce               off
  messenger   LXMF: messages in and out, announces, start  on by default
  propagation LXMF propagation nodes heard and chosen,     off
              syncs
  rrc         RRC chat: client on, hubs connected and lost off
  bbs         BBS client: client on, servers connected     off
  rmap        RMAP: list fetched from rmap.world           off
  activity   page requests, links, downloads, cache,      off
              name lookups - everything else

The page shows the same things as notifications, so the terminal can stay
quiet. Every line shown starts with the time it was printed. The startup banner (rBrowser.py) is always printed.
The blocks are set apart by one blank line (never two), not by lines of =.

Saved in settings/console.json as {"categories": {...}}. The two old modes
are presets: "full" is everything, "status" the three defaults. --log on
the command line picks one of them for one run.

Rather than editing the ~150 print() calls one by one, install() puts a
filtering print in place of the built-in one inside rBrowser's own modules,
and a line is sorted by the marker it starts with - the markers the code
already uses.
"""

from __future__ import annotations

import builtins
import json
import os
import sys
import time
from typing import Any, Dict, Iterable, Optional

CATEGORIES = ("errors", "connection", "identity", "ephemeral", "announces", "messenger",
              "propagation", "rrc", "bbs", "rmap", "activity")
DEFAULTS = {"errors": True, "connection": True, "identity": True,
            "ephemeral": False, "announces": False, "messenger": True,
            "propagation": False, "rrc": False, "bbs": False, "rmap": False,
            "activity": False}
PRESETS = {
    "full": {c: True for c in CATEGORIES},
    "status": dict(DEFAULTS),
}
MODES = tuple(PRESETS)      # for --log

_real_print = builtins.print


def category_of(line: str) -> str:
    text = line.lstrip()
    if text.startswith(("❌", "⚠️", "⚠")):
        return "errors"
    if text.startswith(("🎭", "💾 Ephemeral")):
        return "ephemeral"
    if text.startswith("🔑"):
        return "identity"
    if text.startswith("🌐 NomadNet Announce"):
        return "announces"
    if text.startswith(("📮", "📥")):
        return "propagation"
    if text.startswith("💬 RRC"):
        return "rrc"
    if text.startswith("📋"):
        return "bbs"
    if text.startswith("🗺"):
        return "rmap"
    if text.startswith(("💬", "📣", "🚫")):
        return "messenger"
    if text.startswith(("🟢", "🔴", "🔄", "⏳", "📡", "🔗 Connecting", "🔗 Internet check", "🌐 rBrowser")):
        return "connection"
    return "activity"


def stamped(args: tuple) -> tuple:
    """The time in front of a line, so a new line can be told from the same
    one printed earlier. Blank lines stay blank; leading newlines stay
    before the time."""
    if not args:
        return args
    first = str(args[0])
    text = first.lstrip("\n")
    if not text.strip():
        return args
    lead = first[:len(first) - len(text)]
    return (f"{lead}[{time.strftime('%H:%M:%S')}] {text}",) + tuple(args[1:])


class ConsoleLog:
    FILE = os.path.join("settings", "console.json")
    _blank = True       # at start: no blank line first

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path or self.FILE
        self.saved: Dict[str, bool] = dict(DEFAULTS)
        self.override: Optional[str] = None   # a preset from --log, for this run only
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                stored = json.load(handle) or {}
            cats = stored.get("categories")
            if isinstance(cats, dict):
                self.saved = {c: bool(cats.get(c, DEFAULTS[c])) for c in CATEGORIES}
            elif stored.get("terminal_log") in PRESETS:      # the old file
                self.saved = dict(PRESETS[stored["terminal_log"]])
        except FileNotFoundError:
            pass
        except Exception as exc:
            _real_print(f"⚠️ Could not read {self.path}, using the default terminal log: {exc}")

    @property
    def categories(self) -> Dict[str, bool]:
        return dict(PRESETS[self.override]) if self.override else dict(self.saved)

    def save(self, categories: Any) -> Dict[str, Any]:
        if not isinstance(categories, dict):
            raise ValueError("categories must be an object")
        chosen = {c: bool(categories.get(c, self.saved.get(c, DEFAULTS[c]))) for c in CATEGORIES}
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"categories": chosen}, handle, indent=2)
        os.replace(tmp, self.path)
        self.saved = chosen
        # Choosing in the page is choosing now: it also ends a --log override.
        self.override = None
        return self.describe()

    def describe(self) -> Dict[str, Any]:
        return {"status": "success", "categories": self.categories,
                "saved": self.saved, "override": self.override}

    def keeps(self, args: Iterable[Any]) -> bool:
        """Would this print() line be shown?"""
        first = ""
        for a in args:
            first = str(a)
            break
        if not first.strip():
            # Blank lines and spacing follow the connection messages.
            return self.categories.get("connection", True)
        return self.categories.get(category_of(first), True)

    def print(self, *args: Any, **kwargs: Any) -> None:
        # Only lines meant for the terminal are filtered; print(..., file=f)
        # to anything else goes through untouched.
        target = kwargs.get("file")
        if target is not None and target not in (sys.stdout, sys.stderr,
                                                 sys.__stdout__, sys.__stderr__):
            _real_print(*args, **kwargs)
            return
        if self.keeps(args):
            self.say(*args, **kwargs)

    def say(self, *args: Any, **kwargs: Any) -> None:
        """Printed with the time, whatever the categories (rBrowser.py's own
        lines go straight here). Never two blank lines in a row: the blocks
        are set apart by one."""
        first = str(args[0]) if args else ""
        if not first.strip():
            if self._blank:
                return
            self._blank = True
        else:
            self._blank = first.endswith("\n")
        _real_print(*stamped(args), **kwargs)


console = ConsoleLog()


def install(*modules: Any) -> None:
    """Make print() inside these modules go through the filter."""
    for module in modules:
        setattr(module, "print", console.print)


__all__ = ["ConsoleLog", "console", "install", "MODES", "CATEGORIES", "category_of"]
