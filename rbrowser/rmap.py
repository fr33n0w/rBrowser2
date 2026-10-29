"""
RMAP integration: the nodes rmap.world hears, as if a remote rnsd were
listening to announces for us.

rmap.world publishes every node it has heard as JSON (https://rmap.world/?json,
~3.7 MB, ~7000 nodes). While the integration is on (Settings > RMAP), it is
fetched every few minutes, kept in cache/rmap.json (so the map is full at once
after a restart) and handed to the page trimmed: only the kinds rBrowser can
use and only the fields it shows.

Groups, one list column each:
  nomadnet  NomadNet nodes                 - open their pages
  propnode  LXMF propagation nodes         - use one as ours
  rrc       RRC chat hubs                  - open in the RRC client
  bbs       RetiBBS servers + NomadNet nodes named BBS - BBS client / page
  backbone  Backbone, Yggdrasil, Tor, I2P, Mycelium, TCP client interfaces
            - a resource: their address and a Reticulum config to copy
  rnode     RNode LoRa radios - not reachable from rBrowser itself, but their
            radio settings make the config for a local radio link

Nothing here touches Reticulum: it is plain HTTPS to rmap.world, made only
while the integration is on. Saved in settings/rmap.json.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

from . import netwatch

SETTINGS_FILE = os.path.join("settings", "rmap.json")
CACHE_FILE = os.path.join("cache", "rmap.json")
SOURCE_URL = "https://rmap.world/?json"
USER_AGENT = "rBrowser/2.0 (RMAP integration)"
FETCH_TIMEOUT = 60
MAX_BYTES = 32 * 1024 * 1024        # far above the real size; a runaway answer stops here

# Minutes. Not more often than every 30: with many rBrowsers around, every
# one of them fetching ~3.7 MB every few minutes would hammer rmap.world.
# Once at start too (LAUNCH_GAP: not again after a quick restart).
REFRESH_CHOICES = (30, 60, 120, 360, 720, 1440)
LAUNCH_GAP = 10 * 60                        # s: a cache newer than this is not fetched again at start
AGE_CHOICES = (1, 6, 24, 72, 168)           # hours: nodes heard within
# Offline: the country borders built into rBrowser, nothing fetched for the
# map. Online: Esri's Light Gray or Dark Gray canvas. Light or dark each.
MAP_CHOICES = ("offline-light", "offline-dark", "online-light", "online-dark")
OLD_MAP = {"offline": "offline-light", "online": "online-light"}     # before light/dark
DEFAULTS = {"enabled": False, "refresh_minutes": 60, "max_age_hours": 24, "map": "offline-light"}
MANUAL_GAP = 10 * 60                        # s: Refresh by hand at most this often

BACKBONE_TYPES = ("Backbone", "Yggdrasil", "Tor", "I2P", "Mycelium", "TCP_Client")
# The word BBS in a NomadNet node's name, as in the BBS client's list
# (script/retibbs.js NOMAD_BBS_NAME).
BBS_NAME = re.compile(r"(^|[^a-z0-9])bbs([^a-z0-9]|$)", re.I)
HEX32 = re.compile(r"^[0-9a-f]{32}$")


def _atomic_write(path: str, data: Any) -> None:
    from .fileio import atomic_write_json
    atomic_write_json(path, data, indent=1, ensure_ascii=False)


def groups_of(node: Dict[str, Any]) -> List[str]:
    """The list columns a node of rmap belongs to (none: not shown)."""
    kind = node.get("node_type")
    if kind == "NomadNet":
        return ["nomadnet", "bbs"] if BBS_NAME.search(node.get("display_name") or "") else ["nomadnet"]
    if kind == "PropNode":
        return ["propnode"]
    if kind == "RRC":
        return ["rrc"]
    if kind == "RetiBBS":
        return ["bbs"]
    if kind in BACKBONE_TYPES:
        return ["backbone"]
    if kind == "RNode_LoRa":
        return ["rnode"]
    return []


def _num(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None     # NaN out


def _text(value: Any, limit: int = 120) -> str:
    return " ".join(str(value or "").split())[:limit]


def trim(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What the page needs of one rmap node, checked: a hash of 32 hex
    characters, numbers as numbers, text as short single-line text."""
    address = str(node.get("hash") or "").lower()
    groups = groups_of(node)
    if not groups or not HEX32.match(address):
        return None
    lat, lon = _num(node.get("lat")), _num(node.get("lon"))
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        lat = lon = None
    out: Dict[str, Any] = {
        "hash": address,
        "type": node.get("node_type"),
        "groups": groups,
        "name": _text(node.get("display_name")),
        "lat": lat, "lon": lon,
        "seen": _num(node.get("last_seen_ts")),
        "hops": node.get("hops") if isinstance(node.get("hops"), int) else None,
        "rate": _num(node.get("announce_rate")),
    }
    operator = str(node.get("operator_lxmf_address") or node.get("service_lxmf") or "").lower()
    if HEX32.match(operator):
        out["lxmf"] = operator
    if "propnode" in groups:
        out["stamp_cost"] = node.get("pn_stamp_cost") if isinstance(node.get("pn_stamp_cost"), int) else None
        out["transfer_kb"] = _num(node.get("pn_transfer_kb"))
    if "backbone" in groups:
        out["iface"] = _text(node.get("iface_type"), 40)
        out["host"] = _text(node.get("host"), 100)
        port = node.get("port")
        out["port"] = port if isinstance(port, int) and 0 < port < 65536 else None
        out["ifac_netname"] = _text(node.get("ifac_netname"), 80)
        out["ifac_netkey"] = _text(node.get("ifac_netkey"), 80)
        out["version"] = _text(" ".join(filter(None, [node.get("transport_software"),
                                                     node.get("transport_version")])), 40)
    if "rnode" in groups:
        # As rmap shows them: "869.525 MHz", "125.0 kHz", plain numbers for
        # sf/cr. Kept as text for the list, read back as numbers for a config.
        out["frequency"] = _text(node.get("frequency"), 24)
        out["bandwidth"] = _text(node.get("bandwidth"), 24)
        for key, name in (("spreading_factor", "sf"), ("coding_rate", "cr")):
            value = node.get(key)
            out[name] = value if isinstance(value, int) and 0 < value < 64 else None
    return out


