"""
Filling the node list at start with the NomadNet announces Reticulum
already knows.

Off by default: the list shows nodes as they announce, so everything in it
was heard since rBrowser started and is likely online. Turned on (Settings
> Node list), the list starts with the nodes that announced within the
chosen time - useful right after a restart, when the list is otherwise
half empty until the nodes announce again.

Where they come from: RNS keeps every validated announce in
Identity.known_destinations ([received at, packet hash, public key,
app_data, ...]), saved with the Reticulum storage that rnsd and its clients
share. An entry is a NomadNet node only if its hash is the
"nomadnetwork.node" destination of the key in it - checked, not assumed.
Nothing is sent.

Saved in settings/node_list.json, with the order the list is sorted by
("sort"), so the order chosen survives a restart. It lived in the browser's
localStorage before, which is one per address (127.0.0.1, localhost,
rbrowser.local, each port): opened another way, the list was back to the
original order.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from typing import Any, Dict, List

import RNS

FILE = os.path.join("settings", "node_list.json")
HOUR_CHOICES = (1, 3, 6, 12, 24)
SORT_CHOICES = ("original", "recent", "frequent", "visited", "alphabetical")
DEFAULTS = {"prefill": False, "prefill_hours": 6, "sort": "original"}


def load() -> Dict[str, Any]:
    settings = dict(DEFAULTS)
    try:
        with open(FILE, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        if isinstance(stored, dict):
            settings["prefill"] = bool(stored.get("prefill", DEFAULTS["prefill"]))
            if stored.get("prefill_hours") in HOUR_CHOICES:
                settings["prefill_hours"] = stored["prefill_hours"]
            if stored.get("sort") in SORT_CHOICES:
                settings["sort"] = stored["sort"]
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"⚠️ Could not read {FILE}, using defaults: {exc}")
    return settings


def sort_saved() -> bool:
    """Whether a sort order was ever written to the file."""
    try:
        with open(FILE, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        return isinstance(stored, dict) and stored.get("sort") in SORT_CHOICES
    except Exception:
        return False


def save(incoming: Dict[str, Any]) -> Dict[str, Any]:
    from .fileio import atomic_write_json
    settings = load()
    if "prefill" in incoming:
        settings["prefill"] = bool(incoming["prefill"])
    if "prefill_hours" in incoming:
        try:
            hours = int(incoming["prefill_hours"])
        except (TypeError, ValueError):
            raise ValueError("prefill_hours must be a number of hours")
        if hours not in HOUR_CHOICES:
            raise ValueError(f"prefill_hours must be one of {HOUR_CHOICES}")
        settings["prefill_hours"] = hours
    if "sort" in incoming:
        if incoming["sort"] not in SORT_CHOICES:
            raise ValueError(f"sort must be one of {SORT_CHOICES}")
        settings["sort"] = incoming["sort"]
    # The default order is not written for the user: a file with "sort" in
    # it means it was chosen, and wins over the browser's (sort_saved).
    written = dict(settings)
    if "sort" not in incoming and not sort_saved():
        written.pop("sort")
    atomic_write_json(FILE, written, indent=2)
    return settings


def recent_nodes(max_age_hours: float, now: float = None) -> List[Dict[str, Any]]:
    """The NomadNet nodes among the announces RNS knows, heard within the
    time, newest first: {destination_hash, identity, app_data, heard}."""
    now = time.time() if now is None else now
    limit = now - max_age_hours * 3600
    with RNS.Identity.known_destinations_lock:
        entries = list(RNS.Identity.known_destinations.items())
    found = []
    for destination_hash, entry in entries:
        try:
            heard, public_key, app_data = float(entry[0]), entry[2], entry[3]
        except (TypeError, ValueError, IndexError):
            continue
        if heard < limit or heard > now + 60 or not public_key:
            continue
        try:
            identity = RNS.Identity(create_keys=False)
            identity.load_public_key(public_key)
            if RNS.Destination.hash(identity, "nomadnetwork", "node") != destination_hash:
                continue
        except Exception:
            continue
        found.append({"destination_hash": destination_hash, "identity": identity,
                      "app_data": app_data, "heard": heard})
    found.sort(key=lambda n: -n["heard"])
    return found


def prefill(browser: Any) -> int:
    """Put the recent nodes in the list, if the setting says so. Returns how
    many were added; nodes already in the list are left as they are."""
    settings = load()
    if not settings["prefill"]:
        return 0
    added = 0
    for node in recent_nodes(settings["prefill_hours"]):
        hash_str = RNS.prettyhexrep(node["destination_hash"])
        if hash_str in browser.nomadnet_nodes:
            continue
        try:
            browser.add_known_node(node["destination_hash"], node["identity"], node["app_data"],
                                   datetime.fromtimestamp(node["heard"]))
            added += 1
        except Exception as exc:
            print(f"⚠️ Could not list known node {hash_str}: {exc}")
    print(f"📋 Node list: {added} node{'s' if added != 1 else ''} announced in the last "
          f"{settings['prefill_hours']} h, from Reticulum's known announces")
    return added


__all__ = ["load", "save", "recent_nodes", "prefill", "HOUR_CHOICES"]
