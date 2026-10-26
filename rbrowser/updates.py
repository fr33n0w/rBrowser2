"""Check for updates: version.txt here against the one on GitHub.

The file holds comments (#) and one line with the version, "2.0.0" - or
"2.0.0b" for a beta, which comes before 2.0.0 and after 1.x. Only
version.txt is read from GitHub, plus CHANGELOG.md when there is an update
(what is new, shown as text); nothing is downloaded or run: the page shows
the link and the command to update by hand.
"""

from __future__ import annotations

import os
import re
import time
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

REPO_URL = "https://github.com/fr33n0w/rBrowser2"
VERSION_URL = "https://raw.githubusercontent.com/fr33n0w/rBrowser2/main/version.txt"
CHANGELOG_URL = "https://raw.githubusercontent.com/fr33n0w/rBrowser2/main/CHANGELOG.md"
# What is shown of the changelog: a few versions, a few lines each, plain text.
NEWS_VERSIONS, NEWS_ITEMS, NEWS_CHARS = 5, 20, 400
UPDATE_COMMAND = "git pull"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_S = 600                       # GitHub asked at most every 10 minutes

_last: Dict[str, Any] = {}


def parse_version(text: str) -> str:
    for line in str(text or "").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line if re.fullmatch(r"\d+(\.\d+){0,3}(b\d*)?", line) else ""
    return ""


def _tuple(v: str) -> Tuple[int, ...]:
    """2.0.0b -> (2, 0, 0, 0, 0): a beta, before (2, 0, 0, 1, 0) = 2.0.0;
    2.0.0b2 after 2.0.0b. Missing parts count as 0 (2.0 == 2.0.0)."""
    if not v:
        return ()
    m = re.fullmatch(r"([\d.]+?)(?:b(\d*))?", v)
    if not m:
        return ()
    nums = [int(x) for x in m.group(1).split(".")] + [0] * 4
    beta = m.group(2) is not None or v.endswith("b")
    return tuple(nums[:4]) + ((0, int(m.group(2) or 0)) if beta else (1, 0))


def local_version() -> str:
    try:
        with open(os.path.join(HERE, "version.txt"), encoding="utf-8") as f:
            return parse_version(f.read()) or "?"
    except OSError:
        return "?"


_SECTION_RE = re.compile(r"##\s+v?(\d+(?:\.\d+){0,3}(?:b\d*)?)\b(.*)$")


def changelog_news(text: str, mine: str, remote: str) -> List[Dict[str, Any]]:
    """The CHANGELOG.md sections newer than mine, up to remote, newest
    first: [{'version', 'title', 'items': [...]}]. "## 2.0.1b - date" opens a
    section, "- text" is an item; anything else is skipped. Plain text only:
    the page escapes it."""
    news: List[Dict[str, Any]] = []
    section: Optional[Dict[str, Any]] = None
    for raw in str(text or "").splitlines():
        line = raw.strip()
        m = _SECTION_RE.match(line)
        if m:
            v = m.group(1)
            keep = _tuple(v) > _tuple(mine) and (not remote or _tuple(v) <= _tuple(remote))
            section = {"version": v, "title": m.group(2).strip(" -")[:60], "items": []} if keep else None
            if section is not None:
                news.append(section)
            continue
        if section is not None and line.startswith(("- ", "* ")) and len(section["items"]) < NEWS_ITEMS:
            section["items"].append(line[2:].strip()[:NEWS_CHARS])
    news.sort(key=lambda s: _tuple(s["version"]), reverse=True)
    return news[:NEWS_VERSIONS]


def check(force: bool = False) -> Dict[str, Any]:
    now = time.time()
    if not force and _last and now - _last.get("at", 0) < CACHE_S:
        return dict(_last)
    mine = local_version()
    out: Dict[str, Any] = {"status": "success", "local": mine, "remote": "", "update": False,
                           "repo": REPO_URL, "command": UPDATE_COMMAND, "at": now}
    try:
        req = urllib.request.Request(VERSION_URL, headers={"User-Agent": f"rBrowser/{mine}"})
        with urllib.request.urlopen(req, timeout=8) as r:
            remote = parse_version(r.read(4096).decode("utf-8", "replace"))
        out["remote"] = remote
        out["update"] = bool(remote) and mine != "?" and _tuple(remote) > _tuple(mine)
        if out["update"]:
            # What is new: a missing or unreadable changelog is no error.
            try:
                req = urllib.request.Request(CHANGELOG_URL, headers={"User-Agent": f"rBrowser/{mine}"})
                with urllib.request.urlopen(req, timeout=8) as r:
                    out["news"] = changelog_news(r.read(65536).decode("utf-8", "replace"), mine, remote)
            except Exception:
                out["news"] = []
    except Exception as exc:
        out = {**out, "status": "error", "error": f"GitHub not reachable: {exc}"}
    _last.clear()
    _last.update(out)
    return dict(out)


def cached() -> Optional[Dict[str, Any]]:
    return dict(_last) if _last else None
