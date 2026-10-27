"""Update rBrowser from the page: git pull in its own folder.

Only for a folder made with git clone and with git on the PATH; a zip or the
Docker image is updated by hand (Settings > About says how). The pull is
--ff-only: with files changed by hand it stops and names them, nothing is
stashed or reset, they are the user's. After the pull the page restarts
rBrowser through /api/restart; if requirements.txt changed it asks for pip
first instead (installing packages is left to the user).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PULL_TIMEOUT = 300                  # s: a pull that takes longer is stopped
# "Receiving objects:  45% (9/20)": git's own progress lines, on stderr.
_PROGRESS = re.compile(r"([A-Za-z][A-Za-z ]+):\s+(\d{1,3})%")

_lock = threading.Lock()
_state: Dict[str, Any] = {"state": "idle"}


def _git() -> Optional[str]:
    return shutil.which("git")


def _run(args: List[str], timeout: float = 30) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C", LANG="C")
    return subprocess.run([_git() or "git", *args], cwd=HERE, env=env, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)


def availability() -> Dict[str, Any]:
    """Can the page update this copy? With the reason when it cannot."""
    if os.path.exists("/.dockerenv"):
        return {"can": False, "reason": "Docker: update with git pull and bash docker.sh"}
    if not os.path.isdir(os.path.join(HERE, ".git")):
        return {"can": False, "reason": "Not a git clone: update by hand (see How to update)"}
    if not _git():
        return {"can": False, "reason": "git is not installed: update by hand (see How to update)"}
    return {"can": True, "reason": ""}


def local_changes() -> List[str]:
    """Files changed by hand that a pull could not go over (tracked only:
    new files of the user's are left alone, git says if one is in the way)."""
    r = _run(["status", "--porcelain", "--untracked-files=no"])
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or "git status failed")
    return [line[3:].strip() for line in r.stdout.splitlines() if line.strip()]


def status() -> Dict[str, Any]:
    with _lock:
        return dict(_state)


def _set(**kw: Any) -> None:
    with _lock:
        _state.update(kw)


def start() -> Dict[str, Any]:
    """Start the pull in the background; the page follows it with status()."""
    can = availability()
    if not can["can"]:
        return {"status": "error", "error": can["reason"]}
    with _lock:
        if _state.get("state") == "running":
            return {"status": "error", "error": "An update is already running"}
        _state.clear()
        _state.update(state="running", phase="Starting", percent=0, started=time.time())
    threading.Thread(target=_pull, name="rbrowser-update", daemon=True).start()
    return {"status": "success"}


def _pull() -> None:
    try:
        changed = local_changes()
        if changed:
            shown = ", ".join(changed[:8]) + (" ..." if len(changed) > 8 else "")
            _set(state="error", error=f"Files changed by hand in the rBrowser folder: {shown}. "
                                      f"Put them back (git stash, or git checkout -- <file>) "
                                      f"and try again, or update by hand.")
            return
        before = _run(["rev-parse", "HEAD"]).stdout.strip()
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C", LANG="C")
        proc = subprocess.Popen([_git() or "git", "pull", "--ff-only", "--progress"], cwd=HERE, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        killer = threading.Timer(PULL_TIMEOUT, proc.kill)
        killer.start()
        tail: List[str] = []
        buf = b""
        try:
            # Progress lines end with \r (rewritten in place), the rest with \n.
            while True:
                ch = proc.stderr.read(1)
                if not ch:
                    break
                if ch in (b"\r", b"\n"):
                    line = buf.decode("utf-8", "replace").strip()
                    buf = b""
                    if not line:
                        continue
                    m = _PROGRESS.search(line)
                    if m:
                        _set(phase=m.group(1).strip(), percent=min(100, int(m.group(2))))
                    else:
                        tail = (tail + [line])[-6:]
                else:
                    buf += ch
            out = proc.stdout.read().decode("utf-8", "replace")
            code = proc.wait()
        finally:
            killer.cancel()
        if code != 0:
            why = " ".join(tail[-3:]) or out.strip() or f"git pull ended with code {code}"
            _set(state="error", error=f"git pull failed: {why}")
            return
        after = _run(["rev-parse", "HEAD"]).stdout.strip()
        files: List[str] = []
        if before and after and before != after:
            files = [f for f in _run(["diff", "--name-only", before, after]).stdout.splitlines() if f]
        _set(state="done", percent=100, phase="Done", updated=before != after, files=len(files),
             requirements="requirements.txt" in files)
    except Exception as exc:
        _set(state="error", error=f"Update failed: {exc}")
