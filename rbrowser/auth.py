"""
Access password for the web UI (Settings > System Setup > Access password).

rBrowser listens on the LAN (0.0.0.0) so a phone can use it; on a network
that is not yours that means anyone there could open it, read the messages
and use the identities. With the password on, every page and every API call
needs a session first (/login).

- Only a PBKDF2-SHA256 hash of the password is kept, with its salt, in
  settings/auth.json: never the password itself.
- The session is Flask's signed cookie, HttpOnly and SameSite=Strict (another
  site cannot make the browser use it), signed with a key kept in the same
  file so a restart does not log everybody out. Changing the password logs
  every session out (the session carries a tag of the hash).
- Wrong passwords: LOCK_AFTER per address, then LOCK_SECONDS of refusals.
- This computer (localhost) is let in without asking unless "ask here too"
  is on. NOTE: a tunnel or a reverse proxy on this computer also arrives as
  localhost: with one, switch "ask here too" on.

Guest mode (Settings > Guest mode): a second password, for people trying
rBrowser on the owner's machine. The login page takes either: the owner's
gives everything, the guest's a session marked "guest" that routes.py lets
read the settings but not change them (guest_blocked). The guest password
is hashed the same way and logged out the same way (its own tag).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, Optional, Tuple

AUTH_FILE = os.path.join("settings", "auth.json")
ITERATIONS = 200_000
MIN_LENGTH = 6
LOCK_AFTER = 5              # wrong passwords from one address...
LOCK_SECONDS = 300          # ...then refused for this long
LOCAL = {"127.0.0.1", "::1", "localhost"}

# Reachable without a session: the login page itself.
OPEN_PATHS = {"/login", "/logout", "/favicon.ico"}


def _hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS).hex()


class Auth:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.fails: Dict[str, Tuple[int, float]] = {}       # address -> (count, first fail)
        self.data = self._load()

    # --- file ------------------------------------------------------------

    def _load(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {}
        try:
            with open(AUTH_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                data = stored
        except FileNotFoundError:
            pass
        except Exception as exc:
            print(f"⚠️ {AUTH_FILE} not readable, access password OFF: {exc}")
        out = {"enabled": bool(data.get("enabled")),
               "ask_local": bool(data.get("ask_local")),
               "salt": data.get("salt") if isinstance(data.get("salt"), str) else "",
               "hash": data.get("hash") if isinstance(data.get("hash"), str) else "",
               "secret": data.get("secret") if isinstance(data.get("secret"), str) else "",
               "guest_enabled": bool(data.get("guest_enabled")),
               "guest_salt": data.get("guest_salt") if isinstance(data.get("guest_salt"), str) else "",
               "guest_hash": data.get("guest_hash") if isinstance(data.get("guest_hash"), str) else "",
               # What a guest may use besides reading: chatting (RRC, BBS)
               # and the LXMF messenger (your messages: off unless chosen).
               "guest_chat": bool(data.get("guest_chat", True)),
               "guest_messenger": bool(data.get("guest_messenger"))}
        if not out["hash"]:
            out["enabled"] = False          # never on without a password
        if not out["guest_hash"]:
            out["guest_enabled"] = False
        if len(out["secret"]) < 32:
            out["secret"] = secrets.token_hex(32)
            self._save(out)
        return out

    def _save(self, data: Optional[Dict[str, Any]] = None) -> None:
        from .fileio import atomic_write_json
        os.makedirs(os.path.dirname(AUTH_FILE), exist_ok=True)
        atomic_write_json(AUTH_FILE, data if data is not None else self.data, indent=1)

    @property
    def secret(self) -> str:
        return self.data["secret"]

    def tag(self) -> str:
        """In the session: a password change makes old sessions worthless."""
        return self.data["hash"][:16]

    # --- checks ----------------------------------------------------------

    @staticmethod
    def is_local(address: Optional[str]) -> bool:
        return (address or "") in LOCAL

    def required(self, address: Optional[str]) -> bool:
        if not self.data["enabled"]:
            return False
        return self.data["ask_local"] or not self.is_local(address)

    def guest_tag(self) -> str:
        return "g" + self.data["guest_hash"][:16]

    def guest_on(self) -> bool:
        return self.data["enabled"] and self.data["guest_enabled"] and bool(self.data["guest_hash"])

    def session_role(self, session: Any) -> Optional[str]:
        """"owner", "guest" or None (no valid session)."""
        value = str(session.get("auth", ""))
        if self.data["hash"] and hmac.compare_digest(value, self.tag()):
            return "owner"
        if self.guest_on() and hmac.compare_digest(value, self.guest_tag()):
            return "guest"
        return None

    def session_ok(self, session: Any) -> bool:
        return self.session_role(session) is not None

    def role(self, session: Any, address: Optional[str]) -> str:
        """Who this request is: without the password asked, the owner."""
        if not self.required(address):
            return "owner"
        return self.session_role(session) or "none"

    def guest_rights(self) -> Dict[str, bool]:
        return {"chat": self.data["guest_chat"], "messenger": self.data["guest_messenger"]}

    def locked(self, address: str) -> int:
        """Seconds this address still has to wait (0: it may try)."""
        with self.lock:
            count, since = self.fails.get(address, (0, 0.0))
            if count >= LOCK_AFTER:
                left = int(since + LOCK_SECONDS - time.time())
                if left > 0:
                    return left
                self.fails.pop(address, None)
        return 0

    def _matches(self, password: Any, which: str = "") -> bool:
        stored, salt = self.data[which + "hash"], self.data[which + "salt"]
        return bool(stored) and hmac.compare_digest(_hash(str(password or ""), bytes.fromhex(salt)), stored)

    def login(self, password: Any, address: str) -> Optional[str]:
        """The login page: the session tag for the owner's password or, with
        guest mode on, the guest's; None if neither (counted as a failure)."""
        if self.locked(address):
            return None
        if self.guest_on() and self._matches(password, "guest_"):
            with self.lock:
                self.fails.pop(address, None)
            return self.guest_tag()
        return self.tag() if self.check_password(password, address) else None

    def check_password(self, password: Any, address: str) -> bool:
        if self.locked(address):
            return False
        ok = self._matches(password)
        with self.lock:
            if ok:
                self.fails.pop(address, None)
            else:
                count, since = self.fails.get(address, (0, time.time()))
                self.fails[address] = (count + 1, since if count else time.time())
        return ok

    # --- settings ----------------------------------------------------------

    def status(self, address: Optional[str]) -> Dict[str, Any]:
        return {"status": "success", "enabled": self.data["enabled"], "ask_local": self.data["ask_local"],
                "has_password": bool(self.data["hash"]), "local": self.is_local(address),
                "min_length": MIN_LENGTH,
                "guest": {"enabled": self.data["guest_enabled"], "active": self.guest_on(),
                          "has_password": bool(self.data["guest_hash"]), **self.guest_rights()}}

    def update(self, incoming: Dict[str, Any], address: str) -> Dict[str, Any]:
        """Settings > System Setup > Access password. With a password set, the
        current one is needed for any change (a session alone is not enough:
        a browser left open must not let someone lock the owner out)."""
        if self.data["hash"] and not self.check_password(incoming.get("current"), address):
            wait = self.locked(address)
            return {"status": "error", "error": f"Too many wrong passwords: wait {wait // 60 + 1} min" if wait
                    else "The current password is not right"}
        new = incoming.get("password")
        guest_new = incoming.get("guest_password")
        with self.lock:
            if new is not None and new != "":
                new = str(new)
                if len(new) < MIN_LENGTH:
                    return {"status": "error", "error": f"At least {MIN_LENGTH} characters"}
                if self._matches(new, "guest_"):
                    return {"status": "error", "error": "That is the guest password: pick another one"}
                salt = secrets.token_bytes(16)
                self.data["salt"], self.data["hash"] = salt.hex(), _hash(new, salt)
            if guest_new is not None and guest_new != "":
                guest_new = str(guest_new)
                if len(guest_new) < MIN_LENGTH:
                    return {"status": "error", "error": f"Guest password: at least {MIN_LENGTH} characters"}
                if self._matches(guest_new):
                    return {"status": "error", "error": "The guest password must not be your own password"}
                salt = secrets.token_bytes(16)
                self.data["guest_salt"], self.data["guest_hash"] = salt.hex(), _hash(guest_new, salt)
            for key in ("guest_chat", "guest_messenger"):
                if key in incoming:
                    self.data[key] = bool(incoming[key])
            if "guest_enabled" in incoming:
                if incoming["guest_enabled"] and not self.data["guest_hash"]:
                    return {"status": "error", "error": "Set a guest password first"}
                self.data["guest_enabled"] = bool(incoming["guest_enabled"])
            if "ask_local" in incoming:
                self.data["ask_local"] = bool(incoming["ask_local"])
            if "enabled" in incoming:
                if incoming["enabled"] and not self.data["hash"]:
                    return {"status": "error", "error": "Set a password first"}
                self.data["enabled"] = bool(incoming["enabled"])
            self._save()
        out = self.status(address)
        out["tag"] = self.tag()
        return out


