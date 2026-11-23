"""
Access password for the web UI (Settings > Access & Remote > Access password).

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

Guest mode (Settings > Access & Remote > Guest mode): a second password, for
people trying rBrowser on the owner's machine. The login page takes either:
the owner's gives everything, the guest's a session marked "guest" that
routes.py lets read the settings but not change them (guest_blocked). The
guest password is hashed the same way and logged out the same way (its own
tag). With "No password" (guest_open) the login page has an "Enter as guest"
button instead.
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
from typing import Any, Dict, List, Optional, Tuple

from . import guest_log
from .guest_sessions import GuestSessions

AUTH_FILE = os.path.join("settings", "auth.json")
ITERATIONS = 200_000
MIN_LENGTH = 6
LOCK_AFTER = 5              # wrong passwords from one address...
LOCK_SECONDS = 300          # ...then refused for this long
LOCAL = {"127.0.0.1", "::1", "localhost"}
GUEST_IN_USE = 120         # s since a guest's last request: still in
KICKED_MAX = 200
BANS_MAX = 200
BAN_TIMES = (900, 3600, 86400, 0)    # Ban: 15 min, 1 h, 24 h, until Unban (0)
# Settings that change without the owner's password (with the guest clients and shared lists).
FREE_KEYS = {"current", "ask_local", "guest_log", "guest_log_path", "guest_log_lxmf", "guest_access_log",
             "guest_rrc_hub_on", "guest_rrc_hub", "guest_max"}
GUEST_MAX_DEFAULT, GUEST_MAX_TOP = 3, 30     # guests in at once (one identity each)
ACCESS_LOG_NAME = "guest_access.log"     # next to the guest actions log

# Reachable without a session: the login page itself.
# /api/guest/state: a guest the owner just shut out must still hear why.
OPEN_PATHS = {"/login", "/logout", "/favicon.ico", "/api/guest/state"}


def _hub_address(value: Any) -> str:
    value = str(value or "").strip().lower()
    return value if re.fullmatch(r"[0-9a-f]{32}", value) else ""


def _hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS).hex()


class Auth:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.fails: Dict[str, Tuple[int, float]] = {}       # address -> (count, first fail)
        self.guest_seen = 0.0                                # last request of a guest session
        self.guests = GuestSessions()
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
               "guest_open": bool(data.get("guest_open")),     # no guest password: a button on the login page
               # New at every close: old guest cookies stay out when access reopens.
               "guest_epoch": data.get("guest_epoch") if isinstance(data.get("guest_epoch"), str) else "",
               # Guest sessions the owner kicked out (guest_sessions.py ids), until the next close.
               "guest_kicked": [k for k in data.get("guest_kicked", []) if isinstance(k, str)][-KICKED_MAX:]
               if isinstance(data.get("guest_kicked"), list) else [],
               # Logged-out sessions (their "sid"): an old cookie coming back stays out.
               "revoked": [k for k in data.get("revoked", []) if isinstance(k, str)][-KICKED_MAX:]
               if isinstance(data.get("revoked"), list) else [],
               # Bans {id: {address, device, until (0 = until Unban), since, agent}}, kept across closes.
               "guest_bans": {k: v for k, v in data.get("guest_bans", {}).items()
                              if isinstance(k, str) and isinstance(v, dict)}
               if isinstance(data.get("guest_bans"), dict) else {},
               "guest_access_log": bool(data.get("guest_access_log", True)),   # logins, logouts, kicks
               # One switch per client. Older files had guest_chat for RRC and BBS.
               "guest_nomadnet": bool(data.get("guest_nomadnet", True)),
               "guest_rrc": bool(data.get("guest_rrc", data.get("guest_chat", True))),
               "guest_bbs": bool(data.get("guest_bbs", data.get("guest_chat", True))),
               "guest_messenger": bool(data.get("guest_messenger")),
               "guest_rmap": bool(data.get("guest_rmap", True)),
               "guest_radio": bool(data.get("guest_radio", True)),
               # The owner's lists shown to guests: off, they get empty ones.
               "guest_favorites": bool(data.get("guest_favorites")),
               "guest_history": bool(data.get("guest_history")),
               "guest_log": bool(data.get("guest_log")),          # guest_log.py; the login page says so
               "guest_log_path": data.get("guest_log_path") if isinstance(data.get("guest_log_path"), str) else "",
               "guest_log_lxmf": bool(data.get("guest_log_lxmf")),     # the text of guests' LXMF messages too
               # On: guests are put on this one RRC hub, and only there.
               "guest_rrc_hub_on": bool(data.get("guest_rrc_hub_on")),
               "guest_rrc_hub": _hub_address(data.get("guest_rrc_hub")),
               "guest_max": _guest_max(data.get("guest_max", GUEST_MAX_DEFAULT))}
        if not out["guest_rrc_hub"]:
            out["guest_rrc_hub_on"] = False
        if not out["hash"]:
            out["enabled"] = False          # never on without a password
        if not out["guest_hash"] and not out["guest_open"]:
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
        # Open and with-password guests get different tags: switching mode logs guests out.
        epoch = self.data["guest_epoch"]
        if self.data["guest_open"]:
            return "o" + hmac.new(self.secret.encode(), ("guest-open:" + epoch).encode(), "sha256").hexdigest()[:16]
        return "g" + hmac.new(self.secret.encode(), (self.data["guest_hash"] + ":" + epoch).encode(),
                              "sha256").hexdigest()[:16]

    def guest_on(self) -> bool:
        return (self.data["enabled"] and self.data["guest_enabled"]
                and (self.data["guest_open"] or bool(self.data["guest_hash"])))

    def guest_open(self) -> bool:
        return self.guest_on() and self.data["guest_open"]

    def session_role(self, session: Any) -> Optional[str]:
        """"owner", "guest" or None (no valid session)."""
        value = str(session.get("auth", ""))
        if session.get("sid") and session.get("sid") in self.data["revoked"]:
            return None
        if self.data["hash"] and hmac.compare_digest(value, self.tag()):
            return "owner"
        if self._guest_tag_ok(value) and not self.is_kicked(session):
            return "guest"
        return None

    def _guest_tag_ok(self, value: str) -> bool:
        return self.guest_on() and hmac.compare_digest(value, self.guest_tag())

    def revoke(self, sid: str) -> None:
        """Log out: a request still on its way can send the old cookie back."""
        with self.lock:
            if sid and sid not in self.data["revoked"]:
                self.data["revoked"] = (self.data["revoked"] + [sid])[-KICKED_MAX:]
                self._save()

    def is_kicked(self, session: Any) -> bool:
        return str(session.get("gid", "")) in self.data["guest_kicked"]

    def guest_state(self, session: Any) -> Dict[str, Any]:
        """For the guest page's check: still in (and with which clients), or shut out and why.
        Guest tags start with "g"/"o", the owner's is hex: nothing to tell a non-guest."""
        if self.session_role(session) == "guest":
            return {"state": "active", "rights": self.guest_rights(), "log": self.guest_logged(),
                    "online": self.guests.count()}
        value = str(session.get("auth", ""))
        if value[:1] in ("g", "o"):
            if self._guest_tag_ok(value):
                return {"state": "kicked"}
            return {"state": "closed" if not self.guest_on() else "changed"}
        # The login page reloads when these change (the "Enter as guest" button comes and goes).
        return {"state": "none", "guest_on": self.guest_on(), "guest_open": self.guest_open()}

    def kick(self, gid: str) -> bool:
        """One guest session out; it stays out until guest access closes (then all are)."""
        with self.lock:
            if not gid or gid in self.data["guest_kicked"]:
                return False
            self.data["guest_kicked"] = (self.data["guest_kicked"] + [gid])[-KICKED_MAX:]
            self._save()
        self.guests.end(gid)
        return True

    def _ban_of(self, address: str, device: str) -> Optional[str]:
        """The id of the ban that hits this address or this browser, None if none (ended ones go)."""
        now, hit = time.time(), None
        for bid, row in list(self.data["guest_bans"].items()):
            until = float(row.get("until") or 0)
            if until and until <= now:
                self.unban(bid)
            elif hit is None and ((address and row.get("address") == address)
                                  or (device and row.get("device") == device)):
                hit = bid
        return hit

    def banned(self, address: str, device: str = "") -> Optional[float]:
        """When the guest ban on this address or browser ends (0: until Unban), None if not banned."""
        bid = self._ban_of(address, device)
        return None if bid is None else float(self.data["guest_bans"][bid].get("until") or 0)

    def ban(self, address: str, device: str, seconds: int, agent: str = "") -> bool:
        """Guests from this address and this browser out (now and at the login) for seconds, 0 = until Unban."""
        if not (address or device) or seconds not in BAN_TIMES:
            return False
        now = time.time()
        with self.lock:
            bans = dict(self.data["guest_bans"])
            bans[secrets.token_hex(4)] = {"address": address, "device": device, "agent": agent[:120],
                                          "until": now + seconds if seconds else 0, "since": now}
            self.data["guest_bans"] = dict(sorted(bans.items(), key=lambda kv: kv[1]["since"])[-BANS_MAX:])
            self._save()
        return True

    def unban(self, bid: str) -> bool:
        with self.lock:
            if bid not in self.data["guest_bans"]:
                return False
            self.data["guest_bans"] = {k: v for k, v in self.data["guest_bans"].items() if k != bid}
            self._save()
        return True

    def ban_text(self, address: str, device: str = "") -> str:
        """What a banned guest reads, "" if not banned."""
        until = self.banned(address, device)
        if until is None:
            return ""
        if not until:
            return "The owner banned you from guest access."
        left = max(1, int((until - time.time() + 59) // 60))
        when = f"{left} min" if left < 120 else f"{round(left / 60)} h"
        return f"The owner banned you from guest access: try again in {when}."

    def bans(self) -> List[Dict[str, Any]]:
        self._ban_of("", "")                          # drops the ended ones
        return [dict(v, id=k, device=bool(v.get("device"))) for k, v in self.data["guest_bans"].items()]

    def close_all_guests(self) -> None:
        """Every guest session out; guests may log in again."""
        with self.lock:
            self._new_guest_epoch()
            self._save()

    def _new_guest_epoch(self) -> None:
        self.data["guest_epoch"] = secrets.token_hex(8)
        self.data["guest_kicked"] = []

    def guest_access_file(self) -> str:
        """Next to a guest actions log you chose, else logs/ beside settings/ (the rBrowser folder)."""
        if self.data["guest_log_path"]:
            folder = os.path.dirname(self.guest_log_file())
        else:
            folder = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(AUTH_FILE))), "logs")
        target = os.path.join(folder, ACCESS_LOG_NAME)
        return target if target != self.guest_log_file() else target + ".txt"

    def guest_access_logged(self) -> bool:
        return self.data["guest_access_log"]

    def session_ok(self, session: Any) -> bool:
        return self.session_role(session) is not None

    def role(self, session: Any, address: Optional[str]) -> str:
        """Who this request is: without the password asked, the owner."""
        if not self.required(address):
            return "owner"
        return self.session_role(session) or "none"

    def guest_sees(self, kind: str) -> bool:
        """May guests see the owner's favorites / history?"""
        return bool(self.data.get("guest_" + kind))

    def guest_fixed_hub(self) -> str:
        """The one RRC hub guests are put on, "" if they choose."""
        return self.data["guest_rrc_hub"] if self.data["guest_rrc_hub_on"] else ""

    def guest_in_use(self) -> bool:
        """A guest is in: a guest page asked something lately (they poll every few seconds)."""
        return self.guest_on() and time.time() - self.guest_seen < GUEST_IN_USE

    def guest_max(self) -> int:
        return self.data["guest_max"]

    def guest_rights(self) -> Dict[str, bool]:
        return {k: self.data["guest_" + k] for k in GUEST_CLIENTS}

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

    def login(self, password: Any, address: str, as_guest: bool = False, device: str = "") -> Optional[str]:
        """The login page: the session tag for the owner's password or, with
        guest mode on, the guest's; None if neither (counted as a failure).
        as_guest: the "Enter as guest" button, only with open guest access.
        A banned address or browser gets no guest session (the owner's password still works)."""
        if as_guest:
            return self.guest_tag() if self.guest_open() and self.banned(address, device) is None else None
        if self.locked(address):
            return None
        if self.guest_on() and not self.data["guest_open"] and self._matches(password, "guest_"):
            with self.lock:
                self.fails.pop(address, None)
            return self.guest_tag() if self.banned(address, device) is None else None
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
                          "has_password": bool(self.data["guest_hash"]), "open": self.data["guest_open"],
                          "log": self.data["guest_log"], "log_path": self.guest_log_file(),
                          "log_lxmf": self.data["guest_log_lxmf"],
                          "log_default": guest_log.resolve(""),
                          "favorites": self.data["guest_favorites"], "history": self.data["guest_history"],
                          "rrc_hub_on": self.data["guest_rrc_hub_on"], "rrc_hub": self.data["guest_rrc_hub"],
                          "in_use": self.guest_in_use(), "max": self.data["guest_max"],
                          "access_log": self.data["guest_access_log"], "access_log_path": self.guest_access_file(),
                          "online": self.guests.count() if self.guest_on() else 0,
                          **self.guest_rights()}}

    def guest_log_file(self) -> str:
        return guest_log.resolve(self.data["guest_log_path"])

    def guest_logged(self) -> bool:
        return self.guest_on() and self.data["guest_log"]

    def guest_lxmf_logged(self) -> bool:
        """The text of guests' LXMF messages in the actions log (off: only who and when)."""
        return self.guest_logged() and self.data["guest_log_lxmf"]

    def update(self, incoming: Dict[str, Any], address: str) -> Dict[str, Any]:
        """Settings > Access & Remote; the current password only for who gets in (_needs_current)."""
        if self.data["hash"] and self._needs_current(incoming) and not self.check_password(incoming.get("current"), address):
            wait = self.locked(address)
            if wait:
                error = f"Too many wrong passwords: wait {wait // 60 + 1} min. Nothing was changed."
            elif not incoming.get("current"):
                error = "Type your access password (the admin one) to apply. Nothing was changed."
            else:
                error = "Your access password (the admin one) is not right. Nothing was changed."
            return {"status": "error", "error": error}
        with self.lock:
            before = dict(self.data)
            was_on = self.guest_on()
            error = self._apply(incoming)
            if error:
                self.data = before              # all or nothing
                return {"status": "error", "error": error + " Nothing was changed."}
            if was_on and not self.guest_on():
                self._new_guest_epoch()
            self._save()
        out = self.status(address)
        out["tag"] = self.tag()
        return out

    def update_here(self, incoming: Dict[str, Any]) -> Optional[str]:
        """From the terminal (cli_auth.py): no current password, the file is ours anyway. Error or None."""
        with self.lock:
            before = dict(self.data)
            was_on = self.guest_on()
            error = self._apply(incoming)
            if error:
                self.data = before
                return error
            if was_on and not self.guest_on():
                self._new_guest_epoch()
            self._save()
        return None

    def _needs_current(self, incoming: Dict[str, Any]) -> bool:
        """A change that needs the owner's password: a new password, or a guarded switch that moves."""
        for key, value in incoming.items():
            if key in FREE_KEYS or key in {"guest_" + k for k in GUEST_CLIENTS + GUEST_SHARES}:
                continue
            if key in ("password", "guest_password"):
                if value not in (None, ""):
                    return True
            elif key not in self.data or bool(value) != bool(self.data[key]):
                return True
        return False

    def _apply(self, incoming: Dict[str, Any]) -> Optional[str]:
        """The changes of one update, in order; an error stops them (update() rolls back)."""
        new = incoming.get("password")
        guest_new = incoming.get("guest_password")
        if new is not None and new != "":
            new = str(new)
            if len(new) < MIN_LENGTH:
                return f"At least {MIN_LENGTH} characters."
            if self._matches(new, "guest_"):
                return "That is the guest password: pick another one."
            salt = secrets.token_bytes(16)
            self.data["salt"], self.data["hash"] = salt.hex(), _hash(new, salt)
        if guest_new is not None and guest_new != "":
            guest_new = str(guest_new)
            if len(guest_new) < MIN_LENGTH:
                return f"Guest password: at least {MIN_LENGTH} characters."
            if self._matches(guest_new):
                return "Guest password: pick one different from your admin password."
            salt = secrets.token_bytes(16)
            self.data["guest_salt"], self.data["guest_hash"] = salt.hex(), _hash(guest_new, salt)
        for key in ["guest_" + k for k in GUEST_CLIENTS] + ["guest_" + k for k in GUEST_SHARES]:
            if key in incoming:
                self.data[key] = bool(incoming[key])
        if "guest_rrc_hub" in incoming:
            hub = _hub_address(incoming["guest_rrc_hub"])
            if incoming["guest_rrc_hub"] and not hub:
                return "Fixed RRC hub: not an RRC hub address (32 hex characters)."
            self.data["guest_rrc_hub"] = hub
        if "guest_rrc_hub_on" in incoming:
            if incoming["guest_rrc_hub_on"] and not self.data["guest_rrc_hub"]:
                return "Fixed RRC hub for guests: pick the hub."
            self.data["guest_rrc_hub_on"] = bool(incoming["guest_rrc_hub_on"])
        if "guest_open" in incoming:
            self.data["guest_open"] = bool(incoming["guest_open"])
        if "guest_max" in incoming:
            self.data["guest_max"] = _guest_max(incoming["guest_max"])
        if "guest_log_path" in incoming:
            error = self._set_log_path(incoming["guest_log_path"])
            if error:
                return error
        if "guest_log" in incoming:
            self.data["guest_log"] = bool(incoming["guest_log"])
        if "guest_log_lxmf" in incoming:
            self.data["guest_log_lxmf"] = bool(incoming["guest_log_lxmf"])
        if "guest_access_log" in incoming:
            self.data["guest_access_log"] = bool(incoming["guest_access_log"])
        if "guest_enabled" in incoming:
            if incoming["guest_enabled"] and not self.data["guest_hash"] and not self.data["guest_open"]:
                return "Guest password: type one, or choose 'No password (open)'."
            self.data["guest_enabled"] = bool(incoming["guest_enabled"])
        if "ask_local" in incoming:
            self.data["ask_local"] = bool(incoming["ask_local"])
        if "enabled" in incoming:
            if incoming["enabled"] and not self.data["hash"]:
                return "Set a password first."
            self.data["enabled"] = bool(incoming["enabled"])
        return None

    def _set_log_path(self, value: Any) -> Optional[str]:
        """Empty = the default (logs/guest_actions.log in the rBrowser folder)."""
        value = str(value or "").strip().strip('"')
        if not value or guest_log.resolve(value) == guest_log.resolve(""):
            self.data["guest_log_path"] = ""
            return None
        target = guest_log.resolve(value)
        if not target.lower().endswith((".log", ".txt")):
            return "Guest log: the file name must end in .log or .txt."
        if os.path.isdir(target):
            return "Guest log: that is a folder, add a file name."
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "a", encoding="utf-8"):
                pass
        except OSError as exc:
            return f"Guest log: cannot write there ({exc.strerror or exc})."
        self.data["guest_log_path"] = target
        return None


