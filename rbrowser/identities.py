"""
Identity profiles for rBrowser.

What a node actually sees
-------------------------
Browsing a NomadNet node is anonymous: every RNS link is set up with fresh
keys and the node learns nothing about who opened it. A node only finds out
who you are when you identify on the link (the fingerprint button, which is
RNS `link.identify()`). From then on its pages receive your identity hash as
`remote_identity` (nomadnet/Node.py) and that is what a node keys accounts on.

So an account on a node *is* an identity, and having more than one account
means having more than one identity. That is all this module does:

- **Profiles**: identities kept on disk, with a name. The original
  `nomadnet_browser_identity` file is the "Default" profile, unchanged, so
  nothing a node already knows you by is lost.
- **Ephemeral**: a throwaway identity that only lives in memory. It is
  replaced at every start, and also at every page reload or every set
  interval (30 s to 1 h) if asked to. "Keep" turns the
  current one into a profile, which is the only way to come back to an
  account made with it.
- **Bindings**: which identity you first identified to each node with.
  Auto-identify uses it, and the UI warns before identifying to a node as
  somebody else.

RNS 1.5 also has an "ephemeral transport identity", rerolled at every start
when transport is off. That one is unrelated: it is the identity of the RNS
instance itself, and the nodes you browse never see it.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, List, Optional

import RNS


EPHEMERAL = "ephemeral"
DEFAULT_ID = "default"
EPHEMERAL_MODES = ("session", "reload", "timed")
# Timed mode: a new ephemeral identity every so often. Seconds.
EPHEMERAL_INTERVALS = (30, 60, 120, 300, 600, 900, 1800, 3600)
DEFAULT_INTERVAL = 300

_HASH_RE = re.compile(r"^[0-9a-f]{32}$")
_ID_RE = re.compile(r"^[a-z0-9]{1,32}$")


def clean_node_hash(value: Any) -> Optional[str]:
    """A node hash as 32 lowercase hex characters, or None."""
    text = str(value or "").replace("<", "").replace(">", "").replace(":", "").strip().lower()
    return text if _HASH_RE.match(text) else None


def describe_identity(identity: Optional[RNS.Identity]) -> Dict[str, str]:
    """The addresses a node or a person would know this identity by."""
    if identity is None:
        return {"identity_hash": "", "lxmf_address": ""}
    return {
        "identity_hash": identity.hash.hex(),
        "lxmf_address": RNS.Destination.hash(identity, "lxmf", "delivery").hex(),
    }


class IdentityManager:
    """Profiles, the ephemeral identity, and per-node bindings."""

    LEGACY_FILE = "nomadnet_browser_identity"
    PROFILE_DIR = "identities"
    STATE_FILE = os.path.join("settings", "identities.json")
    MAX_NAME = 40
    # Where the default key lives, if not nomadnet_browser_identity. The
    # Docker setup points it inside identities/, so that one volume keeps
    # every key: a single loose file cannot be a volume of its own.
    DEFAULT_FILE_ENV = "RBROWSER_DEFAULT_IDENTITY"

    def default_identity_file(self) -> str:
        return os.environ.get(self.DEFAULT_FILE_ENV) or self.LEGACY_FILE

    def __init__(self, base_dir: str = ".") -> None:
        self.base_dir = base_dir
        self._lock = threading.RLock()
        self._loaded: Dict[str, RNS.Identity] = {}
        self._broken: set = set()

        # The ephemeral identity and the nodes identified to with it. Never
        # written to disk: that is what makes it ephemeral.
        self._ephemeral = RNS.Identity()
        self._ephemeral_nodes: List[str] = []
        # When the timed countdown started: at start-up, at each new
        # ephemeral identity, and when ephemeral or its interval is set.
        self._ephemeral_since = time.time()

        self.state: Dict[str, Any] = {
            "active": DEFAULT_ID,
            "profiles": [],
            "bindings": {},
            "auto_identify": False,
            # The saved identity to go back to when ephemeral is switched off.
            "last_fixed": DEFAULT_ID,
            "ephemeral_mode": "session",
            "ephemeral_interval": DEFAULT_INTERVAL,
        }
        self._load()

    # ------------------------------------------------------------------ #
    # Storage                                                            #
    # ------------------------------------------------------------------ #

    def _path(self, *parts: str) -> str:
        return os.path.join(self.base_dir, *parts)

    def _load(self) -> None:
        try:
            with open(self._path(self.STATE_FILE), "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key in self.state:
                    if key in stored:
                        self.state[key] = stored[key]
        except FileNotFoundError:
            pass
        except Exception as exc:
            print(f"⚠️ Could not read {self.STATE_FILE}, starting from defaults: {exc}")

        # Repair anything a hand edit may have broken, rather than failing.
        profiles = [p for p in self.state.get("profiles") or []
                    if isinstance(p, dict) and _ID_RE.match(str(p.get("id", "")))]
        default_file = self.default_identity_file()
        if not any(p["id"] == DEFAULT_ID for p in profiles):
            profiles.insert(0, {"id": DEFAULT_ID, "name": "Default",
                                "file": default_file, "created": time.time()})
        elif os.environ.get(self.DEFAULT_FILE_ENV):
            for p in profiles:
                if p["id"] == DEFAULT_ID:
                    p["file"] = default_file
        self.state["profiles"] = profiles

        bindings = self.state.get("bindings")
        known = {p["id"] for p in profiles}
        self.state["bindings"] = {
            node: pid for node, pid in (bindings.items() if isinstance(bindings, dict) else [])
            if clean_node_hash(node) and pid in known
        }
        if self.state.get("ephemeral_mode") not in EPHEMERAL_MODES:
            self.state["ephemeral_mode"] = "session"
        if self.state.get("ephemeral_interval") not in EPHEMERAL_INTERVALS:
            self.state["ephemeral_interval"] = DEFAULT_INTERVAL
        self.state["auto_identify"] = bool(self.state.get("auto_identify"))
        if self.state.get("active") != EPHEMERAL and self.state.get("active") not in known:
            self.state["active"] = DEFAULT_ID
        if self.state.get("last_fixed") not in known:
            self.state["last_fixed"] = (self.state["active"] if self.state["active"] != EPHEMERAL
                                        else DEFAULT_ID)

        # The default identity must exist before anything asks for it: it is
        # created on first run exactly as rBrowser always has.
        self.identity_for(DEFAULT_ID)
        self._save()

    def _save(self) -> None:
        path = self._path(self.STATE_FILE)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.state, handle, indent=2)
        os.replace(tmp, path)

    def _profile(self, profile_id: str) -> Optional[Dict[str, Any]]:
        for profile in self.state["profiles"]:
            if profile["id"] == profile_id:
                return profile
        return None

    def profile_file(self, profile_id: str) -> Optional[str]:
        profile = self._profile(profile_id)
        return self._path(profile["file"]) if profile else None

    def identity_for(self, profile_id: str) -> Optional[RNS.Identity]:
        """The identity behind a profile id (or the ephemeral one)."""
        with self._lock:
            if profile_id == EPHEMERAL:
                return self._ephemeral
            if profile_id in self._loaded:
                return self._loaded[profile_id]
            if profile_id in self._broken:
                return None
            path = self.profile_file(profile_id)
            if not path:
                return None
            identity = RNS.Identity.from_file(path) if os.path.exists(path) else None
            if identity is None:
                if os.path.exists(path):
                    # A file that does not load is never overwritten: it may
                    # be the only copy of somebody's key. Reported once, not
                    # on every look at the identity list.
                    print(f"❌ Identity file {path} could not be loaded")
                    self._broken.add(profile_id)
                    return None
                identity = RNS.Identity()
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
                identity.to_file(path)
            self._loaded[profile_id] = identity
            return identity

    # ------------------------------------------------------------------ #
    # The active identity                                                #
    # ------------------------------------------------------------------ #

    @property
    def active_id(self) -> str:
        return self.state["active"]

    def active_identity(self) -> Optional[RNS.Identity]:
        return self.identity_for(self.active_id)

    def name_of(self, profile_id: str) -> str:
        if profile_id == EPHEMERAL:
            return "Ephemeral"
        profile = self._profile(profile_id)
        return profile["name"] if profile else profile_id

    def set_active(self, profile_id: str) -> None:
        with self._lock:
            if profile_id != EPHEMERAL and not self._profile(profile_id):
                raise ValueError("No such identity")
            if self.identity_for(profile_id) is None:
                raise ValueError("That identity file cannot be loaded")
            if profile_id == EPHEMERAL and self.state["active"] != EPHEMERAL:
                # Timed: the countdown runs from when ephemeral is switched on.
                self._ephemeral_since = time.time()
            self.state["active"] = profile_id
            if profile_id != EPHEMERAL:
                self.state["last_fixed"] = profile_id
            self._save()

    def fixed_to_return_to(self) -> str:
        """
        The saved identity ephemeral mode was switched on from - where
        switching it off goes back to. The default if that one is gone or
        no longer loads.
        """
        last = self.state.get("last_fixed") or DEFAULT_ID
        if self._profile(last) and self.identity_for(last) is not None:
            return last
        return DEFAULT_ID

    # ------------------------------------------------------------------ #
    # Profiles                                                           #
    # ------------------------------------------------------------------ #

    def _clean_name(self, name: Any, fallback: str) -> str:
        text = " ".join(str(name or "").split())[: self.MAX_NAME]
        return text or fallback

    def _new_id(self) -> str:
        while True:
            candidate = "p" + secrets.token_hex(4)
            if not self._profile(candidate):
                return candidate

    def _add_profile(self, identity: RNS.Identity, name: Any) -> Dict[str, Any]:
        profile_id = self._new_id()
        rel = os.path.join(self.PROFILE_DIR, profile_id)
        path = self._path(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        identity.to_file(path)
        profile = {"id": profile_id,
                   "name": self._clean_name(name, f"Identity {len(self.state['profiles']) + 1}"),
                   "file": rel, "created": time.time()}
        self.state["profiles"].append(profile)
        self._loaded[profile_id] = identity
        self._save()
        return profile

    def create_profile(self, name: Any = None) -> Dict[str, Any]:
        with self._lock:
            return self._add_profile(RNS.Identity(), name)

    def import_profile(self, key_bytes: bytes, name: Any = None) -> Dict[str, Any]:
        with self._lock:
            identity = RNS.Identity.from_bytes(key_bytes) if key_bytes else None
            if identity is None:
                raise ValueError("That file is not an RNS identity")
            for profile in self.state["profiles"]:
                existing = self.identity_for(profile["id"])
                if existing is not None and existing.hash == identity.hash:
                    raise ValueError(f"Already present as \"{profile['name']}\"")
            return self._add_profile(identity, name)

    def rename(self, profile_id: str, name: Any) -> None:
        with self._lock:
            profile = self._profile(profile_id)
            if not profile:
                raise ValueError("No such identity")
            profile["name"] = self._clean_name(name, profile["name"])
            self._save()

    def delete(self, profile_id: str) -> None:
        with self._lock:
            if profile_id == DEFAULT_ID:
                raise ValueError("The default identity cannot be deleted")
            if profile_id == self.active_id:
                raise ValueError("Switch to another identity before deleting this one")
            profile = self._profile(profile_id)
            if not profile:
                raise ValueError("No such identity")
            path = self._path(profile["file"])
            self.state["profiles"].remove(profile)
            self.state["bindings"] = {n: p for n, p in self.state["bindings"].items()
                                      if p != profile_id}
            if self.state.get("last_fixed") == profile_id:
                self.state["last_fixed"] = DEFAULT_ID
            self._loaded.pop(profile_id, None)
            self._broken.discard(profile_id)
            self._save()
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    # ------------------------------------------------------------------ #
    # Ephemeral                                                          #
    # ------------------------------------------------------------------ #

    def rotate_ephemeral(self) -> List[str]:
        """
        Replace the ephemeral identity. Returns the nodes the old one had
        identified to: any account made with it is now out of reach.
        """
        with self._lock:
            dropped = list(self._ephemeral_nodes)
            self._ephemeral = RNS.Identity()
            self._ephemeral_nodes = []
            self._ephemeral_since = time.time()
            return dropped

    def next_rotation(self) -> Optional[float]:
        """
        When timed mode replaces the ephemeral identity next (epoch seconds),
        or None: not in timed mode, or ephemeral is not the one in use.
        """
        with self._lock:
            if self.state["active"] != EPHEMERAL or self.state["ephemeral_mode"] != "timed":
                return None
            return self._ephemeral_since + self.state["ephemeral_interval"]

    def keep_ephemeral(self, name: Any = None, activate: bool = True) -> Dict[str, Any]:
        """
        Save the current ephemeral identity as a profile and switch to it.
        The nodes it identified to become bound to the new profile, so
        auto-identify finds them again. activate=False (the messenger keeping
        it while browsing as someone else) leaves the identity in use alone.
        """
        with self._lock:
            kept = self._ephemeral
            profile = self._add_profile(kept, name or "Kept identity")
            for node in self._ephemeral_nodes:
                self.state["bindings"].setdefault(node, profile["id"])
            if activate:
                self.state["active"] = profile["id"]
                self.state["last_fixed"] = profile["id"]
            # The kept key is a profile now; the next ephemeral is a new one.
            self._ephemeral = RNS.Identity()
            self._ephemeral_nodes = []
            self._save()
            return profile

    # ------------------------------------------------------------------ #
    # Bindings and auto-identify                                         #
    # ------------------------------------------------------------------ #

    def binding_for(self, node_hash: Any) -> Optional[str]:
        node = clean_node_hash(node_hash)
        if not node:
            return None
        if node in self.state["bindings"]:
            return self.state["bindings"][node]
        if node in self._ephemeral_nodes:
            return EPHEMERAL
        return None

    def record_identify(self, node_hash: Any, profile_id: Optional[str] = None) -> None:
        """
        Note that we identified to a node. Only the first identity used on a
        node is bound to it; identifying later as somebody else is a second
        account, and does not move the binding.
        """
        node = clean_node_hash(node_hash)
        if not node:
            return
        with self._lock:
            profile_id = profile_id or self.active_id
            if self.binding_for(node):
                return
            if profile_id == EPHEMERAL:
                self._ephemeral_nodes.append(node)
                return
            self.state["bindings"][node] = profile_id
            self._save()

    def set_binding(self, node_hash: Any, profile_id: Optional[str]) -> None:
        node = clean_node_hash(node_hash)
        if not node:
            raise ValueError("Not a node hash")
        with self._lock:
            if profile_id in (None, ""):
                self.state["bindings"].pop(node, None)
                if node in self._ephemeral_nodes:
                    self._ephemeral_nodes.remove(node)
            else:
                if not self._profile(profile_id):
                    raise ValueError("No such identity")
                self.state["bindings"][node] = profile_id
                if node in self._ephemeral_nodes:
                    self._ephemeral_nodes.remove(node)
            self._save()

    def set_options(self, auto_identify: Optional[bool] = None,
                    ephemeral_mode: Optional[str] = None,
                    ephemeral_interval: Any = None) -> None:
        with self._lock:
            if auto_identify is not None:
                self.state["auto_identify"] = bool(auto_identify)
            if ephemeral_interval is not None:
                try:
                    interval = int(ephemeral_interval)
                except (TypeError, ValueError):
                    interval = None
                if interval not in EPHEMERAL_INTERVALS:
                    raise ValueError("Unknown interval")
                if interval != self.state["ephemeral_interval"]:
                    self.state["ephemeral_interval"] = interval
                    self._ephemeral_since = time.time()
            if ephemeral_mode is not None:
                if ephemeral_mode not in EPHEMERAL_MODES:
                    raise ValueError("Unknown ephemeral mode")
                if ephemeral_mode == "timed" and self.state["ephemeral_mode"] != "timed":
                    self._ephemeral_since = time.time()
                self.state["ephemeral_mode"] = ephemeral_mode
            self._save()

    def migrate_nodes(self, nodes: Any, auto_identify: Optional[bool] = None) -> int:
        """
        Take over the auto-identify list the page used to keep in the
        browser's own storage. Those nodes were identified to with the only
        identity there was, so they are bound to the default profile.
        """
        added = 0
        with self._lock:
            for value in nodes if isinstance(nodes, list) else []:
                node = clean_node_hash(value)
                if node and node not in self.state["bindings"]:
                    self.state["bindings"][node] = DEFAULT_ID
                    added += 1
            if auto_identify is not None:
                self.state["auto_identify"] = bool(auto_identify) or self.state["auto_identify"]
            self._save()
        return added

    # ------------------------------------------------------------------ #
    # For the UI                                                         #
    # ------------------------------------------------------------------ #

    def snapshot(self, node_names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        node_names = node_names or {}
        with self._lock:
            profiles = []
            for profile in self.state["profiles"]:
                identity = self.identity_for(profile["id"])
                profiles.append({
                    "id": profile["id"],
                    "name": profile["name"],
                    "created": profile.get("created"),
                    "is_default": profile["id"] == DEFAULT_ID,
                    "loadable": identity is not None,
                    "file_path": os.path.abspath(self._path(profile["file"])),
                    **describe_identity(identity),
                })

            bindings = [
                {"node": node, "node_name": node_names.get(node, ""),
                 "profile_id": pid, "profile_name": self.name_of(pid)}
                for node, pid in sorted(self.state["bindings"].items(),
                                        key=lambda kv: node_names.get(kv[0], kv[0]).lower())
            ]
            bindings += [
                {"node": node, "node_name": node_names.get(node, ""),
                 "profile_id": EPHEMERAL, "profile_name": "Ephemeral"}
                for node in self._ephemeral_nodes
            ]

            active = self.active_id
            next_rotation = self.next_rotation()
            return {
                "status": "success",
                "active": active,
                "active_name": self.name_of(active),
                "active_identity": describe_identity(self.active_identity()),
                "profiles": profiles,
                "ephemeral": {
                    **describe_identity(self._ephemeral),
                    "used_on": [{"node": n, "node_name": node_names.get(n, "")}
                                for n in self._ephemeral_nodes],
                },
                "ephemeral_mode": self.state["ephemeral_mode"],
                "ephemeral_interval": self.state["ephemeral_interval"],
                "ephemeral_intervals": list(EPHEMERAL_INTERVALS),
                # Seconds, not a time of day: the phone's clock need not
                # agree with the computer's.
                "ephemeral_rotates_in": (None if next_rotation is None
                                         else max(0, round(next_rotation - time.time()))),
                "ephemeral_on": active == EPHEMERAL,
                "last_fixed": self.state["last_fixed"],
                "last_fixed_name": self.name_of(self.state["last_fixed"]),
                "auto_identify": self.state["auto_identify"],
                "bindings": bindings,
            }


__all__ = ["IdentityManager", "EPHEMERAL", "DEFAULT_ID", "EPHEMERAL_MODES", "EPHEMERAL_INTERVALS",
           "clean_node_hash", "describe_identity"]
