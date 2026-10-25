"""
RetiBBS client (https://github.com/kc1awv/RetiBBS): bulletin boards over
Reticulum, listed in the Reticulum manual.

The protocol is a remote terminal. A server announces "retibbs.bbs" with
JSON app data {"server_name": ...}. The client opens a Link, identifies with
one of our identities (the BBS account is that identity), and sends what
the user types as UTF-8 packets ("?", "n name", "b", "c"...). The server
answers with text - small replies as packets, long ones as a Resource - in
Rich markup ([bold red]...[/]), plus control packets: "CTRL CLS" (clear the
screen), "CTRL AREA x", "CTRL BOARD x", "CTRL ROOM x". "PING" gets "PONG".

Servers heard are listed (from announces, and those Reticulum remembers);
favourites and the ones connected to (history) are kept on disk so they are
never lost. Several servers can be open at once, one session each: the page
shows them as tabs.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict, deque
from typing import Any, Dict, Optional

import RNS

from .identities import DEFAULT_ID

SETTINGS_FILE = os.path.join("settings", "retibbs.json")
APP_NAME, ASPECT = "retibbs", "bbs"

# The kinds of BBS the client lists, in the order the server list shows them
# (one group per kind, a separator between groups when there is more than
# one). The kind comes from the aspect the server announces on, which RNS
# checks against the destination hash. RetiBBS stays last.
BBS_TYPES = OrderedDict([
    ("retibbs", {"label": "RetiBBS", "aspect": f"{APP_NAME}.{ASPECT}"}),
])
DEFAULT_TYPE = "retibbs"         # entries saved before kinds existed

HEARD_MAX = 500
PREFILL_DAYS = 7
HISTORY_MAX = 50
LINES_MAX = 3000                 # kept per session
RESOURCE_MAX = 1024 * 1024       # a reply bigger than this is refused
IDENTITY_WAIT = 30               # asking the network for a server never heard
PING_EVERY = 30
PING_TIMEOUT = 90                # no PONG for this long: the link is gone
INPUT_MAX = 2000


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
        self.rtt: Optional[float] = None
        self.receiving = False
        self.last_ping = 0.0
        self.last_pong = 0.0
        self.opened = time.time()

    def add(self, kind: str, text: str = "") -> None:
        self.seq += 1
        self.lines.append({"seq": self.seq, "kind": kind, "text": text, "ts": time.time()})

    def summary(self) -> Dict[str, Any]:
        return {"address": self.address, "name": self.name, "state": self.state, "error": self.error,
                "area": self.area, "board": self.board, "room": self.room, "rtt": self.rtt,
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
        "favorites": {},                 # {address: {"name", "added"}}
        "history": {},                   # {address: {"name", "last"}}
    }

    def __init__(self, browser: Any) -> None:
        self.browser = browser
        self.lock = threading.RLock()
        self.settings: Dict[str, Any] = json.loads(json.dumps(self.DEFAULTS))
        self._load()
        self.heard: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self.sessions: Dict[str, Session] = {}
        self._registered = False
        self.revision = 0

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
                if self.browser.identities.identity_for(identity_id) is None or identity_id == "ephemeral":
                    raise ValueError("Pick a saved identity: the BBS account belongs to it")
                self.settings["identity"] = identity_id
            if "enabled" in incoming:
                self.settings["enabled"] = bool(incoming["enabled"])
            if "terminal_fx" in incoming:
                self.settings["terminal_fx"] = bool(incoming["terminal_fx"])
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
            for address in list(self.sessions):
                self.disconnect(address)
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

    def _heard(self, address: str, name: str, when: float) -> None:
        with self.lock:
            old = self.heard.get(address)
            if old and old["heard"] > when:
                return
            self.heard[address] = {"address": address, "name": name or (old or {}).get("name", ""),
                                   "heard": when, "type": DEFAULT_TYPE}
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
        self._heard(destination_hash.hex(), server_name(app_data), time.time())

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
                    found.append((heard, dest_hash.hex(), server_name(app_data)))
            except Exception:
                continue
        for heard, address, name in sorted(found):
            self._heard(address, name, heard)

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
                    "favorite": address in self.settings["favorites"],
                    "last": self.settings["history"].get(address, {}).get("last"),
                    "open": address in self.sessions}
        with self.lock:
            favorites = sorted(self.settings["favorites"].items(),
                               key=lambda kv: (self.name_of(kv[0]) or kv[0]).lower())
            history = sorted(self.settings["history"].items(), key=lambda kv: -(kv[1].get("last") or 0))
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
        identity = self.browser.identities.identity_for(self.settings["identity"])
        if identity is None:
            return {"status": "error", "error": "The BBS identity is gone: pick another in Settings > BBS Client"}
        with self.lock:
            session = self.sessions.get(address)
            if session and session.state in ("connecting", "connected"):
                return {"status": "success", "session": session.summary()}
            name = self.name_of(address)
            if session is None:
                session = Session(address, name, self.settings["identity"])
                self.sessions[address] = session
            else:
                session.state, session.error, session.identity_id = "connecting", None, self.settings["identity"]
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
                with self.lock:
                    name = self.name_of(session.address)
                    self.settings["history"][session.address] = {"name": name, "last": time.time(),
                                                                 "type": self.type_of(session.address)}
                    while len(self.settings["history"]) > HISTORY_MAX:
                        oldest = min(self.settings["history"], key=lambda a: self.settings["history"][a].get("last", 0))
                        self.settings["history"].pop(oldest)
                    self._save()
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
            link.set_packet_callback(lambda data, packet: self._packet(session, data))
            link.set_resource_strategy(RNS.Link.ACCEPT_APP)
            link.set_resource_callback(lambda adv: (adv.get_data_size() or 0) <= RESOURCE_MAX)
            link.set_resource_started_callback(lambda r: self._receiving(session, True))
            link.set_resource_concluded_callback(lambda r: self._resource(session, r))
        except Exception as exc:
            self._fail(session, f"Could not connect: {exc}")

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

    def _receiving(self, session: Session, on: bool) -> None:
        session.receiving = on
        self.revision += 1

    def _resource(self, session: Session, resource: Any) -> None:
        session.receiving = False
        try:
            if resource.status == RNS.Resource.COMPLETE and resource.data is not None:
                resource.data.seek(0)
                session.add("text", resource.data.read().decode("utf-8", "replace"))
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
            elif command == "BOARD":
                session.board = value
            elif command == "ROOM":
                session.room = value
            self.revision += 1
            return
        session.add("text", data.decode("utf-8", "replace"))
        self.revision += 1

    def send(self, address: Any, text: Any) -> Dict[str, Any]:
        address = clean_address(address)
        session = self.sessions.get(address or "")
        if session is None or session.state != "connected" or session.link is None:
            return {"status": "error", "error": "Not connected to this server"}
        line = str(text or "").replace("\r", "").strip("\n")[:INPUT_MAX]
        if not line.strip():
            return {"status": "error", "error": "Nothing to send"}
        data = line.encode("utf-8")
        limit = getattr(session.link, "mdu", None) or 400
        if len(data) > limit:
            return {"status": "error", "error": f"Too long for one packet: at most {limit} bytes"}
        try:
            RNS.Packet(session.link, data).send()
        except Exception as exc:
            return {"status": "error", "error": f"Not sent: {exc}"}
        session.add("me", line)
        self.revision += 1
        return {"status": "success"}

    def disconnect(self, address: Any) -> Dict[str, Any]:
        session = self.sessions.get(clean_address(address) or "")
        if session is None:
            return {"status": "success"}
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
        return {"status": "success"}

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
                         "terminal_fx": self.settings["terminal_fx"]},
            "identities": identities,
            "identity_name": ids.name_of(self.settings["identity"]),
            "running": self._registered,
            "sessions": [s.summary() for s in self.sessions.values()],
            "revision": self.revision,
        }