# --- Guest mode: what a guest session may do -------------------------------
#
# A list of what is ALLOWED, not of what is forbidden: an API added later is
# closed to guests until someone puts it here. Reading (GET) is open except
# the keys and, unless allowed, the messenger; anything that writes is closed
# except browsing and, if allowed, chatting.

# Never, not even to read: the private keys.
def _guest_max(value: Any) -> int:
    try:
        return max(1, min(GUEST_MAX_TOP, int(value)))
    except (TypeError, ValueError):
        return GUEST_MAX_DEFAULT


GUEST_NEVER = (re.compile(r"^/api/identities/(export-all|[^/]+/export)$"),
               re.compile(r"^/api/files(/|$)"),
               re.compile(r"^/api/guest/(log|sessions)(/|$)"),
               re.compile(r"^/api/monitor$"),
               # The owner's terminal, server, remote access and vanity keys: Settings only.
               re.compile(r"^/api/(log|server-settings|console-settings|remote|autostart|shortcuts|netwatch)$"),
               re.compile(r"^/api/vanity(/|$)"))

# Writes a guest may always make: browsing NomadNet pages and files, the
# node checks (ping, path, kind), the RMAP refresh (limited by the server).
GUEST_USE = tuple(re.compile(p) for p in (
    r"^/api/fetch/[0-9a-f]+$",
    r"^/api/nomadnet/tabs$",
    r"^/api/guest/bye$",
    r"^/api/guest/(stamp|name)$",
    r"^/api/download/cancel/[^/]+$",
    r"^/api/(ping|path)/[0-9a-f]+$",
    r"^/api/fingerprint/[0-9a-f]+$",
    r"^/api/hash-kind/[0-9a-f]+$",
    r"^/api/lxmf-check/[0-9a-f]+$",
    r"^/api/rmap/refresh$",
))