# --- Guest mode: what a guest session may do -------------------------------
#
# A list of what is ALLOWED, not of what is forbidden: an API added later is
# closed to guests until someone puts it here. Reading (GET) is open except
# the keys and, unless allowed, the messenger; anything that writes is closed
# except browsing and, if allowed, chatting.

# Never, not even to read: the private keys.
GUEST_NEVER = (re.compile(r"^/api/identities/(export-all|[^/]+/export)$"),)

# Writes a guest may always make: browsing NomadNet pages and files, the
# node checks (ping, path, kind), the RMAP refresh (limited by the server).
GUEST_USE = tuple(re.compile(p) for p in (
    r"^/api/fetch/[0-9a-f]+$",
    r"^/api/download/cancel/[^/]+$",
    r"^/api/(ping|path)/[0-9a-f]+$",
    r"^/api/hash-kind/[0-9a-f]+$",
    r"^/api/lxmf-check/[0-9a-f]+$",
    r"^/api/rmap/refresh$",
))

# With "guests can chat": RRC and BBS sessions, joining, writing.
GUEST_CHAT = tuple(re.compile(p) for p in (
    r"^/api/rrc/(connect|disconnect|close|input|join|part|list|read)/[0-9a-f]+$",
    r"^/api/retibbs/(connect|disconnect|close|send)/[0-9a-f]+$",
))

