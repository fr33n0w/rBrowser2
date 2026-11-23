"""
RetiBBS client (https://github.com/kc1awv/RetiBBS): bulletin boards over
Reticulum, listed in the Reticulum manual.

The protocol is a remote terminal. A server announces "retibbs.bbs" with
JSON app data {"server_name": ...}. The client opens a Link, identifies with
one of our identities (the BBS account is that identity), and sends what
the user types as UTF-8 packets ("?", "n name", "b", "c"...). The server
answers with text - small replies as packets, long ones as a Resource - in
Rich markup ([bold red]...[/]), plus control packets: "CTRL CLS" (clear the
screen), "CTRL AREA x", "CTRL BOARD x", "CTRL ROOM x", "CTRL ECHO on|off" (rBBS:
the server echoes our lines, so they are not shown twice). "PING" gets "PONG".
rBBS also says "CTRL HELLO rbbs 1": we answer "CTRL CAPS image screen", then it
may send "CTRL SCREEN cols rows", "CTRL STATUS text" (live counters, shown in the
bar) and pictures (a Resource with metadata type=image).
With "rows" in our CAPS, a screen starts STX S<n> STX and "CTRL ROWS n v len" updates
single rows of it (we prove those packets, the server resends what is not proved).

Servers heard are listed (from announces, and those Reticulum remembers);
favourites and the ones connected to (history) are kept on disk so they are
never lost. Several servers can be open at once, one session each: the page
shows them as tabs.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
from collections import OrderedDict, deque
from typing import Any, Dict, List, Optional

import RNS

from .identities import DEFAULT_ID
from .messenger import GUEST_ID, guest_view
from .guest_identity import current as guest_current

SETTINGS_FILE = os.path.join("settings", "retibbs.json")
APP_NAME, ASPECT = "retibbs", "bbs"

# The kinds of BBS the client lists, in the order the server list shows them
# (one group per kind, a separator between groups when there is more than
# one). The kind comes from the aspect the server announces on, which RNS
# checks against the destination hash. RetiBBS stays last.
BBS_TYPES = OrderedDict([
    # an rBBS answers on the RetiBBS aspect too: told apart by its announce ("rbbs") or its CTRL HELLO
    ("rbbs", {"label": "rBBS", "aspect": f"{APP_NAME}.{ASPECT}"}),
    ("retibbs", {"label": "RetiBBS", "aspect": f"{APP_NAME}.{ASPECT}"}),
])
DEFAULT_TYPE = "retibbs"         # entries saved before kinds existed

HEARD_MAX = 500
PREFILL_DAYS = 7
HISTORY_MAX = 50
LINES_MAX = 3000                 # kept per session
RESOURCE_MAX = 1024 * 1024       # a reply bigger than this is refused
IMAGE_MIMES = {"image/webp", "image/png", "image/jpeg", "image/gif"}
IMAGE_MAX = 512 * 1024           # pictures (rBBS logo) up to this size
ROWS_MAX = 400                   # rows of an rBBS live screen
SCREEN_MARK = b"\x02S"           # an rBBS screen we keep as rows starts \x02S<number>\x02
IDENTITY_WAIT = 30               # asking the network for a server never heard
PING_EVERY = 30
PING_TIMEOUT = 90                # no PONG for this long: the link is gone
INPUT_MAX = 2000


def font_size(value: Any) -> int:
    """BBS screen font in px: 0 (fit the pane) or 8..32."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return n if 8 <= n <= 32 else 0


def _atomic_write(path: str, data: Any) -> None:
    from .fileio import atomic_write_json
    atomic_write_json(path, data, indent=1, ensure_ascii=False)


def clean_address(value: Any) -> Optional[str]:
    text = str(value or "").strip().lower().strip("<>")
    if len(text) == 32 and all(c in "0123456789abcdef" for c in text):
        return text
    return None


def server_name(app_data: Optional[bytes]) -> str:
    """The name in a RetiBBS announce: JSON {"server_name": ...}."""
    if not app_data:
        return ""
    try:
        data = json.loads(app_data.decode("utf-8"))
        if isinstance(data, dict):
            return " ".join(str(data.get("server_name") or "").split())[:80]
    except (ValueError, UnicodeDecodeError, AttributeError):
        pass
    return ""


