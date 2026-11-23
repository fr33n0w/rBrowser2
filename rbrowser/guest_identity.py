"""
One throwaway identity per guest session (pages, LXMF, RRC, BBS): made at login, in memory only,
gone when the session ends. The announce stamp (when RNS asks for one) is worked out by the
guest's browser (script/stamper.js) and checked here before RNS gets it.
"""
from __future__ import annotations

import contextvars
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import RNS

try:
    from RNS import Stamps
except ImportError:          # an RNS without stamps
    Stamps = None

NICK_MAX = 32
MAX_GUESTS = 30
STAMP_LENGTH = 14

_CURRENT = contextvars.ContextVar("rb_guest_gid", default="")


def set_current(gid: str) -> None:
    """The guest session the request is for ("" = not a guest), set by routes.py."""
    _CURRENT.set(gid or "")


def current() -> str:
    return _CURRENT.get()


def lxmf_address(identity: RNS.Identity) -> bytes:
    return RNS.Destination.hash(identity, "lxmf", "delivery")


def stamp_material(identity: RNS.Identity) -> bytes:
    # what RNS.Destination.stamp_material() gives for lxmf.delivery
    name_hash = RNS.Identity.full_hash(b"lxmf.delivery")[:RNS.Identity.NAME_HASH_LENGTH // 8]
    return lxmf_address(identity) + identity.get_public_key() + name_hash


def stamps_needed() -> bool:
    return Stamps is not None and bool(getattr(RNS.Transport, "STAMP_DESTINATIONS", False))


def stamp_value_wanted() -> float:
    return float(getattr(RNS.Transport, "DESTINATION_VALUE", 25.0))


class GuestEntry:
    def __init__(self, gid: str, slot: int, identity: RNS.Identity) -> None:
        self.gid, self.slot, self.identity = gid, slot, identity
        self.since = time.time()
        self.names: Dict[str, str] = {}          # per client, set by the guest; "" = the default
        self.ready = not stamps_needed()         # the LXMF announce can go out
        self.no_lxmf = False                     # the browser could not make the stamp: no LXMF
        self.resume_chats = None                 # LXMF chats from before a restart (guest_resume.py)
        self.resume_rrc: Dict[str, List[str]] = {}    # and its RRC rooms per hub, joined at reconnect

    @property
    def hash(self) -> str:
        return self.identity.hash.hex()

    @property
    def address(self) -> str:
        return lxmf_address(self.identity).hex()

    def default_name(self) -> str:
        return f"rB2.Guest{self.slot}.{self.hash[:4]}"

    def name(self, client: str = "") -> str:
        return self.names.get(client) or self.names.get("") or self.default_name()

    def info(self) -> Dict[str, Any]:
        return {"id": self.gid, "slot": self.slot, "identity_hash": self.hash, "lxmf_address": self.address,
                "name": self.default_name(), "names": dict(self.names), "ready": self.ready,
                "lxmf": not self.no_lxmf, "since": self.since}


class GuestIdentity:
    def __init__(self, max_guests: Callable[[], int] = lambda: 3) -> None:
        self.max_guests = max_guests
        self.lock = threading.Lock()
        self.entries: Dict[str, GuestEntry] = {}
        self.on_ready: Optional[Callable[[GuestEntry], None]] = None     # stamp in: announce
        self.on_release: Optional[Callable[[GuestEntry], None]] = None   # session over: clients drop it
        self.on_rename: Optional[Callable[[GuestEntry, str], None]] = None

    # sessions

    def assign(self, gid: str) -> Optional[GuestEntry]:
        """The identity of this guest session, made now if new; None if all slots are taken."""
        with self.lock:
            entry = self.entries.get(gid)
            if entry is not None:
                return entry
            used = {e.slot for e in self.entries.values()}
            top = max(1, min(MAX_GUESTS, int(self.max_guests())))
            slot = next((n for n in range(1, top + 1) if n not in used), None)
            if slot is None:
                return None
            entry = self.entries[gid] = GuestEntry(gid, slot, RNS.Identity())
        print(f"👤 Guest identity {entry.default_name()} for session {gid}")
        return entry

    def slots(self) -> tuple:
        """(taken, max) guest places."""
        with self.lock:
            return len(self.entries), max(1, min(MAX_GUESTS, int(self.max_guests())))

    def full(self) -> bool:
        taken, top = self.slots()
        return taken >= top

    def release(self, gid: str) -> Optional[GuestEntry]:
        with self.lock:
            entry = self.entries.pop(gid, None)
        if entry is not None:
            self._drop_stamp(entry)
            if self.on_release:
                try:
                    self.on_release(entry)
                except Exception as exc:
                    print(f"⚠️ Guest identity release {gid}: {exc}")
            print(f"👤 Guest identity {entry.default_name()} thrown away")
        return entry

    def release_all(self) -> None:
        for gid in list(self.entries):
            self.release(gid)

    def entry(self, gid: Optional[str] = None) -> Optional[GuestEntry]:
        return self.entries.get(current() if gid is None else gid)

    def list(self) -> List[GuestEntry]:
        with self.lock:
            return sorted(self.entries.values(), key=lambda e: e.slot)

    # what the clients ask, for the guest of the request (or a given session)

    def get(self, gid: Optional[str] = None) -> Optional[RNS.Identity]:
        entry = self.entry(gid)
        return entry.identity if entry is not None else None

    def nickname(self, client: str = "", gid: Optional[str] = None) -> str:
        entry = self.entry(gid)
        return entry.name(client) if entry is not None else "rB2.Guest"

    def set_nickname(self, value: Any, client: str = "", gid: Optional[str] = None) -> Dict[str, Any]:
        entry = self.entry(gid)
        if entry is None:
            return {"status": "error", "error": "No guest session"}
        nick = clean_nick(value)
        if nick:
            entry.names[client] = nick
        else:
            entry.names.pop(client, None)
        if self.on_rename:
            self.on_rename(entry, client)
        return {"status": "success", **entry.info()}

    # the announce stamp

    def stamp_job(self, gid: Optional[str] = None) -> Dict[str, Any]:
        entry = self.entry(gid)
        if entry is None:
            return {"status": "error", "error": "No guest session"}
        if entry.ready:
            return {"status": "success", "ready": True}
        value = stamp_value_wanted()
        target = Stamps.target_from_cost(value).to_bytes(32, "big")
        return {"status": "success", "ready": False, "material": stamp_material(entry.identity).hex(),
                "target": target.hex(), "size": STAMP_LENGTH, "cost": value}

    def accept_stamp(self, stamp_hex: Any, gid: Optional[str] = None) -> Dict[str, Any]:
        entry = self.entry(gid)
        if entry is None:
            return {"status": "error", "error": "No guest session"}
        if entry.ready:
            return {"status": "success", "ready": True}
        try:
            stamp = bytes.fromhex(str(stamp_hex))
        except ValueError:
            stamp = b""
        material, value = stamp_material(entry.identity), stamp_value_wanted()
        if len(stamp) != STAMP_LENGTH or not Stamps.stamp_valid(stamp, value, material):
            return {"status": "error", "error": "Stamp not valid"}
        got = Stamps.stamp_value(material, stamp)
        # RNS loads it when the LXMF destination is made, and checks it again.
        Stamps.store_destination_stamp(lxmf_address(entry.identity), stamp, got)
        entry.ready = True
        print(f"👤 Guest {entry.default_name()}: stamp {got:.2f} from the browser")
        if self.on_ready:
            try:
                self.on_ready(entry)
            except Exception as exc:
                print(f"⚠️ Guest identity ready {entry.gid}: {exc}")
        return {"status": "success", "ready": True}

    def skip_stamp(self, gid: Optional[str] = None) -> Dict[str, Any]:
        """No stamp from this browser: in without LXMF (the server does not make it instead)."""
        entry = self.entry(gid)
        if entry is None:
            return {"status": "error", "error": "No guest session"}
        if not entry.ready:
            entry.ready, entry.no_lxmf = True, True
            print(f"👤 Guest {entry.default_name()}: no stamp from the browser, LXMF off")
        return {"status": "success", "ready": True, "lxmf": not entry.no_lxmf}

    def _drop_stamp(self, entry: GuestEntry) -> None:
        if Stamps is None:
            return
        try:
            path = Stamps.destination_stamp_file(lxmf_address(entry.identity))
            if path and os.path.isfile(path):
                os.remove(path)
        except Exception as exc:
            print(f"⚠️ Guest stamp file: {exc}")


def clean_nick(value: Any) -> str:
    text = " ".join(str(value or "").split())
    return "".join(ch for ch in text if ch.isprintable())[:NICK_MAX]
