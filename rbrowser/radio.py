"""
The Radio client: listens to radio-lxst stations (github.com/fr33n0w/radio-lxst)
and to any LXST phone that answers by itself.

The call is the one of radio_client.py: a Link to "lxst.telephony", identify,
ask for a profile at RINGING, then frames {0x01: [0x01 + Opus packet]} and
the station info {"radiolxst": {n, l, np, kb, air}} on the same Link.
The audio must play in the browser (phone, tunnel, guest of a PC), not on
this machine: the Opus packets are not decoded here, only wrapped into an
Ogg Opus stream (GET /api/radio/stream) that an <audio> element plays.
No LXST, no numpy: RNS and umsgpack only.
"""

from __future__ import annotations

import json
import os
import queue
import random
import struct
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional

import RNS
from RNS.vendor import umsgpack as mp

from . import rnsquiet
from .identities import DEFAULT_ID
from .messenger import GUEST_ID, guest_view
from .guest_identity import current as guest_current

STATION_ASPECT = "radiolxst.station"
FIELD_SIGNALLING, FIELD_FRAMES, FIELD_META = 0x00, 0x01, "radiolxst"
FIELD_LISTENER = "radiolxst_listener"  # our name, sent to the station inside the call
STATUS_BUSY, STATUS_REJECTED, STATUS_AVAILABLE, STATUS_RINGING = 0x00, 0x01, 0x03, 0x04
STATUS_ESTABLISHED = 0x06
PREFERRED_MODE, PREFERRED_PROFILE, MODE_HALF_DUPLEX = 0xF0, 0xFF, 0x02
PROFILES = {"SHQ": 0x60, "HQ": 0x50, "MQ": 0x40, "LBW": 0x30, "VLBW": 0x20, "ULBW": 0x10}

RADIO_DIR = os.path.join("settings", "radio")
STATIONS_FILE = os.path.join(RADIO_DIR, "stations.json")
SETTINGS_FILE = os.path.join(RADIO_DIR, "radio.json")

PREFILL_S = 5.0        # audio held before a browser gets its first byte (3 s ran dry in the first seconds)
BACKLOG_S = 6.0        # kept for a browser that joins later (more than PREFILL_S)
IDLE_HANGUP_S = 45     # no browser listening for this long = hang up
PATH_WAIT = 20         # seconds for a path answer
ANSWER_WAIT = 30       # seconds for the station to answer
DIAL_TRIES = 2         # second try drops the path first: the first one can be stale
RETRY_WAITS = (15, 30, 60, 120)  # pauses before redialing after a drop while playing
NO_AUDIO_S = 20        # playing but no audio this long = lost (RNS notices a dead link much later)
STEADY_S = 60          # this much good listening resets the retry count
COMMANDS = ("help", "info", "status", "link", "subscribe", "unsubscribe")  # the station's autoresponder
COMMANDS_SHOWN = 40
STATUS_EVERY = 180     # seconds between status requests to one station
STATUS_MIN_GAP = 15    # Refresh: not more often than this per station
STATUS_WINDOW = 24 * 3600  # only stations heard in the last day (or added by hand) are asked
STATUS_PARALLEL = 1     # stamps in parallel stall the whole process (GIL)
STATUS_TIMEOUT = 25    # path + link + answer
NO_ANSWER = "no answer"
VIEW_GRACE = 15        # the tab asked for the list this recently: someone is looking, keep states fresh
REPLY_WAIT = 90         # a command not answered by then is not waiting any more


def _log(text: str) -> None:
    try:
        print(text)
    except Exception:
        try:
            print(text.encode("ascii", "replace").decode())
        except Exception:
            pass


def _drop_path(dh: bytes) -> None:
    """Forget a path here and in the shared rnsd (like rnpath -d), so the next request gets a fresh one."""
    try:
        RNS.Reticulum.get_instance().drop_path(dh)
    except Exception:
        pass
    try:
        with RNS.Transport.path_table_lock:
            RNS.Transport.path_table.pop(dh, None)
    except Exception:
        pass


def subscription(rows: List[Dict[str, Any]]) -> Optional[bool]:
    """True/False from the last subscribe/unsubscribe the station answered, None if never asked.
    Replies come in order, each one answers the oldest command still waiting (not by text: replies can be custom)."""
    waiting: List[Any] = []
    state = None
    for r in rows:
        if r.get("dir") == "out":
            if r.get("state") != "failed":
                waiting.append((str(r.get("content") or "").strip().lower(), r.get("ts") or 0))
            continue
        waiting = [w for w in waiting if (r.get("ts") or 0) - w[1] < REPLY_WAIT]  # never answered: not this one
        if waiting:
            cmd = waiting.pop(0)[0]
            if cmd in ("subscribe", "unsubscribe"):
                state = cmd == "subscribe"
    return state


