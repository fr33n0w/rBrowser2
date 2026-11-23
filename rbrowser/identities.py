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
- **Bindings**: which identity you first identified to each node with.
  Auto-identify uses it, and the UI warns before identifying to a node as
  somebody else.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, Optional

import RNS


DEFAULT_ID = "default"

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
    """Profiles and per-node bindings."""

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

        self.state: Dict[str, Any] = {
            "active": DEFAULT_ID,
            "profiles": [],
            "bindings": {},
            "auto_identify": False,
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
        self.state["auto_identify"] = bool(self.state.get("auto_identify"))
        if self.state.get("active") not in known:
            self.state["active"] = DEFAULT_ID

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
        """The identity behind a profile id."""
        with self._lock:
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
        profile = self._profile(profile_id)
        return profile["name"] if profile else profile_id

    def set_active(self, profile_id: str) -> None:
        with self._lock:
            if not self._profile(profile_id):
                raise ValueError("No such identity")
            if self.identity_for(profile_id) is None:
                raise ValueError("That identity file cannot be loaded")
            self.state["active"] = profile_id
            self._save()

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
            self._loaded.pop(profile_id, None)
            self._broken.discard(profile_id)
            self._save()
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    # ------------------------------------------------------------------ #
    # Bindings and auto-identify                                         #
    # ------------------------------------------------------------------ #

    def binding_for(self, node_hash: Any) -> Optional[str]:
        node = clean_node_hash(node_hash)
        if not node:
            return None
        return self.state["bindings"].get(node)

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
            if self.binding_for(node) or not self._profile(profile_id):
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
            else:
                if not self._profile(profile_id):
                    raise ValueError("No such identity")
                self.state["bindings"][node] = profile_id
            self._save()

    def set_options(self, auto_identify: Optional[bool] = None) -> None:
        with self._lock:
            if auto_identify is not None:
                self.state["auto_identify"] = bool(auto_identify)
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

            active = self.active_id
            return {
                "status": "success",
                "active": active,
                "active_name": self.name_of(active),
                "active_identity": describe_identity(self.active_identity()),
                "profiles": profiles,
                "auto_identify": self.state["auto_identify"],
                "bindings": bindings,
            }


__all__ = ["IdentityManager", "DEFAULT_ID", "clean_node_hash", "describe_identity"]