class Rmap:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.settings = self._load_settings()
        self.nodes: List[Dict[str, Any]] = []
        self.generated_at = ""
        self.generated_ts: Optional[float] = None
        self.fetched_at: Optional[float] = None
        self.error = ""
        self.fetching = False
        self.revision = 0
        self._wake = threading.Event()
        self._load_cache()
        threading.Thread(target=self._loop, name="rmap-fetch", daemon=True).start()

    # --- settings -------------------------------------------------------

    def _load_settings(self) -> Dict[str, Any]:
        settings = dict(DEFAULTS)
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                settings["enabled"] = bool(stored.get("enabled", False))
                # An old 10 or 15 is not offered any more: back to the default.
                if stored.get("refresh_minutes") in REFRESH_CHOICES:
                    settings["refresh_minutes"] = stored["refresh_minutes"]
                if stored.get("max_age_hours") in AGE_CHOICES:
                    settings["max_age_hours"] = stored["max_age_hours"]
                stored_map = OLD_MAP.get(stored.get("map"), stored.get("map"))
                if stored_map in MAP_CHOICES:
                    settings["map"] = stored_map
        except FileNotFoundError:
            pass
        except Exception as exc:
            print(f"⚠️ Could not read {SETTINGS_FILE}, using defaults: {exc}")
        return settings

    def update_settings(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            settings = dict(self.settings)
            if "enabled" in incoming:
                settings["enabled"] = bool(incoming["enabled"])
            for key, choices in (("refresh_minutes", REFRESH_CHOICES), ("max_age_hours", AGE_CHOICES)):
                if key in incoming:
                    try:
                        value = int(incoming[key])
                    except (TypeError, ValueError):
                        raise ValueError(f"{key} must be one of {choices}")
                    if value not in choices:
                        raise ValueError(f"{key} must be one of {choices}")
                    settings[key] = value
            if "map" in incoming:
                wanted = OLD_MAP.get(incoming["map"], incoming["map"])
                if wanted not in MAP_CHOICES:
                    raise ValueError(f"map must be one of {MAP_CHOICES}")
                settings["map"] = wanted
            turned_on = settings["enabled"] and not self.settings["enabled"]
            self.settings = settings
            _atomic_write(SETTINGS_FILE, settings)
            self.revision += 1
        if turned_on:
            self._wake.set()            # fetch now, not at the next tick
        return self.status()

    # --- fetching -------------------------------------------------------

    def _load_cache(self) -> None:
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            self._take(data, os.path.getmtime(CACHE_FILE))
        except FileNotFoundError:
            pass
        except Exception as exc:
            print(f"⚠️ RMAP: cached list not readable ({exc}); it will be fetched again")

    def _take(self, data: Any, fetched_at: float) -> None:
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
            raise ValueError("unexpected JSON from rmap.world")
        nodes = [n for n in (trim(x) for x in data["nodes"] if isinstance(x, dict)) if n]
        with self.lock:
            self.nodes = nodes
            self.generated_at = _text(data.get("generated_at"), 40)
            self.generated_ts = _num(data.get("generated_ts"))
            self.fetched_at = fetched_at
            self.revision += 1

    def fetch(self) -> Dict[str, Any]:
        with self.lock:
            if self.fetching:
                return self.status()
            if netwatch.offline():
                # Network down: no fetch and no error line; the loop is woken
                # when it is back.
                return self.status()
            self.fetching = True
            self.revision += 1
        try:
            request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT,
                                                                  "Accept-Encoding": "identity"})
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("answer too big")
            data = json.loads(raw.decode("utf-8"))
            self._take(data, time.time())
            os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
            _atomic_write(CACHE_FILE, data)
            with self.lock:
                self.error = ""
            print(f"🗺️ RMAP: {len(self.nodes)} usable nodes from rmap.world")
        except Exception as exc:
            with self.lock:
                self.error = _text(exc, 200) or exc.__class__.__name__
            print(f"⚠️ RMAP: fetch failed: {self.error}")
        finally:
            with self.lock:
                self.fetching = False
                self.revision += 1
        return self.status()

    def _due(self) -> bool:
        if not self.settings["enabled"]:
            return False
        if self.fetched_at is None:
            return True
        return time.time() - self.fetched_at >= self.settings["refresh_minutes"] * 60

    def _loop(self) -> None:
        netwatch.on_change(lambda online: online and self._wake.set())
        # Once at start, unless the cache is only minutes old (a restart).
        if self.settings["enabled"] and (self.fetched_at is None or time.time() - self.fetched_at >= LAUNCH_GAP):
            self.fetch()
        while True:
            self._wake.wait(30)
            self._wake.clear()
            if self._due():
                self.fetch()

    def manual_wait(self) -> int:
        """Seconds before Refresh by hand is allowed again (0: now)."""
        if self.fetched_at is None:
            return 0
        return max(0, int(self.fetched_at + MANUAL_GAP - time.time()))

    def refresh(self) -> Dict[str, Any]:
        """Refresh by hand: not while a fetch runs, and not more often than
        every MANUAL_GAP, however many times it is asked (and from however
        many tabs): rmap.world is shared by everyone."""
        if not self.settings["enabled"]:
            return {"status": "error", "error": "RMAP integration is off: Settings > RMAP"}
        with self.lock:
            if self.fetching:
                return {"status": "error", "error": "Already fetching"}
            wait = self.manual_wait()
            if wait:
                return {"status": "error",
                        "error": f"Fetched {max(1, (MANUAL_GAP - wait) // 60)} min ago: again in {max(1, round(wait / 60))} min"}
        threading.Thread(target=self.fetch, name="rmap-refresh", daemon=True).start()
        with self.lock:
            self.fetching = True        # shown at once; fetch() sets it again
            self.revision += 1
        return self.status()

    # --- what the page reads -------------------------------------------

    def status(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "status": "success",
                "settings": dict(self.settings),
                "refresh_choices": list(REFRESH_CHOICES),
                "age_choices": list(AGE_CHOICES),
                "map_choices": list(MAP_CHOICES),
                "generated_at": self.generated_at,
                "fetched_at": self.fetched_at,
                "fetching": self.fetching,
                "manual_wait": self.manual_wait(),
                "error": self.error,
                "revision": self.revision,
                "source": SOURCE_URL,
            }

    def count(self) -> Optional[int]:
        """How many nodes the list shows (heard within max_age_hours), for
        the status bar; None while the integration is off."""
        if not self.settings["enabled"]:
            return None
        with self.lock:
            now = self.generated_ts or time.time()
            cutoff = now - self.settings["max_age_hours"] * 3600
            return sum(1 for n in self.nodes if (n.get("seen") or 0) >= cutoff)

    def listing(self) -> Dict[str, Any]:
        """The nodes heard within max_age_hours (by rmap's clock), newest
        first. Empty while the integration is off."""
        out = self.status()
        if not self.settings["enabled"]:
            out["nodes"] = []
            return out
        with self.lock:
            # rmap's own clock, so a wrong clock here does not empty the list.
            now = self.generated_ts or time.time()
            cutoff = now - self.settings["max_age_hours"] * 3600
            nodes = [n for n in self.nodes if (n.get("seen") or 0) >= cutoff]
        nodes.sort(key=lambda n: -(n.get("seen") or 0))
        out["nodes"] = nodes
        out["now"] = now
        return out