# Each client a guest may be kept out of: every request of it, reads too.
GUEST_CLIENTS = ("nomadnet", "rrc", "bbs", "messenger", "rmap", "radio")
GUEST_SHARES = ("favorites", "history")
GUEST_AREAS = {
    "nomadnet": re.compile(r"^/api/(fetch|download|fingerprint|cache/(search|pages|summary|node))(/|$)"),
    "rrc": re.compile(r"^/api/rrc(/|$)"),
    "bbs": re.compile(r"^/api/retibbs(/|$)"),
    "messenger": re.compile(r"^/api/messenger(/|$)"),
    "rmap": re.compile(r"^/api/rmap(/|$)"),
    "radio": re.compile(r"^/api/radio(/|$)"),
}
GUEST_OFF = {
    "nomadnet": "Guest mode: NomadNet pages are not open to guests",
    "rrc": "Guest mode: RRC is not open to guests",
    "bbs": "Guest mode: the BBS client is not open to guests",
    "messenger": "Guest mode: the messenger is not open to guests",
    "rmap": "Guest mode: RMAP is not open to guests",
    "radio": "Guest mode: the Radio is not open to guests",
}

# Writes of the chat clients a guest is allowed into.
GUEST_RRC = tuple(re.compile(p) for p in (
    r"^/api/rrc/(connect|disconnect|close|input|retry|join|part|list|read)/[0-9a-f]+$",
))
# Its own call only: not the owner's identity or station list.
GUEST_RADIO = tuple(re.compile(p) for p in (
    r"^/api/radio/(tune|stop|quality|command|refresh)$",
))
GUEST_BBS = tuple(re.compile(p) for p in (
    r"^/api/retibbs/(connect|disconnect|close|send)/[0-9a-f]+$",
))

