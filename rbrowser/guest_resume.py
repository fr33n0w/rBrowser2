"""
Guest sessions across a restart of rBrowser: at a clean stop the guests in (or away) are
written to settings/guest_resume.json - identity key, place, names, LXMF chats, RRC rooms - and read back
at the next start, the file deleted at once. Back as away: a guest returning within AWAY_KEEP
finds everything as it was, otherwise it all goes as for any session away too long.
After a crash there is no file: a guest coming back is sent to the login (routes.py, "lost").
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any, Dict, List

import RNS

from .guest_identity import GuestEntry
from .guest_sessions import TIMEOUT

RESUME_FILE = os.path.join("settings", "guest_resume.json")
ROW_KEYS = ("address", "agent", "since", "clients", "device")


def _chats(browser: Any, gid: str) -> Dict[str, Any]:
    messenger = getattr(browser, "messenger", None)
    listener = messenger.guest_listener(gid) if messenger is not None else None
    if listener is None:
        return {}
    store = listener.store
    with store.lock:
        return {"data": store.data,
                "files": {k: base64.b64encode(v).decode() for k, v in store.memory_files.items()}}


def _rooms(browser: Any, gid: str) -> Dict[str, List[str]]:
    rrc = getattr(browser, "rrc", None)
    try:
        return rrc.guest_rooms(gid) if rrc is not None else {}
    except Exception:
        return {}


def save(browser: Any, auth: Any) -> int:
    """At a clean stop. The number of guest sessions written."""
    keys = getattr(browser, "guest_identity", None)
    if auth is None or keys is None or not auth.guest_on():
        return 0
    guests: List[Dict[str, Any]] = []
    for entry in keys.list():
        row = auth.guests.rows.get(entry.gid)
        if row is None:
            continue
        guests.append({"gid": entry.gid, "slot": entry.slot, "key": entry.identity.get_private_key().hex(),
                       "names": entry.names, "ready": entry.ready, "no_lxmf": entry.no_lxmf,
                       "since": entry.since, "row": {k: row[k] for k in ROW_KEYS if k in row},
                       "chats": _chats(browser, entry.gid), "rrc": _rooms(browser, entry.gid)})
    if not guests:
        return 0
    from .fileio import atomic_write_json
    os.makedirs(os.path.dirname(RESUME_FILE), exist_ok=True)
    atomic_write_json(RESUME_FILE, {"saved": time.time(), "epoch": auth.data["guest_epoch"], "guests": guests})
    print(f"👤 {len(guests)} guest session{'s' if len(guests) != 1 else ''} kept for the restart")
    return len(guests)


def load(browser: Any, auth: Any) -> int:
    """At start: the saved sessions back, away. The file goes whatever is in it."""
    try:
        with open(RESUME_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return 0
    finally:
        try:
            os.remove(RESUME_FILE)
        except OSError:
            pass
    keys = getattr(browser, "guest_identity", None)
    # Guest access closed or changed since: those sessions are over anyway.
    if (auth is None or keys is None or not auth.guest_on() or not isinstance(data, dict)
            or data.get("epoch") != auth.data["guest_epoch"]):
        return 0
    now, back = time.time(), 0
    for g in data.get("guests") or []:
        try:
            identity = RNS.Identity.from_bytes(bytes.fromhex(g["key"]))
            gid = str(g["gid"])
            if identity is None or not gid or auth.is_kicked({"gid": gid}):
                continue
            entry = GuestEntry(gid, int(g["slot"]), identity)
            entry.names = {str(k): str(v) for k, v in (g.get("names") or {}).items()}
            entry.ready, entry.no_lxmf = bool(g.get("ready")), bool(g.get("no_lxmf"))
            entry.since = float(g.get("since") or now)
            entry.resume_chats = g.get("chats") or None
            entry.resume_rrc = {str(k): [str(n) for n in v] for k, v in (g.get("rrc") or {}).items()
                                if isinstance(v, list)}
        except Exception as exc:
            print(f"⚠️ Guest session not resumed: {exc}")
            continue
        with keys.lock:
            if gid in keys.entries or entry.slot in {e.slot for e in keys.entries.values()}:
                continue
            keys.entries[gid] = entry
        row = {k: v for k, v in (g.get("row") or {}).items() if k in ROW_KEYS}
        row.setdefault("clients", [])
        # Away from now: AWAY_KEEP to come back, as for any session gone silent.
        row.update(id=gid, last=now - TIMEOUT - 1, away=now)
        row.setdefault("since", entry.since)
        with auth.guests.lock:
            auth.guests.rows[gid] = row
        back += 1
    if back:
        print(f"👤 {back} guest session{'s' if back != 1 else ''} back from before the restart (away)")
    return back


def restore_chats(entry: Any, store: Any) -> None:
    """The messenger making the guest's listener: its chats from before the restart, once."""
    chats = getattr(entry, "resume_chats", None)
    if not chats:
        return
    entry.resume_chats = None
    with store.lock:
        if isinstance(chats.get("data"), dict):
            store.data.update(chats["data"])
        for key, value in (chats.get("files") or {}).items():
            try:
                store.memory_files[key] = base64.b64decode(value)
            except Exception:
                pass
