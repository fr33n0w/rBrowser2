"""
The LXMF messenger: rBrowser as an LXMF client, next to the NomadNet browser.

Everything that goes on the wire is done by the reference stack: an
LXMF.LXMRouter sends, receives, announces, retries, computes the stamps a
recipient asks for and keeps the delivery receipts. This module only picks
the identity, keeps the conversations and holds a few limits of our own.

Identity
--------
LXMF knows you by an identity, and an LXMF address is that identity's
"lxmf.delivery" destination. The messenger uses a saved profile (the same
list as the browser's, chosen separately here) or, when allowed in Advanced,
the ephemeral identity - which changes at restart, reload or on a timer, and
replies sent to it after a change are lost. The messenger follows whichever
identity it should be on, once a second.

One LXMRouter carries one delivery identity, and a router can only be
created on the main thread (it installs signal handlers), so there is one
router for the life of the process and the identity on it is swapped:
the old delivery destination is deregistered, the new one registered.

Announces
---------
Through LXMRouter.announce(), so the app data is LXMF's own. Automatic ones
(at start, and every N minutes, never under 20 - our limit, not RNS's) are
for saved profiles only: an ephemeral identity that announced at every
change would only be noise. It can be announced by hand.

Stamps asked of senders
-----------------------
As NomadNet's required_stamp_cost: a cost set in Settings goes in our
announce (LXMF's app data), senders' LXMF computes the stamp, and with
enforce_stamps on LXMF drops messages without a valid one. Whoever we write
to gets a ticket (include_ticket) and can answer without a stamp. Saved
identities only; changing the cost announces at once.

Files
-----
In the fields Sideband and MeshChat use: FIELD_IMAGE [format, bytes] for one
image, FIELD_FILE_ATTACHMENTS [[name, bytes], ...] for the rest. A message
bigger than a packet goes as an RNS Resource over the link - split,
compressed and put back together by RNS, as NomadNet downloads are. At most
10 MB and 10 files a message. Received files land in downloads/<contact>/
with their own names; our own sent files are kept as a copy (for the chat
and Retry) in settings/messenger/files/. The ephemeral identity keeps both
in memory only. Voice messages (FIELD_AUDIO): Opus/Ogg kept as it is, Codec2
made into a WAV (pycodec2 or ffmpeg); both play in the chat.

Storage
-------
    settings/messenger.json                     the settings
    settings/messenger/lxmf/                    LXMRouter's own state
    settings/messenger/conversations/<identity hash>/<peer address>.json
    settings/messenger/files/<identity hash>/<peer>/<local id>-<n>   sent files
    downloads/<contact>/<file name>                                   received files

One JSON file per conversation, written to a temporary file and renamed.
Conversations of the ephemeral identity are kept in memory only.

Limits of our own
-----------------
One recipient per message, nothing sent to lists. With the ephemeral
identity at most one message every 10 s and 20 an hour.

Propagation nodes
-----------------
As NomadNet does: when direct delivery fails, the message is handed to the
propagation node instead (LXMessage.PROPAGATED, with the propagation stamp
LXMF computes), and the node keeps it until the recipient syncs. Our own
messages waiting on a node are collected with a sync: by hand, and every
360 minutes for saved profiles (NomadNet's lxmf_sync_interval). The node is
the nearest active one heard (propagation.py) or one chosen in Settings.
"""

from __future__ import annotations

import atexit
import json
import os
import re
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional

import RNS
from . import rnsquiet

from .identities import DEFAULT_ID, EPHEMERAL

SETTINGS_FILE = os.path.join("settings", "messenger.json")
STORE_DIR = os.path.join("settings", "messenger")
DOWNLOADS_DIR = "downloads"             # files received, one folder per contact

ANNOUNCE_MIN_MINUTES = 20
ANNOUNCE_DEFAULT_MINUTES = 60           # a new user is heard within the hour, named or not
ANNOUNCE_GAP = 3                        # s between the identities announced on going online
ANNOUNCE_CHOICES = (20, 30, 60, 120, 360, 720, 1440)
MANUAL_ANNOUNCE_GAP = 60                # the Announce button, at most once a minute

MAX_CONTENT = 16 * 1024
MAX_TITLE = 200
EPHEMERAL_GAP = 10                      # seconds between two messages
EPHEMERAL_PER_HOUR = 20
IDENTITY_WAIT = 30                      # asking the network for an unknown recipient
PATH_WAIT = 20                          # asking the network for a path before a direct send

PROPAGATION_MODES = ("auto", "manual", "off")
SYNC_DEFAULT_MINUTES = 360              # NomadNet's lxmf_sync_interval
SYNC_CHOICES = (10, 15, 30, 60, 120, 360, 720, 1440)
SYNC_MIN_MINUTES = 10
SYNC_START_DELAY = 30                   # after start, let paths come in first
MANUAL_SYNC_GAP = 15                    # the Sync now button
PN_FAIL_COOLDOWN = 30 * 60              # a node that did not answer is passed over this long
PN_SYNC_TRIES = 3                       # nodes tried in one sync
PN_ROTATE_CHOICES = (0, 1, 6, 12, 24)   # hours; 0 = never

# Stamp asked of whoever writes to us (LXMF's inbound stamp cost): 0 = off.
# NomadNet: "a stamp cost of 8 will take less than a second to compute".
STAMP_CHOICES = (0, 8, 12, 16, 20, 24)
STAMP_MAX = 254                         # LXMRouter.set_inbound_stamp_cost

# Attachments, in the fields Sideband and MeshChat use: FIELD_IMAGE is
# [format, bytes] (one image), FIELD_FILE_ATTACHMENTS [[name, bytes], ...].
# LXMF sends a big message as an RNS Resource over the link on its own.
MAX_ATTACH_BYTES = 10 * 1024 * 1024
MAX_ATTACH_FILES = 10
PN_TYPICAL_LIMIT = 256 * 1024           # lxmd's default per-transfer limit
IMAGE_TYPES = {"webp": "image/webp", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
               "gif": "image/gif", "bmp": "image/bmp"}

_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_LOCAL_ID = re.compile(r"^[0-9a-f]{16}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")      # an LXMessage hash


def safe_filename(name: Any, fallback: str = "file") -> str:
    """A name to show and to offer when saving: no folders, no control
    characters, not too long. Never used as a path here."""
    text = os.path.basename(str(name or "").replace("\\", "/"))
    text = "".join(ch for ch in text if ch.isprintable() and ch not in '<>:"/\\|?*').strip(" .")
    return (text or fallback)[:120]


MAX_NICKNAME = 48
MAX_REACTION = 32                       # bytes: an emoji, or a few
QUICK_REACTIONS = ("👍", "❤️", "😂", "😮", "😢", "🙏")


REPLY_QUOTE_MAX = 300


def quote_of(message: Dict[str, Any]) -> str:
    """What a reply quotes of a message: its text, else its files' names."""
    text = " ".join(str(message.get("content", "")).split())
    if not text and message.get("files"):
        text = ", ".join(f.get("name", "") for f in message["files"])
    return text[:REPLY_QUOTE_MAX]


def clean_nickname(value: Any) -> str:
    return " ".join(str(value or "").split())[:MAX_NICKNAME]


def clean_display_name(value: Any) -> str:
    return " ".join(str(value or "").split())[:64]


def ephemeral_default_name(address: str) -> str:
    """The name of an ephemeral identity nobody renamed: eph_ + 4 hex."""
    return f"eph_{address[:4]}" if address else ""


def clean_reaction(value: Any) -> Optional[str]:
    """One short reaction, or "" to take ours back; None if unusable."""
    text = str(value or "").strip()
    if not text:
        return ""
    import unicodedata
    # Control characters and line breaks out; joiners (ZWJ emoji) stay.
    if len(text.encode("utf-8")) > MAX_REACTION or any(
            unicodedata.category(ch) in ("Cc", "Zl", "Zp") for ch in text):
        return None
    return text


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


# Audio files: a player in the chat. mimetypes does not know all of these on
# every system (.opus on Windows).
AUDIO_TYPES = {"ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav",
               "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "flac": "audio/flac",
               "weba": "audio/webm"}

# FIELD_AUDIO [mode, bytes] (Sideband's voice messages): Opus in an Ogg file,
# played as it is, or raw Codec2 frames at 8 kHz, made into a WAV here.
CODEC2_MODES = {0x03: "700C", 0x04: "1200", 0x05: "1300", 0x06: "1400", 0x07: "1600",
                0x08: "2400", 0x09: "3200"}
AM_OPUS_OGG = 0x10


def _wav(pcm: bytes, rate: int = 8000) -> bytes:
    import io
    import wave
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def codec2_to_wav(data: bytes, mode: int) -> Optional[bytes]:
    """Raw Codec2 frames to a WAV: pycodec2 (libcodec2) if it loads, else
    ffmpeg (its libcodec2 decoder), as Sideband does it. None if neither."""
    name = CODEC2_MODES.get(mode)
    if not name or not data:
        return None
    try:
        import struct
        import pycodec2
        c2 = pycodec2.Codec2(int(name.rstrip("C")))
        spf, bpf = c2.samples_per_frame(), c2.bytes_per_frame()
        pcm = b"".join(struct.pack(f"{spf}h", *c2.decode(data[i:i + bpf]))
                       for i in range(0, len(data) - bpf + 1, bpf))
        return _wav(pcm)
    except Exception:
        pass
    import shutil
    import subprocess
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    try:
        proc = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "codec2raw", "-mode", name,
                               "-i", "pipe:0", "-ac", "1", "-ar", "8000", "-f", "wav", "pipe:1"],
                              input=data, capture_output=True, timeout=60,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return proc.stdout if proc.returncode == 0 and proc.stdout[:4] == b"RIFF" else None
    except (OSError, subprocess.SubprocessError):
        return None


def clean_address(value: Any) -> Optional[str]:
    text = str(value or "").replace("<", "").replace(">", "").replace(":", "").strip().lower()
    return text if _HEX32.match(text) else None


def _atomic_write(path: str, data: Any) -> None:
    from .fileio import atomic_write_json
    atomic_write_json(path, data, indent=1, ensure_ascii=False)