# With "guests can use the messenger": reading and writing messages (not its
# settings, names, contacts, blocks or deletions).
GUEST_MESSENGER = tuple(re.compile(p) for p in (
    r"^/api/messenger/(send|sync|sync/cancel)$",
    r"^/api/messenger/(react|read|ping)/[0-9a-f]+$",
    r"^/api/messenger/(cancel|retry)/[0-9a-f]+/[^/]+$",
    r"^/api/messenger/cancel-incoming/[^/]+$",
))

READ_METHODS = {"GET", "HEAD", "OPTIONS"}


def guest_blocked(method: str, path: str, rights: Dict[str, bool]) -> Optional[str]:
    """Why a guest may not make this request, or None if it may."""
    if any(p.match(path) for p in GUEST_NEVER):
        return "Guest mode: identity keys are not shown to guests"
    if (path == "/api/messenger" or path.startswith("/api/messenger/")) and not rights.get("messenger"):
        return "Guest mode: the messenger is not open to guests"
    if method.upper() in READ_METHODS:
        return None
    if any(p.match(path) for p in GUEST_USE):
        return None
    if rights.get("chat") and any(p.match(path) for p in GUEST_CHAT):
        return None
    if rights.get("messenger") and any(p.match(path) for p in GUEST_MESSENGER):
        return None
    return "Guest mode: read only, settings cannot be changed"


LOGIN_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rBrowser - access</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0d1117;color:#e6edf3;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
 form{width:min(320px,calc(100vw - 32px));padding:24px;border:1px solid #30363d;border-radius:10px;background:#161b22}
 h1{font-size:17px;margin:0 0 6px} p{font-size:13px;color:#8b949e;margin:0 0 16px}
 input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #30363d;border-radius:6px;
       background:#0d1117;color:#e6edf3;font-size:15px}
 button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:6px;background:#238636;color:#fff;font-size:14px;cursor:pointer}
 .err{color:#f85149;font-size:13px;margin-top:10px;min-height:1em}
</style></head><body>
<form method="post" action="/login">
 <h1>rBrowser</h1>
 <p>This rBrowser asks for a password.</p>
 <input type="password" name="password" autofocus autocomplete="current-password" placeholder="Password">
 <input type="hidden" name="next" value="{next}">
 <button type="submit">Enter</button>
 <div class="err">{error}</div>
</form></body></html>"""
