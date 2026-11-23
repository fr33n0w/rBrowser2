"""
Guest actions log (Settings > Access & Remote > Guest mode > Log guest actions).

One line per thing a guest does: pages opened, files downloaded, messages
sent, chat lines, refused requests. Polling and the page's own bookkeeping
are left out. The login page tells guests when this is on.
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import Any, Optional

DEFAULT_PATH = os.path.join("logs", "guest_actions.log")
MAX_BYTES = 5 * 1024 * 1024         # then the file moves to .1 and starts again
TEXT_MAX = 300
SHOW_BYTES = 256 * 1024             # what the Open log window shows (the end)

_lock = threading.Lock()

# Requests the page makes by itself: not actions.
_SKIP = ("/api/nomadnet/tabs", "/api/rmap/refresh", "/api/hash-kind/", "/api/lxmf-check/",
         "/api/download/cancel/", "/api/rrc/read/", "/api/messenger/read/", "/api/messenger/sync/cancel",
         "/api/ui-prefs", "/api/node-sort", "/api/guest/bye")


def is_bookkeeping(path: str) -> bool:
    """A request the page makes by itself, not an action of the guest."""
    return any(path.startswith(p) for p in _SKIP)


def resolve(path: Optional[str]) -> str:
    return os.path.abspath(path or DEFAULT_PATH)


def _short(text: Any) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= TEXT_MAX else text[:TEXT_MAX] + "..."


def write(path: Optional[str], address: str, text: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {address or '?'}  {text}\n"
    target = resolve(path)
    with _lock:
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.exists(target) and os.path.getsize(target) > MAX_BYTES:
                os.replace(target, target + ".1")
            with open(target, "a", encoding="utf-8") as handle:
                handle.write(line)
        except OSError as exc:
            print(f"⚠️ guest log not written ({target}): {exc}")


_HASH = re.compile(r"\b[0-9a-f]{32}\b")


def name_hashes(line: str, name_of) -> str:
    """'hash' -> 'hash [Name]' for every hash whose name is known."""
    def named(match):
        try:
            name = " ".join(str(name_of(match.group(0)) or "").split())[:60]
        except Exception:
            name = ""
        name = name.replace("[", "(").replace("]", ")")
        return f"{match.group(0)} [{name}]" if name and name != match.group(0) else match.group(0)
    return _HASH.sub(named, line)


def describe(request, status: int, lxmf_text: bool = False) -> Optional[str]:
    """The log line for one guest request, or None if it is not an action.
    lxmf_text: with the text of LXMF messages (its own switch, off by default)."""
    path, method = request.path, request.method.upper()
    if any(path.startswith(p) for p in _SKIP):
        return None
    parts = path.strip("/").split("/")
    data = request.get_json(silent=True) if request.is_json else None
    data = data if isinstance(data, dict) else {}
    failed = "" if status < 400 else f"  [HTTP {status}]"
    target = parts[-1] if len(parts) > 2 else ""
    if path.startswith("/api/fetch/"):
        line = f"Page {target}:{request.args.get('path', '/page/index.mu')}"
        if method == "POST":
            fields = ", ".join(f"{k}={_short(v)}" for k, v in data.items())
            line += f"  form: {_short(fields)}"
        return line + failed
    if path.startswith("/api/download/") and path.endswith("/start"):
        return f"Download {parts[2]}:{request.args.get('path', '')}" + failed
    if method in ("GET", "HEAD", "OPTIONS"):
        return None
    if path == "/api/messenger/send":
        form = request.form if request.files else data
        files = [f.filename for f in request.files.getlist("file")] if request.files else []
        line = f"LXMF to {form.get('peer', '')}"
        if lxmf_text:
            line += f": {_short(form.get('content', ''))}"
            if files:
                line += f"  files: {_short(', '.join(files))}"
        elif files:
            line += f"  {len(files)} file{'s' if len(files) != 1 else ''}"
        return line + failed
    if path.startswith("/api/rrc/"):
        action, room = parts[2], data.get("room")
        where = f"RRC {target}" + (f" {room}" if room else "")
        if action == "input":
            return f"{where}: {_short(data.get('text', ''))}" + failed
        return f"{where} {action}" + failed
    if path.startswith("/api/retibbs/"):
        if parts[2] == "send":
            return f"BBS {target}: {_short(data.get('text', ''))}" + failed
        return f"BBS {target} {parts[2]}" + failed
    if path.startswith("/api/messenger/"):
        extra = data.get("reaction") or data.get("nickname") or ""
        if not lxmf_text and data.get("reaction"):
            extra = ""
        return f"LXMF {' '.join(parts[2:])}" + (f": {_short(extra)}" if extra else "") + failed
    if path.startswith("/api/fingerprint/"):
        return f"Identify to {target} (guest identity)" + failed
    if path.startswith(("/api/ping/", "/api/path/")):
        return f"{parts[1].capitalize()} {target}" + failed
    return f"{method} {path}" + failed


def read(path: Optional[str]) -> dict:
    target = resolve(path)
    try:
        size = os.path.getsize(target)
        with open(target, "rb") as handle:
            if size > SHOW_BYTES:
                handle.seek(size - SHOW_BYTES)
            text = handle.read().decode("utf-8", "replace")
        if size > SHOW_BYTES:
            text = text.split("\n", 1)[-1]
    except FileNotFoundError:
        size, text = 0, ""
    except OSError as exc:
        return {"status": "error", "error": str(exc), "path": target}
    return {"status": "success", "path": target, "size": size, "text": text, "cut": size > SHOW_BYTES}


def clear(path: Optional[str]) -> dict:
    target = resolve(path)
    with _lock:
        try:
            if os.path.exists(target):
                open(target, "w", encoding="utf-8").close()
            if os.path.exists(target + ".1"):
                os.remove(target + ".1")
        except OSError as exc:
            return {"status": "error", "error": str(exc), "path": target}
    return {"status": "success", "path": target}