def server_kind(app_data: Optional[bytes]) -> Optional[str]:
    """"rbbs" when the announce is of an rBBS, None when it does not say."""
    try:
        data = json.loads(app_data.decode("utf-8")) if app_data else None
        if isinstance(data, dict) and ("rbbs" in data or "link" in data):
            return "rbbs"
    except (ValueError, UnicodeDecodeError, AttributeError):
        pass
    return None


class Session:
    """One server open in the client."""

    def __init__(self, address: str, name: str, identity_id: str) -> None:
        self.address = address
        self.name = name
        self.identity_id = identity_id
        self.state = "connecting"        # connecting, connected, closed, failed
        self.error: Optional[str] = None
        self.link: Any = None
        self.lines: deque = deque(maxlen=LINES_MAX)
        self.seq = 0
        self.area = ""
        self.board = ""
        self.room = ""
        self.echo = False                # server sends back what we type (rBBS chat)
        self.screen: Optional[List[int]] = None   # [cols, rows] the server draws for (rBBS)
        self.status = ""                 # live counters the server keeps up to date (rBBS)
        self.kind = "retibbs"            # "rbbs" once the server says CTRL HELLO rbbs (its commands)
        self.rtt: Optional[float] = None
        self.receiving = False
        self.last_ping = 0.0
        self.last_pong = 0.0
        self.opened = time.time()
        # rBBS live screen (CTRL CAPS rows): the screen as rows, updates of single rows applied in order
        self.rlock = threading.Lock()
        self.scr = 0                     # number of the screen on show
        self.rows: List[str] = []
        self.rowv: List[int] = []        # version of the update each row comes from
        self.lenv = 0                    # version that last set the number of rows
        self.pending: Dict[int, list] = {}   # updates of a screen still on its way (a Resource)

    def add(self, kind: str, text: str = "", **extra: Any) -> None:
        self.seq += 1
        self.lines.append({"seq": self.seq, "kind": kind, "text": text, "ts": time.time(), **extra})

    def reset_rows(self) -> None:
        with self.rlock:
            self.scr, self.rows, self.rowv, self.lenv, self.pending = 0, [], [], 0, {}

    def screen_in(self, scr: int, text: str) -> None:
        """A whole screen (rBBS): kept as rows, the updates that came before it applied."""
        with self.rlock:
            if scr < self.scr:
                return
            self.scr, self.rows, self.lenv = scr, text.split("\n"), 0
            self.rowv = [0] * len(self.rows)
            early = sorted(self.pending.pop(scr, []))
            self.pending = {k: v for k, v in self.pending.items() if k > scr}
            for v, n, rows in early:
                self._apply(v, n, rows)
            self.add("screen", "\n".join(self.rows), scr=scr)

    def rows_in(self, scr: int, v: int, n: int, rows: Dict[int, str]) -> None:
        """Some rows of a screen changed: older updates (packets overtake each other) are skipped."""
        with self.rlock:
            if scr < self.scr:
                return
            if scr > self.scr:
                if len(self.pending) < 4:
                    self.pending.setdefault(scr, []).append((v, n, rows))
                return
            changed = self._apply(v, n, rows)
            if changed is not None:
                self.add("rows", json.dumps({"len": len(self.rows), "rows": changed}), scr=scr)

    def _apply(self, v: int, n: int, rows: Dict[int, str]) -> Optional[Dict[str, str]]:
        resized = False
        if v > self.lenv and 0 < n <= ROWS_MAX and n != len(self.rows):
            self.lenv, resized = v, True
            self.rows = (self.rows + [""] * n)[:n]
            self.rowv = (self.rowv + [0] * n)[:n]
        changed = {}
        for i, text in rows.items():
            if 0 <= i < len(self.rows) and v > self.rowv[i]:
                self.rows[i], self.rowv[i] = text, v
                changed[str(i)] = text
        return changed if changed or resized else None

    def summary(self) -> Dict[str, Any]:
        return {"address": self.address, "name": self.name, "state": self.state, "error": self.error,
                "area": self.area, "board": self.board, "room": self.room, "rtt": self.rtt, "screen": self.screen,
                "status": self.status, "kind": self.kind,
                "receiving": self.receiving, "seq": self.seq, "identity": self.identity_id}