def ask_status(call_id: str, timeout: float = STATUS_TIMEOUT):
    """The station's live state (dict), NO_ANSWER if the link came up but the request was not answered,
    None if the station cannot be reached."""
    try:
        ident_hash = bytes.fromhex(call_id)
        dh = RNS.Destination.hash_from_name_and_identity(STATION_ASPECT, ident_hash)
    except ValueError:
        return None
    end = time.time() + timeout
    if not RNS.Transport.has_path(dh):
        RNS.Transport.request_path(dh)
        while not RNS.Transport.has_path(dh) and time.time() < end:
            time.sleep(0.25)
    ident = RNS.Identity.recall(dh)
    if ident is None or ident.hash != ident_hash:
        return None
    dest = RNS.Destination(ident, RNS.Destination.OUT, RNS.Destination.SINGLE, *STATION_ASPECT.split("."))
    box: List[Any] = []
    done = threading.Event()
    link = RNS.Link(dest)
    try:
        while link.status not in (RNS.Link.ACTIVE, RNS.Link.CLOSED) and time.time() < end:
            time.sleep(0.1)
        if link.status != RNS.Link.ACTIVE:
            return None
        link.request("status", None, response_callback=lambda r: (box.append(r.response), done.set()),
                     failed_callback=lambda r: done.set(), timeout=max(1.0, end - time.time()))
        done.wait(max(0.5, end - time.time()) + 1)
        return box[0] if box and isinstance(box[0], dict) else NO_ANSWER
    finally:
        try:
            link.teardown()
        except Exception:
            pass


def lxmf_of(call_id: str) -> str:
    """The station's LXMF address: where its messages go (same identity as the Call ID, another hash)."""
    try:
        return RNS.Destination.hash_from_name_and_identity("lxmf.delivery", bytes.fromhex(call_id)).hex()
    except ValueError:
        return ""


# ─── Ogg Opus ───────────────────────────────────────────────

def announce_emitted(destination_hash: bytes) -> int:
    """Emission time of the announce just received (signed by the station, repeaters cannot change it), 0 if unknown."""
    try:
        blobs = RNS.Transport.path_table[destination_hash][4]  # IDX_PT_RANDBLOBS
        return int.from_bytes(blobs[-1][5:10], "big") if blobs else 0
    except Exception:
        return 0


def _crc_table():
    t = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
        t.append(r & 0xFFFFFFFF)
    return t


_CRC = _crc_table()


def _ogg_crc(data: bytes) -> int:
    c = 0
    for b in data:
        c = ((c << 8) ^ _CRC[((c >> 24) ^ b) & 0xFF]) & 0xFFFFFFFF
    return c


def opus_samples(packet: bytes) -> int:
    """Length of an Opus packet in 48 kHz samples, from its TOC byte."""
    if not packet:
        return 0
    toc = packet[0]
    cfg = toc >> 3
    if cfg < 12:
        tenths = (100, 200, 400, 600)[cfg % 4]      # SILK: 10/20/40/60 ms
    elif cfg < 16:
        tenths = (100, 200)[cfg % 2]                # hybrid
    else:
        tenths = (25, 50, 100, 200)[cfg % 4]        # CELT: 2.5/5/10/20 ms
    code = toc & 3
    count = 1 if code == 0 else 2 if code < 3 else (packet[1] & 0x3F if len(packet) > 1 else 0)
    return tenths * 48 * count // 10


