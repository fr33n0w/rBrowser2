"""
The RRC client: Reticulum Relay Chat, IRC-style rooms on hubs.

Written after rrcd 0.3.2 and NomadNet 1.4.4's RRC.py. Rule: show what the
hub says, never guess.

Protocol: a Link to the hub's "rrc.hub" destination, link.identify(), then one
CBOR envelope per packet {0: v=1, 1: type, 2: id (8 bytes), 3: ts ms, 4: src
identity hash, 5: room, 6: body, 7: nick}.
  HELLO -> WELCOME {0: hub name, 1: version, 2: caps, 3: limits}
  JOIN room [body = key] -> JOINED (to us: body = member hashes; to the others:
    body = [joiner], nick = joiner's nick). PART -> PARTED the same way.
  MSG / ACTION: sent to the room, the hub sends them to every member, us too
    (we show ours at once and drop the echo by id, as NomadNet does).
  NOTICE: from the hub (answers to commands, MOTD), or from a user with
    key 8 (dst) set: a direct notice.
  Commands ("/who room", "/topic room text", "/op room nick"...) are MSG text
    starting with "/", answered with a NOTICE or an ERROR.
  PING from the hub must be answered with PONG (same body), or it drops us.
  Long texts: RESOURCE_ENVELOPE (type 50) first, then an RNS Resource.

What the hub tells and what it does not: who is in a room (hashes, nicks
only from /who and from what people send); who is operator or voice it does
not tell, except "mode for <room> is now: +o <hash12>" after a /mode.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict, deque
from typing import Any, Dict, List, Optional, Tuple

import RNS
from . import rnsquiet

from . import cbor

SETTINGS_FILE = os.path.join("settings", "rrc.json")
# The RRC identity: made for RRC alone, the first time it is needed, and kept
# (it is who the hubs know). Not a profile: it does not listen on LXMF.
RRC_ID = "rrc"
RRC_IDENTITY_FILE = os.path.join("settings", "rrc_identity")
RRC_IDENTITY_DIR = os.path.join("settings", "rrc_identities")    # more of them, made in Settings
APP_NAME, ASPECT = "rrc", "hub"

K_V, K_T, K_ID, K_TS, K_SRC, K_ROOM, K_BODY, K_NICK, K_DST = range(9)
T_HELLO, T_WELCOME = 1, 2
T_JOIN, T_JOINED, T_PART, T_PARTED = 10, 11, 12, 13
T_MSG, T_NOTICE, T_ACTION = 20, 21, 22
T_PING, T_PONG = 30, 31
T_ERROR = 40
T_RESOURCE_ENVELOPE = 50
RRC_VERSION = 1

B_WELCOME_HUB, B_WELCOME_VER, B_WELCOME_CAPS, B_WELCOME_LIMITS = 0, 1, 2, 3
L_MAX_NICK, L_MAX_ROOM, L_MAX_MSG, L_MAX_ROOMS, L_RATE = 0, 1, 2, 3, 4
B_RES_ID, B_RES_KIND, B_RES_SIZE, B_RES_SHA256, B_RES_ENCODING = 0, 1, 2, 3, 4
CAP_RESOURCE_ENVELOPE, CAP_ACTION = 0, 1

from .updates import local_version as _local_version
CLIENT_NAME, CLIENT_VERSION = "rBrowser", _local_version()
HEARD_MAX = 1000
PREFILL_DAYS = 7
LINES_MAX = 1500                   # per room, this session only
IDENTITY_WAIT = 30
HELLO_TRIES = 5
RESOURCE_MAX = 256 * 1024
RECONNECT_STEPS = (5, 15, 30, 60, 120)
# A hub restarted without closing our link leaves it dead but "active" for
# RNS until its own timeout (many minutes). Quiet this long: a silent PING;
# no answer in PROBE_WAIT: the link is dead, reconnect.
SILENT_PROBE = 60                  # at most one tiny PING a minute per hub
# A transport pausing half a minute (seen on rmap: every hub through it
# dropped at once, NomadNet - no watchdog - stayed): the PING is sent again
# every PROBE_AGAIN, the link is dead only after PROBE_WAIT with no answer.
PROBE_WAIT = 150
PROBE_AGAIN = 30
WATCH_EVERY = 15
# RNS sizes a link's patience from the RTT measured at the start: a fast
# hub (0.05 s) gives ~20 s, so a busy transport pausing 20 s kills the link.
# Keepalives keep their pace (the hub's side needs them); we wait longer.
STALE_MIN = 120
CMD_ANSWER_WINDOW = 15             # s: a hub line with no room this soon after a /command answers it
STATUS = ""                        # the hub's own window: notices, MOTD, errors
DEFAULT_MAX_MSG = 350
JOIN_ALL_GAP = 1.5                 # s between two joins of /joinall

# The hub's answers, as rrcd writes them (NomadNet parses the same text).
WHO_PREFIX = "members in "
QUIET_WHO_WAIT = 20      # s: a quiet /who with no answer by then is taken as lost
WHO_ENTRY = re.compile(r"(?:^|,\s)(?:(?P<bh>[0-9a-fA-F]{32,64})|(?P<nick>.+?)\s\((?P<np>[0-9a-fA-F]{12})\))(?=,\s|$)")
LIST_HEAD = "registered public rooms"
LIST_NONE = "no public rooms registered"
LIST_LINE = re.compile(r"^\s+(?P<name>\S+?)(?: - (?P<topic>.*))?$")
LIST_WINDOW = 30.0
ROOM_INFO = re.compile(r"^room (?P<room>\S+): (?P<reg>registered|unregistered); mode=(?P<mode>\S*); topic=(?P<topic>.*)$")
TOPIC_IS = re.compile(r"^topic for (?P<room>\S+)(?: is now)?: (?P<topic>.*)$")
MODE_IS = re.compile(r"^mode for (?P<room>\S+) is now: (?P<flag>[+-][ov]) (?P<who>[0-9a-f]{12})$")
ROOM_FLAGS_IS = re.compile(r"^mode for (?P<room>\S+) is now: (?P<modes>\+[A-Za-z]+|\(none\))$")
GONE = re.compile(r"^(?:kicked|banned) from (?P<room>\S+)$")

# Control characters and bidi overrides out of anything from the network.
_UNSAFE = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩﻿]")

NICK_MAX = 32                      # bytes, when the hub does not say (rrcd's default)
MOTD_QUIET = 1.5                   # s without hub notices: the MOTD is over
MOTD_MAX = 6.0                     # s: our connect lines wait no longer than this


def cut_nick(value: Any, max_bytes: int = NICK_MAX) -> str:
    """One line, single spaces, at most max_bytes of UTF-8 (rrcd counts
    bytes), never cut inside a character."""
    s = clean_text(" ".join(str(value or "").split()), 200, multiline=False)
    data = s.encode("utf-8")[:max(1, int(max_bytes))]
    return data.decode("utf-8", errors="ignore").strip()


BOOL_SETTINGS = ("enabled", "show_joins", "reconnect", "autoconnect_all", "autoconnect_selected",
                 "nick_on",
                 "rejoin_rooms", "compact_joins",
                 "notices_to_hub", "show_auto",
                 "notify_mentions", "notify_messages", "notify_events", "autoreply_on", "echo_on", "away_notice",
                 "back_notice", "away_nick_on")
# The automatic replies: the same as the Messenger's (rbrowser/autoreply.py).
AUTOREPLY_TEXT_SETTINGS = ("autoreply_rules", "echo_text", "away_mode", "away_from", "away_to", "away_text",
                           "away_notice_text", "away_notice_every", "back_notice_text", "away_nick",
                           "autoreply_scope", "autoreply_rooms")
DEFAULT_BACK = "is back"
DEFAULT_AWAY_NICK = "{nick}|Away"
AWAY_NOTICE_HOURS = (0, 1, 2, 3, 4, 6, 8, 12, 24)     # 0 = once per away period

HELP = [
    "Commands of this client:",
    "  /join room [key]   enter a room          /part [room]   leave it",
    "  /me text           an action              /nick name     your nick on this hub",
    "  /ping              round trip to the hub  /clear         empty this window",
    "  /quit              disconnect             /connect       connect again",
    "  /notice text       a notice in this room  /noticeall text  in every room on this hub",
    "  /joinall           into every room of the hub, one every 1.5 s",
    "  /rejoin [room]     leave the room (this one if none) and join it again",
    "  /help              this list              (also /j, /leave, /disconnect, /names)",
    "Everything else starting with / goes to the hub as it is, for example:",
    "  /list   /who room   /topic room [text]   /mode room +o nick",
    "  /op room nick   /voice room nick   /kick room nick   /ban room add nick",
    "  /register room   /invite room add nick   /stats   (some need operator rights)",
]


def _log(text: str) -> None:
    """A console line; never an error on a console that cannot show emoji."""
    try:
        print(text)
    except Exception:
        try:
            print(text.encode("ascii", "replace").decode())
        except Exception:
            pass


def clean_text(value: Any, limit: int = 4000, multiline: bool = True) -> str:
    text = _UNSAFE.sub("", str(value or ""))
    if not multiline:
        text = " ".join(text.split())
    return text[:limit]


def clean_address(value: Any) -> Optional[str]:
    text = str(value or "").strip().lower().strip("<>")
    for prefix in ("rrc://", "rrc@", "rrc.hub.session@", "rrc.hub@"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    text = text.split("/")[0].split(":")[0]
    if len(text) == 32 and all(c in "0123456789abcdef" for c in text):
        return text
    return None


def split_message(text: str, max_bytes: int) -> List[str]:
    """A message too long for the hub, in parts "(i/n) ..." that fit, cut on
    a space where it can (NomadNet's _split_message). [] if nothing fits."""
    parts: List[str] = [text]
    for _ in range(10):
        n = max(1, len(parts))
        budget = max_bytes - len(f"({n}/{n}) ".encode("utf-8"))
        if budget <= 0:
            return []
        parts, rest = [], text
        while rest:
            raw = rest.encode("utf-8")
            if len(raw) <= budget:
                parts.append(rest)
                break
            cut = raw[:budget]
            while cut and (cut[-1] & 0xC0) == 0x80:
                cut = cut[:-1]
            chunk = cut.decode("utf-8", errors="ignore")
            space = max(chunk.rfind(" "), chunk.rfind("\n"), chunk.rfind("\t"))
            if space > 0 and space >= len(chunk) // 2:
                chunk = chunk[:space]
            chunk = chunk or rest[:1]
            parts.append(chunk.rstrip())
            rest = rest[len(chunk):].lstrip()
        if len(parts) == n:
            break
    return [f"({i + 1}/{len(parts)}) {p}" for i, p in enumerate(parts)]


def clean_room(value: Any) -> str:
    """As rrcd: stripped and lower case. "#" is how people write it (NomadNet
    takes it off too)."""
    return clean_text(value, 64, multiline=False).lstrip("#").strip().lower()


def hub_name(app_data: Optional[bytes]) -> Optional[str]:
    """The hub's name from its announce ({"proto": "rrc", "hub": name}), or
    None when the app_data is not an RRC hub's."""
    if not app_data:
        return ""
    try:
        data = cbor.loads(app_data)
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("proto") != "rrc":
        return None
    name = data.get("hub")
    return clean_text(name, 80, multiline=False) if isinstance(name, str) else ""


def envelope(msg_type: int, src: bytes, room: Optional[str] = None, body: Any = None,
             nick: Optional[str] = None) -> Dict[int, Any]:
    env: Dict[int, Any] = {K_V: RRC_VERSION, K_T: msg_type, K_ID: os.urandom(8),
                           K_TS: int(time.time() * 1000), K_SRC: src}
    if room is not None:
        env[K_ROOM] = room
    if body is not None:
        env[K_BODY] = body
    if nick:
        env[K_NICK] = nick
    return env


def _hex(value: Any) -> str:
    return bytes(value).hex() if isinstance(value, (bytes, bytearray)) else ""


class Room:
    def __init__(self, name: str) -> None:
        self.name = name
        self.joined = False
        self.members: set = set()             # full identity hex
        self.prefixes: Dict[str, str] = {}    # hash12 -> nick, from /who, full hash not known yet
        self.roles: Dict[str, str] = {}       # hash12 -> "o" / "v", only from "mode for ... is now"
        self.topic = ""
        self.modes = ""
        self.lines: deque = deque(maxlen=LINES_MAX)
        self.outbox: List[Any] = []           # (kind, text) typed before the hub's JOINED
        self.unread = 0
        self.mentions = 0
        self.joins = 0                        # others joined since you last looked

    def learn(self, ident: str) -> None:
        """A full hash seen in the room: it takes the place of its /who prefix."""
        self.members.add(ident)
        self.prefixes.pop(ident[:12], None)


class Hub:
    def __init__(self, address: str, name: str, identity_id: str) -> None:
        self.address = address
        self.name = name
        self.identity_id = identity_id
        self.state = "connecting"
        self.error: Optional[str] = None
        self.link: Any = None
        self.hub_hash = b""                 # the hub's identity hash: src of its own notices
        self.welcomed = False
        self.version = ""
        self.max_msg = DEFAULT_MAX_MSG
        self.max_nick = NICK_MAX            # bytes: the hub says it in its welcome
        self.notice_at = 0.0                # last NOTICE from the hub (MOTD still coming?)
        self.manual = False                 # closed by us: no reconnecting
        self.reconnects = 0
        self.rtt: Optional[float] = None
        self.receiving = False
        self.rooms: Dict[str, Room] = {STATUS: Room(STATUS)}
        self.nicks: Dict[str, str] = {}     # identity hex -> last nick seen
        self.room_list: Optional[List[Dict[str, str]]] = None
        self.list_until = 0.0
        self.pending_joins: set = set()
        self.pending_parts: set = set()
        self.silent_who: Dict[str, float] = {}  # room -> when our quiet /who left
        self.who_again: set = set()             # joins/parts while that /who was on its way
        self.room_users: Dict[str, int] = {}    # room -> people in it (bots too), from a /who
        self.count_who: set = set()             # rooms asked /who only to count them
        self.count_next = False                 # the next /list answer is the Rooms window's
        self.link_up = False                    # the current link got past RNS's handshake
        self.active = STATUS            # the window on screen (the page says it)
        self.list_target = STATUS       # where the /list answer being received goes
        self.cmd_at = 0.0               # last /command typed: its answer may go to that window
        self.sent_ids: deque = deque(maxlen=256)
        self.pings: Dict[bytes, Any] = {}
        self.expect: Dict[bytes, Dict[str, Any]] = {}
        self.last_rx = 0.0              # last packet from the hub
        self.probe_at = 0.0             # silent PING sent, no answer yet
        self.probe_last = 0.0           # the last of them
        self.seq = 0
        self.rev = 0

    def room(self, name: str) -> Room:
        r = self.rooms.get(name)
        if r is None:
            r = self.rooms[name] = Room(name)
        return r

    def reset_session(self) -> None:
        """The link is gone: what the hub told us was for that session."""
        self.welcomed = False
        self.link = None
        self.rtt = None
        self.receiving = False
        self.pending_joins.clear()
        self.pending_parts.clear()
        self.silent_who.clear()
        self.who_again.clear()
        self.count_who.clear()
        self.pings.clear()
        self.expect.clear()
        self.last_rx = self.probe_at = 0.0
        for r in self.rooms.values():
            r.joined = False
            r.outbox.clear()
            r.members.clear()
            r.prefixes.clear()
            r.roles.clear()
        self.rev += 1

    def name_of(self, ident: str) -> str:
        return self.nicks.get(ident) or ident[:12]

    def ident_of(self, nick: str) -> str:
        """The one identity seen with this nick ("" if none or several):
        joins and parts often come without it, and the page colours a nick
        by its identity, as in the people list."""
        hits = [h for h, n in self.nicks.items() if n == nick]
        return hits[0] if len(hits) == 1 else ""


class RRC:
    """The client, and the announce handler for rrc.hub."""

    aspect_filter = f"{APP_NAME}.{ASPECT}"
    receive_path_responses = True

    DEFAULTS: Dict[str, Any] = {
        # Off for a new user, who switches it on after choosing a nick.
        "enabled": False,
        "identity": RRC_ID,
        # Default nick: used on the hubs where you chose none, only when
        # nick_on. Off: those hubs see your identity hash only.
        "nick": "Anonymous Peer",
        "nick_on": False,
        "show_joins": True,
        # Every hub notice in the hub tab, the rooms keep only the chat (and
        # their own topic and modes, which belong to the room).
        "notices_to_hub": False,
        # The answers to what the client asks by itself (/who for the room
        # counts and the people lists): shown in the hub tab. Off: read, not
        # shown. The link check's ping is always silent.
        "show_auto": True,
        "reconnect": True,
        # At start: every favourite, or only those marked ⚡ (favorites[a]["auto"]).
        # A favourite is a bookmark, not a wish to connect.
        "autoconnect_all": False,
        "autoconnect_selected": True,
        "rejoin_rooms": True,            # on connect, the rooms you were in last time
        "compact_joins": True,
        "highlight": "",
        "notify_mentions": True,
        "notify_messages": False,
        "notify_events": True,           # pop-up: hub connected/dropped, kicked/banned
        # Automatic replies, as in the Messenger, to the messages that name
        # you (your nick or a highlight word) - rbrowser/autoreply.py.
        "autoreply_on": False,
        "autoreply_rules": "",
        "echo_on": False,
        "echo_text": "",
        "away_mode": "off",
        "away_from": "22:00",
        "away_to": "08:00",
        "away_text": "",
        "away_since": 0,                 # state: when away was switched on
        # Away said in the rooms too: "/me is away (text)" in each room you
        # are in when away starts (and in rooms joined while away), again
        # every N hours if asked (0 = once).
        "away_notice": False,
        "away_notice_text": "",
        # Another nick while away: {nick} is the usual one.
        "away_nick_on": False,
        "away_nick": "",
        "away_notice_every": 0,
        # Back from away (switched off, or the schedule ends): "/me is back"
        # (or the text chosen) in the rooms told you were away, or in every
        # room you are in if none was.
        "back_notice": False,
        "back_notice_text": "",
        # Where the automatic replies (rules, away, echo, the away notice)
        # act: every room, or only the rooms chosen ("address/room").
        "autoreply_scope": "all",
        "autoreply_rooms": [],
        "favorites": {},                 # {address: {"name", "added"}}
        "history": {},                   # {address: {"name", "last"}}
        "hubs": {},                      # {address: {"rooms": [...], "nick": "", "identity": id?}}
        "ignored": {},                   # {identity hex: nick}
        "rrc_identities": {},            # {id: name}: the files in RRC_IDENTITY_DIR
    }

    def __init__(self, browser: Any) -> None:
        self.browser = browser
        self.lock = threading.RLock()
        self.settings: Dict[str, Any] = json.loads(json.dumps(self.DEFAULTS))
        self._load()
        self.heard: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self.sessions: Dict[str, Hub] = {}
        self._registered = False
        self._rrc_identity: Optional[RNS.Identity] = None
        self._extra_ids: Dict[str, Any] = {}
        from .autoreply import AutoReply
        self.autoreply = AutoReply()
        self._away_rooms: Dict[Any, Any] = {}     # (hub, room) -> (away period, when told)
        self._was_away = False                    # for the "back" notice
        self._away_lock = threading.Lock()        # watchdog and settings never tell twice

    # ---------------------------------------------------------------- settings

    def _load(self) -> None:
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key in self.DEFAULTS:
                    if key in stored:
                        self.settings[key] = stored[key]
                # Before the Default nick had its switch, a nick typed there
                # was always used: it stays on for whoever had one.
                if "nick_on" not in stored:
                    self.settings["nick_on"] = bool(str(stored.get("nick") or "").strip())
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            _log(f"⚠️ Could not read {SETTINGS_FILE}, using defaults: {exc}")
        self._repair()

    def _repair(self) -> None:
        s = self.settings
        for key in BOOL_SETTINGS:
            s[key] = bool(s.get(key, self.DEFAULTS[key]))
        s["highlight"] = ", ".join(w for w in (clean_text(x, 40, multiline=False)
                                               for x in str(s.get("highlight") or "").split(",")) if w)[:300]
        from . import autoreply as ar
        rules = s.get("autoreply_rules")
        s["autoreply_rules"] = (str(rules) if isinstance(rules, str) and rules.strip() else ar.DEFAULT_RULES)[:ar.MAX_RULES_CHARS]
        s["echo_text"] = str(s.get("echo_text") or "")[:ar.MAX_TEXT_CHARS]
        s["away_text"] = str(s.get("away_text") or "").strip()[:ar.MAX_TEXT_CHARS] or ar.DEFAULT_AWAY
        if s.get("away_mode") not in ar.AWAY_MODES:
            s["away_mode"] = "off"
        s["away_from"] = ar.clean_hhmm(s.get("away_from"), "22:00")
        s["away_to"] = ar.clean_hhmm(s.get("away_to"), "08:00")
        try:
            s["away_since"] = float(s.get("away_since") or 0)
        except (TypeError, ValueError):
            s["away_since"] = 0
        s["away_notice_text"] = clean_text(s.get("away_notice_text"), 200, multiline=False)
        s["back_notice_text"] = clean_text(s.get("back_notice_text"), 200, multiline=False)
        s["away_nick"] = cut_nick(s.get("away_nick"), 64)
        try:
            every = int(s.get("away_notice_every") or 0)
        except (TypeError, ValueError):
            every = 0
        # Not more often than once an hour: the rooms are not ours to fill.
        s["away_notice_every"] = every if every in AWAY_NOTICE_HOURS else 0
        s["autoreply_scope"] = "selected" if s.get("autoreply_scope") == "selected" else "all"
        chosen = s.get("autoreply_rooms") if isinstance(s.get("autoreply_rooms"), list) else []
        s["autoreply_rooms"] = sorted({c for c in chosen if isinstance(c, str)
                                       and re.fullmatch(r"[0-9a-f]{32}/[^\s/]{1,64}", c)})[:200]
        if not isinstance(s.get("identity"), str) or not s["identity"]:
            s["identity"] = RRC_ID
        s["nick"] = cut_nick(s.get("nick"))
        for key in ("favorites", "history", "hubs"):
            table = s.get(key) if isinstance(s.get(key), dict) else {}
            s[key] = {a: (v if isinstance(v, dict) else {}) for a, v in table.items() if clean_address(a) == a}
        extra = s.get("rrc_identities") if isinstance(s.get("rrc_identities"), dict) else {}
        s["rrc_identities"] = {k: clean_text(v, 40, multiline=False) or k for k, v in extra.items()
                               if isinstance(k, str) and re.fullmatch(r"rrc-[0-9a-f]{8}", k)}
        ignored = s.get("ignored") if isinstance(s.get("ignored"), dict) else {}
        s["ignored"] = {k: clean_text(v, 64, multiline=False) for k, v in ignored.items()
                        if isinstance(k, str) and re.fullmatch(r"[0-9a-f]{32}", k)}
        # The old single "autoconnect" (every favourite) is gone: favourites are
        # bookmarks. Nothing is marked ⚡ for you: you pick the hubs.
        s.pop("autoconnect", None)
        for entry in s["favorites"].values():
            entry["auto"] = bool(entry.get("auto"))
        for entry in s["hubs"].values():
            rooms = entry.get("rooms") if isinstance(entry.get("rooms"), list) else []
            entry["rooms"] = [r for r in dict.fromkeys(clean_room(x) for x in rooms) if r][:32]
            entry["nick"] = cut_nick(entry.get("nick"))
            if not isinstance(entry.get("identity"), str) or not entry.get("identity"):
                entry.pop("identity", None)

    def _save(self) -> None:
        try:
            from .fileio import atomic_write_json
            atomic_write_json(SETTINGS_FILE, self.settings, indent=1, ensure_ascii=False)
        except OSError as exc:
            _log(f"⚠️ Could not save the RRC settings: {exc}")

    def _hub_entry(self, address: str) -> Dict[str, Any]:
        return self.settings["hubs"].setdefault(address, {"rooms": [], "nick": ""})

    def update_settings(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            if "identity" in incoming:
                identity_id = str(incoming["identity"] or "")
                if self.identity_of(identity_id) is None:
                    raise ValueError("Pick the RRC identity or a saved one: on RRC you are your identity")
                self.settings["identity"] = identity_id
            for key in BOOL_SETTINGS:
                if key in incoming:
                    self.settings[key] = bool(incoming[key])
            if "nick" in incoming:
                self.settings["nick"] = str(incoming["nick"] or "")
            if "highlight" in incoming:
                self.settings["highlight"] = str(incoming["highlight"] or "")
            # Away switched on now: a new period, everybody is told once again.
            if incoming.get("away_mode") == "on" and self.settings.get("away_mode") != "on":
                self.settings["away_since"] = time.time()
            for key in AUTOREPLY_TEXT_SETTINGS:
                if key in incoming:
                    self.settings[key] = incoming[key]
            self._repair()
            self._save()
        # Away (or back) said in the rooms in a second or two, not at the
        # watchdog's next round (up to 15 s):
        if any(k in incoming for k in ("away_mode", "away_from", "away_to", "away_notice", "back_notice", "away_nick_on", "away_nick")):
            def soon() -> None:
                time.sleep(1.5)
                self._away_now()
                # Away nick switched or changed while away: the list at once.
                for hub in list(self.sessions.values()):
                    self._own_nick_to_list(hub)
            threading.Thread(target=soon, name="rrc-away-now", daemon=True).start()
        if self.settings["enabled"]:
            self.start()
        else:
            for address in list(self.sessions):
                self.disconnect(address)
        return self.status()

    def ignore(self, ident: Any, on: bool, nick: Any = "") -> Dict[str, Any]:
        ident = str(ident or "").lower()
        if not re.fullmatch(r"[0-9a-f]{32}", ident):
            return {"status": "error", "error": "Not an identity hash"}
        with self.lock:
            if on:
                self.settings["ignored"][ident] = clean_text(nick, 64, multiline=False)
            else:
                self.settings["ignored"].pop(ident, None)
            self._save()
        return {"status": "success", "ignored": dict(self.settings["ignored"])}

    def _own_nick_to_list(self, hub: Hub) -> None:
        """Our nick in the people lists at once (/nick, away nick on/off):
        RRC has no nick-change event, the hub learns it from our next message."""
        with self.lock:
            me = self._me(hub).hex()
            nick = self.nick_for(hub.address)
            if nick:
                hub.nicks[me] = clean_text(nick, 64, multiline=False)
            else:
                hub.nicks.pop(me, None)
            hub.rev += 1

    def nick_for(self, address: str) -> str:
        return self.nick_source(address)[0]

    def nick_source(self, address: str, away_nick: bool = True) -> Tuple[str, str]:
        """Who we are on a hub, and why: the nick chosen for that hub
        (Settings > RRC Client > Saved hubs, /nick) -> "hub"; else the Default nick
        if switched on -> "default"; else none, the hub shows the hash ->
        "none". Cut to the hub's own limit once it has said it."""
        hub = self.sessions.get(address)
        limit = hub.max_nick if hub is not None else NICK_MAX
        own = self.settings["hubs"].get(address, {}).get("nick")
        if own:
            nick, source = cut_nick(own, limit), "hub"
        elif self.settings["nick_on"] and self.settings["nick"]:
            nick, source = cut_nick(self.settings["nick"], limit), "default"
        else:
            nick, source = "", "none"
        # Away with its own nick: carried by every message while away, so the
        # hub and the others see it from the next one ("/me is away" too).
        s = self.settings
        if away_nick and s.get("away_nick_on"):
            from .autoreply import away_period
            if away_period(s, time.time()):
                # Empty box: the usual nick with |Away.
                template = s.get("away_nick") or DEFAULT_AWAY_NICK
                # No usual nick (hash only): "|Away" alone would be no nick.
                away = template.replace("{nick}", nick).strip() if nick or "{nick}" not in template else ""
                if away:
                    return cut_nick(away, limit), "away"
        return nick, source

    def set_hub_nick(self, address: Any, nick: Any, room: str = STATUS) -> Dict[str, Any]:
        """The nick for one hub (/nick, the Nick button, Settings > Hubs).
        Empty: back to the Default nick, or to the hash if that is off.
        The hub learns it from our next message: it keeps no nicks."""
        address = clean_address(address)
        if not address:
            return {"status": "error", "error": "Not a hub address"}
        hub = self.sessions.get(address)
        limit = hub.max_nick if hub is not None else NICK_MAX
        wanted = " ".join(str(nick or "").split())
        nick = cut_nick(wanted, limit)
        with self.lock:
            self._hub_entry(address)["nick"] = nick
            self._save()
            if hub is not None:
                self._own_nick_to_list(hub)
        if hub is not None:
            cut = f" (cut to {limit} bytes, the hub's limit)" if nick != wanted and nick else ""
            if nick:
                text = f"Your nick on this hub is now {nick}{cut}, saved in Settings > RRC Client > Saved hubs"
            else:
                text = f"Nick for this hub cleared: {self.nick_label(address)}"
            if hub.welcomed and nick:
                text += ". The others see it from your next message"
            self._sys(hub, text, room if room in hub.rooms else STATUS)
        return {"status": "success", "nick": nick, "label": self.nick_label(address)}

    def hub_settings(self) -> List[Dict[str, Any]]:
        """Settings > RRC Client > Saved hubs: every hub we have been on, with the
        identity and the nick used there."""
        with self.lock:
            addresses = list(dict.fromkeys(list(self.settings["history"]) + list(self.settings["hubs"])))
            rows = []
            for a in addresses:
                entry = self.settings["hubs"].get(a, {})
                nick, source = self.nick_source(a)
                rows.append({"address": a, "name": self.name_of(a) or self.settings["history"].get(a, {}).get("name", ""),
                             "identity": entry.get("identity", ""), "identity_used": self.identity_for_hub(a),
                             "nick": entry.get("nick", ""), "nick_used": nick, "nick_source": source,
                             "last": self.settings["history"].get(a, {}).get("last"),
                             "connected": a in self.sessions and self.sessions[a].welcomed})
        rows.sort(key=lambda r: -(r["last"] or 0))
        return rows

    def forget_hub(self, address: Any) -> Dict[str, Any]:
        """Settings > Hubs ✕: nick, identity and rooms of that hub forgotten,
        and it leaves the history. A favourite stays a favourite."""
        address = clean_address(address)
        with self.lock:
            self.settings["hubs"].pop(address or "", None)
            self.settings["history"].pop(address or "", None)
            self._save()
        return {"status": "success"}

    def nick_label(self, address: str) -> str:
        """The nick in use and where it comes from, in words."""
        nick, source = self.nick_source(address)
        if source == "hub":
            return f"{nick} (from Settings > RRC Client > Saved hubs)"
        if source == "default":
            return f"{nick} (from the Default nick)"
        if source == "away":
            return f"{nick} (the away nick, while you are away)"
        return "none, the hub shows your identity hash (Default nick off)"

    # -------------------------------------------------------------- identities

    def rrc_identity(self) -> Optional[RNS.Identity]:
        if self._rrc_identity is not None:
            return self._rrc_identity
        try:
            if os.path.isfile(RRC_IDENTITY_FILE):
                self._rrc_identity = RNS.Identity.from_file(RRC_IDENTITY_FILE)
            else:
                os.makedirs(os.path.dirname(RRC_IDENTITY_FILE), exist_ok=True)
                identity = RNS.Identity()
                identity.to_file(RRC_IDENTITY_FILE)
                self._rrc_identity = identity
        except Exception as exc:
            _log(f"⚠️ RRC identity: {exc}")
        return self._rrc_identity

    def identity_of(self, identity_id: Any) -> Optional[RNS.Identity]:
        identity_id = str(identity_id or "")
        if identity_id == RRC_ID:
            return self.rrc_identity()
        if not identity_id or identity_id == "ephemeral":
            return None
        if identity_id in self.settings["rrc_identities"]:
            if identity_id not in self._extra_ids:
                try:
                    self._extra_ids[identity_id] = RNS.Identity.from_file(os.path.join(RRC_IDENTITY_DIR, identity_id))
                except Exception as exc:
                    _log(f"⚠️ RRC identity {identity_id}: {exc}")
                    return None
            return self._extra_ids[identity_id]
        return self.browser.identities.identity_for(identity_id)

    def create_identity(self, name: Any) -> Dict[str, Any]:
        """A new identity for RRC alone, kept in settings/rrc_identities."""
        name = clean_text(name, 40, multiline=False) or "RRC identity"
        identity = RNS.Identity()
        with self.lock:
            identity_id = f"rrc-{identity.hash.hex()[:8]}"
            try:
                os.makedirs(RRC_IDENTITY_DIR, exist_ok=True)
                identity.to_file(os.path.join(RRC_IDENTITY_DIR, identity_id))
            except OSError as exc:
                return {"status": "error", "error": f"Could not save it: {exc}"}
            self._extra_ids[identity_id] = identity
            self.settings["rrc_identities"][identity_id] = name
            self._save()
        return {"status": "success", "id": identity_id, "hash": identity.hash.hex()}

    def delete_identity(self, identity_id: Any) -> Dict[str, Any]:
        """Gone for good: hubs will not know us by it again (ops, bans)."""
        identity_id = str(identity_id or "")
        with self.lock:
            if identity_id not in self.settings["rrc_identities"]:
                return {"status": "error", "error": "Only the identities made here can be deleted"}
            if self.settings["identity"] == identity_id:
                return {"status": "error", "error": "It is the one in use: pick another in Chat as, Save, then delete it"}
            if any(h.identity_id == identity_id and h.state in ("connecting", "connected") for h in self.sessions.values()):
                return {"status": "error", "error": "A hub is connected with it: disconnect it first"}
            try:
                os.remove(os.path.join(RRC_IDENTITY_DIR, identity_id))
            except FileNotFoundError:
                pass
            except OSError as exc:
                return {"status": "error", "error": f"Could not delete it: {exc}"}
            self.settings["rrc_identities"].pop(identity_id, None)
            self._extra_ids.pop(identity_id, None)
            for entry in self.settings["hubs"].values():
                if entry.get("identity") == identity_id:
                    entry.pop("identity", None)
            self._save()
        return {"status": "success"}

    def identity_for_hub(self, address: str) -> str:
        own = self.settings["hubs"].get(address, {}).get("identity")
        if own and self.identity_of(own) is not None:
            return own
        chosen = self.settings["identity"]
        return chosen if self.identity_of(chosen) is not None else RRC_ID

    def identity_choices(self) -> List[Dict[str, Any]]:
        out = []
        own = self.rrc_identity()
        if own is not None:
            out.append({"id": RRC_ID, "name": "RRC identity", "hash": own.hash.hex(), "rrc": True})
        for identity_id, name in self.settings["rrc_identities"].items():
            identity = self.identity_of(identity_id)
            if identity is not None:
                out.append({"id": identity_id, "name": name, "hash": identity.hash.hex(), "rrc": True, "deletable": True})
        ids = self.browser.identities
        for profile in ids.state.get("profiles", []):
            identity = ids.identity_for(profile["id"])
            if identity is not None:
                out.append({"id": profile["id"], "name": profile["name"], "hash": identity.hash.hex()})
        return out

    def name_of_identity(self, identity_id: str) -> str:
        return next((c["name"] for c in self.identity_choices() if c["id"] == identity_id), identity_id)

    def set_hub_identity(self, address: Any, identity_id: Any) -> Dict[str, Any]:
        """Who we are on one hub ("" = as in Settings). Open: reconnected."""
        address = clean_address(address)
        if not address:
            return {"status": "error", "error": "Not a hub address"}
        identity_id = str(identity_id or "")
        if identity_id and self.identity_of(identity_id) is None:
            return {"status": "error", "error": "Pick the RRC identity or a saved one"}
        with self.lock:
            entry = self._hub_entry(address)
            if identity_id:
                entry["identity"] = identity_id
            else:
                entry.pop("identity", None)
            self._save()
        hub = self.sessions.get(address)
        if hub is not None and hub.identity_id != self.identity_for_hub(address):
            was_open = hub.state in ("connecting", "connected")
            self.disconnect(address)
            hub.identity_id = self.identity_for_hub(address)
            if was_open:
                return self.connect(address)
        return {"status": "success"}

    # -------------------------------------------------------------- hubs heard

    def start(self) -> None:
        if not self.settings["enabled"] or not getattr(self.browser, "reticulum_ready", False):
            return
        with self.lock:
            if self._registered:
                return
            self._registered = True
        RNS.Transport.register_announce_handler(self)
        threading.Thread(target=self.prefill, name="rrc-prefill", daemon=True).start()
        threading.Thread(target=self._watchdog, name="rrc-watchdog", daemon=True).start()
        _log("💬 RRC client on: listening for RRC hubs")
        if self.autoconnect_list():
            threading.Thread(target=self._autoconnect, name="rrc-autoconnect", daemon=True).start()

    def autoconnect_list(self) -> List[str]:
        """The favourites to connect at start: all of them, or the ⚡ ones."""
        fav = self.settings["favorites"]
        if self.settings["autoconnect_all"]:
            return list(fav)
        if self.settings["autoconnect_selected"]:
            return [a for a, e in fav.items() if e.get("auto")]
        return []

    def _autoconnect(self) -> None:
        time.sleep(3)
        for address in self.autoconnect_list():
            if address not in self.sessions:
                self.connect(address)
                time.sleep(1)

    def _heard(self, address: str, name: str, when: float) -> None:
        with self.lock:
            old = self.heard.get(address)
            if old and old["heard"] > when:
                return
            self.heard[address] = {"address": address, "name": name or (old or {}).get("name", ""), "heard": when}
            self.heard.move_to_end(address)
            while len(self.heard) > HEARD_MAX:
                self.heard.popitem(last=False)
            for key in ("favorites", "history"):
                entry = self.settings[key].get(address)
                if entry is not None and name and entry.get("name") != name:
                    entry["name"] = name

    def received_announce(self, destination_hash: bytes, announced_identity: Any,
                          app_data: Optional[bytes], *args: Any, **kwargs: Any) -> None:
        if announced_identity is None or not self.settings["enabled"]:
            return
        name = hub_name(app_data)
        if name is not None:
            self._heard(destination_hash.hex(), name, time.time())

    def prefill(self) -> None:
        """Hubs Reticulum remembers (last PREFILL_DAYS), checked to be rrc.hub."""
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
                if RNS.Destination.hash(identity, APP_NAME, ASPECT) != dest_hash:
                    continue
                name = hub_name(app_data)
                if name is not None:
                    found.append((heard, dest_hash.hex(), name))
            except Exception:
                continue
        for heard, address, name in sorted(found):
            self._heard(address, name, heard)

    def name_of(self, address: str) -> str:
        session = self.sessions.get(address)
        if session is not None and session.name:
            return session.name
        for table in (self.heard, self.settings["favorites"], self.settings["history"]):
            entry = table.get(address)
            if entry and entry.get("name"):
                return entry["name"]
        return ""

    def hubs(self) -> Dict[str, Any]:
        def row(address: str, entry: Dict[str, Any]) -> Dict[str, Any]:
            hops = None
            try:
                if RNS.Transport.has_path(bytes.fromhex(address)):
                    hops = RNS.Transport.hops_to(bytes.fromhex(address))
            except Exception:
                pass
            session = self.sessions.get(address)
            return {"address": address, "name": self.name_of(address) or entry.get("name", ""),
                    "heard": self.heard.get(address, {}).get("heard"), "hops": hops,
                    "favorite": address in self.settings["favorites"],
                    "auto": bool(self.settings["favorites"].get(address, {}).get("auto")),
                    "last": self.settings["history"].get(address, {}).get("last"),
                    "rooms": self.settings["hubs"].get(address, {}).get("rooms", []),
                    "state": session.state if session else None}
        with self.lock:
            favorites = sorted(self.settings["favorites"].items(), key=lambda kv: (self.name_of(kv[0]) or kv[0]).lower())
            history = sorted(self.settings["history"].items(), key=lambda kv: -(kv[1].get("last") or 0))
            heard = list(reversed(self.heard.items()))
            return {"favorites": [row(a, e) for a, e in favorites],
                    "history": [row(a, e) for a, e in history],
                    "heard": [row(a, e) for a, e in heard]}

    def set_favorite(self, address: Any, favorite: bool) -> Dict[str, Any]:
        address = clean_address(address)
        if not address:
            return {"status": "error", "error": "Not an RRC hub address (32 hex characters)"}
        with self.lock:
            if favorite:
                self.settings["favorites"].setdefault(address, {"name": self.name_of(address), "added": time.time()})
            else:
                self.settings["favorites"].pop(address, None)
            self._save()
        return {"status": "success", "favorite": favorite}

    def set_autoconnect(self, address: Any, on: bool) -> Dict[str, Any]:
        """⚡ on a favourite: connected at start (Settings > RRC Client >
        Connect to the selected favourite hubs). Only favourites have it."""
        address = clean_address(address)
        with self.lock:
            entry = self.settings["favorites"].get(address or "")
            if entry is None:
                return {"status": "error", "error": "Star the hub first: only favourites connect at start"}
            entry["auto"] = bool(on)
            self._save()
        return {"status": "success", "auto": bool(on)}

    def forget(self, address: Any) -> Dict[str, Any]:
        address = clean_address(address)
        with self.lock:
            if address:
                self.settings["history"].pop(address, None)
                self._save()
        return {"status": "success"}

    # ------------------------------------------------------------------ lines

    def _line(self, hub: Hub, room: str, kind: str, text: str, nick: str = "", src: str = "",
              mention: bool = False, count: bool = False) -> None:
        """Adds a line to a window. count: a message that makes the room "new"."""
        with self.lock:
            # Windows are made by join() only: a line for a room closed goes
            # to the hub window, never brings back a ghost window.
            r = hub.rooms.get(room) or hub.rooms[STATUS]
            hub.seq += 1
            r.lines.append({"seq": hub.seq, "ts": time.time(), "room": r.name, "kind": kind,
                            "text": clean_text(text), "nick": clean_text(nick, 64, multiline=False),
                            "src": src, "mention": mention})
            if count:
                r.unread += 1
                if mention:
                    r.mentions += 1
            hub.rev += 1

    def _sys(self, hub: Hub, text: str, room: str = STATUS) -> None:
        self._line(hub, room, "system", text)

    def _sys_all(self, hub: Hub, text: str) -> None:
        for name in list(hub.rooms):
            self._sys(hub, text, name)

    def _mention_words(self, hub: Hub) -> List[str]:
        # The away nick and the usual one: while away people still name you
        # by the usual one (and that is when the away reply is wanted).
        words = list(dict.fromkeys(n for n in (self.nick_for(hub.address),
                                               self.nick_source(hub.address, away_nick=False)[0]) if n))
        return words + [w.strip() for w in self.settings["highlight"].split(",") if w.strip()]

    def _mentions(self, hub: Hub, text: str) -> bool:
        return any(re.search(r"(?<![\w])@?" + re.escape(w) + r"(?![\w])", text, re.IGNORECASE)
                   for w in self._mention_words(hub))

    def _maybe_autoreply(self, hub: Hub, room: str, src: str, sender: str, text: str) -> None:
        """Rules, away, echo (rbrowser/autoreply.py) for a message that names
        us: one reply at most, in the same room, shown like any of ours. The
        rules are matched on the message without our name ("@alice ping" ->
        "ping"); a bare "@alice" still gets the away message. Two of these
        could answer each other only if a reply names the other ({sender}):
        the flood limit of autoreply.py stops that after a few."""
        s = self.settings
        if not self.autoreply.any_on(s) or not self._autoreply_here(hub, room):
            return
        said = text
        for w in self._mention_words(hub):
            said = re.sub(r"(?<![\w])@?" + re.escape(w) + r"(?![\w])[:,]?", " ", said, flags=re.IGNORECASE)
        said = " ".join(said.split())
        try:
            values = {"name": self.nick_for(hub.address) or "Anonymous Peer",
                      "sender": sender or src[:12], "address": self._me(hub).hex()}
            decision = self.autoreply.decide(s, src, said or text, "", 0, values)
            if decision is None:
                return
            reply = decision[1].encode("utf-8")[:hub.max_msg].decode("utf-8", "ignore")
            self._say(hub, room, T_MSG, reply)
        except Exception as exc:
            _log(f"⚠️ RRC automatic reply not sent: {exc}")

    # ------------------------------------------------------------- connecting

    def connect(self, address: Any, room: Any = None) -> Dict[str, Any]:
        address = clean_address(address)
        if not address:
            return {"status": "error", "error": "Not an RRC hub address (32 hex characters)"}
        if not self.settings["enabled"]:
            return {"status": "error", "error": "The RRC client is off: Settings > RRC Client"}
        if not getattr(self.browser, "reticulum_ready", False):
            return {"status": "error", "error": "Reticulum is not connected yet"}
        identity_id = self.identity_for_hub(address)
        identity = self.identity_of(identity_id)
        if identity is None:
            return {"status": "error", "error": "The RRC identity is gone: pick another in Settings > RRC Client"}
        wanted = clean_room(room)
        with self.lock:
            hub = self.sessions.get(address)
            if wanted:
                entry = self._hub_entry(address)
                if wanted not in entry["rooms"]:
                    entry["rooms"].append(wanted)
                    self._save()
            if hub and hub.state in ("connecting", "connected"):
                if wanted and hub.welcomed and not hub.room(wanted).joined:
                    self.join(address, wanted)
                return {"status": "success"}
            if hub is None:
                hub = self.sessions[address] = Hub(address, self.name_of(address), identity_id)
            hub.state, hub.error, hub.identity_id, hub.manual = "connecting", None, identity_id, False
            hub.rev += 1
        self._sys(hub, f"Connecting to {hub.name or address}…")
        threading.Thread(target=self._connect_job, args=(hub, identity), name="rrc-connect", daemon=True).start()
        return {"status": "success"}

    def _fail(self, hub: Hub, error: str) -> None:
        hub.state, hub.error = "failed", error
        self._line(hub, STATUS, "error", error)
        self._schedule_reconnect(hub)

    def _connect_job(self, hub: Hub, our_identity: Any) -> None:
        dest_hash = bytes.fromhex(hub.address)
        try:
            if not RNS.Transport.has_path(dest_hash):
                self._sys(hub, "Asking the network for a path…")
                RNS.Transport.request_path(dest_hash)
                deadline = time.time() + IDENTITY_WAIT
                while not RNS.Transport.has_path(dest_hash) and time.time() < deadline and hub.state == "connecting":
                    time.sleep(0.3)
            identity = RNS.Identity.recall(dest_hash)
            if hub.state != "connecting":
                return
            if identity is None:
                return self._fail(hub, "No answer: the hub is not reachable now")
            destination = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, APP_NAME, ASPECT)
            if destination.hash != dest_hash:
                hub.manual = True
                return self._fail(hub, "This address is not an RRC hub")
            hub.hub_hash = identity.hash
            hops = RNS.Transport.hops_to(dest_hash) if RNS.Transport.has_path(dest_hash) else "?"
            self._sys(hub, f"Opening a link ({hops} hops)…")

            def established(link: Any) -> None:
                if hub.link is not link:
                    return
                hub.link_up = True
                try:
                    link.identify(our_identity)
                except Exception as exc:
                    self._line(hub, STATUS, "error", f"Could not identify: {exc}")
                    link.teardown()
                    return
                hub.rtt = link.rtt
                try:
                    link.stale_time = max(link.stale_time, STALE_MIN)
                except Exception:
                    pass
                self._sys(hub, "Link open, saying hello…")
                threading.Thread(target=self._hello_loop, args=(hub, link, our_identity),
                                 name="rrc-hello", daemon=True).start()

            def closed(link: Any) -> None:
                if hub.link is link:
                    self._closed(hub, getattr(link, "teardown_reason", None))

            hub.link_up = False
            link = RNS.Link(destination, established_callback=established, closed_callback=closed)
            hub.link = link
            link.set_packet_callback(lambda data, packet: self._packet(hub, link, data))
            link.set_resource_strategy(RNS.Link.ACCEPT_APP)
            link.set_resource_callback(lambda res: self._resource_ok(hub, res))
            link.set_resource_concluded_callback(lambda res: self._resource_done(hub, res))
        except Exception as exc:
            self._fail(hub, f"Could not connect: {exc}")

    def _hello_loop(self, hub: Hub, link: Any, our_identity: Any) -> None:
        body = {0: CLIENT_NAME, 1: CLIENT_VERSION, 2: {CAP_RESOURCE_ENVELOPE: True, CAP_ACTION: True}}
        for _ in range(HELLO_TRIES):
            if hub.link is not link or hub.welcomed or link.status != RNS.Link.ACTIVE:
                return
            try:
                self._send(hub, envelope(T_HELLO, our_identity.hash, body=body, nick=self.nick_for(hub.address)))
            except Exception as exc:
                self._line(hub, STATUS, "error", f"HELLO not sent: {exc}")
            deadline = time.time() + max(3.0, (link.rtt or 0) * getattr(link, "traffic_timeout_factor", 6))
            while time.time() < deadline and not hub.welcomed and hub.link is link:
                time.sleep(0.2)
        if not hub.welcomed and hub.link is link:
            hub.error = "The hub did not answer the hello"
            try:
                link.teardown()
            except Exception:
                pass

    @staticmethod
    def _why_not(link_up: bool, reason: Any) -> str:
        """Why a link closed before the hub's welcome, as far as RNS knows."""
        if not link_up:
            # The request went out and no proof came back: it was lost on
            # the way, or the hub's side is busy or stuck. Not a refusal.
            return ("The link did not open: no answer from the hub's side "
                    "(lost on the way, or the hub is busy)")
        if reason == getattr(RNS.Link, "DESTINATION_CLOSED", 0x03):
            return "The hub closed the link before the welcome, without saying why"
        if reason == getattr(RNS.Link, "TIMEOUT", 0x01):
            return "The link opened, then went silent before the welcome (timeout)"
        return "The link closed before the welcome"

    def _closed(self, hub: Hub, reason: Any = None) -> None:
        was, link_up = hub.state, hub.link_up
        hub.reset_session()
        if was == "connecting":
            hub.state = "failed"
            hub.error = hub.error or self._why_not(link_up, reason)
            self._line(hub, STATUS, "error", hub.error)
        elif was == "connected":
            hub.state = "closed"
            self._sys_all(hub, "Disconnected from the hub.")
            _log(f"💬 RRC: disconnected from {hub.name or hub.address}")
        self._schedule_reconnect(hub)

    def _schedule_reconnect(self, hub: Hub) -> None:
        if hub.manual or not self.settings["reconnect"] or not self.settings["enabled"]:
            return
        if self.sessions.get(hub.address) is not hub:
            return
        delay = RECONNECT_STEPS[min(hub.reconnects, len(RECONNECT_STEPS) - 1)]
        hub.reconnects += 1
        self._sys(hub, f"Trying again in {delay} s…")

        def again() -> None:
            time.sleep(delay)
            if hub.manual or self.sessions.get(hub.address) is not hub or hub.state in ("connecting", "connected"):
                return
            self.connect(hub.address)

        threading.Thread(target=again, name="rrc-reconnect", daemon=True).start()

    def _watchdog(self) -> None:
        """A link that went quiet: silent PING; still nothing, it is dead."""
        while True:
            time.sleep(WATCH_EVERY)
            try:
                self._watch_once(time.time())
            except Exception as exc:
                _log(f"⚠️ RRC watchdog: {exc}")

    def _autoreply_here(self, hub: Hub, room: str) -> bool:
        """The automatic replies act in every room, or only in those chosen."""
        s = self.settings
        return s.get("autoreply_scope") != "selected" or f"{hub.address}/{room}" in s.get("autoreply_rooms", [])

    def _away_notices(self, now: float) -> None:
        """Away with "Say it in the rooms" on: "/me is away (text)" in each
        joined room not told in this away period, or told more than the
        chosen hours ago. Back from away: forgotten, next time told again,
        and with "back" on, "/me is back" where they were told (everywhere
        if nobody was)."""
        from .autoreply import away_period
        s = self.settings
        away = bool(away_period(s, now))
        if self._was_away and not away and s.get("back_notice"):
            self._back_notices(set(self._away_rooms))
        if self._was_away != away and s.get("away_nick_on"):
            for hub in list(self.sessions.values()):
                self._own_nick_to_list(hub)
        self._was_away = away
        period = away_period(s, now) if s.get("away_notice") else None
        if not period:
            self._away_rooms.clear()
            return
        every = (s.get("away_notice_every") or 0) * 3600
        text = "is away" + (f" ({s['away_notice_text']})" if s.get("away_notice_text") else "")
        for hub in list(self.sessions.values()):
            if hub.state != "connected" or not hub.welcomed:
                continue
            for room, r in list(hub.rooms.items()):
                if not room or not r.joined or not self._autoreply_here(hub, room):
                    continue
                key = (hub.address, room)
                told = self._away_rooms.get(key)
                if told and told[0] == period and not (every and now - told[1] >= every):
                    continue
                self._away_rooms[key] = (period, now)
                try:
                    self._say(hub, room, T_ACTION, text)
                except Exception as exc:
                    _log(f"⚠️ RRC away notice not sent: {exc}")
                time.sleep(0.5)             # rrcd limits messages per minute

    def _back_notices(self, told: set) -> None:
        text = self.settings.get("back_notice_text") or DEFAULT_BACK
        for hub in list(self.sessions.values()):
            if hub.state != "connected" or not hub.welcomed:
                continue
            for room, r in list(hub.rooms.items()):
                if not room or not r.joined or not self._autoreply_here(hub, room):
                    continue
                if told and (hub.address, room) not in told:
                    continue
                try:
                    self._say(hub, room, T_ACTION, text)
                except Exception as exc:
                    _log(f"⚠️ RRC back notice not sent: {exc}")
                time.sleep(0.5)             # rrcd limits messages per minute

    def _away_now(self) -> None:
        try:
            with self._away_lock:
                self._away_notices(time.time())
        except Exception as exc:
            _log(f"⚠️ RRC away notice: {exc}")

    def _watch_once(self, now: float) -> None:
        self._away_now()
        for hub in list(self.sessions.values()):
            link = hub.link
            if hub.state != "connected" or not hub.welcomed or link is None:
                continue
            if not hub.last_rx:
                hub.last_rx = now
                continue
            if hub.probe_at:
                if now - hub.probe_at > max(PROBE_WAIT, (hub.rtt or 0) * 10):
                    _log(f"💬 RRC: no answer from {hub.name or hub.address}, link dead, reconnecting")
                    self._sys_all(hub, "No answer from the hub: the link is dead. Reconnecting…")
                    try:
                        link.teardown()
                    except Exception:
                        pass
                    if hub.link is link:        # teardown did not call back
                        self._closed(hub)
                elif now - hub.probe_last >= PROBE_AGAIN:
                    hub.probe_last = now
                    body = os.urandom(8)
                    hub.pings[body] = (now, None)
                    try:
                        self._send(hub, envelope(T_PING, self._me(hub), body=body))
                    except Exception:
                        pass
            elif now - hub.last_rx > SILENT_PROBE:
                hub.probe_last = now
                body = os.urandom(8)
                hub.pings[body] = (now, None)
                hub.probe_at = now
                try:
                    self._send(hub, envelope(T_PING, self._me(hub), body=body))
                except Exception:
                    pass

    def disconnect(self, address: Any) -> Dict[str, Any]:
        hub = self.sessions.get(clean_address(address) or "")
        if hub is None:
            return {"status": "success"}
        hub.manual = True
        link = hub.link
        if hub.state in ("connecting", "connected"):
            hub.state = "closed"
            self._sys_all(hub, "Disconnected.")
        hub.reset_session()
        try:
            if link is not None:
                link.teardown()
        except Exception:
            pass
        return {"status": "success"}

    def close_all(self) -> int:
        """Every link closed properly (LINKCLOSE to the hub), for an exit or
        a restart. A process just killed leaves the hub with a session that
        looks alive until its ping timeout, and the next connect from the
        same identity can fail meanwhile. Not "manual": if this process
        stays up after all, the hubs reconnect by themselves."""
        n = 0
        for hub in list(self.sessions.values()):
            link = hub.link
            if link is None:
                continue
            try:
                link.teardown()
                n += 1
            except Exception:
                pass
        if n:
            _log(f"💬 RRC: {n} link(s) closed")
        return n

    def close(self, address: Any) -> Dict[str, Any]:
        address = clean_address(address)
        self.disconnect(address)
        with self.lock:
            self.sessions.pop(address or "", None)
        return {"status": "success"}

    # ---------------------------------------------------------------- sending

    def _send(self, hub: Hub, env: Dict[int, Any]) -> None:
        link = hub.link
        if link is None or link.status != RNS.Link.ACTIVE:
            raise RuntimeError("not connected")
        data = cbor.dumps(env)
        if len(data) > link.mdu:
            raise RuntimeError(f"too long for one packet ({len(data)} > {link.mdu} bytes)")
        RNS.Packet(link, data).send()

    def _me(self, hub: Hub) -> bytes:
        identity = self.identity_of(hub.identity_id)
        return identity.hash if identity is not None else b"\x00" * 16

    def _ready(self, address: Any) -> Hub:
        hub = self.sessions.get(clean_address(address) or "")
        if hub is None:
            raise RuntimeError("Not connected to this hub")
        if not hub.welcomed:
            raise RuntimeError("Not connected yet")
        return hub

    def _cmd(self, hub: Hub, text: str, room: Optional[str]) -> None:
        """A command for the hub: MSG text starting with "/"."""
        self._send(hub, envelope(T_MSG, self._me(hub), room=room or None, body=text,
                                 nick=self.nick_for(hub.address)))

    def join(self, address: Any, room: Any, key: str = "") -> Dict[str, Any]:
        try:
            hub = self._ready(address)
            name = clean_room(room)
            if not name:
                raise RuntimeError("Which room?")
            with self.lock:
                hub.pending_joins.add(name)
                hub.pending_parts.discard(name)
                hub.room(name)
                hub.rev += 1
            self._send(hub, envelope(T_JOIN, self._me(hub), room=name, body=key or None,
                                     nick=self.nick_for(hub.address)))
            if not hub.rooms[name].joined:
                self._sys(hub, f"Joining #{name}… waiting for the hub", name)
            return {"status": "success", "room": name}
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def part(self, address: Any, room: Any) -> Dict[str, Any]:
        """Leaves the room: PART is sent and the window closes when the hub
        answers PARTED (or an error for that room). Not in the room, not
        connected, or asked again while waiting: it closes at once."""
        hub = self.sessions.get(clean_address(address) or "")
        name = clean_room(room)
        if hub is None or not name:
            return {"status": "success"}
        with self.lock:
            entry = self._hub_entry(hub.address)
            if name in entry["rooms"]:
                entry["rooms"].remove(name)
                self._save()
            joined = name in hub.rooms and hub.rooms[name].joined
            hub.pending_joins.discard(name)
            wait = joined and hub.welcomed and name not in hub.pending_parts
            if wait:
                hub.pending_parts.add(name)
            else:
                hub.pending_parts.discard(name)
                hub.rooms.pop(name, None)
            hub.rev += 1
        if wait:
            self._sys(hub, f"Leaving #{name}…", name)
            try:
                self._send(hub, envelope(T_PART, self._me(hub), room=name))
            except Exception:
                self._close_room(hub, name)
        return {"status": "success", "waiting": wait}

    def _close_room(self, hub: Hub, name: str) -> None:
        with self.lock:
            hub.pending_parts.discard(name)
            hub.rooms.pop(name, None)
            hub.rev += 1

    def mark_read(self, address: Any, room: Any) -> Dict[str, Any]:
        """The page shows this window: it is read, and it is where the hub's
        answers without a room go (see _where)."""
        hub = self.sessions.get(clean_address(address) or "")
        if hub is not None:
            with self.lock:
                hub.active = clean_room(room) if room else STATUS
                r = hub.rooms.get(hub.active)
                if r is not None and (r.unread or r.mentions or r.joins):
                    r.unread = r.mentions = r.joins = 0
                    hub.rev += 1
        return {"status": "success"}

    def list_rooms(self, address: Any) -> Dict[str, Any]:
        try:
            hub = self._ready(address)
            hub.count_next = True       # the Rooms window asked: its answer gets the counts
            self._cmd(hub, "/list", None)
            return {"status": "success"}
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def ping(self, hub: Hub, room: str) -> None:
        body = os.urandom(8)
        hub.pings[body] = (time.time(), room)
        self._send(hub, envelope(T_PING, self._me(hub), body=body))

    def input(self, address: Any, room: Any, text: Any, split: bool = False) -> Dict[str, Any]:
        """A line typed in a window: a message, or a command. A message over
        the hub's limit is refused with too_long (the page asks), or with
        split sent in parts "(1/3) ...", as NomadNet does."""
        hub = self.sessions.get(clean_address(address) or "")
        if hub is None:
            return {"status": "error", "error": "Not connected to this hub"}
        room = clean_room(room) if room else STATUS
        text = clean_text(text, 2000).strip()
        if not text:
            return {"status": "success"}
        try:
            if text.startswith("/") and not text.startswith("//"):
                return self._command(hub, room, text)
            if text.startswith("//"):
                text = text[1:]
            if len(text.encode("utf-8")) > hub.max_msg and hub.welcomed:
                parts = split_message(text, hub.max_msg)
                if not parts:
                    raise RuntimeError(f"Too long: the hub takes {hub.max_msg} bytes at most")
                if not split:
                    return {"status": "error", "too_long": True, "parts": len(parts), "max": hub.max_msg,
                            "error": f"Too long: the hub takes {hub.max_msg} bytes at most"}
                for part in parts:
                    self._say(hub, room, T_MSG, part)
                return {"status": "success"}
            return self._say(hub, room, T_MSG, text)
        except Exception as exc:
            self._line(hub, room, "error", str(exc))
            return {"status": "error", "error": str(exc)}

    def _say(self, hub: Hub, room: str, kind: int, text: str) -> Dict[str, Any]:
        if not hub.welcomed:
            raise RuntimeError("Not connected")
        if not room:
            raise RuntimeError("This is the hub window: /join a room to talk")
        if not hub.rooms.get(room) or not hub.rooms[room].joined:
            if room in hub.pending_joins:           # the hub has not answered the JOIN yet
                if len(text.encode("utf-8")) > hub.max_msg:
                    raise RuntimeError(f"Too long: the hub takes {hub.max_msg} bytes at most")
                hub.rooms[room].outbox.append((kind, text))
                self._sys(hub, "Not in yet: sent as soon as the hub lets you in", room)
                return {"status": "success", "queued": True}
            raise RuntimeError(f"You are not in #{room}: /join {room}")
        if len(text.encode("utf-8")) > hub.max_msg:
            raise RuntimeError(f"Too long: the hub takes {hub.max_msg} bytes at most")
        nick = self.nick_for(hub.address)
        env = envelope(kind, self._me(hub), room=room, body=text, nick=nick)
        if nick:
            with self.lock:
                hub.nicks[self._me(hub).hex()] = clean_text(nick, 64, multiline=False)
        self._send(hub, env)
        hub.sent_ids.append(env[K_ID])
        me = self._me(hub).hex()
        self._line(hub, room, "msg" if kind == T_MSG else "action", text, nick or me[:12], me)
        return {"status": "success"}

    def _notice_all(self, hub: Hub, text: str, only: str = "") -> Dict[str, Any]:
        """/noticeall text: a notice in every room you are in on this hub;
        /notice text: in this room only. A NOTICE is a kind of message in
        RRC (like MSG and ACTION), not a hub command: the hub passes it to
        the room, each client shows it its way (rBrowser and NomadNet as a
        notice). E.g. "bots restarting, sorry for the noise". Sent in the
        background, half a second apart: rrcd limits messages per minute."""
        text = clean_text(text, 1000, multiline=False)
        if not text:
            raise RuntimeError("/notice text" if only else "/noticeall text")
        if text.startswith("/"):
            raise RuntimeError("A notice cannot start with /: the hub takes it for a command")
        if len(text.encode("utf-8")) > hub.max_msg:
            raise RuntimeError(f"Too long: the hub takes {hub.max_msg} bytes at most")
        with self.lock:
            rooms = [name for name, r in hub.rooms.items() if name and r.joined and (not only or name == only)]
        if not rooms:
            raise RuntimeError(f"You are not in #{only}" if only else "You are in no room on this hub")
        nick = self.nick_for(hub.address)
        me = self._me(hub)

        def go() -> None:
            for name in rooms:
                try:
                    env = envelope(T_NOTICE, me, room=name, body=text, nick=nick)
                    self._send(hub, env)
                    hub.sent_ids.append(env[K_ID])
                    self._line(hub, name, "notice", text, nick or me.hex()[:12], me.hex())
                except Exception as exc:
                    self._sys(hub, f"Notice not sent in #{name}: {exc}", name)
                time.sleep(0.5)
        threading.Thread(target=go, name="rrc-noticeall", daemon=True).start()
        return {"status": "success", "rooms": len(rooms)}

    def _rejoin(self, hub: Hub, name: str, key: str, here: str) -> Dict[str, Any]:
        """/rejoin [room] [key]: out of the room and in again, as a /part and
        a /join by hand would - the join only once the hub has answered the
        part (PARTED, the window closed), then JOIN_ALL_GAP s more."""
        if not name:
            raise RuntimeError("Which room? /rejoin room")
        self.part(hub.address, name)

        def go() -> None:
            deadline = time.time() + 15
            while time.time() < deadline:
                with self.lock:
                    if name not in hub.pending_parts and name not in hub.rooms:
                        break
                time.sleep(0.25)
            time.sleep(JOIN_ALL_GAP)
            if not hub.welcomed:
                self._sys(hub, f"/rejoin: #{name} not joined again: not connected", here if here in hub.rooms else "")
                return
            done = self.join(hub.address, name, key)
            if done.get("status") != "success":
                self._sys(hub, f"/rejoin: #{name} not joined again: {done.get('error')}", "")
        threading.Thread(target=go, name="rrc-rejoin", daemon=True).start()
        return {"status": "success", "rejoin": name}

    def _join_all(self, hub: Hub, room: str) -> Dict[str, Any]:
        """/joinall: the hub's /list, then into every room found, one every
        JOIN_ALL_GAP s (a burst of joins floods the page with history and
        the hub with packets). Rooms already in are skipped."""
        if not hub.welcomed:
            raise RuntimeError("Not connected")
        with self.lock:
            hub.room_list = None
        self._cmd(hub, "/list", None)
        self._sys(hub, "Asking the hub for its rooms…", room)

        def go() -> None:
            deadline = time.time() + 30
            while time.time() < deadline:
                time.sleep(0.5)
                with self.lock:
                    # The list's last line 3 s ago (list_until = last line + LIST_WINDOW).
                    done = hub.room_list is not None and time.time() - (hub.list_until - LIST_WINDOW) >= 3
                if done:
                    break
            with self.lock:
                names = [p["name"] for p in (hub.room_list or []) if p.get("name")]
                todo = [n for n in names if not (n in hub.rooms and hub.rooms[n].joined) and n not in hub.pending_joins]
            if not names:
                self._sys(hub, "/joinall: no room list from the hub (none, or no answer in 30 s)", room)
                return
            self._sys(hub, f"/joinall: {len(names)} rooms, joining {len(todo)} ({JOIN_ALL_GAP:g} s apart)", room)
            for name in todo:
                if not hub.welcomed:
                    self._sys(hub, "/joinall stopped: not connected", room)
                    return
                done = self.join(hub.address, name)
                if done.get("status") != "success":
                    self._sys(hub, f"/joinall: #{name} not joined: {done.get('error')}", room)
                time.sleep(JOIN_ALL_GAP)
        threading.Thread(target=go, name="rrc-joinall", daemon=True).start()
        return {"status": "success"}

    def _command(self, hub: Hub, room: str, line: str) -> Dict[str, Any]:
        word, _, arg = line[1:].partition(" ")
        word, arg = word.lower(), arg.strip()
        hub.cmd_at = time.time()
        if word == "help":
            for h in HELP:
                self._sys(hub, h, room)
            return {"status": "success"}
        if word == "joinall":
            return self._join_all(hub, room)
        if word == "clear":
            with self.lock:
                if room in hub.rooms:
                    hub.rooms[room].lines.clear()
                    hub.rev += 1
            return {"status": "success", "clear": True}
        if word == "nick":
            return self.set_hub_nick(hub.address, arg, room)
        if word in ("quit", "disconnect"):
            return self.disconnect(hub.address)
        if word == "connect":
            return self.connect(hub.address)
        if not hub.welcomed:
            raise RuntimeError("Not connected")
        if word in ("join", "j"):
            name, _, key = arg.partition(" ")
            res = self.join(hub.address, name, key.strip())
            if res["status"] != "success":
                raise RuntimeError(res["error"])
            return res
        if word == "rejoin":
            name, _, key = arg.partition(" ")
            return self._rejoin(hub, clean_room(name) if name else room, key.strip(), room)
        if word in ("part", "leave"):
            name = clean_room(arg) if arg else room
            if not name:
                raise RuntimeError("Which room? /part room")
            return self.part(hub.address, name)
        if word == "me":
            if not arg:
                raise RuntimeError("/me text")
            return self._say(hub, room, T_ACTION, arg)
        if word == "ping":
            self.ping(hub, room)
            return {"status": "success"}
        if word == "noticeall":
            return self._notice_all(hub, arg)
        if word == "notice":
            if not room:
                raise RuntimeError("This is the hub window: /notice goes to a room (or /noticeall)")
            return self._notice_all(hub, arg, only=room)
        # Anything else is the hub's: sent as it is.
        if word in ("who", "names"):
            target = clean_room(arg) if arg else room
            if not target:
                raise RuntimeError("Which room? /who room")
            line = f"/{word} {target}"
        shown = line
        # "/mode room +o <hash>": the hub answers "mode for room is now: +o …"
        # with the same nick, so echoing the command too showed it twice.
        if word == "mode" and re.search(r"[+-][ov]\s+[0-9a-f]{12,32}\b", arg):
            self._cmd(hub, line, room or None)
            return {"status": "success"}
        if word == "mode":
            # "/mode italia +o 73f1…": the nick of that hash, from the room's people.
            with self.lock:
                for h in re.findall(r"\b[0-9a-f]{12,32}\b", arg):
                    full = next((m for r in hub.rooms.values() for m in r.members if m.startswith(h)), "")
                    nick = hub.nicks.get(full) or next((n for r in hub.rooms.values()
                                                        for p, n in r.prefixes.items() if h.startswith(p)), "")
                    if nick:
                        shown += f"  ({nick})"
        self._sys(hub, f"» {shown}", room)
        self._cmd(hub, line, room or None)
        return {"status": "success"}

    # -------------------------------------------------------------- receiving

    def _packet(self, hub: Hub, link: Any, data: bytes) -> None:
        if hub.link is not link:
            return
        hub.last_rx, hub.probe_at = time.time(), 0.0
        try:
            env = cbor.loads(data)
        except Exception:
            return
        if not isinstance(env, dict) or not isinstance(env.get(K_T), int):
            return
        try:
            self._handle(hub, env)
        except Exception as exc:
            _log(f"⚠️ RRC: {exc}")

    def _handle(self, hub: Hub, env: Dict[Any, Any]) -> None:
        t = env.get(K_T)
        room = env.get(K_ROOM)
        room = clean_room(room) if isinstance(room, str) else None
        body = env.get(K_BODY)
        src = _hex(env.get(K_SRC))
        nick = env.get(K_NICK) if isinstance(env.get(K_NICK), str) else ""
        me = self._me(hub).hex()

        if t == T_PING:
            try:
                self._send(hub, envelope(T_PONG, self._me(hub), body=body))
            except Exception:
                pass
            return
        if t == T_PONG:
            sent = hub.pings.pop(bytes(body), None) if isinstance(body, (bytes, bytearray)) else None
            if sent:
                ms = int((time.time() - sent[0]) * 1000)
                if sent[1] is not None:
                    self._sys(hub, f"Pong from the hub: {ms} ms", sent[1] if sent[1] in hub.rooms else STATUS)
            return
        if t == T_WELCOME:
            self._welcome(hub, body)
            return
        if t == T_JOINED and room:
            self._joined(hub, room, body, nick, me)
            return
        if t == T_PARTED and room:
            self._parted(hub, room, body, nick, me)
            return
        if t in (T_MSG, T_ACTION):
            if src == me and bytes(env.get(K_ID) or b"") in hub.sent_ids:
                # Our own, already shown; its nick still goes to the people
                # list (RRC has no nick-change event: the away nick, /nick).
                if nick:
                    with self.lock:
                        hub.nicks[src] = clean_text(nick, 64, multiline=False)
                        hub.rev += 1
                return
            if not isinstance(body, str) or not room:
                return
            with self.lock:
                if nick and src:
                    hub.nicks[src] = clean_text(nick, 64, multiline=False)
                r = hub.rooms.get(room)
                if r is None or not r.joined:
                    return
                if src:
                    r.learn(src)
            if src in self.settings["ignored"]:
                return
            mention = src != me and self._mentions(hub, body)
            self._line(hub, room, "msg" if t == T_MSG else "action", body,
                       nick or hub.name_of(src), src, mention, count=True)
            if mention:
                self._maybe_autoreply(hub, room, src, nick or hub.name_of(src), body)
            return
        if t == T_NOTICE:
            if not isinstance(body, str):
                return
            hub.notice_at = time.time()         # the MOTD is still coming (see _after_motd)
            if src == me and bytes(env.get(K_ID) or b"") in hub.sent_ids:
                return                          # our own (/noticeall), already shown
            if src and hub.hub_hash and src != hub.hub_hash.hex():
                # From a user: a direct notice (key 8), or a notice to a room.
                if src in self.settings["ignored"]:
                    return
                if nick:
                    hub.nicks[src] = clean_text(nick, 64, multiline=False)
                where = room if room in hub.rooms else STATUS
                self._line(hub, where, "notice", body, nick or hub.name_of(src), src,
                           self._mentions(hub, body), count=True)
                return
            self._hub_notice(hub, body, room)
            return
        if t == T_ERROR:
            text = body if isinstance(body, str) else "error"
            if not hub.welcomed:
                # Said before the welcome ("banned", a full hub...): it is the
                # reason the link closes next, and the error to show for it.
                hub.error = f"The hub refused the connection: {clean_text(text, 200, False)}"
            self._hub_error(hub, text, room)
            return
        if t == T_RESOURCE_ENVELOPE and isinstance(body, dict):
            rid, size = body.get(B_RES_ID), body.get(B_RES_SIZE)
            if isinstance(rid, (bytes, bytearray)) and isinstance(size, int) and size > 0:
                sha = body.get(B_RES_SHA256)
                hub.expect[bytes(rid)] = {
                    "kind": body.get(B_RES_KIND) if isinstance(body.get(B_RES_KIND), str) else "blob",
                    "size": size, "sha": bytes(sha) if isinstance(sha, (bytes, bytearray)) else None,
                    "enc": body.get(B_RES_ENCODING) if isinstance(body.get(B_RES_ENCODING), str) else "utf-8",
                    "room": room, "until": time.time() + 60}

    def _welcome(self, hub: Hub, body: Any) -> None:
        with self.lock:
            hub.welcomed = True
            hub.state, hub.error, hub.reconnects = "connected", None, 0
            if isinstance(body, dict):
                if isinstance(body.get(B_WELCOME_HUB), str):
                    hub.name = clean_text(body[B_WELCOME_HUB], 80, multiline=False) or hub.name
                if isinstance(body.get(B_WELCOME_VER), str):
                    hub.version = clean_text(body[B_WELCOME_VER], 20, multiline=False)
                limits = body.get(B_WELCOME_LIMITS)
                if isinstance(limits, dict) and isinstance(limits.get(L_MAX_MSG), int):
                    hub.max_msg = limits[L_MAX_MSG]
                if isinstance(limits, dict) and isinstance(limits.get(L_MAX_NICK), int) and limits[L_MAX_NICK] > 0:
                    hub.max_nick = limits[L_MAX_NICK]
            self.settings["history"][hub.address] = {"name": hub.name, "last": time.time()}
            # The rooms of last time (Settings > "Remember and join the last
            # rooms"), then the windows still open (a reconnect after a drop).
            rooms = list(self._hub_entry(hub.address)["rooms"]) if self.settings["rejoin_rooms"] else []
            # Windows open from before (a reconnect): joined again too.
            rooms += [n for n in hub.rooms if n and n not in rooms]
            self._save()
            hub.rev += 1
        _log(f"💬 RRC: connected to {hub.name or hub.address}")
        hub.notice_at = time.time()
        threading.Thread(target=self._after_motd, args=(hub, hub.link, bool(rooms)),
                         name="rrc-status", daemon=True).start()
        for name in rooms:
            self.join(hub.address, name)

    def _after_motd(self, hub: Hub, link: Any, has_rooms: bool) -> None:
        """Our own lines after the hub's welcome text, not in the middle of
        it: the MOTD comes as many notices right after WELCOME. Written once
        the hub has been quiet for MOTD_QUIET s (MOTD_MAX at most)."""
        start = time.time()
        while time.time() - start < MOTD_MAX and time.time() - hub.notice_at < MOTD_QUIET:
            time.sleep(0.2)
        if hub.link is not link or not hub.welcomed:
            return                      # gone meanwhile
        self._sys(hub, f"Connected to {hub.name or hub.address}" + (f" (rrcd {hub.version})" if hub.version else "")
                  + (". /join a room, /list for the public rooms, /help for the commands." if not has_rooms else "."))
        # What we are using here, in plain sight: nothing about who we are
        # on a hub should have to be guessed.
        self._sys(hub, "\n".join([
            f"Hub: {hub.name or 'unnamed'} ({hub.address})",
            f"Using identity: {self.name_of_identity(hub.identity_id)} ({self._me(hub).hex()})",
            f"Nickname for this hub: {self.nick_label(hub.address)}",
        ]))

    def _joined(self, hub: Hub, room: str, body: Any, nick: str, me: str) -> None:
        hashes = [bytes(h).hex() for h in body if isinstance(h, (bytes, bytearray))] if isinstance(body, list) else []
        with self.lock:
            ours = room in hub.pending_joins
            if ours:
                hub.pending_joins.discard(room)
                r = hub.room(room)
                r.joined = True
                r.members = set(hashes) | {me}
                entry = self._hub_entry(hub.address)
                if room not in entry["rooms"]:
                    entry["rooms"].append(room)
                    self._save()
                hub.rev += 1
            else:
                r = hub.rooms.get(room)
                if r is None or not r.joined:
                    return
                for h in hashes:
                    r.learn(h)
                if nick and len(hashes) == 1:
                    hub.nicks[hashes[0]] = clean_text(nick, 64, multiline=False)
                hub.rev += 1
        if ours:
            self._sys(hub, f"You joined #{room}", room)
            self._quiet_who(hub, room)              # the nicks: JOINED brings only hashes
            waiting, r.outbox = r.outbox, []
            for kind, text in waiting:              # typed while the JOIN was on its way
                try:
                    self._say(hub, room, kind, text)
                except Exception as exc:
                    self._line(hub, room, "error", str(exc))
        else:
            if not hashes:
                self._quiet_who(hub, room)
            if self.settings["show_joins"]:
                who = nick or (hub.name_of(hashes[0]) if len(hashes) == 1 else "someone")
                self._line(hub, room, "join", f"{who} joined #{room}", who, hashes[0] if len(hashes) == 1 else hub.ident_of(who))
                # Its own badge on the room: the join sound otherwise left
                # nothing to tell which of many rooms it came from.
                with self.lock:
                    r.joins += 1
                    hub.rev += 1

    def _quiet_who(self, hub: Hub, room: str) -> None:
        """Hubs with include_joined_member_list off say who joined or left
        only by nick: the list comes from a /who, not shown."""
        # One on its way: its answer may predate this join/part, so one more
        # after it. An answer lost on the way does not block the next ones.
        if time.time() - hub.silent_who.get(room, 0) < QUIET_WHO_WAIT:
            hub.who_again.add(room)
            return
        hub.silent_who[room] = time.time()
        try:
            self._cmd(hub, f"/who {room}", room)
        except Exception:
            hub.silent_who.pop(room, None)

    def _count_rooms(self, hub: Hub) -> None:
        """After a /list: a silent /who for each public room, only to say
        "(N online)" in the Rooms list. rrcd has no count in /list, and
        answers /who for a public room you are not in. A few seconds first:
        on small links the list comes one line per packet."""
        time.sleep(3)
        with self.lock:
            names = [p["name"] for p in (hub.room_list or [])][:64]
            hub.count_who.update(names)
        for name in names:
            if not hub.welcomed:
                return
            try:
                self._cmd(hub, f"/who {name}", None)
            except Exception:
                hub.count_who.discard(name)
            time.sleep(0.5)             # rrcd limits messages per minute
        time.sleep(30)                  # answers lost on the way: no "counting" forever
        with self.lock:
            hub.count_who.difference_update(names)

    def _parted(self, hub: Hub, room: str, body: Any, nick: str, me: str) -> None:
        hashes = [bytes(h).hex() for h in body if isinstance(h, (bytes, bytearray))] if isinstance(body, list) else []
        with self.lock:
            if room in hub.pending_parts and (not hashes or me in hashes):
                self._close_room(hub, room)          # the answer to our /part: the window goes
                return
            r = hub.rooms.get(room)
            if r is None or not r.joined:
                return
            for h in hashes:
                r.members.discard(h)
                r.prefixes.pop(h[:12], None)
            hub.rev += 1
        if not hashes:
            self._quiet_who(hub, room)
        if self.settings["show_joins"]:
            who = nick or (hub.name_of(hashes[0]) if len(hashes) == 1 else "someone")
            self._line(hub, room, "part", f"{who} left #{room}", who, hashes[0] if len(hashes) == 1 else hub.ident_of(who))

    def _hub_error(self, hub: Hub, text: str, room: Optional[str]) -> None:
        gone = GONE.match(text)
        with self.lock:
            dropped = 0
            if room and room in hub.pending_joins:
                hub.pending_joins.discard(room)
                r = hub.rooms.get(room)
                if r is not None:
                    r.joined = False
                    dropped, r.outbox = len(r.outbox), []
            if gone and gone.group("room") in hub.rooms:
                r = hub.rooms[gone.group("room")]
                r.joined = False
                r.members.clear()
                r.prefixes.clear()
                room = r.name
            if room and room in hub.pending_parts:
                self._close_room(hub, room)          # the /part refused: the window goes anyway
            hub.rev += 1
        self._line(hub, self._where(hub, room), "error", text, count=True)
        if dropped:
            self._sys(hub, f"Not sent ({dropped}): the hub did not let you in", self._where(hub, room))

    def _where(self, hub: Hub, room: Optional[str]) -> str:
        """The window for a hub's NOTICE or ERROR: the room it names (K_ROOM);
        with none (/stats, usage lines, "not authorized" of hub commands) the
        window on screen, as NomadNet does - the answer shows where the
        command was typed. A room closed meanwhile: the hub window."""
        if room:
            return room if room in hub.rooms else STATUS
        # No room: the answer to a command just typed goes where it was typed;
        # anything else (the MOTD after a reconnect...) to the hub window.
        if time.time() - hub.cmd_at < CMD_ANSWER_WINDOW and hub.active in hub.rooms:
            return hub.active
        return STATUS

    def _hub_notice(self, hub: Hub, text: str, room: Optional[str]) -> None:
        """A notice from the hub. A few answers are read (who, list, topic,
        mode) to fill the window's head and the people list; all of them are
        shown, except the /who sent by us after a join."""
        first = text.strip().split("\n")[0]
        low = first.lower()
        target = self._where(hub, room)
        if first.startswith(WHO_PREFIX):
            name, _, rest = first[len(WHO_PREFIX):].partition(": ")
            name = clean_room(name)
            with self.lock:
                # Every /who answer says how many are in the room: kept for
                # the Rooms list, "(N online)".
                hub.room_users[name] = 0 if rest.strip() == "(none)" else \
                    sum(1 for _ in WHO_ENTRY.finditer(rest.strip()))
                counted = name in hub.count_who
                hub.count_who.discard(name)
                hub.rev += 1
                r = hub.rooms.get(name)
                if r is not None and r.joined:
                    # The whole room as the hub sees it now: who is not
                    # listed has gone. Full hashes known stay full.
                    old, members, prefixes = r.members, set(), {}
                    for m in WHO_ENTRY.finditer(rest.strip()):
                        if m.group("bh"):
                            members.add(m.group("bh").lower())
                            continue
                        p, n = m.group("np").lower(), clean_text(m.group("nick"), 64, multiline=False)
                        full = next((h for h in old | set(hub.nicks) if h.startswith(p)), None)
                        if full:
                            members.add(full)
                            hub.nicks[full] = n
                        else:
                            prefixes[p] = n
                    members.add(self._me(hub).hex())
                    r.members, r.prefixes = members, prefixes
                    hub.rev += 1
                auto = name in hub.silent_who or counted
                hub.silent_who.pop(name, None)
                again = name in hub.who_again
                hub.who_again.discard(name)
            if again:
                self._quiet_who(hub, name)
            if auto and not self.settings["show_auto"]:
                return
            target = STATUS                 # 50 names do not belong in the chat
        elif low.startswith(LIST_HEAD) or low.startswith(LIST_NONE):
            rooms = []
            for line in text.split("\n")[1:]:
                m = LIST_LINE.match(line)
                if m:
                    rooms.append({"name": clean_room(m.group("name")), "topic": clean_text(m.group("topic") or "", 200, False)})
            with self.lock:
                hub.room_list = rooms
                hub.list_until = time.time() + LIST_WINDOW
                hub.list_target = STATUS     # the rest of the list follows it there
                hub.rev += 1
                count, hub.count_next = hub.count_next, False
            if count:                        # only when the Rooms window opens or refreshes
                threading.Thread(target=self._count_rooms, args=(hub,), daemon=True).start()
            target = STATUS
        elif time.time() < hub.list_until and room is None and LIST_LINE.match(text.strip("\r\n").split("\n")[0].rstrip()):
            # A /list sent one line per packet (small links): more of the list,
            # each "  name - topic" (the leading spaces tell it apart).
            m = LIST_LINE.match(text.strip("\r\n").split("\n")[0].rstrip())
            with self.lock:
                hub.room_list = (hub.room_list or []) + [{"name": clean_room(m.group("name")),
                                                          "topic": clean_text(m.group("topic") or "", 200, False)}]
                hub.list_until = time.time() + LIST_WINDOW
                hub.rev += 1
            target = hub.list_target if hub.list_target in hub.rooms else STATUS
        else:
            info, topic, mode = ROOM_INFO.match(first), TOPIC_IS.match(first), MODE_IS.match(first)
            flags = ROOM_FLAGS_IS.match(first)
            with self.lock:
                if flags and flags.group("room") in hub.rooms:
                    # The room's own modes changed (+m, +k...): the head follows.
                    r = hub.rooms[flags.group("room")]
                    r.modes = flags.group("modes")
                    target = r.name
                if info and info.group("room") in hub.rooms:
                    r = hub.rooms[info.group("room")]
                    t = info.group("topic")
                    r.topic = "" if t == "(none)" else t
                    r.modes = info.group("mode")
                    target = r.name
                elif topic and topic.group("room") in hub.rooms:
                    r = hub.rooms[topic.group("room")]
                    t = topic.group("topic")
                    r.topic = "" if t in ("(none)", "(cleared)") else t
                    target = r.name
                elif mode and mode.group("room") in hub.rooms:
                    r = hub.rooms[mode.group("room")]
                    flag, who = mode.group("flag"), mode.group("who")
                    if flag[0] == "+":
                        r.roles[who] = flag[1]
                    elif r.roles.get(who) == flag[1]:
                        r.roles.pop(who, None)
                    target = r.name
                    full = next((h for h in r.members if h.startswith(who)), "")
                    name = hub.nicks.get(full) or r.prefixes.get(who) or who
                    text = f"{text}  ({name})"
                hub.rev += 1
            if not room and not (flags or info or topic or mode) and target != STATUS \
                    and (text.count("\n") >= 3 or len(text) > 300):
                target = STATUS                         # /stats and the like: long
            if self.settings["notices_to_hub"] and not (flags or info or topic):
                # Rooms keep the chat and their own topic and modes; everything
                # else the hub says (people's +o/+v, kicks, answers) goes to the
                # hub tab. The room's head and people list are updated anyway.
                target = STATUS
        self._line(hub, target, "notice", text, count=target == STATUS)

    def _resource_ok(self, hub: Hub, resource: Any) -> bool:
        try:
            size = resource.get_data_size() if hasattr(resource, "get_data_size") else resource.total_size
        except Exception:
            return False
        ok = 0 < size <= RESOURCE_MAX
        if ok:
            hub.receiving = True
            hub.rev += 1
        return ok

    def _resource_done(self, hub: Hub, resource: Any) -> None:
        hub.receiving = False
        hub.rev += 1
        try:
            if resource.status != RNS.Resource.COMPLETE:
                return
            data = resource.data.read()
        except Exception:
            return
        now = time.time()
        found = None
        with self.lock:
            for rid, exp in list(hub.expect.items()):
                if exp["until"] < now:
                    hub.expect.pop(rid, None)
                elif found is None and exp["size"] == len(data):
                    found = hub.expect.pop(rid)
        if found is None or found["kind"] not in ("notice", "motd"):
            return
        if found["sha"] is not None and hashlib.sha256(data).digest() != found["sha"]:
            return
        text = data.decode(found["enc"] or "utf-8", errors="replace")
        if found["kind"] == "motd":
            self._line(hub, STATUS, "notice", text)
        else:
            self._hub_notice(hub, text, found["room"])

    # ------------------------------------------------------------- for the page

    def _role(self, r: Room, ident: str) -> str:
        return r.roles.get(ident[:12], "")

    def _room_summary(self, hub: Hub, r: Room) -> Dict[str, Any]:
        members = [{"id": h, "nick": hub.nicks.get(h, ""), "role": self._role(r, h)} for h in r.members]
        members += [{"id": p, "nick": n, "role": self._role(r, p), "partial": True} for p, n in r.prefixes.items()
                    if not any(h.startswith(p) for h in r.members)]
        return {"name": r.name, "joined": r.joined, "leaving": r.name in hub.pending_parts, "topic": r.topic, "modes": r.modes,
                "unread": r.unread, "mentions": r.mentions, "joins": r.joins, "members": members}

    def output(self, address: Any, since: Any = 0) -> Dict[str, Any]:
        hub = self.sessions.get(clean_address(address) or "")
        if hub is None:
            return {"status": "error", "error": "Not connected to this hub"}
        try:
            since = int(since)
        except (TypeError, ValueError):
            since = 0
        with self.lock:
            lines = sorted((ln for r in hub.rooms.values() for ln in r.lines if ln["seq"] > since),
                           key=lambda ln: ln["seq"])
            return {"status": "success", "seq": hub.seq, "rev": hub.rev,
                    "hub": {"address": hub.address, "name": hub.name, "state": hub.state, "error": hub.error,
                            "version": hub.version, "rtt": hub.rtt, "receiving": hub.receiving,
                            "me": self._me(hub).hex(), "nick": self.nick_for(hub.address),
                            "nick_source": self.nick_source(hub.address)[1],
                            "identity": hub.identity_id, "identity_name": self.name_of_identity(hub.identity_id),
                            "max_msg": hub.max_msg, "room_list": hub.room_list,
                            "room_users": hub.room_users,
                            "rooms": [self._room_summary(hub, r) for r in hub.rooms.values()]},
                    "lines": lines}

    def peer_info(self, address: Any, ident: Any) -> Dict[str, Any]:
        """Everything known here about a person, from the identity hash: nick
        and rooms on each open hub, and what Reticulum knows of the same
        identity - its LXMF address, NomadNet node, RRC hub (they follow from
        the hash), announces, paths. Reads tables only; nothing is sent."""
        ident = str(ident or "").lower()
        if not re.fullmatch(r"[0-9a-f]{12}|[0-9a-f]{32}", ident):
            return {"status": "error", "error": "Not an identity hash"}
        hubs = []
        with self.lock:
            for hub in self.sessions.values():
                full = next((h for r in hub.rooms.values() for h in r.members if h.startswith(ident)), "")
                rooms = [r.name for r in hub.rooms.values() if r.name and
                         (any(h.startswith(ident) for h in r.members) or ident[:12] in r.prefixes)]
                nick = hub.nicks.get(full, "") or next((n for r in hub.rooms.values()
                                                       for p, n in r.prefixes.items() if p == ident[:12]), "")
                if full and len(ident) == 12:
                    ident = full
                if rooms or nick:
                    hubs.append({"address": hub.address, "name": hub.name, "nick": nick, "rooms": rooms})
            me = any(self._me(h).hex() == ident for h in self.sessions.values())
        out: Dict[str, Any] = {"status": "success", "id": ident, "full": len(ident) == 32, "hubs": hubs,
                               "ignored": ident in self.settings["ignored"], "me": me}
        if len(ident) != 32:
            return out                      # a 12-hex prefix from /who: no address follows from it
        id_bytes = bytes.fromhex(ident)
        try:
            out["keys_known"] = rnsquiet.recall(id_bytes, from_identity_hash=True) is not None
        except Exception:
            out["keys_known"] = None

        def dest(name: str) -> Dict[str, Any]:
            h = RNS.Destination.hash_from_name_and_identity(name, id_bytes)
            info: Dict[str, Any] = {"address": h.hex()}
            try:
                info["announced"] = rnsquiet.recall_app_data(h) is not None
            except Exception:
                info["announced"] = False
            try:
                info["path"] = RNS.Transport.has_path(h)
                info["hops"] = RNS.Transport.hops_to(h) if info["path"] else None
            except Exception:
                info["path"], info["hops"] = False, None
            return info

        lxmf = dest("lxmf.delivery")
        messenger = getattr(self.browser, "messenger", None)
        if messenger is not None:
            try:
                lxmf["name"] = messenger.peer_name(lxmf["address"])
                conv = messenger.store.data.get(lxmf["address"]) if messenger.store is not None else None
                lxmf["conversation"] = bool(conv)
                lxmf["unread"] = int(conv.get("unread", 0)) if conv else 0
            except Exception:
                pass
        out["lxmf"] = lxmf
        node = dest("nomadnetwork.node")
        entry = getattr(self.browser, "nomadnet_nodes", {}).get(node["address"])
        if entry:
            node.update({"name": entry.get("name"), "hops": entry.get("hops", node.get("hops"))})
        out["nomadnet"] = node
        rhub = dest("rrc.hub")
        if rhub["announced"]:
            try:
                rhub["name"] = hub_name(rnsquiet.recall_app_data(bytes.fromhex(rhub["address"])))
            except Exception:
                pass
        out["rrc_hub"] = rhub
        return out

    def status(self) -> Dict[str, Any]:
        with self.lock:
            hubs = [{"address": h.address, "name": h.name, "state": h.state, "rev": h.rev,
                     "unread": sum(r.unread for r in h.rooms.values()),
                     # The rooms only, not the hub tab (its automatic answers
                     # would keep the browser's RRC tab badge lit for nothing).
                     "room_unread": sum(r.unread for r in h.rooms.values() if r.name != STATUS),
                     "mentions": sum(r.mentions for r in h.rooms.values()),
                     "room_joins": sum(r.joins for r in h.rooms.values() if r.name != STATUS)}
                    for h in self.sessions.values()]
            settings = {k: v for k, v in self.settings.items() if k not in ("favorites", "history", "hubs")}
        return {"status": "success", "settings": settings, "identities": self.identity_choices(),
                "ignored": dict(self.settings["ignored"]), "hubs": hubs}