class Conversations:
    """
    The conversations of one identity. On disk for a saved profile, in
    memory for the ephemeral one.
    """

    def __init__(self, identity_hash: str, on_disk: bool) -> None:
        self.identity_hash = identity_hash
        self.on_disk = on_disk
        self.dir = os.path.join(STORE_DIR, "conversations", identity_hash)
        # Attachments: <files_dir>/<peer>/<local_id>-<n>, the name and type
        # in the message's "files". In memory for the ephemeral identity.
        self.files_dir = os.path.join(STORE_DIR, "files", identity_hash)
        self.memory_files: Dict[str, bytes] = {}
        self.lock = threading.RLock()
        self.data: Dict[str, Dict[str, Any]] = {}
        if on_disk:
            self._load()

    def put_file(self, peer: str, local_id: str, index: int, data: bytes) -> None:
        key = f"{local_id}-{index}"
        if not self.on_disk:
            self.memory_files[f"{peer}/{key}"] = data
            return
        folder = os.path.join(self.files_dir, peer)
        os.makedirs(folder, exist_ok=True)
        tmp = os.path.join(folder, f"{key}.tmp{os.getpid()}")
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, os.path.join(folder, key))

    def get_file(self, peer: str, local_id: str, index: int) -> Optional[bytes]:
        key = f"{local_id}-{index}"
        if not self.on_disk:
            return self.memory_files.get(f"{peer}/{key}")
        try:
            with open(os.path.join(self.files_dir, peer, key), "rb") as handle:
                return handle.read()
        except OSError:
            return None

    def persist(self) -> None:
        """From memory to disk: the ephemeral identity kept as a profile."""
        with self.lock:
            self.on_disk = True
            for key, data in list(self.memory_files.items()):
                peer, name = key.split("/", 1)
                local_id, _, index = name.rpartition("-")
                self.put_file(peer, local_id, int(index), data)
            self.memory_files.clear()
            for peer in list(self.data):
                self._save(peer)

    def _drop_files(self, peer: str) -> None:
        for key in [k for k in self.memory_files if k.startswith(peer + "/")]:
            self.memory_files.pop(key, None)
        folder = os.path.join(self.files_dir, peer)
        if self.on_disk and os.path.isdir(folder):
            import shutil
            shutil.rmtree(folder, ignore_errors=True)

    def _load(self) -> None:
        if not os.path.isdir(self.dir):
            return
        for name in os.listdir(self.dir):
            peer = clean_address(name[:-5]) if name.endswith(".json") else None
            if not peer:
                continue
            try:
                with open(os.path.join(self.dir, name), "r", encoding="utf-8") as handle:
                    conv = json.load(handle)
                if isinstance(conv, dict) and isinstance(conv.get("messages"), list):
                    conv["peer"] = peer
                    self.data[peer] = conv
            except (OSError, json.JSONDecodeError) as exc:
                print(f"⚠️ Ignoring unreadable conversation {name}: {exc}")

    def _save(self, peer: str) -> None:
        if not self.on_disk:
            return
        conv = self.data.get(peer)
        path = os.path.join(self.dir, peer + ".json")
        try:
            if conv is None:
                if os.path.exists(path):
                    os.remove(path)
            else:
                _atomic_write(path, conv)
        except OSError as exc:
            print(f"⚠️ Could not save the conversation with {peer[:16]}: {exc}")

    def conversation(self, peer: str) -> Dict[str, Any]:
        conv = self.data.get(peer)
        if conv is None:
            conv = {"peer": peer, "name": "", "unread": 0, "updated": time.time(), "messages": []}
            self.data[peer] = conv
        return conv

    def add(self, peer: str, message: Dict[str, Any], name: str = "", unread: bool = False) -> None:
        with self.lock:
            conv = self.conversation(peer)
            if any(m.get("id") == message.get("id") for m in conv["messages"] if message.get("id")):
                return
            conv["messages"].append(message)
            conv["updated"] = message.get("ts", time.time())
            if name:
                conv["name"] = name
            if unread:
                conv["unread"] = int(conv.get("unread", 0)) + 1
            self._save(peer)

    def set_reaction(self, peer: str, message_id: str, who: str, content: str) -> bool:
        """who: "me" or "peer"; an empty content removes it."""
        with self.lock:
            conv = self.data.get(peer)
            target = next((m for m in conv["messages"] if m.get("id") == message_id), None) if conv else None
            if target is None:
                return False
            reactions = dict(target.get("reactions") or {})
            if content:
                reactions[who] = content
            else:
                reactions.pop(who, None)
            target["reactions"] = reactions
            self._save(peer)
            return True

    def find_id(self, peer: str, message_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            conv = self.data.get(peer)
            return next((m for m in conv["messages"] if m.get("id") == message_id), None) if conv else None

    def has_id(self, peer: str, message_id: str) -> bool:
        with self.lock:
            conv = self.data.get(peer)
            return bool(conv) and any(m.get("id") == message_id for m in conv["messages"])

    def has_same(self, peer: str, ts: float, content: str, title: str) -> bool:
        """The same message sent again by the peer's client, with another
        hash (other fields) but the same time and text: a copy, not new."""
        with self.lock:
            conv = self.data.get(peer)
            return bool(conv) and any(m.get("dir") == "in" and m.get("ts") == ts and m.get("content") == content
                                      and m.get("title", "") == title for m in conv["messages"])

    def update(self, peer: str, local_id: str, **fields: Any) -> bool:
        with self.lock:
            conv = self.data.get(peer)
            if not conv:
                return False
            for message in conv["messages"]:
                if message.get("local_id") == local_id:
                    message.update(fields)
                    self._save(peer)
                    return True
            return False

    def set_name(self, peer: str, name: str) -> None:
        with self.lock:
            conv = self.data.get(peer)
            if conv is not None and name and conv.get("name") != name:
                conv["name"] = name
                self._save(peer)

    def mark_read(self, peer: str) -> None:
        with self.lock:
            conv = self.data.get(peer)
            if conv and conv.get("unread"):
                conv["unread"] = 0
                self._save(peer)

    def delete(self, peer: str) -> bool:
        with self.lock:
            if self.data.pop(peer, None) is None:
                return False
            self._save(peer)
            self._drop_files(peer)
            return True

    def clear(self, peer: str) -> bool:
        """The messages and their files go, the contact stays in the list."""
        with self.lock:
            conv = self.data.get(peer)
            if conv is None:
                return False
            conv["messages"] = []
            conv["unread"] = 0
            self._save(peer)
            self._drop_files(peer)
            return True

    def listing(self) -> List[Dict[str, Any]]:
        with self.lock:
            rows = []
            for peer, conv in self.data.items():
                last = conv["messages"][-1] if conv["messages"] else {}
                preview = str(last.get("content", "")).strip()
                if not preview and last.get("files"):
                    first = last["files"][0]
                    preview = ("🖼 " if first.get("kind") == "image" else "📎 ") + first.get("name", "")
                    if len(last["files"]) > 1:
                        preview += f" +{len(last['files']) - 1}"
                rows.append({
                    "peer": peer,
                    "name": conv.get("name", ""),
                    "unread": int(conv.get("unread", 0)),
                    "updated": conv.get("updated", 0),
                    "started": conv["messages"][0].get("ts", 0) if conv["messages"] else 0,
                    "last": {"dir": last.get("dir"), "content": preview[:120],
                             "state": last.get("state"), "ts": last.get("ts")} if last else None,
                })
            rows.sort(key=lambda r: r["updated"] or 0, reverse=True)
            return rows

    def messages(self, peer: str) -> List[Dict[str, Any]]:
        with self.lock:
            conv = self.data.get(peer)
            return [dict(m) for m in conv["messages"]] if conv else []

    def unread_total(self) -> int:
        with self.lock:
            return sum(int(c.get("unread", 0)) for c in self.data.values())


class Listener:
    """One identity the messenger listens on: every saved one at once, and
    the ephemeral one while it is the identity chosen. The one chosen in
    "Write as" is only the one we write with and look at."""

    def __init__(self, profile_id: str, identity: Any, destination: Any, store: "Conversations",
                 ephemeral: bool, ratchet: Optional[str] = None) -> None:
        self.id = profile_id
        self.identity = identity
        self.destination = destination
        self.store = store
        self.ephemeral = ephemeral
        self.ratchet = ratchet
        self.address = destination.hash.hex()


class _DeliveryDestinations(dict):
    """LXMRouter.delivery_destinations. LXMF keeps its delivery identities in
    this dict and serves all of them (delivery, announces, stamps, the
    propagation node all look up by hash), but register_delivery_identity
    refuses a second one by checking len() first. While we register, len()
    says empty; the dict itself never changes hands, so a message arriving
    at that moment still finds its identity."""
    registering = False

    def __len__(self) -> int:
        return 0 if self.registering else dict.__len__(self)


class Messenger:
    """The LXMF client. See the module docstring."""

    DEFAULTS: Dict[str, Any] = {
        # Off for a new user, who switches it on after setting it up. Then
        # no announce at start: the periodic one comes after an hour, time
        # enough to choose a name (else it goes unnamed, as other clients do).
        "enabled": False,
        "identity": DEFAULT_ID,          # a profile id, or "ephemeral"
        # The saved profile last chosen here: where the messenger goes back
        # to when ephemeral messages are switched off, never silently to
        # another identity.
        "fixed_identity": DEFAULT_ID,
        # Old single name, kept only to move it to display_names; the page
        # still sends "display_name" for the identity chosen in Settings.
        "display_name": "",
        # Name in announces, one per identity: {profile id: name}, and for
        # the ephemeral identity {"ephemeral:<lxmf address>": name} (it
        # changes, so does the key). Ephemeral without one: eph_<4 hex>.
        "display_names": {},
        "announce_at_start": False,
        "announce_periodic": True,
        "announce_minutes": ANNOUNCE_DEFAULT_MINUTES,
        # Settings > Advanced, unlocked by tapping the version seven times.
        "advanced_unlocked": False,
        "allow_ephemeral": False,
        # LXMF addresses whose messages are dropped: {address: {"name", "at"}}.
        # Applied with LXMRouter.ignore_destination, LXMF's own ignore list.
        "blocked": {},
        # Avatar colour chosen for a contact: {address: hue 0-359}. Without
        # one, the colour comes from the address (messenger.js avatarHtml).
        "colors": {},
        # Propagation node: "auto" (nearest heard), "manual" (propagation_node)
        # or "off". Fallback: a message that cannot be delivered directly is
        # left on the node.
        "propagation_mode": "auto",
        "propagation_node": "",
        "propagation_fallback": True,
        # A node that does not answer (sync failed, a message not taken) is
        # set aside for PN_FAIL_COOLDOWN and another one is used, the chosen
        # one included. Rotate: in auto, every N hours the most recently
        # heard reachable node instead of the nearest (0 = never).
        "propagation_failover": True,
        "propagation_rotate_hours": 0,
        "sync_periodic": True,
        # Offline (the bar's button): nothing heard on any identity, no
        # announce, sync or sending; the chats stay readable. Kept on restart.
        "offline": False,
        "sync_minutes": SYNC_DEFAULT_MINUTES,
        "last_sync": 0,                  # state, not set from the page
        # Stamp asked of whoever writes to us, 0 = none; carried in our
        # announce. Without a valid stamp (or a ticket we gave) a message is
        # dropped, unless enforce_stamps is off. Saved identities only.
        "stamp_cost": 0,
        "enforce_stamps": True,
        # Markdown in messages (FIELD_RENDERER): received ones marked
        # markdown are shown formatted, and ours are marked markdown.
        "markdown": True,
        # Our own names for contacts: {address: nickname}. Local only, like
        # the colours; shown instead of the announced name.
        "nicknames": {},
        # Favourite contacts, shown first in the list: {address: time added}.
        "favorites": {},
        # Add contact checks what the address is (one path request if never
        # heard) and asks before adding something that is not LXMF.
        "check_new_contacts": True,
        # Sideband's icon for a contact (FIELD_ICON_APPEARANCE in its
        # messages): {address: {"icon": name, "fg": "#rrggbb", "bg": "#rrggbb"}}.
        # Used for the avatar, before a colour picked here, while sideband_look is on.
        "appearances": {},
        "sideband_look": True,
        # Files picked, dropped or pasted in a chat go at once, without Enter.
        "autosend_files": False,
        # Images shown in the chat; off, they are listed like any other file.
        "image_previews": True,
        # Short messages in one packet, no link first (LXMF OPPORTUNISTIC);
        # LXMF itself goes by link when it does not fit, and for files.
        "opportunistic": False,
        # Every saved identity sees the contacts of the others too (the
        # messages stay with the identity they belong to).
        "share_contacts": False,
        # Automatic replies (rbrowser/autoreply.py): rules, away, echo bot.
        "autoreply_on": False,
        "autoreply_rules": "",
        "echo_on": False,
        "echo_text": "",
        "away_mode": "off",
        "away_from": "22:00",
        "away_to": "08:00",
        "away_text": "",
        "away_since": 0,                 # state: when away was switched on
    }

    def __init__(self, browser: Any) -> None:
        self.browser = browser
        self.lock = threading.RLock()
        self.settings: Dict[str, Any] = dict(self.DEFAULTS)
        self._load_settings()

        self.router = None
        self.destination = None
        self.identity_hash: Optional[str] = None
        self.using_ephemeral = False
        self.ephemeral_ratchet: Optional[str] = None
        self.store: Optional[Conversations] = None
        self.ephemeral_store: Optional[Conversations] = None
        self.last_announce = 0.0
        self.listening_since = 0.0
        self.announced_at_start = False
        self.revision = 0
        # Counts messages received, for the pop-up in the page; and the last one.
        self.incoming_seq = 0
        self.last_incoming: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None
        self._sent_times: deque = deque()
        self._last_sent = 0.0
        self._watcher_started = False
        self.identity: Optional[RNS.Identity] = None
        from .propagation import PropagationNodes
        self.pn = PropagationNodes(on_change=self._pn_heard)
        from .lxmf_peers import LxmfPeers
        self.peers = LxmfPeers(browser)
        from .autoreply import AutoReply
        self.autoreply = AutoReply()
        self._sync_state_seen = None
        self._manual_sync_at = 0.0
        # Sending progress of messages with files: {local_id: 0..1}.
        self.progress: Dict[str, float] = {}
        # Messages of ours still going out, and those cancelled by hand: a
        # cancelled one must never be retried nor left on a propagation node.
        self._outbound: Dict[str, Any] = {}
        self._cancelled: set = set()
        # Every identity listening, by LXMF address (see Listener).
        self.listeners: Dict[str, Listener] = {}
        # A sync goes through the saved identities one after the other.
        self._sync_queue: List[Any] = []
        self._sync_all: List[Any] = []
        self._sync_tries = 0
        self._pn_failed: Dict[str, float] = {}   # node -> when it did not answer
        self._rot_node: Optional[str] = None     # rotation: the node picked and when
        self._rot_at = 0.0
        self._sync_got = 0

    # ------------------------------------------------------------------ #
    # Settings                                                           #
    # ------------------------------------------------------------------ #

    def _load_settings(self) -> None:
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key in self.DEFAULTS:
                    if key in stored:
                        self.settings[key] = stored[key]
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as exc:
            print(f"⚠️ Could not read {SETTINGS_FILE}, using defaults: {exc}")
        self._repair()

    def _repair(self) -> None:
        s = self.settings
        for key in ("enabled", "announce_at_start", "announce_periodic", "advanced_unlocked", "allow_ephemeral", "offline"):
            s[key] = bool(s.get(key))
        try:
            s["announce_minutes"] = max(ANNOUNCE_MIN_MINUTES, int(s.get("announce_minutes")))
        except (TypeError, ValueError):
            s["announce_minutes"] = ANNOUNCE_DEFAULT_MINUTES
        s["display_name"] = clean_display_name(s.get("display_name"))
        names = s.get("display_names") if isinstance(s.get("display_names"), dict) else {}
        s["display_names"] = {str(k): clean_display_name(v) for k, v in names.items()
                              if isinstance(k, str) and clean_display_name(v)}
        blocked = s.get("blocked") if isinstance(s.get("blocked"), dict) else {}
        s["blocked"] = {a: (v if isinstance(v, dict) else {}) for a, v in blocked.items() if clean_address(a) == a}
        colors = s.get("colors") if isinstance(s.get("colors"), dict) else {}
        s["colors"] = {a: int(h) % 360 for a, h in colors.items()
                       if clean_address(a) == a and isinstance(h, (int, float)) and not isinstance(h, bool)}
        if not s["advanced_unlocked"]:
            s["allow_ephemeral"] = False
        if not isinstance(s.get("fixed_identity"), str) or s["fixed_identity"] == EPHEMERAL:
            s["fixed_identity"] = DEFAULT_ID
        if not isinstance(s.get("identity"), str):
            s["identity"] = s["fixed_identity"]
        if s["identity"] == EPHEMERAL and not s["allow_ephemeral"]:
            s["identity"] = s["fixed_identity"]
        if s["identity"] != EPHEMERAL:
            s["fixed_identity"] = s["identity"]
        # From the single name of before: it goes to the identity it was used with.
        if s["display_name"] and not s["display_names"]:
            s["display_names"][s["fixed_identity"]] = s["display_name"]
        s["display_name"] = ""
        if s.get("propagation_mode") not in PROPAGATION_MODES:
            s["propagation_mode"] = "auto"
        s["propagation_node"] = clean_address(s.get("propagation_node")) or ""
        if s["propagation_mode"] == "manual" and not s["propagation_node"]:
            s["propagation_mode"] = "auto"
        for key in ("propagation_fallback", "propagation_failover", "sync_periodic"):
            s[key] = bool(s.get(key))
        try:
            s["propagation_rotate_hours"] = int(s.get("propagation_rotate_hours") or 0)
        except (TypeError, ValueError):
            s["propagation_rotate_hours"] = 0
        if s["propagation_rotate_hours"] not in PN_ROTATE_CHOICES:
            s["propagation_rotate_hours"] = 0
        try:
            s["sync_minutes"] = max(SYNC_MIN_MINUTES, int(s.get("sync_minutes")))
        except (TypeError, ValueError):
            s["sync_minutes"] = SYNC_DEFAULT_MINUTES
        try:
            s["last_sync"] = float(s.get("last_sync") or 0)
        except (TypeError, ValueError):
            s["last_sync"] = 0
        try:
            s["stamp_cost"] = min(STAMP_MAX, max(0, int(s.get("stamp_cost") or 0)))
        except (TypeError, ValueError):
            s["stamp_cost"] = 0
        s["enforce_stamps"] = bool(s.get("enforce_stamps", True))
        s["markdown"] = bool(s.get("markdown", True))
        s["check_new_contacts"] = bool(s.get("check_new_contacts", True))
        s["sideband_look"] = bool(s.get("sideband_look", True))
        s["autosend_files"] = bool(s.get("autosend_files", False))
        s["image_previews"] = bool(s.get("image_previews", True))
        from . import autoreply as ar
        s["opportunistic"] = bool(s.get("opportunistic"))
        s["share_contacts"] = bool(s.get("share_contacts"))
        s["autoreply_on"] = bool(s.get("autoreply_on"))
        s["echo_on"] = bool(s.get("echo_on"))
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
        looks = s.get("appearances") if isinstance(s.get("appearances"), dict) else {}
        s["appearances"] = {a: v for a, v in looks.items() if clean_address(a) == a and isinstance(v, dict)}
        nicks = s.get("nicknames") if isinstance(s.get("nicknames"), dict) else {}
        s["nicknames"] = {a: clean_nickname(n) for a, n in nicks.items()
                          if clean_address(a) == a and clean_nickname(n)}
        favs = s.get("favorites") if isinstance(s.get("favorites"), dict) else {}
        s["favorites"] = {a: (t if isinstance(t, (int, float)) and not isinstance(t, bool) else 0)
                          for a, t in favs.items() if clean_address(a) == a}

    def _save_settings(self) -> None:
        try:
            _atomic_write(SETTINGS_FILE, self.settings)
        except OSError as exc:
            print(f"⚠️ Could not save the messenger settings: {exc}")

    def update_settings(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            # The block list has its own calls (block/unblock), and the time
            # of the last sync is ours.
            wanted = {**self.settings, **{k: incoming[k] for k in self.DEFAULTS
                                          if k in incoming and k not in ("blocked", "colors", "nicknames",
                                                                         "favorites", "appearances",
                                                                         "last_sync", "display_name",
                                                                         "display_names", "away_since")}}
            # Away switched on now: a new period, everybody is told once again.
            if wanted.get("away_mode") == "on" and self.settings.get("away_mode") != "on":
                wanted["away_since"] = time.time()
            if wanted.get("propagation_mode") == "manual" and not clean_address(wanted.get("propagation_node")):
                raise ValueError("Pick a propagation node, or paste its address (32 hex characters)")
            if "identity" in incoming and incoming["identity"] != EPHEMERAL:
                if self.browser.identities.identity_for(str(incoming["identity"])) is None:
                    raise ValueError("No such identity")
            if incoming.get("identity") == EPHEMERAL and not (wanted.get("advanced_unlocked")
                                                               and wanted.get("allow_ephemeral")):
                raise ValueError("Ephemeral identity messages are not allowed (Settings > Advanced)")
            old_offline = self.settings.get("offline")
            old_cost = self.settings.get("stamp_cost")
            old_name = self.current_display_name()
            old_identity = self.settings["identity"]
            self.settings = wanted
            self._repair()
            # Settings sends the name of the identity chosen there.
            if "display_name" in incoming:
                self._store_display_name(self.settings["identity"], incoming["display_name"])
            self._save_settings()
            if self.router is not None and self.destination is not None:
                # Another identity gets its name when _sync_identity registers it.
                if old_identity == self.settings["identity"]:
                    self.destination.display_name = self.current_display_name() or None
                    # The name travels in announces only: a new one goes out now
                    # (a new stamp cost announces below anyway).
                    if (old_name != self.current_display_name() and not self.using_ephemeral
                            and old_cost == self.settings["stamp_cost"]):
                        self._announce()
                self._apply_stamps()
                # Senders learn the cost from our announce: tell them now.
                if old_cost != self.settings["stamp_cost"] and not self.using_ephemeral:
                    self._announce()
            self._apply_propagation()
            if old_offline != self.settings["offline"]:
                self._apply_offline(announce=True)
            self.revision += 1
        if self.settings["enabled"]:
            self.request_start()
        else:
            self.stop()
        return self.status()

    # ------------------------------------------------------------------ #
    # Starting, stopping, the identity on the router                     #
    # ------------------------------------------------------------------ #

    def start_on_main_thread(self) -> None:
        """Called by the main thread once Reticulum is up, and for a start
        asked for from the settings (request_start)."""
        if not self.settings["enabled"] or not getattr(self.browser, "reticulum_ready", False):
            return
        with self.lock:
            if self.router is None:
                try:
                    import LXMF
                    # The router's own identity only names its (unused)
                    # propagation destination: a fresh one, tied to nobody.
                    self.router = LXMF.LXMRouter(identity=RNS.Identity(), storagepath=STORE_DIR)
                    self.router.delivery_destinations = _DeliveryDestinations(self.router.delivery_destinations)
                    self.router.register_delivery_callback(self._delivered)
                    for address in self.settings["blocked"]:
                        self.router.ignore_destination(bytes.fromhex(address))
                    self._apply_stamps()
                    self.error = None
                    self._clean_ephemeral_ratchets()
                    atexit.register(self._at_exit)
                    self.pn.register()
                    self.peers.register()
                    self._apply_propagation()
                    print("💬 LXMF messenger started")
                except Exception as exc:
                    self.error = f"Could not start LXMF: {exc}"
                    print(f"❌ {self.error}")
                    return
            self._sync_identity()
        if not self._watcher_started:
            self._watcher_started = True
            threading.Thread(target=self._watch, name="messenger", daemon=True).start()

    def _clean_ephemeral_ratchets(self) -> None:
        """Ratchet files LXMF keeps per delivery destination. Only saved
        profiles may leave one behind: anything else is from an ephemeral
        identity of an earlier run that did not end cleanly."""
        try:
            ids = self.browser.identities
            keep = set()
            for profile in ids.state.get("profiles", []):
                identity = ids.identity_for(profile["id"])
                if identity is not None:
                    keep.add(RNS.Destination.hash(identity, "lxmf", "delivery").hex())
            folder = self.router.ratchetpath
            for name in os.listdir(folder) if os.path.isdir(folder) else []:
                if name.endswith(".ratchets") and name[:-9] not in keep:
                    os.remove(os.path.join(folder, name))
        except Exception as exc:
            print(f"⚠️ Could not clean old ephemeral ratchets: {exc}")

    def _at_exit(self) -> None:
        paths = {l.ratchet for l in self.listeners.values() if l.ratchet}
        if self.ephemeral_ratchet:
            paths.add(self.ephemeral_ratchet)
        for path in paths:
            try:
                os.remove(path)
            except OSError:
                pass

    def request_start(self) -> None:
        tasks = getattr(self.browser, "main_thread_tasks", None)
        if self.router is not None:
            with self.lock:
                self._sync_identity()
        elif tasks is not None:
            tasks.put(self.start_on_main_thread)

    def stop(self) -> None:
        with self.lock:
            if not self.listeners and self.destination is None:
                return
            for address in list(self.listeners):
                self._drop_listener(address)
            self._set_active(None)
            self.revision += 1
        print("💬 LXMF messenger off: nothing listens on the LXMF addresses any more")

    def _wanted_listeners(self) -> Dict[str, Any]:
        """{lxmf address: (profile id, identity, ephemeral)}: every saved
        identity, and the ephemeral one only while it is the one chosen."""
        ids = self.browser.identities
        wanted: Dict[str, Any] = {}
        for profile in ids.state.get("profiles", []):
            identity = ids.identity_for(profile["id"])
            if identity is not None:
                wanted[RNS.Destination.hash(identity, "lxmf", "delivery").hex()] = (profile["id"], identity, False)
        if self.settings["identity"] == EPHEMERAL and self.settings["allow_ephemeral"]:
            identity = ids.identity_for(EPHEMERAL)
            if identity is not None:
                wanted[RNS.Destination.hash(identity, "lxmf", "delivery").hex()] = (EPHEMERAL, identity, True)
        return wanted

    def _add_listener(self, profile_id: str, identity: Any, ephemeral: bool) -> Optional[Listener]:
        table = self.router.delivery_destinations
        if isinstance(table, _DeliveryDestinations):
            table.registering = True
        try:
            destination = self.router.register_delivery_identity(
                identity, display_name=self.display_name_of(profile_id) or None,
                stamp_cost=None if ephemeral else (self.settings["stamp_cost"] or None))
        finally:
            if isinstance(table, _DeliveryDestinations):
                table.registering = False
        if destination is None:
            return None
        ratchet = None
        if ephemeral:
            self._hold_ephemeral_announces(destination)
            ratchet = os.path.join(self.router.ratchetpath, RNS.hexrep(destination.hash, delimit=False) + ".ratchets")
            store = Conversations(identity.hash.hex(), on_disk=False)
        else:
            store = Conversations(identity.hash.hex(), on_disk=True)
        listener = Listener(profile_id, identity, destination, store, ephemeral, ratchet)
        self.listeners[listener.address] = listener
        print(f"💬 Messenger listening on {RNS.prettyhexrep(destination.hash)}"
              f" ({'ephemeral' if ephemeral else self.browser.identities.name_of(profile_id)})")
        if self.settings["offline"]:
            self._apply_offline()
        return listener

    def _apply_offline(self, announce: bool = False) -> None:
        """Offline: every LXMF destination off the transport (links closed,
        senders see it fail, nothing lands here). Back online: registered
        again, and announced (announce=True) so peers find us at once."""
        offline = self.settings["offline"]
        for listener in list(self.listeners.values()):
            destination = listener.destination
            known = destination in getattr(RNS.Transport, "destinations", [])
            try:
                if offline and known:
                    for link in list(getattr(destination, "links", []) or []):
                        if link.status == RNS.Link.ACTIVE:
                            link.teardown()
                    RNS.Transport.deregister_destination(destination)
                elif not offline and not known:
                    RNS.Transport.register_destination(destination)
            except Exception as exc:
                print(f"⚠️ Offline/online {RNS.prettyhexrep(destination.hash)}: {exc}")
        print(f"💬 Messenger {'offline: not listening' if offline else 'back online'}")
        if announce and not offline and self.router is not None and self.destination is not None \
                and not self.using_ephemeral:
            # A few seconds after, once the destinations are back on the
            # transport, and every identity listening, not only the one in
            # use: right after "online" peers could not reach us.
            # The others one at a time, ANNOUNCE_GAP s apart: all at once was
            # a burst on the interfaces.
            def later() -> None:
                with self.lock:
                    if self.settings["offline"] or self.router is None or self.destination is None:
                        return
                    self._announce()
                    others = [l.destination.hash for l in self.listeners.values()
                              if l.destination.hash != self.destination.hash]
                for h in others:
                    time.sleep(ANNOUNCE_GAP)
                    with self.lock:
                        if self.settings["offline"] or self.router is None:
                            return
                        if not any(l.destination.hash == h for l in self.listeners.values()):
                            continue
                        try:
                            self.router.announce(h)
                            print(f"📣 LXMF announce sent for {RNS.prettyhexrep(h)}")
                        except Exception as exc:
                            print(f"⚠️ Announce {RNS.prettyhexrep(h)}: {exc}")
            threading.Timer(3, later).start()

    def _drop_listener(self, address: str) -> None:
        listener = self.listeners.pop(address, None)
        if listener is None:
            return
        destination = listener.destination
        # Links still open towards it would take messages and prove them
        # delivered, then LXMF finds no identity for them and drops them:
        # closed, the sender learns it failed.
        for link in list(getattr(destination, "links", []) or []):
            try:
                if link.status == RNS.Link.ACTIVE:
                    link.teardown()
            except Exception as exc:
                print(f"⚠️ Could not close a link to {RNS.prettyhexrep(destination.hash)}: {exc}")
        try:
            RNS.Transport.deregister_destination(destination)
        except Exception as exc:
            print(f"⚠️ Could not deregister the LXMF destination: {exc}")
        if self.router is not None:
            self.router.delivery_destinations.pop(destination.hash, None)
        # An ephemeral identity leaves nothing behind on disk.
        if listener.ratchet:
            try:
                os.remove(listener.ratchet)
            except OSError:
                pass
        if self.destination is destination:
            self._set_active(None)

    def _set_active(self, listener: Optional[Listener]) -> None:
        """The identity we write with and look at."""
        self.destination = listener.destination if listener else None
        self.identity = listener.identity if listener else None
        self.identity_hash = listener.identity.hash.hex() if listener else None
        self.store = listener.store if listener else None
        self.using_ephemeral = bool(listener and listener.ephemeral)
        self.ephemeral_store = listener.store if listener and listener.ephemeral else None
        self.ephemeral_ratchet = listener.ratchet if listener else None

    def _sync_identity(self) -> None:
        if self.router is None or not self.settings["enabled"]:
            return
        wanted = self._wanted_listeners()
        changed = False
        for address in [a for a in self.listeners if a not in wanted]:
            self._drop_listener(address)
            changed = True
        for address, (profile_id, identity, ephemeral) in wanted.items():
            listener = self.listeners.get(address)
            if listener is None:
                if self._add_listener(profile_id, identity, ephemeral) is not None:
                    changed = True
            elif listener.id != profile_id:
                listener.id = profile_id
                changed = True
        chosen = next((l for l in self.listeners.values() if l.id == self.settings["identity"]), None)
        if chosen is None:
            if self.destination is not None:
                self._set_active(None)
                changed = True
            self.error = "The messenger identity is gone or cannot be loaded: pick another in Settings"
        else:
            self.error = None
            if self.destination is not chosen.destination:
                self._set_active(chosen)
                # The announce timer starts from here: choosing an identity
                # does not announce it (only Announce, and the timer, do).
                self.listening_since = time.time()
                changed = True
                print(f"💬 Writing as {RNS.prettyhexrep(chosen.destination.hash)}"
                      f"{' (ephemeral)' if chosen.ephemeral else ''}")
                if (not chosen.ephemeral and self.settings["announce_at_start"]
                        and not self.settings["offline"] and not self.announced_at_start):
                    self.announced_at_start = True
                    self._announce()
            self.announced_at_start = True
        if changed:
            self.revision += 1

    def _hold_ephemeral_announces(self, destination: Any) -> None:
        """Connected to a shared instance, RNS hands every destination to
        rnsd as soon as it is registered, and all of them again when rnsd
        comes back (announce with path_response=True, no interface). rnsd
        keeps it to answer path requests from the network - without it
        nobody finds the address - and does not send it on to the network;
        it does show it to every other program on this computer, as an
        announce. Saved identities keep that, as in every LXMF client. An
        ephemeral one on a timer would show a new address every few minutes,
        so it is held back until the identity writes (_expose_ephemeral)."""
        original = destination.announce
        destination.rb_announce = original
        destination.rb_exposed = False

        def announce(app_data=None, path_response=False, attached_interface=None, tag=None, send=True):
            if path_response and attached_interface is None and not destination.rb_exposed:
                return None
            return original(app_data=app_data, path_response=path_response,
                            attached_interface=attached_interface, tag=tag, send=send)

        destination.announce = announce

    def _expose_ephemeral(self, source: Any) -> None:
        """The ephemeral identity writes: rnsd learns the address now, or
        the other side could not find its keys to read and answer."""
        if getattr(source, "rb_exposed", True):
            return
        source.rb_exposed = True
        try:
            source.rb_announce(path_response=True)
        except Exception as exc:
            print(f"⚠️ Could not hand the ephemeral address to Reticulum: {exc}")

    def _watch(self) -> None:
        """Follow the identities (the ephemeral one changes on its own) and
        announce the one in use on the timer."""
        tick = 0
        while True:
            time.sleep(1)
            tick += 1
            try:
                if not self.settings["enabled"] or self.router is None:
                    continue
                with self.lock:
                    self._sync_identity()
                    # Only the identity in use, counted from when it was
                    # chosen or last announced (by hand too).
                    since = max(self.last_announce, self.listening_since)
                    if (self.destination is not None and not self.using_ephemeral and not self.settings["offline"]
                            and self.settings["announce_periodic"] and since
                            and time.time() - since >= self.settings["announce_minutes"] * 60):
                        self._announce()
                    # Paths come and go: the nearest node is looked at again.
                    if tick % 30 == 0:
                        self._apply_propagation()
                    self._follow_sync()
                    if (self.destination is not None and self.settings["sync_periodic"] and self.current_pn()
                            and time.time() - self.listening_since >= SYNC_START_DELAY
                            and time.time() - self.settings["last_sync"] >= self.settings["sync_minutes"] * 60):
                        self._start_sync("periodic")
            except Exception as exc:
                print(f"⚠️ Messenger: {exc}")
                time.sleep(10)

    def inbound_stamp_cost(self) -> Optional[int]:
        """The stamp asked of senders now: none for the ephemeral identity."""
        if self.using_ephemeral:
            return None
        return self.settings["stamp_cost"] or None

    def _apply_stamps(self) -> None:
        if self.router is None:
            return
        if self.settings["enforce_stamps"]:
            self.router.enforce_stamps()
        else:
            self.router.ignore_stamps()
        cost = self.settings["stamp_cost"] or None
        for listener in self.listeners.values():
            self.router.set_inbound_stamp_cost(listener.destination.hash, None if listener.ephemeral else cost)
        if self.destination is not None and self.destination.hash.hex() not in self.listeners:
            self.router.set_inbound_stamp_cost(self.destination.hash, self.inbound_stamp_cost())

    def _announce(self) -> None:
        self.router.announce(self.destination.hash)
        self.last_announce = time.time()
        self.revision += 1
        print(f"📣 LXMF announce sent for {RNS.prettyhexrep(self.destination.hash)}")

    def announce_now(self) -> Dict[str, Any]:
        with self.lock:
            if self.destination is None:
                return {"status": "error", "error": "The messenger is off"}
            if self.settings["offline"]:
                return {"status": "error", "error": "You are offline: go online to announce"}
            wait = MANUAL_ANNOUNCE_GAP - (time.time() - self.last_announce)
            if wait > 0:
                return {"status": "error", "error": f"Announced a moment ago: wait {int(wait) + 1} s"}
            self._announce()
            return {"status": "success"}

    # ------------------------------------------------------------------ #
    # Propagation node                                                   #
    # ------------------------------------------------------------------ #

    SYNC_STATES = {
        0x00: ("idle", "Idle"),
        0x01: ("busy", "Asking the network for the node"),
        0x02: ("busy", "Connecting to the node"),
        0x03: ("busy", "Connected"),
        0x04: ("busy", "Asking for messages"),
        0x05: ("busy", "Receiving messages"),
        0x06: ("busy", "Messages received"),
        0x07: ("done", "Done"),
        0xf0: ("failed", "No path to the node"),
        0xf1: ("failed", "Could not connect to the node"),
        0xf2: ("failed", "The transfer failed"),
        0xf3: ("failed", "The node did not receive our identity"),
        0xf4: ("failed", "The node refused access"),
        0xfe: ("failed", "Sync failed"),
    }

    def _pn_failed_recently(self) -> set:
        """Nodes that did not answer in the last PN_FAIL_COOLDOWN (none when
        "try another" is off)."""
        if not self.settings.get("propagation_failover"):
            return set()
        now = time.time()
        return {h for h, at in list(self._pn_failed.items()) if now - at < PN_FAIL_COOLDOWN}

    def _pn_mark_failed(self, node: Optional[str], why: str) -> None:
        if node and self.settings.get("propagation_failover"):
            self._pn_failed[node] = time.time()
            info = self.pn.get(node) or {}
            print(f"📮 LXMF propagation node {info.get('name') or node[:12]} set aside for "
                  f"{PN_FAIL_COOLDOWN // 60} min: {why}")
            self.revision += 1

    def _outbound_pn(self) -> Optional[str]:
        """The node LXMF is using now."""
        try:
            node = self.router.get_outbound_propagation_node() if self.router is not None else None
            return node.hex() if node else None
        except Exception:
            return None

    def current_pn(self) -> Optional[str]:
        """The node in use now: the chosen one, or the nearest heard - or,
        with a rotation set, the most recently heard, changed every N hours.
        A node that did not answer lately is passed over while another one
        is reachable."""
        mode = self.settings["propagation_mode"]
        if mode == "off":
            return None
        failed = self._pn_failed_recently()
        if mode == "manual":
            chosen = self.settings["propagation_node"] or None
            if chosen and chosen in failed:
                return self.pn.nearest(exclude=failed) or chosen
            return chosen
        hours = self.settings.get("propagation_rotate_hours") or 0
        if hours:
            now = time.time()
            node = self._rot_node
            if (node and node not in failed and now - self._rot_at < hours * 3600
                    and self.pn.usable(node)):
                return node
            pick = self.pn.freshest(exclude=failed | ({node} if node else set())) or self.pn.freshest(exclude=failed)
            if pick:
                if pick != node:
                    info = self.pn.get(pick) or {}
                    print(f"📮 LXMF propagation node rotated: {info.get('name') or pick[:12]} "
                          f"(the next change in {hours} h)")
                self._rot_node, self._rot_at = pick, now
                return pick
        return self.pn.nearest(exclude=failed) or self.pn.nearest()

    def _apply_propagation(self) -> None:
        if self.router is None:
            return
        node = self.current_pn()
        if node is None:
            return
        try:
            if self.router.get_outbound_propagation_node() != bytes.fromhex(node):
                self.router.set_outbound_propagation_node(bytes.fromhex(node))
                info = self.pn.get(node) or {}
                print(f"📮 LXMF propagation node: {info.get('name') or RNS.prettyhexrep(bytes.fromhex(node))}"
                      f" ({'chosen' if self.settings['propagation_mode'] == 'manual' else 'nearest heard'})")
                self.revision += 1
        except Exception as exc:
            print(f"⚠️ Could not set the propagation node: {exc}")

    def _is_ephemeral_source(self, source: Any) -> bool:
        """The message is sent as the ephemeral identity (checked against
        the one it was written with, not the one in use now)."""
        try:
            eph = self.browser.identities.identity_for(EPHEMERAL)
            return eph is not None and source.hash == RNS.Destination.hash(eph, "lxmf", "delivery")
        except Exception:
            return self.using_ephemeral

    def _pn_heard(self) -> None:
        with self.lock:
            self._apply_propagation()
            self.revision += 1

    def _start_sync(self, why: str) -> Optional[str]:
        """Ask the node for the messages waiting for us. An error text, or None."""
        if self.router is None or not self.listeners and (self.destination is None or self.identity is None):
            return "The messenger is off"
        if self.settings["offline"]:
            return "You are offline: go online to sync"
        # Every saved identity, the one in use first: a node keeps messages
        # for each of them. The ephemeral one has none waiting there.
        queue = [l.identity for l in sorted(self.listeners.values(),
                                            key=lambda l: l.destination is not self.destination)
                 if not l.ephemeral]
        if not queue and self.identity is not None and not self.listeners and not self.using_ephemeral:
            queue = [self.identity]
        if not queue:
            return "Propagation nodes are for saved identities only, not the ephemeral one"
        if not self.current_pn():
            return ("No propagation node heard yet" if self.settings["propagation_mode"] == "auto"
                    else "Propagation is off (Settings > LXMF Messenger)")
        state = self.router.propagation_transfer_state
        if not (state == 0x00 or state >= 0x07):
            return "A sync is already running"
        self._apply_propagation()
        self.settings["last_sync"] = time.time()
        self._save_settings()
        self._sync_queue = queue
        self._sync_all = list(queue)
        self._sync_tries = 0
        self._sync_got = 0
        print(f"📥 LXMF sync with the propagation node ({why})"
              + (f", {len(queue)} identities" if len(queue) > 1 else ""))
        self._sync_next()
        return None

    def _sync_next(self) -> None:
        """The next identity of the sync: LXMF syncs one at a time."""
        import LXMF
        identity = self._sync_queue.pop(0)
        self._sync_state_seen = None
        self.router.request_messages_from_propagation_node(identity, max_messages=LXMF.LXMRouter.PR_ALL_MESSAGES)
        self.revision += 1

    def sync_now(self) -> Dict[str, Any]:
        with self.lock:
            wait = MANUAL_SYNC_GAP - (time.time() - self._manual_sync_at)
            if wait > 0:
                return {"status": "error", "error": f"Synced a moment ago: wait {int(wait) + 1} s"}
            error = self._start_sync("by hand")
            if error:
                return {"status": "error", "error": error}
            self._manual_sync_at = time.time()
            return {"status": "success"}

    def cancel_sync(self) -> Dict[str, Any]:
        with self.lock:
            if self.router is not None:
                self._sync_queue = []
                self.router.cancel_propagation_node_requests()
                self.revision += 1
            return {"status": "success"}

    def _follow_sync(self) -> None:
        """Say once how a sync ended, in the terminal and to the page."""
        if self.router is None:
            return
        state = self.router.propagation_transfer_state
        if state == self._sync_state_seen:
            return
        self._sync_state_seen = state
        self.revision += 1
        kind, text = self.SYNC_STATES.get(state, ("busy", ""))
        if kind == "done":
            self._sync_got += self.router.propagation_transfer_last_result or 0
            if self._sync_queue:
                self._sync_next()
                return
            got = self._sync_got
            print(f"📥 LXMF sync done: {got} new message{'s' if got != 1 else ''}")
        elif kind == "failed":
            # The node did not answer: set aside, and the whole sync again
            # with the next one (at most PN_SYNC_TRIES nodes a sync).
            node = self._outbound_pn()
            self._pn_mark_failed(node, text)
            nxt = self.current_pn()
            if (self.settings.get("propagation_failover") and nxt and nxt != node
                    and self._sync_tries < PN_SYNC_TRIES - 1 and self._sync_all):
                self._sync_tries += 1
                info = self.pn.get(nxt) or {}
                print(f"📥 LXMF sync: {text}, trying {info.get('name') or nxt[:12]}")
                self._apply_propagation()
                self._sync_queue = list(self._sync_all)
                self._sync_next()
                return
            # The node is the same for all: no point trying the others.
            self._sync_queue = []
            print(f"📥 LXMF sync: {text}")

    def sync_status(self) -> Dict[str, Any]:
        node = self.current_pn()
        state = self.router.propagation_transfer_state if self.router is not None else 0
        kind, text = self.SYNC_STATES.get(state, ("busy", ""))
        return {
            "mode": self.settings["propagation_mode"],
            "ephemeral": self.using_ephemeral,
            "node": (self.pn.get(node) or {"hash": node}) if node else None,
            "heard": len(self.pn.nodes),
            "sync": {
                "kind": kind, "text": text,
                "progress": round(float(getattr(self.router, "propagation_transfer_progress", 0) or 0), 2),
                "last_result": (self._sync_got if kind == "done"
                                else getattr(self.router, "propagation_transfer_last_result", None)),
                "last_sync": self.settings["last_sync"] or None,
            },
            "sync_choices": list(SYNC_CHOICES),
            "rotate_choices": list(PN_ROTATE_CHOICES),
            "rotate_hours": self.settings.get("propagation_rotate_hours") or 0,
            # Set aside after not answering: {hash: seconds left}.
            "set_aside": {h: int(PN_FAIL_COOLDOWN - (time.time() - self._pn_failed[h]))
                          for h in self._pn_failed_recently()},
        }

    def propagation_nodes(self) -> List[Dict[str, Any]]:
        current = self.current_pn()
        failed = self._pn_failed_recently()
        rows = self.pn.listing()
        for row in rows:
            row["in_use"] = row["hash"] == current
            row["set_aside"] = row["hash"] in failed
        return rows

    # ------------------------------------------------------------------ #
    # Sending                                                            #
    # ------------------------------------------------------------------ #

    def wrong_aspect(self, address: Any) -> Optional[str]:
        """What this address is, when its identity is known and it is not an
        LXMF address (a page may call an RRC hub "lxmf@"). None otherwise."""
        clean = clean_address(address)
        if not clean:
            return None
        dest = bytes.fromhex(clean)
        identity = rnsquiet.recall(dest)
        if identity is None or RNS.Destination.hash(identity, "lxmf", "delivery") == dest:
            return None
        from .nomadnet import KNOWN_ASPECTS
        aspects = {"nomadnetwork.node": "a NomadNet node", **KNOWN_ASPECTS}
        return next((label for aspect, label in aspects.items()
                     if RNS.Destination.hash_from_name_and_identity(aspect, identity) == dest),
                    "another kind of Reticulum destination")

    def _recall_recipient(self, address: bytes) -> Optional[RNS.Identity]:
        identity = RNS.Identity.recall(address)
        # Only if this address IS its lxmf.delivery: the identity of an RRC
        # hub, say, would send the message to a different address.
        if identity is not None and RNS.Destination.hash(identity, "lxmf", "delivery") == address:
            return identity
        # An operator's address: the node announce carries the same identity.
        hex_address = address.hex()
        for entry in list(self.browser.nomadnet_nodes.values()):
            if entry.get("operator_lxmf_address") == hex_address:
                try:
                    node_identity = RNS.Identity.recall(bytes.fromhex(entry["hash"]))
                except Exception:
                    node_identity = None
                if node_identity is not None and \
                        RNS.Destination.hash(node_identity, "lxmf", "delivery") == address:
                    return node_identity
        return None

    def ping(self, peer: Any) -> Dict[str, Any]:
        """
        Is an LXMF client listening there right now? Opens a link to its
        lxmf.delivery destination - what LXMF's own direct delivery does
        first - and closes it at once; no message is sent. The link's round
        trip is the answer.
        """
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        other = self.wrong_aspect(address)
        if other:
            return {"status": "error", "error": f"Not an LXMF address: it is {other}"}
        dest_hash = bytes.fromhex(address)
        start = time.time()
        identity = self._recall_recipient(dest_hash)
        if identity is None:
            RNS.Transport.request_path(dest_hash)
            while identity is None and time.time() - start < IDENTITY_WAIT:
                time.sleep(0.5)
                identity = self._recall_recipient(dest_hash)
        if identity is None:
            return {"status": "error", "error": "Nobody answered on this address"}
        if not RNS.Transport.has_path(dest_hash):
            RNS.Transport.request_path(dest_hash)
            while not RNS.Transport.has_path(dest_hash) and time.time() - start < IDENTITY_WAIT:
                time.sleep(0.25)
        destination = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE,
                                      "lxmf", "delivery")
        link = RNS.Link(destination)
        deadline = time.time() + 30
        while link.status not in (RNS.Link.ACTIVE, RNS.Link.CLOSED) and time.time() < deadline:
            time.sleep(0.1)
        active = link.status == RNS.Link.ACTIVE
        rtt = link.rtt if active else None
        try:
            link.teardown()
        except Exception:
            pass
        if not active:
            return {"status": "error", "error": "No answer: the LXMF client is offline or out of reach",
                    "elapsed": time.time() - start}
        hops = RNS.Transport.hops_to(dest_hash) if RNS.Transport.has_path(dest_hash) else None
        return {"status": "success", "rtt_ms": round(rtt * 1000) if rtt else None, "hops": hops}

    def peer_name(self, address: str) -> str:
        try:
            from .nomadnet import decode_lxmf_display_name
            name = decode_lxmf_display_name(rnsquiet.recall_app_data(bytes.fromhex(address)))
            if name:
                return name
        except Exception:
            pass
        for entry in list(self.browser.nomadnet_nodes.values()):
            if entry.get("operator_lxmf_address") == address and entry.get("operator_name"):
                return entry["operator_name"]
        return ""

    def _rate_check(self, ephemeral: Optional[bool] = None) -> Optional[str]:
        if not (self.using_ephemeral if ephemeral is None else ephemeral):
            return None
        now = time.time()
        while self._sent_times and now - self._sent_times[0] > 3600:
            self._sent_times.popleft()
        if now - self._last_sent < EPHEMERAL_GAP:
            return f"Ephemeral identity: one message every {EPHEMERAL_GAP} s, wait {int(EPHEMERAL_GAP - (now - self._last_sent)) + 1} s"
        if len(self._sent_times) >= EPHEMERAL_PER_HOUR:
            return f"Ephemeral identity: at most {EPHEMERAL_PER_HOUR} messages an hour"
        return None

    def send(self, peer: Any, content: Any, title: Any = "", propagated: bool = False,
             attachments: Optional[List[Any]] = None, reply_to: Any = None,
             auto: bool = False, via: Optional[Listener] = None) -> Dict[str, Any]:
        """propagated: straight to the propagation node, no direct attempt
        (LXMessage.PROPAGATED). Saved identities only.
        attachments: [(name, bytes), ...] - the first image goes as
        FIELD_IMAGE, everything else as FIELD_FILE_ATTACHMENTS."""
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address (32 hex characters)"}
        if self.settings["offline"]:
            return {"status": "error", "error": "You are offline: go online to send"}
        text = str(content or "")
        files = [(safe_filename(n), bytes(d)) for n, d in (attachments or [])]
        if not text.strip() and not files:
            return {"status": "error", "error": "Empty message"}
        if len(text.encode("utf-8")) > MAX_CONTENT:
            return {"status": "error", "error": f"Message too long (at most {MAX_CONTENT // 1024} KB)"}
        if len(files) > MAX_ATTACH_FILES:
            return {"status": "error", "error": f"At most {MAX_ATTACH_FILES} files in one message"}
        total = sum(len(d) for _, d in files)
        if total > MAX_ATTACH_BYTES:
            return {"status": "error", "error": f"Files too big: at most {MAX_ATTACH_BYTES // (1024 * 1024)} MB in one message"}
        title = str(title or "")[:MAX_TITLE]
        with self.lock:
            if self.destination is None or self.store is None:
                return {"status": "error", "error": self.error or "The messenger is off"}
            # via: the identity that received what we answer (automatic
            # replies); else the one in use.
            store, source = (via.store, via.destination) if via is not None else (self.store, self.destination)
            ephemeral = via.ephemeral if via is not None else self.using_ephemeral
            if address == source.hash.hex():
                return {"status": "error", "error": "That is your own address"}
            other = self.wrong_aspect(address)
            if other:
                return {"status": "error", "error": f"Not an LXMF address: it is {other}"}
            if propagated:
                if ephemeral:
                    return {"status": "error", "error": "Propagation nodes are for saved identities only"}
                if not self.current_pn():
                    return {"status": "error", "error": "No propagation node (Settings > LXMF Messenger)"}
            limited = self._rate_check(ephemeral)
            if limited:
                return {"status": "error", "error": limited}
            if ephemeral:
                self._last_sent = time.time()
                self._sent_times.append(self._last_sent)
            local_id = os.urandom(8).hex()
            record = {"local_id": local_id, "id": None, "dir": "out", "content": text, "title": title,
                      "ts": time.time(), "state": "propagating" if propagated else "sending",
                      "method": "propagated" if propagated else "direct", "error": None}
            if auto:
                record["auto"] = True
            if files:
                metas = []
                image_taken = False
                for index, (name, data) in enumerate(files):
                    is_image = _ext(name) in IMAGE_TYPES and not image_taken
                    image_taken = image_taken or is_image
                    try:
                        store.put_file(address, local_id, index, data)
                    except OSError as exc:
                        return {"status": "error", "error": f"Could not keep a copy of {name}: {exc}"}
                    metas.append(self._file_meta(name, len(data), is_image, index=index))
                record["files"] = metas
            if self.settings["markdown"] and text.strip():
                record["renderer"] = "markdown"
            # A reply (FIELD_REPLY_TO + FIELD_REPLY_QUOTE, as Sideband): the
            # hash of the message answered and a piece of its text.
            quoted = store.find_id(address, str(reply_to or "")) if _HEX64.match(str(reply_to or "")) else None
            if quoted is not None:
                record["reply_to"] = quoted["id"]
                record["reply_quote"] = quote_of(quoted)
            store.add(address, record, name=self.peer_name(address))
            self.revision += 1
        threading.Thread(target=self._send_job, args=(store, source, address, local_id, text, title, propagated),
                         name="lxmf-send", daemon=True).start()
        result = {"status": "success", "local_id": local_id}
        if files and total > PN_TYPICAL_LIMIT and (propagated or self.current_pn()):
            result["warning"] = ("Over 256 KB: if it ends up on a propagation node, "
                                 "the node may refuse it")
        return result

    @staticmethod
    def _file_meta(name: str, size: int, is_image: bool, **extra: Any) -> Dict[str, Any]:
        mime = IMAGE_TYPES.get(_ext(name)) if is_image else AUDIO_TYPES.get(_ext(name))
        if not mime:
            import mimetypes
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        kind = "image" if is_image else "audio" if mime.startswith("audio/") else "file"
        return {"name": name, "size": size, "kind": kind, "mime": mime, **extra}

    def _fields_for(self, store: Conversations, address: str, local_id: str) -> Dict[int, Any]:
        """The LXMF fields of a message of ours, from the copies kept."""
        import LXMF
        conv = store.data.get(address) or {}
        record = next((m for m in conv.get("messages", []) if m.get("local_id") == local_id), None)
        fields: Dict[int, Any] = {}
        attachments = []
        for meta in (record or {}).get("files", []):
            data = store.get_file(address, local_id, meta.get("index", 0))
            if data is None:
                raise OSError(f"the copy of {meta.get('name')} is gone")
            if meta.get("kind") == "image" and LXMF.FIELD_IMAGE not in fields:
                fields[LXMF.FIELD_IMAGE] = [_ext(meta["name"]) or "jpg", data]
            else:
                attachments.append([meta["name"], data])
        if attachments:
            fields[LXMF.FIELD_FILE_ATTACHMENTS] = attachments
        if (record or {}).get("renderer") == "markdown":
            fields[LXMF.FIELD_RENDERER] = LXMF.RENDERER_MARKDOWN
        if (record or {}).get("reply_to"):
            fields[LXMF.FIELD_REPLY_TO] = bytes.fromhex(record["reply_to"])
            fields[LXMF.FIELD_REPLY_QUOTE] = str(record.get("reply_quote", "")).encode("utf-8")
        return fields

    def cancel(self, peer: Any, local_id: Any) -> Dict[str, Any]:
        """Stop a message of ours that has not gone yet: LXMF's own
        cancel_outbound (it also stops a stamp being computed and a file
        transfer). Never retried, never left on a propagation node."""
        address = clean_address(peer)
        if not address or self.store is None or not _LOCAL_ID.match(str(local_id or "")):
            return {"status": "error", "error": "No such message"}
        conv = self.store.data.get(address) or {}
        record = next((m for m in conv.get("messages", []) if m.get("local_id") == local_id
                       and m.get("dir") == "out"), None)
        if record is None:
            return {"status": "error", "error": "No such message"}
        if record.get("state") not in ("sending", "waiting", "propagating"):
            return {"status": "error", "error": "Already gone: it cannot be cancelled"}
        self._cancelled.add(local_id)
        message = self._outbound.pop(local_id, None)
        if message is not None and self.router is not None:
            try:
                message_id = getattr(message, "message_id", None) or getattr(message, "hash", None)
                if message_id:
                    self.router.cancel_outbound(message_id)
            except Exception as exc:
                print(f"⚠️ Could not cancel the LXMF message: {exc}")
        self.store.update(address, local_id, state="cancelled", error="Cancelled before it was sent")
        self.progress.pop(local_id, None)
        self.revision += 1
        return {"status": "success"}

    def retry(self, peer: Any, local_id: Any) -> Dict[str, Any]:
        """Send a failed or cancelled message of ours again, files included,
        in the same bubble: the record goes back to sending (a new copy of
        it in the chat for every try was only clutter)."""
        address = clean_address(peer)
        if not address or self.store is None or not _LOCAL_ID.match(str(local_id or "")):
            return {"status": "error", "error": "No such message"}
        with self.lock:
            if self.destination is None:
                return {"status": "error", "error": self.error or "The messenger is off"}
            store, source = self.store, self.destination
            conv = store.data.get(address) or {}
            record = next((m for m in conv.get("messages", []) if m.get("local_id") == local_id
                           and m.get("dir") == "out"), None)
            if record is None:
                return {"status": "error", "error": "No such message"}
            if record.get("state") not in ("failed", "cancelled"):
                return {"status": "error", "error": "Only a message that failed or was cancelled can be sent again"}
            for meta in record.get("files", []):
                if store.get_file(address, local_id, meta.get("index", 0)) is None:
                    return {"status": "error", "error": f"The copy of {meta.get('name')} is gone"}
            limited = self._rate_check()
            if limited:
                return {"status": "error", "error": limited}
            if self.using_ephemeral:
                self._last_sent = time.time()
                self._sent_times.append(self._last_sent)
            self._cancelled.discard(local_id)
            self.progress.pop(local_id, None)
            store.update(address, local_id, state="sending", method="direct", error=None, id=None,
                         tries=int(record.get("tries") or 1) + 1)
            self.revision += 1
        threading.Thread(target=self._send_job,
                         args=(store, source, address, local_id, record.get("content", ""),
                               record.get("title", ""), False),
                         name="lxmf-send", daemon=True).start()
        return {"status": "success", "local_id": local_id}

    # ------------------------------------------------------------------ #
    # Reactions (FIELD_REACTION)                                         #
    # ------------------------------------------------------------------ #
    # A reaction is an LXMF message of its own, with no text and the field
    # {REACTION_TO: hash of the message, REACTION_CONTENT: the emoji}. It is
    # kept on the message it is about: {"me": "👍", "peer": "❤️"}. An empty
    # content takes a reaction back (LXMF leaves this to clients).

    def react(self, peer: Any, message_id: Any, reaction: Any) -> Dict[str, Any]:
        address = clean_address(peer)
        content = clean_reaction(reaction)
        if not address or not _HEX64.match(str(message_id or "")):
            return {"status": "error", "error": "No such message"}
        if content is None:
            return {"status": "error", "error": "A reaction is one emoji or a few characters"}
        other = self.wrong_aspect(address)
        if other:
            return {"status": "error", "error": f"Not an LXMF address: it is {other}"}
        with self.lock:
            if self.destination is None or self.store is None:
                return {"status": "error", "error": self.error or "The messenger is off"}
            limited = self._rate_check()
            if limited:
                return {"status": "error", "error": limited}
            store, source = self.store, self.destination
            if not store.set_reaction(address, message_id, "me", content):
                return {"status": "error", "error": "No such message"}
            self.revision += 1
        threading.Thread(target=self._send_reaction, args=(store, source, address, message_id, content),
                         name="lxmf-react", daemon=True).start()
        return {"status": "success"}

    def _send_reaction(self, store: Conversations, source: Any, address: str, message_id: str,
                       content: str) -> None:
        import LXMF
        self._expose_ephemeral(source)
        dest_hash = bytes.fromhex(address)
        identity = self._recall_recipient(dest_hash)
        if identity is None:
            RNS.Transport.request_path(dest_hash)
            deadline = time.time() + IDENTITY_WAIT
            while identity is None and time.time() < deadline:
                time.sleep(0.5)
                identity = self._recall_recipient(dest_hash)
        if identity is None:
            print(f"⚠️ Reaction to {address[:16]} not sent: nobody answered on the address")
            return
        destination = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE,
                                      "lxmf", "delivery")
        fields = {LXMF.FIELD_REACTION: {LXMF.REACTION_TO: bytes.fromhex(message_id),
                                        LXMF.REACTION_CONTENT: content.encode("utf-8")}}
        message = LXMF.LXMessage(destination, source, "", "", fields=fields,
                                 desired_method=LXMF.LXMessage.DIRECT,
                                 include_ticket=bool(self.inbound_stamp_cost()))

        def failed(msg: Any) -> None:
            print(f"⚠️ Reaction to {self.peer_label(address)} not delivered")

        message.register_failed_callback(failed)
        self.router.handle_outbound(message)

    def _incoming_reaction(self, store: Conversations, peer: str, field: Any) -> bool:
        """A received reaction, applied to its message. True if it was one."""
        import LXMF
        if not isinstance(field, dict):
            return False
        target = field.get(LXMF.REACTION_TO)
        content = field.get(LXMF.REACTION_CONTENT, b"")
        if isinstance(content, bytes):
            content = content.decode("utf-8", "replace")
        content = clean_reaction(content)
        if isinstance(target, (bytes, bytearray)) and content is not None:
            if store.set_reaction(peer, bytes(target).hex(), "peer", content):
                self.revision += 1
                if content:
                    print(f"💬 LXMF reaction {content} from {self.peer_label(peer)}")
        return True

    # ------------------------------------------------------------------ #
    # Nicknames and search                                               #
    # ------------------------------------------------------------------ #

    def peer_label(self, address: str) -> str:
        """Our nickname for a contact, else its announced name, else the address."""
        return (self.settings["nicknames"].get(address) or self.peer_name(address)
                or RNS.prettyhexrep(bytes.fromhex(address)))

    def set_nickname(self, peer: Any, nickname: Any) -> Dict[str, Any]:
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        nick = clean_nickname(nickname)
        with self.lock:
            if nick:
                self.settings["nicknames"][address] = nick
            else:
                self.settings["nicknames"].pop(address, None)
            self._save_settings()
            self.revision += 1
        return {"status": "success", "nicknames": dict(self.settings["nicknames"])}

    # ------------------------------------------------------------------ #
    # Our name in announces, one per identity                            #
    # ------------------------------------------------------------------ #

    def _ephemeral_address(self) -> str:
        eph = self.browser.identities.identity_for(EPHEMERAL)
        return RNS.Destination.hash(eph, "lxmf", "delivery").hex() if eph is not None else ""

    def _display_name_key(self, identity_id: str) -> Optional[str]:
        if identity_id != EPHEMERAL:
            return identity_id
        address = self._ephemeral_address()
        return f"{EPHEMERAL}:{address}" if address else None

    def display_name_of(self, identity_id: str) -> str:
        """The name announced for an identity; ephemeral ones nobody renamed
        are eph_ and the first 4 hex of their address."""
        key = self._display_name_key(identity_id)
        if key is None:
            return ""
        name = self.settings["display_names"].get(key, "")
        if not name and identity_id == EPHEMERAL:
            name = ephemeral_default_name(key.split(":", 1)[1])
        return name

    def current_display_name(self) -> str:
        return self.display_name_of(self.settings["identity"])

    def _store_display_name(self, identity_id: str, name: Any) -> None:
        key = self._display_name_key(identity_id)
        if key is None:
            return
        names = self.settings["display_names"]
        if identity_id == EPHEMERAL:
            # Only the ephemeral identity of now: the others are gone for good.
            for old in [k for k in names if k.startswith(f"{EPHEMERAL}:") and k != key]:
                names.pop(old)
        name = clean_display_name(name)
        if not name or (identity_id == EPHEMERAL and name == ephemeral_default_name(key.split(":", 1)[1])):
            names.pop(key, None)
        else:
            names[key] = name

    def keep_ephemeral(self, name: Any = None) -> Dict[str, Any]:
        """The ephemeral identity in use becomes a saved one, address and all:
        its conversations and files go to disk, its name to the profile, and
        from now on it is reachable like any saved identity. The browser
        moves to it only if it was browsing as the same ephemeral identity."""
        ids = self.browser.identities
        with self.lock:
            if not self.using_ephemeral or self.destination is None:
                return {"status": "error", "error": "No ephemeral identity in use in the messenger"}
            destination = self.destination
            address = destination.hash.hex()
            my_name = self.current_display_name()
            profile = ids.keep_ephemeral(clean_display_name(name) or my_name or "Kept identity",
                                         activate=ids.active_id == EPHEMERAL)
            names = self.settings["display_names"]
            names.pop(f"{EPHEMERAL}:{address}", None)
            if my_name:
                names[profile["id"]] = my_name
            self.settings["identity"] = profile["id"]
            self.settings["fixed_identity"] = profile["id"]
            if self.store is not None:
                self.store.persist()
            listener = self.listeners.get(address)
            if listener is not None:
                listener.id = profile["id"]
                listener.ephemeral = False
                # Its ratchets are a profile's now: kept at exit.
                listener.ratchet = None
            self.ephemeral_store = None
            self.using_ephemeral = False
            self.ephemeral_ratchet = None
            original = getattr(destination, "rb_announce", None)
            if original is not None:
                del destination.announce
                # rnsd learns the address, as for any saved identity.
                if not getattr(destination, "rb_exposed", True):
                    try:
                        original(path_response=True)
                    except Exception as exc:
                        print(f"⚠️ Could not hand the address to Reticulum: {exc}")
            self._apply_stamps()
            self._save_settings()
            self.revision += 1
        print(f"💬 Ephemeral identity {RNS.prettyhexrep(destination.hash)} kept as {profile['name']}")
        return {"status": "success", "id": profile["id"], "name": profile["name"]}

    def set_display_name(self, identity_id: Any, name: Any) -> Dict[str, Any]:
        """The pencil in the Messages bar. A saved identity in use announces
        the new name at once; the ephemeral one only with Announce."""
        identity_id = str(identity_id or "")
        if identity_id != EPHEMERAL and self.browser.identities.identity_for(identity_id) is None:
            return {"status": "error", "error": "No such identity"}
        with self.lock:
            before = self.display_name_of(identity_id)
            self._store_display_name(identity_id, name)
            self._save_settings()
            now = self.display_name_of(identity_id)
            announced = False
            # Every identity listens: its destination carries the new name
            # for its next announce, in use or not.
            for listener in self.listeners.values():
                if listener.id == identity_id:
                    listener.destination.display_name = now or None
            if (self.destination is not None and identity_id == self.settings["identity"]):
                self.destination.display_name = now or None
                if now != before and not self.using_ephemeral:
                    self._announce()
                    announced = True
            self.revision += 1
        return {"status": "success", "name": now, "announced": announced}

    def add_contact(self, peer: Any, nickname: Any = "") -> Dict[str, Any]:
        """A contact without writing to it: an empty conversation, with a
        nickname if given. What the address is was checked by the page."""
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address (32 hex characters)"}
        with self.lock:
            if self.store is None:
                return {"status": "error", "error": self.error or "The messenger is off"}
            if self.destination is not None and address == self.destination.hash.hex():
                return {"status": "error", "error": "That is your own address"}
            existed = address in self.store.data
            with self.store.lock:
                self.store.conversation(address)
                if not existed:
                    name = self.peer_name(address)
                    if name:
                        self.store.data[address]["name"] = name
                self.store._save(address)
            nick = clean_nickname(nickname)
            if nick:
                self.settings["nicknames"][address] = nick
                self._save_settings()
            self.revision += 1
        return {"status": "success", "existed": existed, "address": address}

    def set_favorite(self, peer: Any, favorite: bool = True) -> Dict[str, Any]:
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        with self.lock:
            if favorite:
                self.settings["favorites"].setdefault(address, time.time())
            else:
                self.settings["favorites"].pop(address, None)
            self._save_settings()
            self.revision += 1
        return {"status": "success", "favorites": sorted(self.settings["favorites"])}

    def search(self, query: Any, limit: int = 100) -> List[Dict[str, Any]]:
        """Messages of every conversation of the identity in use whose text,
        title or file names hold all the words. Newest first."""
        words = [w for w in str(query or "").lower().split() if w][:8]
        if not words or self.store is None:
            return []
        hits = []
        with self.store.lock:
            for peer, conv in self.store.data.items():
                for m in conv["messages"]:
                    hay = " ".join([str(m.get("content", "")), str(m.get("title", ""))]
                                   + [f.get("name", "") for f in m.get("files", [])]).lower()
                    if all(w in hay for w in words):
                        text = str(m.get("content", "")) or ", ".join(f.get("name", "") for f in m.get("files", []))
                        hits.append({"peer": peer, "local_id": m.get("local_id"), "dir": m.get("dir"),
                                     "ts": m.get("ts", 0), "text": text[:300]})
        hits.sort(key=lambda h: -(h["ts"] or 0))
        return hits[:limit]

    def _send_job(self, store: Conversations, source: Any, address: str, local_id: str,
                  text: str, title: str, propagated: bool = False) -> None:
        import LXMF
        self._expose_ephemeral(source)
        dest_hash = bytes.fromhex(address)
        identity = self._recall_recipient(dest_hash)
        if identity is None:
            # As every LXMF client does: ask the network for the recipient's
            # announce, which carries its keys.
            store.update(address, local_id, state="waiting", error=None)
            self.revision += 1
            RNS.Transport.request_path(dest_hash)
            deadline = time.time() + IDENTITY_WAIT
            while identity is None and time.time() < deadline:
                time.sleep(0.5)
                identity = self._recall_recipient(dest_hash)
        if local_id in self._cancelled:
            return
        if identity is None:
            store.update(address, local_id, state="failed",
                         error="Nobody answered on this address: no LXMF client is listening there")
            self.revision += 1
            return
        # Keys known from an old announce, but no path now: the network is
        # asked first, so the first direct try already has one.
        if not propagated and not self._find_path(dest_hash, store, address, local_id):
            if local_id in self._cancelled:
                return
        try:
            destination = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE,
                                          "lxmf", "delivery")
            # include_ticket: when we ask senders for a stamp, whoever we
            # write to gets a ticket and answers without one (NomadNet
            # does this for trusted contacts).
            fields = self._fields_for(store, address, local_id)
            if propagated:
                method = LXMF.LXMessage.PROPAGATED
            elif (self.settings["opportunistic"]
                  and not (LXMF.FIELD_IMAGE in fields or LXMF.FIELD_FILE_ATTACHMENTS in fields)):
                # One packet if it fits; LXMF falls back to a link if not.
                method = LXMF.LXMessage.OPPORTUNISTIC
            else:
                method = LXMF.LXMessage.DIRECT
            message = LXMF.LXMessage(destination, source, text, title,
                                     fields=fields or None,
                                     desired_method=method,
                                     include_ticket=bool(self.inbound_stamp_cost()))

            label = self.peer_label(address)

            def delivered(msg: Any) -> None:
                # The same callback for both: DELIVERED is the recipient's
                # receipt, SENT means the propagation node took it.
                self._outbound.pop(local_id, None)
                state = "sent" if msg.state == LXMF.LXMessage.SENT else "delivered"
                store.update(address, local_id, state=state, error=None,
                             id=msg.hash.hex() if getattr(msg, "hash", None) else None)
                self.revision += 1
                print(f"💬 LXMF message to {label}: "
                      f"{'left on the propagation node' if state == 'sent' else 'delivered'}")

            def failed(msg: Any) -> None:
                # Cancelled by hand: stays cancelled, never goes to a node.
                if local_id in self._cancelled:
                    self._outbound.pop(local_id, None)
                    return
                # Direct failed: once more with a path asked afresh (a transit
                # node may hold an old one until the recipient announces
                # again), before the propagation node.
                if (msg.desired_method != LXMF.LXMessage.PROPAGATED and not getattr(msg, "_rb_rediscovered", False)
                        and not getattr(msg, "stamp_generation_failed", False)):
                    msg._rb_rediscovered = True
                    store.update(address, local_id, state="waiting",
                                 error="Direct delivery failed: asking the network for a fresh path")
                    self.revision += 1
                    print(f"💬 LXMF message to {label}: direct failed, asking for a fresh path")

                    def again() -> None:
                        try:
                            RNS.Reticulum.get_instance().drop_path(msg.get_destination().hash)
                        except Exception:
                            pass
                        self._find_path(msg.get_destination().hash, store, address, local_id, fresh=True)
                        if local_id in self._cancelled:
                            self._outbound.pop(local_id, None)
                            return
                        msg.delivery_attempts = 0
                        if hasattr(msg, "next_delivery_attempt"):
                            del msg.next_delivery_attempt
                        msg.packed = None
                        msg.state = LXMF.LXMessage.OUTBOUND
                        store.update(address, local_id, state="sending",
                                     error="Direct delivery failed once: trying again")
                        self.revision += 1
                        self.router.handle_outbound(msg)
                    threading.Thread(target=again, name="lxmf-repath", daemon=True).start()
                    return
                # NomadNet's try_propagation_on_fail: once, if a node is set
                # and the stamp did not fail.
                if (getattr(msg, "try_propagation_on_fail", None) and self.settings["propagation_fallback"]
                        and self.current_pn() and not getattr(msg, "stamp_generation_failed", False)):
                    msg.try_propagation_on_fail = None
                    msg.delivery_attempts = 0
                    if hasattr(msg, "next_delivery_attempt"):
                        del msg.next_delivery_attempt
                    msg.packed = None
                    msg.desired_method = LXMF.LXMessage.PROPAGATED
                    store.update(address, local_id, state="propagating", method="propagated",
                                 error="Direct delivery failed: leaving it on the propagation node")
                    self.revision += 1
                    print(f"💬 LXMF message to {label}: direct failed, trying the propagation node")
                    self._apply_propagation()
                    self.router.handle_outbound(msg)
                    return
                # Left on a node that did not take it: that node set aside,
                # and once more through the next one.
                if msg.desired_method == LXMF.LXMessage.PROPAGATED and not getattr(msg, "_rb_pn_retried", False):
                    node = self._outbound_pn()
                    self._pn_mark_failed(node, "a message was not taken")
                    self._apply_propagation()
                    nxt = self._outbound_pn()
                    if self.settings.get("propagation_failover") and nxt and nxt != node:
                        msg._rb_pn_retried = True
                        msg.delivery_attempts = 0
                        if hasattr(msg, "next_delivery_attempt"):
                            del msg.next_delivery_attempt
                        msg.packed = None
                        store.update(address, local_id, state="propagating", method="propagated",
                                     error="The propagation node did not take it: trying another one")
                        self.revision += 1
                        print(f"💬 LXMF message to {label}: node did not take it, trying another")
                        self.router.handle_outbound(msg)
                        return
                self._outbound.pop(local_id, None)
                store.update(address, local_id, state="failed",
                             error="Not delivered: the recipient did not answer"
                                   + ("" if msg.desired_method != LXMF.LXMessage.PROPAGATED
                                      else ", and the propagation node did not take it"))
                self.revision += 1
                print(f"💬 LXMF message to {label}: failed")

            message.register_delivery_callback(delivered)
            message.register_failed_callback(failed)
            # Saved identities only: an ephemeral identity never leaves
            # messages on a node, nor collects from one.
            if (not propagated and self.current_pn() and source is not None
                    and not self._is_ephemeral_source(source)):
                message.try_propagation_on_fail = True
            store.update(address, local_id, state="propagating" if propagated else "sending", error=None)
            self.revision += 1
            self._outbound[local_id] = message
            if local_id in self._cancelled:        # cancelled while this was being made
                self._outbound.pop(local_id, None)
                return
            if propagated:
                self._apply_propagation()        # the node of now (rotation, set aside)
            self.router.handle_outbound(message)
            if getattr(message, "hash", None):
                # The method LXMF really used (it may have left opportunistic).
                store.update(address, local_id, id=message.hash.hex(),
                             method={1: "opportunistic", 2: "direct", 3: "propagated"}.get(
                                 getattr(message, "method", None), "direct"))
            if LXMF.FIELD_IMAGE in fields or LXMF.FIELD_FILE_ATTACHMENTS in fields:
                threading.Thread(target=self._follow_progress, args=(message, local_id),
                                 name="lxmf-progress", daemon=True).start()
        except Exception as exc:
            store.update(address, local_id, state="failed", error=f"Could not send: {exc}")
            self.revision += 1

    def _find_path(self, dest_hash: bytes, store: Conversations, address: str, local_id: str,
                   fresh: bool = False) -> bool:
        """Asks the network for a path to the recipient and waits for it
        (PATH_WAIT at most, less if cancelled). True once there is one."""
        if not fresh and RNS.Transport.has_path(dest_hash):
            return True
        store.update(address, local_id, state="waiting", error=None if not fresh else
                     "Direct delivery failed: asking the network for a fresh path")
        self.revision += 1
        RNS.Transport.request_path(dest_hash)
        deadline = time.time() + PATH_WAIT
        while time.time() < deadline and local_id not in self._cancelled:
            if RNS.Transport.has_path(dest_hash):
                return True
            time.sleep(0.5)
        return False

    def _follow_progress(self, message: Any, local_id: str) -> None:
        """A message with files goes as an RNS Resource: its progress, for
        the bar under the bubble. Kept in memory only."""
        import LXMF
        final = {LXMF.LXMessage.DELIVERED, LXMF.LXMessage.SENT, LXMF.LXMessage.FAILED,
                 getattr(LXMF.LXMessage, "CANCELLED", -1), getattr(LXMF.LXMessage, "REJECTED", -1)}
        shown = -1.0
        deadline = time.time() + 6 * 3600
        while message.state not in final and time.time() < deadline:
            value = float(getattr(message, "progress", 0) or 0)
            if value - shown >= 0.02:
                shown = value
                self.progress[local_id] = round(min(1.0, value), 3)
                self.revision += 1
            time.sleep(0.5)
        self.progress.pop(local_id, None)
        self.revision += 1

    # ------------------------------------------------------------------ #
    # Receiving                                                          #
    # ------------------------------------------------------------------ #

    def _delivered(self, message: Any) -> None:
        # Into the conversations of the identity it was written to, whichever
        # is in use.
        target = getattr(message, "destination_hash", None)
        listener = self.listeners.get(target.hex()) if isinstance(target, (bytes, bytearray)) else None
        store = listener.store if listener is not None else (self.store if not self.listeners else None)
        if store is None:
            return
        try:
            import LXMF
            peer = message.source_hash.hex()
            fields = getattr(message, "fields", None) or {}
            # A reaction is not a message of its own: it goes on the one it is about.
            if LXMF.FIELD_REACTION in fields and not (message.content_as_string() or "").strip():
                self._incoming_reaction(store, peer, fields[LXMF.FIELD_REACTION])
                return
            record = {
                "local_id": os.urandom(8).hex(),
                "id": message.hash.hex() if message.hash else None,
                "dir": "in",
                "content": message.content_as_string() or "",
                "title": message.title_as_string() or "",
                "ts": float(message.timestamp or time.time()),
                "received": time.time(),
                "state": "received",
                "method": {1: "opportunistic", 2: "direct", 3: "propagated"}.get(message.method, "unknown"),
                # The sender's signature could not be checked: we do not
                # know its keys yet. Shown, and marked.
                "verified": bool(message.signature_validated),
            }
            name = self.peer_name(peer)
            # Already here (the same message again, e.g. from a sync): its
            # files must not be saved a second time.
            if record["id"] and store.has_id(peer, record["id"]):
                return
            # Sent again by the other client with another hash (seen 20/10:
            # "Ciao ricevuto" of the day before, again after a restart).
            if (record["content"] or record["title"]) and \
                    store.has_same(peer, record["ts"], record["content"], record["title"]):
                return
            files, unsupported = self._incoming_files(store, peer, name, record["local_id"], message)
            if files:
                record["files"] = files
            if unsupported:
                record["unsupported"] = unsupported
            renderer = fields.get(LXMF.FIELD_RENDERER)
            if renderer in (LXMF.RENDERER_MARKDOWN, LXMF.RENDERER_MICRON, LXMF.RENDERER_BBCODE):
                record["renderer"] = {LXMF.RENDERER_MARKDOWN: "markdown", LXMF.RENDERER_MICRON: "micron",
                                      LXMF.RENDERER_BBCODE: "bbcode"}[renderer]
            reply_to = fields.get(LXMF.FIELD_REPLY_TO)
            if isinstance(reply_to, (bytes, bytearray)) and len(reply_to) == 32:
                record["reply_to"] = bytes(reply_to).hex()
                quote = fields.get(LXMF.FIELD_REPLY_QUOTE, b"")
                if isinstance(quote, (bytes, bytearray)):
                    quote = bytes(quote).decode("utf-8", "replace")
                record["reply_quote"] = str(quote or "")[:REPLY_QUOTE_MAX]
            self._apply_appearance(peer, fields)
            store.add(peer, record, name=name, unread=True)
            self.incoming_seq += 1
            self.last_incoming = {"seq": self.incoming_seq, "peer": peer, "name": self.peer_label(peer),
                                  "preview": record["content"][:140], "ts": record["ts"]}
            if listener is not None:
                # Which of our identities it came to: the page says so when
                # it is not the one in use, and a click goes there.
                self.last_incoming.update(identity=listener.id, to=listener.address,
                                          identity_name=self._identity_label(listener),
                                          other=listener.destination is not self.destination)
            self.revision += 1
            print(f"💬 LXMF message from {self.peer_label(peer)}"
                  + (f", {len(files)} file{'s' if len(files) != 1 else ''}" if files else ""))
        except Exception as exc:
            print(f"⚠️ Could not store an incoming LXMF message: {exc}")
            return
        self._maybe_autoreply(peer, record, listener)

    def _identity_label(self, listener: Listener) -> str:
        if listener.ephemeral:
            return "Ephemeral"
        return self.browser.identities.name_of(listener.id)

    def _maybe_autoreply(self, peer: str, record: Dict[str, Any], listener: Optional[Listener] = None) -> None:
        """Rules, away, echo (rbrowser/autoreply.py): one reply at most, sent
        like any message of ours, so it shows in the chat - from the identity
        the message was written to."""
        try:
            destination = listener.destination if listener is not None else self.destination
            if destination is None or peer == destination.hash.hex() or peer in self.settings["blocked"]:
                return
            # Any of our own identities: never answer ourselves.
            if peer in self.listeners:
                return
            name = self.display_name_of(listener.id) if listener is not None else self.current_display_name()
            values = {"name": name or "Anonymous Peer",
                      "sender": self.peer_label(peer), "address": destination.hash.hex()}
            decision = self.autoreply.decide(self.settings, peer, record.get("content", ""),
                                             record.get("title", ""), record.get("ts") or 0, values)
            if decision is None:
                return
            title, text = decision
            result = self.send(peer, text, title=title, auto=True, via=listener)
            print(f"🤖 {title} to {self.peer_label(peer)}"
                  + ("" if result.get("status") == "success" else f": not sent, {result.get('error')}"))
        except Exception as exc:
            print(f"⚠️ Automatic reply: {exc}")

    def _apply_appearance(self, peer: str, fields: Dict[Any, Any]) -> None:
        """Sideband's icon for this contact: [icon name, fg 3 bytes, bg 3 bytes]."""
        import LXMF
        look = fields.get(LXMF.FIELD_ICON_APPEARANCE)
        try:
            icon, fg, bg = look[0], look[1], look[2]
            icon = icon.decode("utf-8", "replace") if isinstance(icon, bytes) else str(icon)
            entry = {"icon": re.sub(r"[^a-z0-9-]", "", icon.lower())[:48],
                     "fg": "#" + bytes(fg)[:3].hex(), "bg": "#" + bytes(bg)[:3].hex()}
        except Exception:
            return
        if len(entry["fg"]) != 7 or len(entry["bg"]) != 7:
            return
        with self.lock:
            if self.settings["appearances"].get(peer) != entry:
                self.settings["appearances"][peer] = entry
                self._save_settings()

    def _incoming_files(self, store: Conversations, peer: str, name: str, local_id: str,
                        message: Any) -> (List[Dict[str, Any]], List[str]):
        """FIELD_IMAGE and FIELD_FILE_ATTACHMENTS of a message received.
        Saved under downloads/<contact>/ with their own names; for the
        ephemeral identity kept in memory only."""
        import LXMF
        fields = getattr(message, "fields", None) or {}
        found = []                     # (name, bytes, is_image)
        image = fields.get(LXMF.FIELD_IMAGE)
        if isinstance(image, (list, tuple)) and len(image) >= 2 and isinstance(image[1], (bytes, bytearray)):
            kind = safe_filename(image[0], "jpg").lower().lstrip(".")[:8] or "jpg"
            stamp = time.strftime("%Y%m%d-%H%M%S")
            found.append((f"image-{stamp}.{kind}", bytes(image[1]), True))
        for entry in fields.get(LXMF.FIELD_FILE_ATTACHMENTS) or []:
            if isinstance(entry, (list, tuple)) and len(entry) >= 2 and isinstance(entry[1], (bytes, bytearray)):
                fname = entry[0].decode("utf-8", "replace") if isinstance(entry[0], bytes) else entry[0]
                found.append((safe_filename(fname), bytes(entry[1]), False))
        unsupported = []
        audio = fields.get(LXMF.FIELD_AUDIO)
        if audio is not None:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            mode = audio[0] if isinstance(audio, (list, tuple)) and len(audio) >= 2 else None
            data = bytes(audio[1]) if mode is not None and isinstance(audio[1], (bytes, bytearray)) else b""
            if mode == AM_OPUS_OGG and data[:4] == b"OggS":
                found.append((f"voice-{stamp}.ogg", data, False))
            elif mode in CODEC2_MODES and data:
                wav = codec2_to_wav(data, mode)
                if wav:
                    found.append((f"voice-{stamp}.wav", wav, False))
                else:
                    # Kept as it came: playable once ffmpeg is installed.
                    found.append((f"voice-{stamp}-codec2-{CODEC2_MODES[mode]}.c2", data, False))
                    unsupported.append("voice message in Codec2: install ffmpeg to play it")
            else:
                unsupported.append("voice message in a format rBrowser does not play")
        metas = []
        for index, (fname, data, is_image) in enumerate(found):
            try:
                if store.on_disk:
                    rel = self._save_download(name or peer[:16], fname, data)
                    metas.append(self._file_meta(fname, len(data), is_image, path=rel))
                else:
                    store.put_file(peer, local_id, index, data)
                    metas.append(self._file_meta(fname, len(data), is_image, index=index))
            except OSError as exc:
                print(f"⚠️ Could not save {fname} from {name or peer[:16]}: {exc}")
                metas.append(self._file_meta(fname, len(data), is_image, deleted=True,
                                             error=f"Not saved: {exc}"))
        return metas, unsupported

    @staticmethod
    def _save_download(contact: str, fname: str, data: bytes) -> str:
        """downloads/<contact>/<name>, "name (2).ext" when taken. Returns the
        path relative to downloads/."""
        folder_name = safe_filename(contact, "contact")
        folder = os.path.join(DOWNLOADS_DIR, folder_name)
        os.makedirs(folder, exist_ok=True)
        stem, dot, ext = fname.rpartition(".")
        if not dot:
            stem, ext = fname, ""
        candidate, n = fname, 1
        while True:
            try:
                # "x": never over a file already there, even one being written.
                with open(os.path.join(folder, candidate), "xb") as handle:
                    handle.write(data)
                return f"{folder_name}/{candidate}"
            except FileExistsError:
                n += 1
                candidate = f"{stem} ({n}){'.' + ext if ext else ''}"

    # ------------------------------------------------------------------ #
    # Files in the chat                                                  #
    # ------------------------------------------------------------------ #

    def _file_record(self, peer: Any, local_id: Any, index: Any):
        address = clean_address(peer)
        if not address or self.store is None or not _LOCAL_ID.match(str(local_id or "")):
            return None, None, None
        conv = self.store.data.get(address) or {}
        record = next((m for m in conv.get("messages", []) if m.get("local_id") == local_id), None)
        try:
            meta = (record or {}).get("files", [])[int(index)]
        except (IndexError, TypeError, ValueError):
            return address, record, None
        return address, record, meta

    def _download_path(self, meta: Dict[str, Any]) -> Optional[str]:
        rel = str(meta.get("path") or "")
        if not rel:
            return None
        root = os.path.abspath(DOWNLOADS_DIR)
        full = os.path.abspath(os.path.join(root, rel))
        # A path from our own records, checked anyway: never outside downloads/.
        return full if full.startswith(root + os.sep) else None

    def file_data(self, peer: Any, local_id: Any, index: Any):
        """(bytes, meta) of a file in a conversation, or (None, reason)."""
        address, record, meta = self._file_record(peer, local_id, index)
        if meta is None:
            return None, "No such file"
        if meta.get("deleted"):
            return None, "Deleted"
        path = self._download_path(meta)
        if path:
            try:
                with open(path, "rb") as handle:
                    return handle.read(), meta
            except OSError:
                return None, "The file is no longer in the downloads folder"
        data = self.store.get_file(address, local_id, meta.get("index", 0))
        return (data, meta) if data is not None else (None, "The copy is gone")

    def delete_file(self, peer: Any, local_id: Any, index: Any) -> Dict[str, Any]:
        address, record, meta = self._file_record(peer, local_id, index)
        if meta is None:
            return {"status": "error", "error": "No such file"}
        path = self._download_path(meta)
        try:
            if path and os.path.exists(path):
                os.remove(path)
            elif not path:
                key = f"{local_id}-{meta.get('index', 0)}"
                self.store.memory_files.pop(f"{address}/{key}", None)
                internal = os.path.join(self.store.files_dir, address, key)
                if self.store.on_disk and os.path.exists(internal):
                    os.remove(internal)
        except OSError as exc:
            return {"status": "error", "error": f"Could not delete it: {exc}"}
        with self.store.lock:
            meta["deleted"] = True
            self.store._save(address)
        self.revision += 1
        return {"status": "success"}

    def show_file(self, peer: Any, local_id: Any, index: Any) -> Dict[str, Any]:
        """Open the folder of a downloaded file on this computer, the file selected."""
        address, record, meta = self._file_record(peer, local_id, index)
        path = self._download_path(meta) if meta else None
        if not path or not os.path.exists(path):
            return {"status": "error", "error": "Not in the downloads folder"}
        import subprocess
        import sys
        try:
            if os.name == "nt":
                subprocess.Popen(["explorer", "/select,", path])
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", path])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(path)])
        except OSError as exc:
            return {"status": "error", "error": str(exc)}
        return {"status": "success"}

    # ------------------------------------------------------------------ #
    # For the API                                                        #
    # ------------------------------------------------------------------ #

    def status(self) -> Dict[str, Any]:
        ids = self.browser.identities
        rotates_in = None
        if self.using_ephemeral:
            mode = ids.state.get("ephemeral_mode")
            due = ids.next_rotation() if ids.active_id == EPHEMERAL else None
            rotates_in = {"mode": mode,
                          "seconds": None if due is None else max(0, round(due - time.time()))}
        # For the identity switch in the Messages tab.
        choices = []
        # Unread per identity: they all listen, and the page shows where a
        # message went when it is not the identity in use.
        unread_of = {l.address: l.store.unread_total() for l in self.listeners.values()}
        for profile in ids.state.get("profiles", []):
            identity = ids.identity_for(profile["id"])
            if identity is not None:
                address = RNS.Destination.hash(identity, "lxmf", "delivery").hex()
                choices.append({"id": profile["id"], "name": profile["name"],
                                "display_name": self.display_name_of(profile["id"]),
                                "address": address, "unread": unread_of.get(address, 0),
                                "listening": address in unread_of})
        if self.settings["allow_ephemeral"]:
            eph = ids.identity_for(EPHEMERAL)
            eph_address = RNS.Destination.hash(eph, "lxmf", "delivery").hex() if eph else ""
            choices.append({"id": EPHEMERAL, "name": "Ephemeral",
                            "display_name": self.display_name_of(EPHEMERAL),
                            "address": eph_address, "unread": unread_of.get(eph_address, 0),
                            "listening": eph_address in unread_of})
        return {
            "status": "success",
            # display_name: the name of the identity in use, for the page.
            "settings": {**self.settings, "display_name": self.current_display_name()},
            "identities": choices,
            "announce_choices": list(ANNOUNCE_CHOICES),
            "stamp_choices": list(STAMP_CHOICES),
            "nicknames": dict(self.settings["nicknames"]),
            "favorites": sorted(self.settings["favorites"]),
            "appearances": dict(self.settings["appearances"]),
            # Bumps on every LXMF announce heard: the open chat re-reads its
            # contact's name (an announce can bring one).
            "peers_revision": self.peers.revision,
            "quick_reactions": list(QUICK_REACTIONS),
            "stamp_cost_now": self.inbound_stamp_cost(),
            "attach_limits": {"bytes": MAX_ATTACH_BYTES, "files": MAX_ATTACH_FILES,
                              "propagation": PN_TYPICAL_LIMIT},
            "running": self.destination is not None,
            "address": self.destination.hash.hex() if self.destination is not None else None,
            "identity_name": ("Ephemeral" if self.using_ephemeral
                              else ids.name_of(self.settings["identity"])),
            "ephemeral": self.using_ephemeral,
            "ephemeral_rotation": rotates_in,
            "last_announce": self.last_announce or None,
            "unread": self.store.unread_total() if self.store else 0,
            "unread_other": sum(n for a, n in unread_of.items()
                                if self.destination is None or a != self.destination.hash.hex()),
            "listening": len(self.listeners),
            "incoming_transfers": self.incoming_transfers(),
            # For the chat tabs: unread per contact on every identity.
            "unread_peers": {l.id: {p: int(c.get("unread", 0)) for p, c in list(l.store.data.items())
                                    if c.get("unread")}
                             for l in self.listeners.values()},
            "incoming": self.last_incoming or {"seq": self.incoming_seq},
            "blocked": [{"address": a, "name": v.get("name", ""), "at": v.get("at")}
                        for a, v in sorted(self.settings["blocked"].items(),
                                           key=lambda kv: -(kv[1].get("at") or 0))],
            "colors": dict(self.settings["colors"]),
            "propagation": self.sync_status(),
            "revision": self.revision,
            "error": self.error,
        }

    def incoming_transfers(self) -> List[Dict[str, Any]]:
        """Messages with files still arriving (LXMF resources over a link):
        how far, how big, to which of our identities and, once the sender
        has identified on the link, from whom."""
        out: List[Dict[str, Any]] = []
        if self.router is None:
            return out
        try:
            resources = self.router.inbound_resources()
        except Exception:
            return out
        for resource in resources:
            try:
                link = getattr(resource, "link", None)
                to = link.destination.hash.hex() if link is not None and getattr(link, "destination", None) else ""
                listener = self.listeners.get(to)
                sender = None
                remote = link.get_remote_identity() if link is not None else None
                if remote is not None:
                    sender = RNS.Destination.hash(remote, "lxmf", "delivery").hex()
                out.append({
                    "id": resource.hash.hex(),
                    "progress": round(float(resource.get_progress() or 0), 3),
                    "size": int(resource.get_data_size() or resource.get_transfer_size() or 0),
                    "to": to,
                    "identity": listener.id if listener else None,
                    "identity_name": self._identity_label(listener) if listener else "",
                    "from": sender,
                    "from_name": self.peer_label(sender) if sender else "",
                })
            except Exception:
                continue
        return out

    def cancel_incoming(self, resource_id: Any) -> Dict[str, Any]:
        if self.router is None or not re.fullmatch(r"[0-9a-f]{64}", str(resource_id or "")):
            return {"status": "error", "error": "No such transfer"}
        if not self.router.cancel_inbound(bytes.fromhex(resource_id)):
            return {"status": "error", "error": "Already finished"}
        self.revision += 1
        return {"status": "success"}

    def conversations(self) -> List[Dict[str, Any]]:
        if self.store is None:
            return []
        rows = self.store.listing()
        for row in rows:
            if not row["name"]:
                row["name"] = self.peer_name(row["peer"])
        if self.settings["share_contacts"]:
            rows += self.shared_contacts()
        return rows

    def shared_contacts(self) -> List[Dict[str, Any]]:
        """Share contact list between identities: the conversations of every
        other saved identity, as they are - unread count, last message,
        time - each marked with the identity it belongs to (shared_from,
        shared_id). We listen on all of them, so all of them show; a
        conversation is opened, and answered, as its own identity. Our own
        addresses and the ephemeral identity are left out."""
        ours = set(self.listeners)
        rows: List[Dict[str, Any]] = []
        for listener in list(self.listeners.values()):
            if listener.ephemeral or listener.store is self.store:
                continue
            name = self.browser.identities.name_of(listener.id)
            for row in listener.store.listing():
                if row["peer"] in ours:
                    continue
                row["name"] = row["name"] or self.peer_name(row["peer"])
                row["shared_from"] = name
                row["shared_id"] = listener.id
                rows.append(row)
        return rows

    def messages(self, peer: Any) -> List[Dict[str, Any]]:
        address = clean_address(peer)
        if not address or self.store is None:
            return []
        name = self.peer_name(address)
        if name:
            self.store.set_name(address, name)
        rows = self.store.messages(address)
        for row in rows:
            if row.get("local_id") in self.progress:
                row["progress"] = self.progress[row["local_id"]]
        return rows

    def mark_read(self, peer: Any) -> None:
        address = clean_address(peer)
        if address and self.store is not None:
            self.store.mark_read(address)
            self.revision += 1

    def block(self, peer: Any, blocked: bool = True) -> Dict[str, Any]:
        """Drop (or accept again) messages from an address. LXMF's own
        ignore list does the dropping; the list is kept in the settings."""
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        with self.lock:
            if blocked:
                self.settings["blocked"][address] = {"name": self.peer_name(address), "at": time.time()}
            else:
                self.settings["blocked"].pop(address, None)
            self._save_settings()
            if self.router is not None:
                if blocked:
                    self.router.ignore_destination(bytes.fromhex(address))
                else:
                    self.router.unignore_destination(bytes.fromhex(address))
            self.revision += 1
        print(f"🚫 LXMF {address[:16]} {'blocked' if blocked else 'unblocked'}")
        return {"status": "success", "blocked": blocked}

    def set_color(self, peer: Any, hue: Any) -> Dict[str, Any]:
        """The avatar colour of a contact: a hue 0-359, or None for the one
        that comes from the address. Kept here, so every device shows it."""
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        if hue is not None and (isinstance(hue, bool) or not isinstance(hue, (int, float))):
            return {"status": "error", "error": "The colour is a hue from 0 to 359"}
        with self.lock:
            if hue is None:
                self.settings["colors"].pop(address, None)
            else:
                self.settings["colors"][address] = int(hue) % 360
            self._save_settings()
            self.revision += 1
        return {"status": "success", "colors": dict(self.settings["colors"])}

    def peer_info(self, peer: Any) -> Dict[str, Any]:
        """Everything known here about an LXMF address. Nothing is sent."""
        address = clean_address(peer)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        dest_hash = bytes.fromhex(address)
        identity = self._recall_recipient(dest_hash)
        identity_hash = identity.hash.hex() if identity is not None else None
        nodes = []
        if identity_hash:
            for entry in list(self.browser.nomadnet_nodes.values()):
                if entry.get("identity_hash") == identity_hash:
                    nodes.append({"hash": entry.get("hash"), "name": entry.get("name"),
                                  "hops": entry.get("hops"), "last_seen": entry.get("last_seen")})
        stamp_cost = None
        if self.router is not None:
            try:
                stamp_cost = self.router.get_outbound_stamp_cost(dest_hash)
            except Exception:
                stamp_cost = None
        conv = self.store.data.get(address) if self.store is not None else None
        messages = conv["messages"] if conv else []
        return {
            "status": "success",
            "address": address,
            "name": self.peer_name(address),
            "nickname": self.settings["nicknames"].get(address, ""),
            "identity_hash": identity_hash,
            "keys_known": identity is not None,
            "announced": rnsquiet.recall_app_data(dest_hash) is not None,
            "stamp_cost": stamp_cost,
            "nodes": nodes,
            "path": self.browser.check_path(address),
            "blocked": address in self.settings["blocked"],
            "messages_in": sum(1 for m in messages if m.get("dir") == "in"),
            "messages_out": sum(1 for m in messages if m.get("dir") == "out"),
            "first": messages[0]["ts"] if messages else None,
        }

    def conversation_owners(self, peer: Any) -> List[Dict[str, Any]]:
        """Our identities (listening now) that have a conversation with peer:
        a contact who wrote to several of them has one chat in each."""
        address = clean_address(peer)
        if not address:
            return []
        out = []
        for listener in list(self.listeners.values()):
            store = listener.store
            if store is not None and address in store.data:
                out.append({"address": listener.address, "name": self._identity_label(listener),
                            "active": store is self.store})
        return out

    def clear_conversation(self, peer: Any) -> bool:
        """Clear: the chat with peer of the identity in use emptied, the
        contact kept in the list (Delete takes it away)."""
        address = clean_address(peer)
        if not address or self.store is None:
            return False
        done = self.store.clear(address)
        if done:
            self.revision += 1
        return done

    def delete_conversation(self, peer: Any, everywhere: bool = False) -> bool:
        """The chat with peer of the identity in use; everywhere: of all of
        ours that have one."""
        address = clean_address(peer)
        if not address or self.store is None:
            return False
        stores = [self.store]
        if everywhere:
            stores += [l.store for l in list(self.listeners.values())
                       if l.store is not None and l.store is not self.store]
        done = False
        for store in stores:
            done = store.delete(address) or done
        if done:
            self.revision += 1
        return done


__all__ = ["Messenger", "clean_address", "ANNOUNCE_MIN_MINUTES", "ANNOUNCE_DEFAULT_MINUTES"]