class RetiBBS:
    """The client. An announce handler too (aspect_filter)."""

    aspect_filter = f"{APP_NAME}.{ASPECT}"
    receive_path_responses = True

    DEFAULTS: Dict[str, Any] = {
        # Off for a new user, who switches it on in Settings.
        "enabled": False,
        # The identity we log in with: the BBS account belongs to it.
        "identity": DEFAULT_ID,
        # The kinds of BBS listened for: RetiBBS for now.
        "protocols": {"retibbs": True},
        # 80s/90s terminal effects in the page (dialing, slow scroll, CRT).
        "terminal_fx": False,
        "font_size": 0,                  # px of the BBS screen, 0 = fit to the pane
        "favorites": {},                 # {address: {"name", "added"}}
        "history": {},                   # {address: {"name", "last"}}
    }

    def __init__(self, browser: Any) -> None:
        self.browser = browser
        self.lock = threading.RLock()
        self.settings: Dict[str, Any] = json.loads(json.dumps(self.DEFAULTS))
        self._load()
        self.heard: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        # Heard live since rBrowser started (not the prefill from Reticulum's
        # memory, not an answer to a path request): the status bar's number.
        self.live: set = set()
        # Each guest session has sessions of its own ({gid: {address: Session}}), with its identity.
        self._owner_sessions: Dict[str, Session] = {}
        self._guest_sessions: Dict[str, Dict[str, Session]] = {}
        self._registered = False
        self.revision = 0

    @property
    def sessions(self) -> Dict[str, Session]:
        if not guest_view():
            return self._owner_sessions
        gid = guest_current()
        return self._guest_sessions.setdefault(gid, {}) if gid else {}

    def _guest_all(self) -> List[Session]:
        return [s for table in list(self._guest_sessions.values()) for s in list(table.values())]

    def _guest_shown(self, kind: str) -> bool:
        """May the guest see the owner's favorites / history (Settings > Guest mode)?"""
        auth = getattr(self.browser, "auth", None)
        return bool(auth is not None and auth.guest_sees(kind))

    # ------------------------------------------------------------------ #
    # Settings                                                           #
    # ------------------------------------------------------------------ #

    def _load(self) -> None:
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key in self.DEFAULTS:
                    if key in stored:
                        self.settings[key] = stored[key]
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            print(f"⚠️ Could not read {SETTINGS_FILE}, using defaults: {exc}")
        self._repair()

    def _repair(self) -> None:
        s = self.settings
        s["enabled"] = bool(s.get("enabled"))
        s["terminal_fx"] = bool(s.get("terminal_fx"))
        s["font_size"] = font_size(s.get("font_size"))
        protocols = s.get("protocols") if isinstance(s.get("protocols"), dict) else {}
        # nomadnet: NomadNet nodes with "BBS" in their name, listed under
        # "Found on NomadNet" and opened as pages (the list is made in the
        # page, from the node list: nothing here listens for them).
        s["protocols"] = {"retibbs": bool(protocols.get("retibbs", True)),
                          "nomadnet": bool(protocols.get("nomadnet", True))}
        if not isinstance(s.get("identity"), str) or not s["identity"]:
            s["identity"] = DEFAULT_ID
        for key in ("favorites", "history"):
            table = s.get(key) if isinstance(s.get(key), dict) else {}
            s[key] = {a: (v if isinstance(v, dict) else {}) for a, v in table.items() if clean_address(a) == a}

    def _save(self) -> None:
        try:
            _atomic_write(SETTINGS_FILE, self.settings)
        except OSError as exc:
            print(f"⚠️ Could not save the RetiBBS settings: {exc}")

    def update_settings(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            if "identity" in incoming:
                identity_id = str(incoming["identity"] or "")
                if self.browser.identities.identity_for(identity_id) is None:
                    raise ValueError("Pick a saved identity: the BBS account belongs to it")
                self.settings["identity"] = identity_id
            if "enabled" in incoming:
                self.settings["enabled"] = bool(incoming["enabled"])
            if "terminal_fx" in incoming:
                self.settings["terminal_fx"] = bool(incoming["terminal_fx"])
            if "font_size" in incoming:
                self.settings["font_size"] = font_size(incoming["font_size"])
            if isinstance(incoming.get("protocols"), dict):
                self.settings["protocols"] = {**self.settings["protocols"],
                                              **{k: bool(v) for k, v in incoming["protocols"].items()
                                                 if k in ("retibbs", "nomadnet")}}
            self._repair()
            self._save()
            self.revision += 1
        if self.settings["enabled"]:
            self.start()
        else:
            # Switched off: guest sessions go too.
            for session in list(self._owner_sessions.values()) + self._guest_all():
                self._drop(session)
        return self.status()

    # ------------------------------------------------------------------ #
    # Servers heard                                                      #
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """Called once Reticulum is up, and when switched on."""
        if not self.settings["enabled"] or not getattr(self.browser, "reticulum_ready", False):
            return
        with self.lock:
            if self._registered:
                return
            self._registered = True
        RNS.Transport.register_announce_handler(self)
        threading.Thread(target=self.prefill, name="retibbs-prefill", daemon=True).start()
        print("📋 RetiBBS client on: listening for RetiBBS servers")

    def _heard(self, address: str, name: str, when: float, kind: Optional[str] = None) -> None:
        with self.lock:
            old = self.heard.get(address)
            if old and old["heard"] > when:
                return
            self.heard[address] = {"address": address, "name": name or (old or {}).get("name", ""),
                                   "heard": when, "type": kind or (old or {}).get("type") or self.type_of(address)}
            self.heard.move_to_end(address)
            while len(self.heard) > HEARD_MAX:
                self.heard.popitem(last=False)
            # A favourite or a server in the history keeps the name it announces.
            for key in ("favorites", "history"):
                entry = self.settings[key].get(address)
                if entry is not None and name and entry.get("name") != name:
                    entry["name"] = name
            self.revision += 1

    def listening(self) -> bool:
        return self.settings["enabled"] and self.settings["protocols"].get("retibbs", True)

    def received_announce(self, destination_hash: bytes, announced_identity: Any,
                          app_data: Optional[bytes], *args: Any, **kwargs: Any) -> None:
        if announced_identity is None or not self.listening():
            return
        if not kwargs.get("is_path_response"):
            self.live.add(destination_hash.hex())
        self._heard(destination_hash.hex(), server_name(app_data), time.time(), server_kind(app_data))

    def prefill(self) -> None:
        """Servers Reticulum remembers, heard in the last PREFILL_DAYS: a
        destination is a RetiBBS server only if its hash, worked out from the
        identity and the name, is the same."""
        cutoff = time.time() - PREFILL_DAYS * 86400
        try:
            known = list(RNS.Identity.known_destinations.items())
        except Exception:
            return
        found = []
        for dest_hash, entry in known:
            try:
                heard, public_key, app_data = entry[0], entry[2], entry[3]
                if heard < cutoff or not public_key:
                    continue
                identity = RNS.Identity(create_keys=False)
                identity.load_public_key(public_key)
                if RNS.Destination.hash(identity, APP_NAME, ASPECT) == dest_hash:
                    found.append((heard, dest_hash.hex(), server_name(app_data), server_kind(app_data)))
            except Exception:
                continue
        for heard, address, name, kind in sorted(found, key=lambda x: x[:2]):
            self._heard(address, name, heard, kind)

    def _is_rbbs(self, address: str) -> None:
        """The server said CTRL HELLO rbbs: it goes with the rBBSes in the lists."""
        with self.lock:
            changed = False
            for table in (self.heard, self.settings["favorites"], self.settings["history"]):
                entry = table.get(address)
                if entry is not None and entry.get("type") != "rbbs":
                    entry["type"] = "rbbs"
                    changed = True
            if changed:
                self._save()

    def name_of(self, address: str) -> str:
        for table in (self.heard, self.settings["favorites"], self.settings["history"]):
            entry = table.get(address)
            if entry and entry.get("name"):
                return entry["name"]
        return ""

    def type_of(self, address: str) -> str:
        """The kind of BBS (BBS_TYPES key) a server is: from its announce
        when heard, else from what was saved with it."""
        for table in (self.heard, self.settings["favorites"], self.settings["history"]):
            entry = table.get(address)
            if entry and entry.get("type") in BBS_TYPES:
                return entry["type"]
        return DEFAULT_TYPE

    def servers(self) -> Dict[str, Any]:
        guest = guest_view()
        show_fav = not guest or self._guest_shown("favorites")
        show_hist = not guest or self._guest_shown("history")

        def row(address: str, entry: Dict[str, Any]) -> Dict[str, Any]:
            heard = self.heard.get(address, {})
            hops = None
            try:
                if RNS.Transport.has_path(bytes.fromhex(address)):
                    hops = RNS.Transport.hops_to(bytes.fromhex(address))
            except Exception:
                pass
            kind = self.type_of(address)
            return {"address": address, "name": self.name_of(address) or entry.get("name", ""),
                    "type": kind, "type_label": BBS_TYPES[kind]["label"],
                    "aspect": BBS_TYPES[kind]["aspect"],
                    "heard": heard.get("heard"), "hops": hops,
                    "favorite": address in self.settings["favorites"] and show_fav,
                    "last": self.settings["history"].get(address, {}).get("last") if show_hist else None,
                    "open": address in self.sessions}
        with self.lock:
            favorites = sorted(self.settings["favorites"].items(),
                               key=lambda kv: (self.name_of(kv[0]) or kv[0]).lower())
            history = sorted(self.settings["history"].items(), key=lambda kv: -(kv[1].get("last") or 0))
            favorites = favorites if show_fav else []
            history = history if show_hist else []
            # RetiBBS switched off in Settings: its servers heard are not listed.
            heard = list(reversed(self.heard.items())) if self.listening() else []
            return {"types": list(BBS_TYPES),
                    "favorites": [row(a, e) for a, e in favorites],
                    "history": [row(a, e) for a, e in history],
                    "heard": [row(a, e) for a, e in heard]}

    def set_favorite(self, address: Any, favorite: bool) -> Dict[str, Any]:
        address = clean_address(address)
        if not address:
            return {"status": "error", "error": "Not a RetiBBS address (32 hex characters)"}
        with self.lock:
            if favorite:
                self.settings["favorites"].setdefault(address, {"name": self.name_of(address), "added": time.time(),
                                                                "type": self.type_of(address)})
            else:
                self.settings["favorites"].pop(address, None)
            self._save()
            self.revision += 1
        return {"status": "success"}

    def forget(self, address: Any) -> Dict[str, Any]:
        """Out of the history (a favourite stays a favourite)."""
        address = clean_address(address)
        with self.lock:
            if address:
                self.settings["history"].pop(address, None)
                self._save()
                self.revision += 1
        return {"status": "success"}

    # ------------------------------------------------------------------ #
    # Sessions                                                           #
    # ------------------------------------------------------------------ #

    def connect(self, address: Any) -> Dict[str, Any]:
        address = clean_address(address)
        if not address:
            return {"status": "error", "error": "Not a RetiBBS address (32 hex characters)"}
        if not self.settings["enabled"]:
            return {"status": "error", "error": "The BBS client is off: Settings > BBS Client"}
        if not self.settings["protocols"].get("retibbs", True):
            return {"status": "error", "error": "RetiBBS is switched off in Settings > BBS Client"}
        if not getattr(self.browser, "reticulum_ready", False):
            return {"status": "error", "error": "Reticulum is not connected yet"}
        guest = guest_view()
        if guest:
            identity, identity_id = self.browser.guest_identity.get(), GUEST_ID
            if identity is None:
                return {"status": "error", "error": "This guest session is over"}
        else:
            identity_id = self.settings["identity"]
            identity = self.browser.identities.identity_for(identity_id)
        if identity is None:
            return {"status": "error", "error": "The BBS identity is gone: pick another in Settings > BBS Client"}
        with self.lock:
            session = self.sessions.get(address)
            if session and session.state in ("connecting", "connected"):
                return {"status": "success", "session": session.summary()}
            name = self.name_of(address)
            if session is None:
                session = Session(address, name, identity_id)
                session.guest = guest
                self.sessions[address] = session
            else:
                session.state, session.error, session.identity_id = "connecting", None, identity_id
                session.reset_rows()     # a new link: the server counts its screens from 1 again
            session.add("system", f"Connecting to {name or address}…")
            self.revision += 1
        threading.Thread(target=self._connect_job, args=(session, identity), name="retibbs-connect",
                         daemon=True).start()
        return {"status": "success", "session": session.summary()}

    def _fail(self, session: Session, error: str) -> None:
        session.state, session.error = "failed", error
        session.add("system", error)
        self.revision += 1

    def _connect_job(self, session: Session, our_identity: Any) -> None:
        dest_hash = bytes.fromhex(session.address)
        try:
            identity = RNS.Identity.recall(dest_hash)
            if identity is None:
                session.add("system", "Asking the network for the server…")
                RNS.Transport.request_path(dest_hash)
                deadline = time.time() + IDENTITY_WAIT
                while identity is None and time.time() < deadline and session.state == "connecting":
                    time.sleep(0.5)
                    identity = RNS.Identity.recall(dest_hash)
            if session.state != "connecting":
                return
            if identity is None:
                return self._fail(session, "No answer: the server is not reachable now")
            destination = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, APP_NAME, ASPECT)
            if destination.hash != dest_hash:
                return self._fail(session, "This address is not a RetiBBS server")
            # Known keys are not a known way there (an old announce): a link
            # request without a path goes nowhere. As NomadNet does: path first.
            if not RNS.Transport.has_path(dest_hash):
                session.add("system", "Asking the network for a path…")
                self.revision += 1
                RNS.Transport.request_path(dest_hash)
                deadline = time.time() + IDENTITY_WAIT
                while not RNS.Transport.has_path(dest_hash) and time.time() < deadline and session.state == "connecting":
                    time.sleep(0.5)
                if session.state != "connecting":
                    return
                if not RNS.Transport.has_path(dest_hash):
                    return self._fail(session, "No path to the server: it is not reachable now")
            hops = RNS.Transport.hops_to(dest_hash)
            session.add("system", f"Opening a link ({hops} hop{'' if hops == 1 else 's'})…")
            self.revision += 1

            def established(link: Any) -> None:
                link.identify(our_identity)
                session.state, session.error = "connected", None
                session.last_pong = time.time()
                session.add("system", "Connected.")
                # A guest's connections are not the owner's history.
                if not getattr(session, "guest", False):
                    self._remember(session)
                self.revision += 1
                print(f"📋 RetiBBS: connected to {session.name or RNS.prettyhexrep(dest_hash)}")
                threading.Thread(target=self._heartbeat, args=(session, link), name="retibbs-ping",
                                 daemon=True).start()

            def closed(link: Any) -> None:
                if session.link is not link:
                    return
                if session.state == "connecting":
                    self._fail(session, "The server did not accept the connection")
                elif session.state == "connected":
                    session.state = "closed"
                    session.add("system", "Disconnected from the server.")
                    self.revision += 1

            link = RNS.Link(destination, established_callback=established, closed_callback=closed)
            session.link = link

            def proof_wanted(packet: Any) -> bool:
                # rBBS resends rows updates not proved: prove those (only those, light on LoRa)
                try:
                    return (link.decrypt(packet.data) or b"").startswith(b"CTRL ROWS ")
                except Exception:
                    return False

            destination.set_proof_strategy(RNS.Destination.PROVE_APP)
            destination.set_proof_requested_callback(proof_wanted)
            link.set_packet_callback(lambda data, packet: self._packet(session, data))
            link.set_resource_strategy(RNS.Link.ACCEPT_APP)
            link.set_resource_callback(lambda adv: (adv.get_data_size() or 0) <= RESOURCE_MAX)
            link.set_resource_started_callback(lambda r: self._receiving(session, True))
            link.set_resource_concluded_callback(lambda r: self._resource(session, r))
        except Exception as exc:
            self._fail(session, f"Could not connect: {exc}")

    def _remember(self, session: Session) -> None:
        with self.lock:
            name = self.name_of(session.address)
            self.settings["history"][session.address] = {"name": name, "last": time.time(),
                                                         "type": self.type_of(session.address)}
            while len(self.settings["history"]) > HISTORY_MAX:
                oldest = min(self.settings["history"], key=lambda a: self.settings["history"][a].get("last", 0))
                self.settings["history"].pop(oldest)
            self._save()

    def _heartbeat(self, session: Session, link: Any) -> None:
        while session.link is link and session.state == "connected":
            try:
                if link.status != RNS.Link.ACTIVE:
                    break
                if time.time() - session.last_pong > PING_TIMEOUT:
                    session.add("system", "The server stopped answering.")
                    link.teardown()
                    break
                session.last_ping = time.time()
                RNS.Packet(link, b"PING").send()
            except Exception:
                break
            time.sleep(PING_EVERY)

    def _text_in(self, session: Session, data: bytes) -> None:
        """Text from the server: an rBBS screen kept as rows, an update of some rows, or plain text."""
        if data.startswith(SCREEN_MARK):
            end = data.find(b"\x02", 2)
            if 2 < end < 14 and data[2:end].isdigit():
                session.screen_in(int(data[2:end]), data[end + 1:].decode("utf-8", "replace"))
                return
        if data.startswith(b"CTRL ROWS "):
            head, _, body = data.decode("utf-8", "replace").partition("\n")
            try:
                scr, v, n = (int(x) for x in head.split()[2:5])
            except ValueError:
                return
            rows = {}
            for line in body.split("\n") if body else []:
                i, tab, text = line.partition("\t")
                if tab and i.isdigit():
                    rows[int(i)] = text
            session.rows_in(scr, v, n, rows)
            return
        session.add("text", data.decode("utf-8", "replace"))

    def _receiving(self, session: Session, on: bool) -> None:
        session.receiving = on
        self.revision += 1

    def _resource(self, session: Session, resource: Any) -> None:
        session.receiving = False
        try:
            if resource.status == RNS.Resource.COMPLETE and resource.data is not None:
                resource.data.seek(0)
                data = resource.data.read()
                meta = getattr(resource, "metadata", None)
                mime = meta.get("mime") if isinstance(meta, dict) and meta.get("type") == "image" else None
                if mime in IMAGE_MIMES and len(data) <= IMAGE_MAX:
                    session.add("image", f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}")
                elif mime is None:
                    self._text_in(session, data)
                else:
                    session.add("system", "A picture was not shown (unknown type or too big).")
            else:
                session.add("system", "A reply did not arrive whole.")
        except Exception as exc:
            session.add("system", f"Could not read a reply: {exc}")
        self.revision += 1

    def _packet(self, session: Session, data: bytes) -> None:
        if data == b"PONG":
            session.last_pong = time.time()
            if session.last_ping:
                session.rtt = round(session.last_pong - session.last_ping, 3)
            return
        if data.startswith(b"CTRL ROWS "):
            self._text_in(session, data)
            self.revision += 1
            return
        if data.startswith(b"CTRL "):
            text = data.decode("utf-8", "replace")
            command, _, value = text[5:].partition(" ")
            value = value.strip()
            if command == "CLS":
                session.add("cls")
            elif command == "AREA":
                session.area = value
                if value == "Main Menu":
                    session.board = session.room = ""
                    session.echo = False
            elif command == "BOARD":
                session.board = value
            elif command == "ROOM":
                session.room = value
            elif command == "ECHO":
                session.echo = value.lower() == "on"
            elif command == "HELLO" and value.split()[:1] == ["rbbs"]:
                # an rBBS: tell it we show pictures and fit the screen to its size
                session.kind = "rbbs"
                self._is_rbbs(session.address)
                try:
                    RNS.Packet(session.link, b"CTRL CAPS image screen rows click").send()
                except Exception:
                    pass
            elif command == "STATUS":
                session.status = " ".join(value.split())[:160]
            elif command == "SCREEN":
                try:
                    cols, rows = (int(x) for x in value.split()[:2])
                    if 40 <= cols <= 200 and 10 <= rows <= 100:
                        session.screen = [cols, rows]
                except ValueError:
                    pass
            self.revision += 1
            return
        self._text_in(session, data)
        self.revision += 1

    def send(self, address: Any, text: Any) -> Dict[str, Any]:
        address = clean_address(address)
        session = self.sessions.get(address or "")
        if session is None or session.state != "connected" or session.link is None:
            return {"status": "error", "error": "Not connected to this server"}
        line = str(text or "").replace("\r", "").strip("\n")[:INPUT_MAX]
        blank = not line.strip()
        # rBBS takes a bare Enter (continue, any key); other servers get nothing
        if blank and getattr(session, "kind", "") != "rbbs":
            return {"status": "error", "error": "Nothing to send"}
        if blank:
            line = " "
        data = line.encode("utf-8")
        limit = getattr(session.link, "mdu", None) or 400
        if len(data) > limit:
            return {"status": "error", "error": f"Too long for one packet: at most {limit} bytes"}
        try:
            RNS.Packet(session.link, data).send()
        except Exception as exc:
            return {"status": "error", "error": f"Not sent: {exc}"}
        # a click on a key of an rBBS screen is not something typed: no echo
        if not session.echo and not blank and not line.startswith("CTRL KEY "):
            session.add("me", line)
        self.revision += 1
        return {"status": "success"}

    def disconnect(self, address: Any) -> Dict[str, Any]:
        session = self.sessions.get(clean_address(address) or "")
        if session is not None:
            self._drop(session)
        return {"status": "success"}

    def _drop(self, session: Session) -> None:
        if session.state == "connecting":
            session.state = "closed"
            session.add("system", "Stopped.")
        link = session.link
        if link is not None and session.state == "connected":
            session.state = "closed"
            session.add("system", "Disconnected.")
        try:
            if link is not None:
                link.teardown()
        except Exception:
            pass
        self.revision += 1

    def close_guests(self, gid: Optional[str] = None) -> int:
        """Guest mode or its BBS switch off: the guests' sessions close at once.
        gid: one guest session only (it ended)."""
        with self.lock:
            if gid is None:
                sessions = self._guest_all()
                self._guest_sessions.clear()
            else:
                sessions = list(self._guest_sessions.pop(gid, {}).values())
        for session in sessions:
            self._drop(session)
        if sessions:
            print(f"🖥️ BBS: {len(sessions)} guest session(s) closed")
        return len(sessions)

    def close(self, address: Any) -> Dict[str, Any]:
        """The tab closed: disconnected and forgotten (the server stays in
        the lists)."""
        address = clean_address(address)
        self.disconnect(address)
        with self.lock:
            self.sessions.pop(address or "", None)
            self.revision += 1
        return {"status": "success"}

    def output(self, address: Any, since: Any = 0) -> Dict[str, Any]:
        session = self.sessions.get(clean_address(address) or "")
        if session is None:
            return {"status": "error", "error": "No such session"}
        try:
            since = int(since or 0)
        except (TypeError, ValueError):
            since = 0
        lines = [l for l in list(session.lines) if l["seq"] > since]
        return {"status": "success", "session": session.summary(), "lines": lines,
                # Lines older than the ones kept are gone: the page starts over.
                "first": session.lines[0]["seq"] if session.lines else 0}

    def status(self) -> Dict[str, Any]:
        if guest_view():
            return self._guest_status()
        ids = self.browser.identities
        identities = []
        for profile in ids.state.get("profiles", []):
            identity = ids.identity_for(profile["id"])
            if identity is not None:
                # The hash is what a server knows us by: our user there.
                identities.append({"id": profile["id"], "name": profile["name"], "hash": identity.hash.hex()})
        return {
            "status": "success",
            "settings": {"enabled": self.settings["enabled"], "identity": self.settings["identity"],
                         "protocols": dict(self.settings["protocols"]),
                         "terminal_fx": self.settings["terminal_fx"],
                         "font_size": self.settings["font_size"]},
            "identities": identities,
            "identity_name": ids.name_of(self.settings["identity"]),
            "running": self._registered,
            "sessions": [s.summary() for s in self.sessions.values()],
            "revision": self.revision,
        }

    def _guest_status(self) -> Dict[str, Any]:
        """What a guest sees: the guest identity only, its own sessions."""
        keys = self.browser.guest_identity
        identity = keys.get()
        name = keys.nickname("bbs")
        return {
            "status": "success",
            "settings": {"enabled": self.settings["enabled"], "identity": GUEST_ID,
                         "protocols": dict(self.settings["protocols"]),
                         "terminal_fx": self.settings["terminal_fx"],
                         "font_size": self.settings["font_size"]},
            "identities": [{"id": GUEST_ID, "name": name, "hash": identity.hash.hex()}] if identity else [],
            "identity_name": name,
            "running": self._registered,
            "sessions": [s.summary() for s in self.sessions.values()],
            "revision": self.revision,
            "guest": True,
        }