class OggWriter:
    """One logical Ogg stream: headers first, then one packet per page."""

    def __init__(self):
        self.serial = random.getrandbits(32)
        self.seq = 0
        self.granule = 0

    def _page(self, packet: bytes, flags: int, granule: int) -> bytes:
        lacing = [255] * (len(packet) // 255) + [len(packet) % 255]
        head = struct.pack("<4sBBqIIIB", b"OggS", 0, flags, granule, self.serial, self.seq, 0, len(lacing))
        page = bytearray(head + bytes(lacing) + packet)
        struct.pack_into("<I", page, 22, _ogg_crc(bytes(page)))
        self.seq += 1
        return bytes(page)

    def headers(self) -> bytes:
        head = b"OpusHead" + struct.pack("<BBHIhB", 1, 2, 0, 48000, 0, 0)
        tags_vendor = b"rBrowser"
        tags = b"OpusTags" + struct.pack("<I", len(tags_vendor)) + tags_vendor + struct.pack("<I", 0)
        return self._page(head, 0x02, 0) + self._page(tags, 0x00, 0)

    def audio(self, packet: bytes) -> bytes:
        self.granule += opus_samples(packet)
        return self._page(packet, 0x00, self.granule)


# ─── Stations heard ─────────────────────────────────────────

class Directory:
    """radiolxst.station announces, kept in settings/radio/stations.json."""

    aspect_filter = STATION_ASPECT

    def __init__(self, path: str = STATIONS_FILE):
        self.path = path
        self.lock = threading.Lock()
        self.stations: Dict[str, Dict[str, Any]] = {}
        self._busy: set = set()
        try:
            with open(path, encoding="utf-8") as f:
                for d in json.load(f):
                    if isinstance(d, dict) and len(str(d.get("call_id", ""))) == 32:
                        self.stations[d["call_id"]] = d
        except (OSError, ValueError):
            pass

    def received_announce(self, destination_hash, announced_identity, app_data):
        try:
            cid = announced_identity.hash.hex()
            emitted = announce_emitted(destination_hash)
            with self.lock:
                old = self.stations.get(cid, {})
                if emitted and old and emitted <= old.get("emitted", 0):
                    # a repeater replaying an announce we already had: the station did not speak again
                    _log(f"📻 Radio: ignored replayed announce of {old.get('name') or cid}")
                    return
                if not app_data:
                    # a path answer without data: never wipe what we know
                    if old:
                        old["heard"], old["emitted"] = time.time(), max(old.get("emitted", 0), emitted)
                    return
                info = mp.unpackb(app_data)
                if not isinstance(info, dict):
                    return
                if "air" in info:
                    # station before radio-lxst 0.4: its state is in the announce
                    self.stations[cid] = {
                        "call_id": cid, "name": str(info.get("n", ""))[:48], "listeners": info.get("l"),
                        "now_playing": str(info.get("np", ""))[:64], "kbps": info.get("kb"),
                        "on_air": bool(info.get("air", True)), "heard": time.time(),
                        "favorite": bool(old.get("favorite")), "added": old.get("added", False),
                        "emitted": emitted, "legacy": True,
                    }
                else:
                    # the announce only says the station exists: the state is asked (status request)
                    s = dict(old) if old else {"call_id": cid, "listeners": None, "now_playing": "",
                                                "on_air": False, "favorite": False, "added": False}
                    s.update(name=str(info.get("n", ""))[:48], kbps=info.get("kb"), heard=time.time(),
                             emitted=emitted, legacy=False, checked=0)
                    self.stations[cid] = s
            self.save()
        except Exception:
            pass

    def add(self, call_id: str, name: str = "") -> None:
        with self.lock:
            if call_id not in self.stations:
                self.stations[call_id] = {"call_id": call_id, "name": name[:48], "listeners": None,
                                          "now_playing": "", "kbps": None, "on_air": True,
                                          "heard": 0, "favorite": False, "added": True}
        self.save()

    # live state: asked to the station (GET "status" over a Link), never put in announces
    def poll(self, skip=()) -> None:
        """Ask the stations heard lately (or added by hand) for their state, a few at a time."""
        now = time.time()
        with self.lock:
            rows = sorted(self.stations.values(), key=lambda s: s.get("checked") or 0)
            for s in rows:
                if len(self._busy) >= STATUS_PARALLEL:
                    break
                cid = s["call_id"]
                if s.get("legacy") or cid in skip or cid in self._busy \
                        or now - (s.get("checked") or 0) < STATUS_EVERY \
                        or (now - (s.get("heard") or 0) > STATUS_WINDOW and not s.get("added")):
                    continue
                self._busy.add(cid)
                s["checked"] = now
                threading.Thread(target=self._check, args=(cid,), name="radio-status", daemon=True).start()

    def refresh(self, skip=()) -> None:
        with self.lock:
            for s in self.stations.values():
                if time.time() - (s.get("checked") or 0) >= STATUS_MIN_GAP:
                    s["checked"] = 0
        self.poll(skip)

    def _check(self, cid: str) -> None:
        try:
            st = ask_status(cid)
            with self.lock:
                s = self.stations.get(cid)
                if s is None or st == NO_ANSWER:
                    return  # link up but no answer: a station before 0.4 (or busy), keep what we know
                if st is None:
                    s.update(on_air=False, listeners=None, now_playing="no reply")
                else:
                    air = bool(st.get("air"))
                    s.update(on_air=air, listeners=st.get("l"), name=str(st.get("n") or s.get("name", ""))[:48],
                             now_playing=str(st.get("np") or "")[:64] if air else "off air", heard=time.time())
            self.save()
        finally:
            with self.lock:
                self._busy.discard(cid)

    def update(self, call_id: str, **fields) -> None:
        with self.lock:
            s = self.stations.get(call_id)
            if s:
                s.update(fields)
        self.save()

    def forget(self, call_id: str) -> None:
        with self.lock:
            self.stations.pop(call_id, None)
        self.save()

    def save(self) -> None:
        try:
            from .fileio import atomic_write_json
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with self.lock:
                data = list(self.stations.values())
            atomic_write_json(self.path, data, indent=1)
        except Exception:
            pass

    def listing(self) -> List[Dict[str, Any]]:
        with self.lock:
            rows = sorted((dict(s) for s in self.stations.values()),
                          key=lambda s: (not s.get("favorite"), not s.get("on_air"), -(s.get("heard") or 0)))
        for s in rows:
            s["lxmf"] = lxmf_of(s["call_id"])
        return rows


# ─── The call ───────────────────────────────────────────────

class Radio:
    """One call: the owner's (gid None) or a guest session's, with its identity."""

    def __init__(self, service: "RadioService", gid: Optional[str] = None):
        self.service = service
        self.browser = service.browser
        self.gid = gid
        self.lock = threading.Lock()
        self.caller = None      # the identity the call was made with
        self.link = None
        self.state, self.message = "idle", ""
        self.call_id = ""
        self.name = ""
        self.meta: Dict[str, Any] = {}
        self.meta_t = 0.0
        self.prev_meta: Dict[str, Any] = {}
        self.prev_t = self.np_changed = 0.0
        # call audio (samples received) when the meta came: the tab lines it up with what it plays
        self.meta_rx = self.prev_rx = self.np_rx = 0
        self.stream_bases: Dict[str, int] = {}
        self.profile = PROFILES["SHQ"]
        self.hops = None
        self.started = 0.0
        self.bytes = 0
        self.frames = 0
        self._gen = 0
        self.retries = 0
        self.last_audio = 0.0
        self._retry_lock = threading.Lock()
        # audio for the browsers: (samples, packet) of the last seconds + one queue per listener
        self.backlog: deque = deque()
        self.backlog_samples = 0
        self.received_samples = 0
        self.listeners: List[queue.Queue] = []
        self.no_listener_since = 0.0
        # a guest's choices live as long as its session
        self.settings = self._load_settings() if gid is None else {"quality": "SHQ", "last": "", "identity": GUEST_ID}

    @property
    def directory(self) -> Optional["Directory"]:
        return self.service.directory

    @property
    def identity(self):
        """Owner: the identity picked in the tab. Guest: its session identity, fixed."""
        if self.gid is not None:
            return self.browser.guest_identity.get(self.gid)
        ids = getattr(self.browser, "identities", None)
        return ids.identity_for(self.settings["identity"]) if ids else None

    def identity_name(self) -> str:
        if self.gid is not None:
            return self.browser.guest_identity.nickname(gid=self.gid)
        return self.browser.identities.name_of(self.settings["identity"])

    def listener_name(self) -> str:
        """What the station shows for us: the name announced for this identity on LXMF."""
        m = getattr(self.browser, "messenger", None)
        try:
            if m is not None:
                name = m.guest_display_name(self.gid) if self.gid is not None \
                    else m.display_name_of(self.settings["identity"])
                if name:
                    return str(name)[:32]
        except Exception:
            pass
        me = self.caller or self.identity
        return f"Radio-LXST Client #{me.hash.hex()[:4]}" if me else "Radio-LXST Client"

    def _send_name(self, link) -> str:
        name = self.listener_name()
        try:
            RNS.Packet(link, mp.packb({FIELD_LISTENER: {"n": name}}), create_receipt=False).send()
        except Exception:
            pass
        return name

    def live(self) -> bool:
        return self.state in ("searching", "connecting", "ringing", "playing", "retrying")

    def _log(self, text: str) -> None:
        _log(text if self.gid is None else text.replace("Radio:", f"Radio [{self.identity_name()}]:", 1))

    # settings: quality, the last station, the identity
    def _load_settings(self) -> Dict[str, Any]:
        s = {"quality": "SHQ", "last": "", "identity": DEFAULT_ID}
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                if d.get("quality") in PROFILES:
                    s["quality"] = d["quality"]
                if isinstance(d.get("last"), str):
                    s["last"] = d["last"][:32]
                if isinstance(d.get("identity"), str) and d["identity"]:
                    s["identity"] = d["identity"]
        except (OSError, ValueError):
            pass
        return s

    def _save_settings(self) -> None:
        if self.gid is not None:
            return
        try:
            from .fileio import atomic_write_json
            os.makedirs(RADIO_DIR, exist_ok=True)
            atomic_write_json(SETTINGS_FILE, self.settings, indent=1)
        except Exception:
            pass

    def start(self) -> bool:
        return self.service.start()

    def set_identity(self, profile_id: str) -> Dict[str, Any]:
        """Owner only: call as another saved identity (a call on goes again with it)."""
        if self.gid is not None:
            return {"status": "error", "error": "A guest listens with its guest identity"}
        if self.browser.identities.identity_for(profile_id) is None:
            return {"status": "error", "error": "Pick a saved identity"}
        if profile_id == self.settings["identity"]:
            return {"status": "success"}
        self.settings["identity"] = profile_id
        self._save_settings()
        self._log(f"📻 Radio: now listening as {self.identity_name()}")
        if self.live() and self.call_id:
            return self.tune(self.call_id)
        return {"status": "success"}

    # tune / hang up
    def tune(self, call_id: str, quality: Optional[str] = None) -> Dict[str, Any]:
        call_id = (call_id or "").strip().lower()
        try:
            if len(bytes.fromhex(call_id)) != RNS.Reticulum.TRUNCATED_HASHLENGTH // 8:
                raise ValueError
        except ValueError:
            return {"status": "error", "error": "A Call ID is 32 hex characters"}
        if not self.start():
            return {"status": "error", "error": "Reticulum is not connected"}
        caller = self.identity
        if caller is None:
            return {"status": "error", "error": "The radio identity is gone: pick another in the Radio tab"}
        if quality in PROFILES:
            self.settings["quality"] = quality
        self.hangup(quiet=True)
        with self.lock:
            self._gen += 1
            gen = self._gen
            self.caller = caller
            self.call_id = call_id
            st = self.directory.stations.get(call_id) or {}
            self.name = st.get("name", "")
            self.meta, self.meta_t = {}, 0.0
            self.prev_meta, self.prev_t, self.np_changed = {}, 0.0, 0.0
            self.meta_rx = self.prev_rx = self.np_rx = 0
            self.profile = PROFILES[self.settings["quality"]]
            self.hops = None
            self.retries = 0
            self.state, self.message = "searching", "looking for a path"
            self.no_listener_since = time.time()
        if call_id not in self.directory.stations:
            self.directory.add(call_id)
        self.settings["last"] = call_id
        self._save_settings()
        threading.Thread(target=self._dial, args=(gen,), name="radio-dial", daemon=True).start()
        return {"status": "success"}

    def _dial(self, gen: int) -> None:
        dh = RNS.Destination.hash_from_name_and_identity("lxst.telephony", bytes.fromhex(self.call_id))
        why = None
        for i in range(DIAL_TRIES):
            why = self._attempt(gen, dh, fresh=i > 0)
            if why in (None, "ok", "rejected"):
                return
        # also on the first Play: a new station's path often comes only on a later try
        self._schedule_retry(gen, why)

    def _attempt(self, gen: int, dh: bytes, fresh: bool) -> Optional[str]:
        """One try: path (a fresh one if asked) + call. Returns ok, rejected, a failure reason, or None if cancelled."""
        if fresh:
            self.state, self.message = "searching", "asking for a fresh path"
            _drop_path(dh)
        if not RNS.Transport.has_path(dh):
            RNS.Transport.request_path(dh)
            t = time.time()
            while not RNS.Transport.has_path(dh) and time.time() - t < PATH_WAIT:
                if gen != self._gen:
                    return None
                time.sleep(0.25)
        remote = rnsquiet.recall(dh)
        if gen != self._gen:
            return None
        if not remote:
            return "no path to the station"
        try:
            self.hops = RNS.Transport.hops_to(dh) if RNS.Transport.has_path(dh) else None
        except Exception:
            self.hops = None
        self.state, self.message = "connecting", ""
        self.no_listener_since = time.time()  # browsers left during a retry: give them time to come back
        dest = RNS.Destination(remote, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxst", "telephony")
        self.bytes = self.frames = 0
        link = RNS.Link(dest, closed_callback=lambda l: self._closed(gen, l))
        link.set_packet_callback(lambda data, packet: self._packet(link, data, gen))
        self.link = link
        t = time.time()
        while gen == self._gen and self.state in ("connecting", "ringing") and time.time() - t < ANSWER_WAIT \
                and link.status != RNS.Link.CLOSED:
            time.sleep(0.2)
        if gen != self._gen:
            return None
        if self.state == "playing":
            return "ok"
        if self.state == "failed":
            return "rejected"
        self.link = None
        try:
            link.teardown()
        except Exception:
            pass
        return "no answer"

    def _signal(self, link, signals) -> None:
        RNS.Packet(link, mp.packb({FIELD_SIGNALLING: signals}), create_receipt=False).send()

    def _packet(self, link, data, gen: int) -> None:
        if gen != self._gen:
            return
        try:
            msg = mp.unpackb(data)
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        sig = msg.get(FIELD_SIGNALLING)
        for s in sig if isinstance(sig, list) else []:
            if s == STATUS_AVAILABLE:
                link.identify(self.caller)
            elif s == STATUS_RINGING:
                self.state, self.message = "ringing", ""
                self._signal(link, [PREFERRED_PROFILE + self.profile, PREFERRED_MODE + MODE_HALF_DUPLEX])
            elif s == STATUS_ESTABLISHED:
                self.state, self.message = "playing", ""
                self.started = self.last_audio = self.no_listener_since = time.time()
                self._log(f"📻 Radio: tuned in to {self.name or self.call_id}")
                threading.Thread(target=self._watch, args=(gen, link, self._send_name(link)),
                                 name="radio-watch", daemon=True).start()
            elif s == STATUS_BUSY:
                m = self.meta or {}
                full = f" ({m['l']}/{m['s']})" if m.get("s") and m.get("l") is not None else ""
                self._fail(gen, f"station full{full}, try later")
            elif s == STATUS_REJECTED:
                self._fail(gen, "station off air")
        meta = msg.get(FIELD_META)
        if isinstance(meta, dict):
            now = time.time()
            if meta.get("np") != self.meta.get("np"):
                # the old track is still heard until the browser buffer plays out: the tab picks which one to show
                self.prev_meta, self.prev_t, self.np_changed = self.meta, self.meta_t, now
                self.prev_rx, self.np_rx = self.meta_rx, self.received_samples
            self.meta, self.meta_t, self.meta_rx = meta, now, self.received_samples
            if meta.get("n"):
                self.name = str(meta["n"])[:48]
            if self.directory is not None:
                self.directory.update(self.call_id, name=self.name, listeners=meta.get("l"),
                                      now_playing=str(meta.get("np") or "")[:64], on_air=bool(meta.get("air", True)),
                                      heard=time.time())
        frames = msg.get(FIELD_FRAMES)
        if frames is None:
            return
        for f in frames if isinstance(frames, list) else [frames]:
            if not f or f[0] != 0x01:
                continue        # Opus only (Codec2 = a voice phone on LoRa: not for a browser)
            self._audio(bytes(f[1:]))
            self.last_audio = time.time()
            self.frames += 1
            self.bytes += len(data)

    def _audio(self, packet: bytes) -> None:
        n = opus_samples(packet)
        if not n:
            return
        with self.lock:
            self.backlog.append((n, packet))
            self.backlog_samples += n
            self.received_samples += n
            while self.backlog_samples > BACKLOG_S * 48000 and len(self.backlog) > 1:
                self.backlog_samples -= self.backlog.popleft()[0]
            for q in self.listeners:
                try:
                    q.put_nowait(packet)
                except queue.Full:
                    pass

    def _closed(self, gen: int, link) -> None:
        if gen != self._gen or link is not self.link or self.state != "playing":
            return  # while connecting, _attempt sees the closed link
        if link.teardown_reason == RNS.Link.TIMEOUT:
            self._log("📻 Radio: lost the station (network)")
            self._schedule_retry(gen, "lost the station", link)
            return
        self.state, self.message = "ended", "the station hung up"
        self._log("📻 Radio: the station closed the call")
        if self.directory is not None:
            self.directory.update(self.call_id, on_air=False, listeners=0, now_playing="offline")
        self._end_audio()

    def _watch(self, gen: int, link, sent: str = "") -> None:
        while gen == self._gen and self.link is link and self.state == "playing":
            time.sleep(1)
            if self.listener_name() != sent:
                sent = self._send_name(link)   # renamed in the messenger: the station hears it now
            now = time.time()
            if self.retries and now - self.started > STEADY_S:
                self.retries = 0
            if now - self.last_audio > NO_AUDIO_S and gen == self._gen and self.link is link:
                self._log(f"📻 Radio: no audio for {NO_AUDIO_S} s")
                self._schedule_retry(gen, "no audio from the station", link)
                return

    def _schedule_retry(self, gen: int, why: str, dropped=None) -> None:
        """After a failed dial or a drop while playing: try again with growing pauses, then give up."""
        with self._retry_lock:
            if gen != self._gen or (dropped is not None and dropped is not self.link):
                return  # cancelled, or this drop is already being handled
            if self.retries >= len(RETRY_WAITS):
                self._fail(gen, f"{why}, gave up after {len(RETRY_WAITS)} retries")
                return
            wait = RETRY_WAITS[self.retries]
            self.retries += 1
            link, self.link = self.link, None
            self.state = "retrying"
        if link:
            try:
                link.teardown()
            except Exception:
                pass
        self._end_audio()
        self._log(f"📻 Radio: {why}, retry {self.retries}/{len(RETRY_WAITS)} in {wait} s")
        threading.Thread(target=self._retry, args=(gen, wait), name="radio-retry", daemon=True).start()

    def _retry(self, gen: int, wait: float) -> None:
        end = time.time() + wait
        while time.time() < end:
            if gen != self._gen:
                return
            self.message = f"retry {self.retries}/{len(RETRY_WAITS)} in {end - time.time():.0f} s"
            time.sleep(0.5)
        if gen != self._gen:
            return
        self.state, self.message = "searching", f"retry {self.retries}/{len(RETRY_WAITS)}"
        self._dial(gen)

    def _fail(self, gen: int, why: str) -> None:
        if gen != self._gen:
            return
        self.state, self.message = "failed", why
        self._log(f"📻 Radio: {why}")
        link, self.link = self.link, None
        if link:
            try:
                link.teardown()
            except Exception:
                pass
        self._end_audio()

    def _end_audio(self) -> None:
        with self.lock:
            self.backlog.clear()
            self.backlog_samples = self.received_samples = 0
            for q in self.listeners:
                try:
                    q.put_nowait(None)
                except queue.Full:
                    pass

    def hangup(self, quiet: bool = False) -> Dict[str, Any]:
        with self.lock:
            self._gen += 1
            link, self.link = self.link, None
        if link:
            try:
                link.teardown()
            except Exception:
                pass
        self._end_audio()
        if self.state not in ("idle", "failed") or not quiet:
            self.state, self.message = "idle", ""
        self.started = 0.0
        return {"status": "success"}

    # the stream for the browsers
    def stream(self, token: str = ""):
        """Ogg Opus bytes for one <audio> element, until the call ends or it goes away."""
        gen = self._gen
        t = time.time()
        while gen == self._gen and self.state in ("searching", "connecting", "ringing", "playing", "retrying") \
                and self.received_samples < PREFILL_S * 48000 and time.time() - t < 60:
            time.sleep(0.1)
        q: queue.Queue = queue.Queue(maxsize=400)
        with self.lock:
            if gen != self._gen or self.state != "playing":
                return
            for _, p in self.backlog:
                q.put_nowait(p)
            self.listeners.append(q)
            if token:  # where this stream starts in the call audio: its currentTime 0
                self.stream_bases[token[:32]] = self.received_samples - self.backlog_samples
                while len(self.stream_bases) > 8:
                    self.stream_bases.pop(next(iter(self.stream_bases)))
        ogg = OggWriter()
        try:
            yield ogg.headers()
            while True:
                try:
                    p = q.get(timeout=20)
                except queue.Empty:
                    if gen != self._gen:
                        break
                    continue
                if p is None or gen != self._gen:
                    break
                yield ogg.audio(p)
        finally:
            with self.lock:
                if q in self.listeners:
                    self.listeners.remove(q)
                if not self.listeners:
                    self.no_listener_since = time.time()

    def idle_check(self) -> None:
        # nobody listening in a browser: the call costs the station bandwidth for nothing
        if self.state in ("playing", "connecting", "ringing") and not self.listeners \
                and time.time() - self.no_listener_since > IDLE_HANGUP_S:
            self._log("📻 Radio: no browser listening, hung up")
            self.hangup()

    def _identities(self) -> List[Dict[str, str]]:
        if self.gid is not None:
            me = self.identity
            return [{"id": GUEST_ID, "name": self.identity_name(), "hash": me.hash.hex()}] if me else []
        ids, out = self.browser.identities, []
        for profile in ids.state.get("profiles", []):
            identity = ids.identity_for(profile["id"])
            if identity is not None:
                out.append({"id": profile["id"], "name": profile["name"], "hash": identity.hash.hex()})
        return out

    @staticmethod
    def _track_info(meta: Dict[str, Any], meta_t: float, rx: int) -> Dict[str, Any]:
        # tp/td = track position/length at the station when the meta came (age seconds ago,
        # at = seconds of call audio received by then), sn = stream name
        out = {"np": str(meta.get("np") or "")[:64], "sn": str(meta.get("sn") or "").strip()[:64],
               "age": round(time.time() - meta_t, 2) if meta_t else 0, "at": rx / 48000}
        try:
            out["tp"], out["td"] = float(meta["tp"]), float(meta["td"])
        except (KeyError, TypeError, ValueError):
            pass
        return out

    # what the tab shows
    def status(self, token: str = "") -> Dict[str, Any]:
        token = token[:32]
        ready = self.start()
        self.service.viewed_at = time.time()
        el = time.time() - self.started if self.started and self.state == "playing" else 0
        me = self.identity
        return {
            "guest": self.gid is not None,
            "identity": self.settings["identity"], "identity_name": self.identity_name(),
            "identities": self._identities(),
            "status": "success", "ready": ready,
            "state": self.state, "message": self.message, "call_id": self.call_id,
            "name": self.name, "listeners": self.meta.get("l"), "track": str(self.meta.get("np") or ""),
            "now": self._track_info(self.meta, self.meta_t, self.meta_rx),
            "prev": self._track_info(self.prev_meta, self.prev_t, self.prev_rx) if self.prev_meta.get("np") else None,
            "np_at": self.np_rx / 48000,
            "stream_base": self.stream_bases[token] / 48000 if token in self.stream_bases else None,
            "np_age": round(time.time() - self.np_changed, 2) if self.np_changed else None,
            "time": el, "kbps": round(self.bytes * 8 / el / 1000, 1) if el > 1 else 0,
            "hops": self.hops, "browsers": len(self.listeners),
            "quality": self.settings["quality"], "last": self.settings["last"],
            "client_id": me.hash.hex() if me else "",
            "lxmf": lxmf_of(self.call_id or self.settings["last"]) if (self.call_id or self.settings["last"]) else "",
            "stations": self._with_subs(self.directory.listing()) if self.directory else [],
        }

    def set_quality(self, quality: str) -> Dict[str, Any]:
        if quality not in PROFILES:
            return {"status": "error", "error": "Unknown quality"}
        self.settings["quality"] = quality
        self._save_settings()
        link = self.link
        if self.state == "playing" and link is not None and link.status == RNS.Link.ACTIVE:
            # the station switches codec on the open call, as it reads the same signal at ringing
            self.profile = PROFILES[quality]
            try:
                self._signal(link, [PREFERRED_PROFILE + self.profile])
                self._log(f"📻 Radio: quality {quality} asked to the station")
            except Exception:
                pass
        return {"status": "success"}

    # station commands: LXMF from the radio identity, through the messenger (the chat stays there too)
    def _cmd_listener(self):
        m = getattr(self.browser, "messenger", None)
        me = self.identity
        if m is None or me is None:
            return None, "The messenger is off"
        listener = m.listeners.get(RNS.Destination.hash(me, "lxmf", "delivery").hex())
        if listener is None:
            return None, ("Guests cannot send messages on this rBrowser" if self.gid is not None
                          else "Turn on the LXMF Messenger to send commands")
        return listener, ""

    def _with_subs(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Each station: are we (the radio identity) subscribed to it."""
        listener, _ = self._cmd_listener()
        for s in rows:
            s["subscribed"] = bool(listener and s.get("lxmf") and
                                   subscription(listener.store.messages(s["lxmf"])))
        return rows

    def send_command(self, call_id: str, cmd: str) -> Dict[str, Any]:
        cmd = (cmd or "").strip().lower()
        if cmd not in COMMANDS:
            return {"status": "error", "error": "Unknown command"}
        try:
            address = RNS.Destination.hash_from_name_and_identity("lxmf.delivery", bytes.fromhex(call_id)).hex()
        except ValueError:
            return {"status": "error", "error": "A Call ID is 32 hex characters"}
        listener, why = self._cmd_listener()
        if listener is None:
            return {"status": "error", "error": why}
        res = self.browser.messenger.send(address, cmd, via=listener)
        if res.get("status") == "success":
            self._log(f"📻 Radio: command '{cmd}' sent to {call_id}")
        return res

    def commands(self, call_id: str) -> Dict[str, Any]:
        """The conversation with a station's LXMF address, as seen by the radio identity."""
        try:
            address = RNS.Destination.hash_from_name_and_identity("lxmf.delivery", bytes.fromhex(call_id)).hex()
        except ValueError:
            return {"status": "error", "error": "A Call ID is 32 hex characters"}
        listener, why = self._cmd_listener()
        if listener is None:
            return {"status": "success", "available": False, "why": why, "messages": []}
        rows = []
        every = listener.store.messages(address)
        for m in every[-COMMANDS_SHOWN:]:
            rows.append({"dir": m.get("dir"), "text": str(m.get("content") or "")[:2000], "ts": m.get("ts"),
                         "state": m.get("state") or "", "error": m.get("error") or ""})
        listener.store.mark_read(address)
        self.browser.messenger.revision += 1
        return {"status": "success", "available": True, "address": address, "from": listener.address,
                "messages": rows, "subscribed": subscription(every)}


class RadioService:
    """The station list (one announce handler) and the calls: the owner's, one per guest session."""

    def __init__(self, browser):
        self.browser = browser
        self.lock = threading.Lock()
        self.directory: Optional[Directory] = None
        self.owner = Radio(self)
        self.guests: Dict[str, Radio] = {}
        self.viewed_at = 0.0

    def start(self) -> bool:
        """Listen for stations: the first time a Radio tab asks for anything."""
        if self.directory is not None:
            return True
        if not getattr(self.browser, "reticulum_ready", False):
            return False
        with self.lock:
            if self.directory is not None:
                return True
            os.makedirs(RADIO_DIR, exist_ok=True)
            self.directory = Directory()
            RNS.Transport.register_announce_handler(self.directory)
        threading.Thread(target=self._watchdog, name="radio-watchdog", daemon=True).start()
        _log("📻 Radio client on: listening for radio-lxst stations")
        return True

    def view(self) -> Radio:
        """The call of whoever is asking: a guest request gets its session's own."""
        if not guest_view():
            return self.owner
        gid = guest_current()
        with self.lock:
            radio = self.guests.get(gid)
            if radio is None:
                radio = self.guests[gid] = Radio(self, gid)
            return radio

    def close_guests(self, gid: Optional[str] = None) -> int:
        with self.lock:
            if gid is None:
                gone = list(self.guests.values())
                self.guests.clear()
            else:
                gone = [self.guests.pop(gid)] if gid in self.guests else []
        for radio in gone:
            radio.hangup()
        return len(gone)

    def in_use_by_owner(self) -> Optional[str]:
        """The owner's identity while a call is on (the "Used in" badges)."""
        return self.owner.settings["identity"] if self.owner.live() else None

    def _playing(self) -> set:
        # the stations we listen to tell their state inside the call
        return {r.call_id for r in [self.owner] + list(self.guests.values()) if r.call_id and r.state == "playing"}

    def refresh(self) -> Dict[str, Any]:
        if self.directory is not None:
            self.directory.refresh(self._playing())
        return {"status": "success"}

    def _watchdog(self) -> None:
        while True:
            time.sleep(5)
            if self.directory is not None and time.time() - self.viewed_at < VIEW_GRACE:
                try:
                    self.directory.poll(self._playing())
                except Exception:
                    pass
            for radio in [self.owner] + list(self.guests.values()):
                try:
                    radio.idle_check()
                except Exception:
                    pass

    # what the routes call: on the asker's own call
    def status(self, token: str = "") -> Dict[str, Any]:
        return self.view().status(token)

    def tune(self, call_id: str, quality: Optional[str] = None) -> Dict[str, Any]:
        return self.view().tune(call_id, quality)

    def hangup(self) -> Dict[str, Any]:
        return self.view().hangup()

    def set_quality(self, quality: str) -> Dict[str, Any]:
        return self.view().set_quality(quality)

    def set_identity(self, profile_id: str) -> Dict[str, Any]:
        return self.view().set_identity(profile_id)

    def stream(self, token: str = ""):
        return self.view().stream(token)

    def send_command(self, call_id: str, cmd: str) -> Dict[str, Any]:
        return self.view().send_command(call_id, cmd)

    def commands(self, call_id: str) -> Dict[str, Any]:
        return self.view().commands(call_id)