# With "guests can use the messenger": reading and writing messages (not its
# settings, names, contacts, blocks or deletions).
GUEST_MESSENGER = tuple(re.compile(p) for p in (
    r"^/api/messenger/(send|sync|sync/cancel|announce|name)$",       # name: its own, not the owner's
    r"^/api/messenger/(react|read|ping|contact)/[0-9a-f]+$",
    r"^/api/messenger/(cancel|retry)/[0-9a-f]+/[^/]+$",
    r"^/api/messenger/cancel-incoming/[^/]+$",
))

READ_METHODS = {"GET", "HEAD", "OPTIONS"}


def guest_blocked(method: str, path: str, rights: Dict[str, bool]) -> Optional[str]:
    """Why a guest may not make this request, or None if it may."""
    if any(p.match(path) for p in GUEST_NEVER):
        if path.startswith("/api/files"):
            return "Guest mode: the files on this computer are not shown to guests"
        if path.startswith("/api/guest/log"):
            return "Guest mode: the guest log is for the owner only"
        if path.startswith("/api/guest/sessions"):
            return "Guest mode: the guest list is for the owner only"
        if path == "/api/monitor":
            return "Guest mode: rB2 Monitor is for the owner only"
        if not path.startswith("/api/identities"):
            return "Guest mode: for the owner only"
        return "Guest mode: identity keys are not shown to guests"
    for client, area in GUEST_AREAS.items():
        if area.match(path) and not rights.get(client):
            return GUEST_OFF[client]
    if method.upper() in READ_METHODS:
        return None
    if any(p.match(path) for p in GUEST_USE):
        return None
    if rights.get("rrc") and any(p.match(path) for p in GUEST_RRC):
        return None
    if rights.get("bbs") and any(p.match(path) for p in GUEST_BBS):
        return None
    if rights.get("radio") and any(p.match(path) for p in GUEST_RADIO):
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
 button.guest{background:#21262d;border:1px solid #30363d;color:#e6edf3}
 p.logged{margin:10px 0 0;font-size:12px;color:#d29922;text-align:center}
 p.online{margin:12px 0 0;font-size:12px;text-align:center}
 .down{margin-top:12px;padding:9px 10px;border:1px solid #f85149;border-radius:6px;background:#2d1215;
       color:#ffa198;font-size:13px;text-align:center}
 .down[hidden]{display:none}
 button:disabled,input:disabled{opacity:.5;cursor:default}
</style></head><body>
<form method="post" action="/login">
 <h1>rBrowser</h1>
 <p>This rBrowser asks for a password.</p>
 <input type="password" name="password" autofocus autocomplete="current-password" placeholder="Password">
 <input type="hidden" name="next" value="{next}">
 <button type="submit">Enter</button>
 {guest}
 {notice}
 <div class="err">{error}</div>
 <div class="down" id="rb-down" role="alert" hidden>rBrowser is not answering: closed, restarting or offline.
  This page reloads by itself when it is back.</div>
</form>{script}</body></html>"""

# Login page: reload when guest access changes or rBrowser is back, warning while it does not answer.
LOGIN_REOPEN_SCRIPT = """<script>
(function(){var ON={on_js},OPEN={open_js},NEXT={next_js},down=false,box=document.getElementById('rb-down');
function go(q){location.replace('/login?'+(q?q+'&':'')+'next='+encodeURIComponent(NEXT))}
function lock(on){document.querySelectorAll('form input,form button').forEach(function(e){e.disabled=on})}
setInterval(function(){var c=new AbortController(),t=setTimeout(function(){c.abort()},4000);
fetch('/api/guest/state',{cache:'no-store',signal:c.signal}).then(function(r){return r.json()}).then(function(s){
clearTimeout(t);if(s.state!=='none'){if(down)go('');return}
if(ON&&!s.guest_on)return go('ended=closed');
if(down||s.guest_on!==ON||s.guest_open!==OPEN)go('')
}).catch(function(){clearTimeout(t);if(!down){down=true;box.hidden=false;lock(true)}})},5000)})();
</script>"""
