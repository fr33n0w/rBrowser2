"""
Favorites, kept on disk in settings/favorites.json.

Each favorite has a hash, a name, and which name it prefers:

  prefer "custom"   the name was given by the user and is kept as it is.
                    Every favorite saved before this field existed is one.
  prefer "network"  the name is the one the node announces. Whatever was
                    typed meanwhile (or nothing) is a placeholder until
                    that name is known, and a node that renames itself
                    renames its favorite too. `network_name` is true once
                    the name has come from the network.

The name of a NomadNet node is in its announce, so it is looked for in
three places, cheapest first:

  1. the node list of this session;
  2. the announces Reticulum already remembers (known destinations), which
     costs no traffic at all;
  3. the network: one path request, which the node - or any transport node
     holding its announce - answers with that announce. It is the same small
     request NomadNet sends whenever a node is opened.

Steps 1 and 2 run every minute. Step 3 runs at most once per pending
favorite on the schedule in NETWORK_RETRY, and only while Reticulum is
connected: a name is a nicety, and on LoRa the airtime is somebody else's.
An announce that arrives on its own fills the name in at any time.

The page reloads the names when `revision` changes (it is in /api/status).
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional

FAVORITES_FILE = os.path.join("settings", "favorites.json")
# Settings > Favorites. Kept apart so favorites.json stays a plain list.
#   enabled                 the Favorites menu and stars are shown
#   follow_announced_names  every favorite takes the name its node announces
#                           next, custom names included; off, a name never
#                           changes once it is there
SETTINGS_FILE = os.path.join("settings", "favorites_settings.json")
DEFAULT_SETTINGS = {"enabled": True, "follow_announced_names": True}

CUSTOM = "custom"
NETWORK = "network"

# Seconds between network lookups of one name: right away, then 10 min,
# 30 min, 2 h, and every 6 h after that.
NETWORK_RETRY = [0, 600, 1800, 7200]
NETWORK_RETRY_LATER = 6 * 3600

LOCAL_CHECK_EVERY = 60


def normalise(fav: Any) -> Optional[Dict[str, Any]]:
    """One favorite as stored, or None if it is not one."""
    if not isinstance(fav, dict) or not fav.get("hash"):
        return None
    name = str(fav.get("name") or "").strip()
    prefer = fav.get("prefer")
    if prefer not in (CUSTOM, NETWORK):
        prefer = CUSTOM if name else NETWORK
    if not name:
        prefer = NETWORK        # there is no custom name to keep
    entry = {"hash": str(fav["hash"]).lower(), "name": name, "prefer": prefer}
    if prefer == NETWORK and fav.get("network_name") and name:
        entry["network_name"] = True
    return entry


def is_pending(fav: Dict[str, Any]) -> bool:
    """Waiting for the name the node announces."""
    return fav.get("prefer") == NETWORK and not fav.get("network_name")


class Favorites:
    def __init__(self, path: str = FAVORITES_FILE, settings_path: Optional[str] = None) -> None:
        self.path = path
        self.settings_path = settings_path or os.path.join(os.path.dirname(path) or ".",
                                                           os.path.basename(SETTINGS_FILE))
        self._lock = threading.RLock()
        self.revision = 0
        self.settings: Dict[str, Any] = dict(DEFAULT_SETTINGS)
        try:
            with open(self.settings_path, "r", encoding="utf-8") as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                for key in DEFAULT_SETTINGS:
                    if key in stored:
                        self.settings[key] = bool(stored[key])
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as exc:
            print(f"⚠️ Ignoring unreadable favorites settings ({exc})")
        # hash -> {"tries": n, "next": time of the next network lookup}
        self._lookups: Dict[str, Dict[str, float]] = {}
        self._busy: set = set()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # Supplied by the browser.
        self.local_name: Callable[[str], Optional[str]] = lambda h: None
        self.network_name: Callable[[str], Optional[str]] = lambda h: None
        self.connected: Callable[[], bool] = lambda: False

    # ------------------------------------------------------------------ #
    # File                                                               #
    # ------------------------------------------------------------------ #

    def load(self) -> List[Dict[str, Any]]:
        with self._lock:
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                return []
            return [e for e in (normalise(fav) for fav in data) if e]

    def _write(self, favorites: List[Dict[str, Any]]) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(favorites, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.path)
        self.revision += 1

    def save(self, favorites: List[Any]) -> List[Dict[str, Any]]:
        """
        Store the list the page sends. A network name found here since the
        page last loaded the list is kept: the page may still hold the
        placeholder, and saving must not put it back.
        """
        with self._lock:
            found = {fav["hash"]: fav["name"] for fav in self.load() if fav.get("network_name")}
            clean = []
            for fav in favorites:
                entry = normalise(fav)
                if not entry:
                    continue
                if is_pending(entry) and entry["hash"] in found:
                    entry["name"] = found[entry["hash"]]
                    entry["network_name"] = True
                clean.append(entry)
            self._write(clean)
            for entry in clean:
                if is_pending(entry):
                    self._lookups.setdefault(entry["hash"], {"tries": 0, "next": 0.0})
            self._wake.set()
            return clean

    def save_settings(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            for key in DEFAULT_SETTINGS:
                if key in (incoming or {}):
                    self.settings[key] = bool(incoming[key])
            os.makedirs(os.path.dirname(self.settings_path) or ".", exist_ok=True)
            tmp = self.settings_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, indent=2)
            os.replace(tmp, self.settings_path)
            self._following_cache = None
            settings = dict(self.settings)
        if settings["follow_announced_names"]:
            # Names already heard need not wait for the next announce.
            threading.Thread(target=self.refresh_from_known_names, name="favorite-names-now",
                             daemon=True).start()
        return settings

    def refresh_from_known_names(self) -> None:
        """Every favorite to the name its node last announced, from what is
        already here (node list, remembered announces). Nothing is sent."""
        for fav in self.load():
            try:
                name = self.local_name(fav["hash"])
                if name:
                    self.set_network_name(fav["hash"], name)
            except Exception as exc:
                print(f"⚠️ Could not refresh the name of favorite {fav['hash'][:16]}: {exc}")

    # ------------------------------------------------------------------ #
    # Names                                                              #
    # ------------------------------------------------------------------ #

    def pending(self) -> List[str]:
        return [fav["hash"] for fav in self.load() if is_pending(fav)]

    def set_network_name(self, node_hash: str, name: str) -> bool:
        """
        The name a node announces. Applied to its favorite if that one is
        still waiting for a name, or - with "follow announced names" on -
        whenever it differs, whatever name the favorite had. False when
        nothing changed.
        """
        node_hash = node_hash.lower()
        name = (name or "").strip()
        if not name:
            return False
        follow = self.settings.get("follow_announced_names", True)
        with self._lock:
            favorites = self.load()
            changed = False
            for fav in favorites:
                if fav["hash"] != node_hash:
                    continue
                if not (is_pending(fav) or follow):
                    continue
                if fav["name"] == name and (fav.get("network_name") or fav["prefer"] == CUSTOM):
                    continue
                if fav["prefer"] == CUSTOM:
                    # Now it is the announced name, and keeps following it.
                    fav["prefer"] = NETWORK
                fav["name"] = name
                fav["network_name"] = True
                changed = True
            if changed:
                self._write(favorites)
                self._lookups.pop(node_hash, None)
                print(f"⭐ Favorite {node_hash[:16]} is named {name}")
            return changed

    def on_announce(self, node_hash: str, name: str) -> None:
        """
        Every NomadNet announce comes through here. The file is only read
        when the node is a favorite that follows its network name; the set
        of those is kept in memory for that.
        """
        if node_hash.lower() in self._following:
            self.set_network_name(node_hash, name)

    @property
    def _following(self) -> set:
        # Re-read at most once every few seconds: announces can arrive
        # several a second, and the file rarely changes.
        now = time.time()
        cached = getattr(self, "_following_cache", None)
        if cached is None or now - cached[0] > 5 or cached[1] != self.revision:
            follow = self.settings.get("follow_announced_names", True)
            hashes = {fav["hash"] for fav in self.load() if follow or is_pending(fav)}
            self._following_cache = (now, self.revision, hashes)
            return hashes
        return cached[2]

    # ------------------------------------------------------------------ #
    # Background lookups                                                 #
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        for node_hash in self.pending():
            self._lookups.setdefault(node_hash, {"tries": 0, "next": 0.0})
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="favorite-names", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            self._wake.wait(LOCAL_CHECK_EVERY)
            self._wake.clear()
            try:
                self.lookup_pass()
            except Exception as exc:
                print(f"⚠️ Favorite name lookup failed: {exc}")

    def lookup_pass(self, now: Optional[float] = None, background: bool = True) -> None:
        pending = set(self.pending())
        for node_hash in list(self._lookups):
            if node_hash not in pending:
                self._lookups.pop(node_hash, None)
        if not pending or not self.connected():
            return

        now = time.time() if now is None else now
        for node_hash in pending:
            name = self.local_name(node_hash)
            if name:
                self.set_network_name(node_hash, name)
                continue

            state = self._lookups.setdefault(node_hash, {"tries": 0, "next": 0.0})
            if now < state["next"] or node_hash in self._busy:
                continue
            tries = int(state["tries"])
            delay = NETWORK_RETRY[tries + 1] if tries + 1 < len(NETWORK_RETRY) else NETWORK_RETRY_LATER
            state["tries"] = tries + 1
            state["next"] = now + delay
            self._busy.add(node_hash)
            if background:
                threading.Thread(target=self._ask_network, args=(node_hash,),
                                 name="favorite-name-lookup", daemon=True).start()
            else:
                self._ask_network(node_hash)

    def _ask_network(self, node_hash: str) -> None:
        try:
            print(f"🔎 Looking up the name of favorite {node_hash[:16]} on the network")
            name = self.network_name(node_hash)
            if name:
                self.set_network_name(node_hash, name)
            else:
                state = self._lookups.get(node_hash)
                when = time.strftime("%H:%M", time.localtime(state["next"])) if state else "later"
                print(f"   no answer for {node_hash[:16]}, next try at {when}")
        finally:
            self._busy.discard(node_hash)
