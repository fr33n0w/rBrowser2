"""
On-disk cache of pages the user has actually visited.

This is deliberately not the crawler that version 1 shipped with. Nothing
here ever reaches for a page on its own: a page enters the cache because
somebody asked for it and it arrived. The cache then does two things that
matter on a slow network - it can answer instantly from disk the way
NomadNet does, and it gives you something to search through later.

Layout on disk, one directory per node:

    cache/pages/<node hash>/index.json        one record per page
    cache/pages/<node hash>/<page id>.mu      the page as it arrived

The page id is a hash of the request path, because a path contains
characters a filesystem will not take and can be longer than a filename is
allowed to be.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------- #
# A page as readable text, for titles and search snippets                #
# ---------------------------------------------------------------------- #

# Characters pages draw with, not write with: box drawing and blocks,
# geometric shapes, Braille (used for logos), legacy computing symbols, the
# private use area (icon fonts). Built from code points: no escapes to get wrong.
_ART_RANGES = ((0x2500, 0x25FF), (0x2800, 0x28FF), (0x1FB00, 0x1FBFF), (0xE000, 0xF8FF))
_ART = re.compile("[" + "".join(f"{re.escape(chr(a))}-{re.escape(chr(b))}" for a, b in _ART_RANGES) + "]+")
# Micron: a link keeps its label (or its address), a field disappears, the
# formatting tags go: colours `Fxxx `Bxxx (and 24-bit `FTxxxxxx), resets,
# bold/italic/underline, alignment, literal.
_MU_LINK_LABEL = re.compile(r"`\[([^`\]]*)`[^\]]*\]")
_MU_LINK_BARE = re.compile(r"`\[([^\]]*)\]")
_MU_FIELD = re.compile(r"`<[^>]*>")
_MU_TAG = re.compile(r"`(?:[FB]T[0-9a-fA-F]{6}|[FB][0-9a-fA-F]{3}|[FBfbclra!*_=`])?")


def plain_line(line: str) -> str:
    """One line of Micron as the words a reader sees."""
    text = _MU_LINK_LABEL.sub(r" \1 ", line)
    text = _MU_LINK_BARE.sub(r" \1 ", text)
    text = _MU_FIELD.sub(" ", text)
    text = _MU_TAG.sub("", text)
    text = _ART.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def plain_text(content: str) -> str:
    """A page's readable text on one line: no header directives (#!c=0),
    no comments, no section dividers, no drawings."""
    kept = []
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or re.fullmatch(r"-.?", stripped):
            continue
        plain = plain_line(stripped.lstrip(">"))
        if plain:
            kept.append(plain)
    return " ".join(kept)


def has_words(text: str) -> bool:
    """At least three letters: a title, not a stray symbol."""
    return len(re.findall(r"[^\W\d_]", text)) >= 3

# rBrowser's own failure messages, which older versions passed off as page
# content and saved over the good copy. Never stored, and a copy that is
# one of them counts as no copy.
_FAILURE_TEXT = re.compile(r"^(Request failed|Request timeout( on cached link)?|"
                           r"(Request|Response) error: .*)$", re.S)


def is_failure_text(content: str) -> bool:
    return bool(_FAILURE_TEXT.match(content.strip()))


# The page NomadNet makes up when a node serves pages but has no index.mu
# (nomadnet/Node.py). It says nothing about the node, and saved it would
# stand in for the real home page once the operator writes one.
_PLACEHOLDER_MARK = "the home page file (index.mu) was not found in the page storage directory"


def is_placeholder(content: str) -> bool:
    return _PLACEHOLDER_MARK in content


# NomadNet's answer to a request the node refuses (DEFAULT_NOTALLOWED in
# nomadnet/Node.py): a page that wants identification, asked for without it.
# The whole page only - a real page may well quote the sentence.
_NOT_ALLOWED = ">Request Not Allowed\n\nYou are not authorised to carry out the request."


def is_not_allowed(content: str) -> bool:
    return content.replace("\r\n", "\n").strip() == _NOT_ALLOWED


def not_worth_saving(content: str) -> bool:
    return is_failure_text(content) or is_placeholder(content) or is_not_allowed(content)


class PageCache:
    """Stores and searches pages that have been visited."""

    DEFAULT_SETTINGS = {
        "enabled": True,
        # Show the stored copy immediately and do not go to the network,
        # which is what NomadNet does. Reload always refetches.
        "serve_from_cache": True,
        "max_age_days": 30,
        "max_total_mb": 50,
        "search_limit": 50,
        # The Local Search Engine opens in a tab (else a window over the
        # page). Here and not in the browser: the same from every address.
        "search_in_tab": False,
    }

    SETTINGS_FILE = os.path.join("settings", "cache_settings.json")

    # How long a stored page may stand in for the live one, as NomadNet
    # decides it: the node says so in a "#!c=<seconds>" first line, 0 means
    # never (dynamic pages), and without the header it is 12 hours. Past
    # that the page is fetched again; the copy is still kept for search and
    # for when the node cannot be reached.
    DEFAULT_PAGE_CACHE_TIME = 12 * 60 * 60

    @classmethod
    def page_cache_time(cls, content: str) -> int:
        if content[:4] == "#!c=":
            end = content.find("\n")
            try:
                return max(0, int(content[4:end if end >= 0 else len(content)].strip()))
            except ValueError:
                pass
        return cls.DEFAULT_PAGE_CACHE_TIME

    def __init__(self, root: str = os.path.join("cache", "pages")) -> None:
        self.root = root
        self.lock = threading.Lock()
        self.settings: Dict[str, Any] = dict(self.DEFAULT_SETTINGS)
        self._load_settings()
        try:
            os.makedirs(self.root, exist_ok=True)
        except OSError as exc:
            print(f"Could not create the page cache directory: {exc}")

    # ---------------------------------------------------------------- #
    # Settings                                                         #
    # ---------------------------------------------------------------- #

    def _load_settings(self) -> None:
        try:
            with open(self.SETTINGS_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            if isinstance(stored, dict):
                for key in self.DEFAULT_SETTINGS:
                    if key in stored:
                        self.settings[key] = stored[key]
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Ignoring unreadable cache settings ({exc}), using defaults")

    def save_settings(self, incoming: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if incoming:
            for key, value in incoming.items():
                if key not in self.DEFAULT_SETTINGS:
                    continue
                default = self.DEFAULT_SETTINGS[key]
                if isinstance(default, bool):
                    self.settings[key] = bool(value)
                else:
                    try:
                        self.settings[key] = max(0, int(value))
                    except (TypeError, ValueError):
                        pass
        try:
            os.makedirs(os.path.dirname(self.SETTINGS_FILE), exist_ok=True)
            with open(self.SETTINGS_FILE, "w", encoding="utf-8") as handle:
                json.dump(self.settings, handle, indent=2)
        except OSError as exc:
            print(f"Could not save cache settings: {exc}")
        return dict(self.settings)

    # ---------------------------------------------------------------- #
    # Paths                                                            #
    # ---------------------------------------------------------------- #

    @staticmethod
    def _safe_hash(node_hash: str) -> Optional[str]:
        """A node hash is 32 hex characters and nothing else. Anything that
        is not goes no further: these values end up as directory names."""
        cleaned = str(node_hash).replace("<", "").replace(">", "").replace(":", "").strip().lower()
        return cleaned if re.fullmatch(r"[0-9a-f]{32}", cleaned) else None

    @staticmethod
    def _page_id(path: str) -> str:
        return hashlib.sha256(path.encode("utf-8")).hexdigest()[:24]

    def _node_dir(self, node_hash: str) -> Optional[str]:
        safe = self._safe_hash(node_hash)
        return os.path.join(self.root, safe) if safe else None

    def _index_path(self, node_dir: str) -> str:
        return os.path.join(node_dir, "index.json")

    def _read_index(self, node_dir: str) -> Dict[str, Any]:
        try:
            with open(self._index_path(node_dir), "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        except OSError:
            return {}

    def _read_index_cached(self, node_dir: str) -> Dict[str, Any]:
        """The index for reading only (search, list): kept in memory, dropped
        when this process writes or deletes it. 375 files opened at every
        search key were most of its time."""
        cache = self.__dict__.setdefault("_index_cache", {})
        if node_dir not in cache:
            cache[node_dir] = self._read_index(node_dir)
        return cache[node_dir]

    def _write_index(self, node_dir: str, index: Dict[str, Any]) -> None:
        self.__dict__.get("_index_cache", {}).pop(node_dir, None)
        texts = self.__dict__.get("_text_cache", {})
        for f in [f for f in texts if os.path.dirname(f) == node_dir]:
            texts.pop(f, None)
        tmp = self._index_path(node_dir) + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(index, handle, indent=1)
            os.replace(tmp, self._index_path(node_dir))
        except OSError as exc:
            print(f"Could not write the cache index: {exc}")
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    # ---------------------------------------------------------------- #
    # Store and fetch                                                  #
    # ---------------------------------------------------------------- #

    def store(self, node_hash: str, path: str, content: str,
              node_name: str = "", operator: Optional[Dict[str, str]] = None,
              partial: bool = False) -> bool:
        """
        Remember a page that has just been fetched.

        The operator's name and address are recorded alongside it so a
        search can find a page by who runs the node, not only by what the
        page says.
        """
        if not self.settings.get("enabled", True):
            return False
        if not isinstance(content, str) or not content.strip() or not_worth_saving(content):
            return False

        node_dir = self._node_dir(node_hash)
        if not node_dir:
            return False

        with self.lock:
            try:
                os.makedirs(node_dir, exist_ok=True)
                page_id = self._page_id(path)
                # Bytes, exactly as they arrived. Text mode on Windows turned
                # every "\n" into "\r\n", and a page sent with "\r\n" came
                # back from disk with a blank line after every line, which
                # tore ASCII art apart.
                with open(os.path.join(node_dir, page_id + ".mu"), "wb") as handle:
                    handle.write(content.encode("utf-8"))

                index = self._read_index(node_dir)
                entry = index.get(page_id, {})
                operator = operator or {}
                title, title_is_heading = self._extract_title(content)
                index[page_id] = {
                    "path": path,
                    "title": title or entry.get("title", ""),
                    "title_is_heading": title_is_heading,
                    "node_name": node_name or entry.get("node_name", ""),
                    # Keep what was known before if this visit did not carry
                    # it: an operator name can arrive after the first visit.
                    "operator_name": operator.get("name") or entry.get("operator_name", ""),
                    "operator_lxmf_address": (operator.get("address")
                                              or entry.get("operator_lxmf_address", "")),
                    "cached_at": time.time(),
                    "first_cached": entry.get("first_cached", time.time()),
                    "size": len(content.encode("utf-8")),
                    "visits": entry.get("visits", 0) + 1,
                    "cache_time": self.page_cache_time(content),
                    # Included in other pages and always read live; kept
                    # only for search and for when the node is offline.
                    # Once seen as a partial, it stays one.
                    "partial": bool(partial or entry.get("partial")),
                    # Written as bytes; entries without it are the old
                    # text-mode files, see _read_page.
                    "exact": True,
                }
                self._write_index(node_dir, index)
                return True
            except OSError as exc:
                print(f"Could not cache {path}: {exc}")
                return False

    def fetch(self, node_hash: str, path: str) -> Optional[Dict[str, Any]]:
        """The stored copy, or None. Expiry is applied here rather than by a
        sweep, so a stale page is never served even if nothing has pruned."""
        node_dir = self._node_dir(node_hash)
        if not node_dir:
            return None

        page_id = self._page_id(path)
        page_file = os.path.join(node_dir, page_id + ".mu")
        if not os.path.exists(page_file):
            return None

        index = self._read_index(node_dir)
        entry = index.get(page_id, {})
        cached_at = entry.get("cached_at", 0)

        max_age = self.settings.get("max_age_days", 0)
        if max_age and cached_at and (time.time() - cached_at) > max_age * 86400:
            return None

        content = self._read_page(page_file, entry)
        if content is None or not_worth_saving(content):
            return None

        age = time.time() - cached_at if cached_at else None
        cache_time = entry.get("cache_time")
        if not isinstance(cache_time, int):
            cache_time = self.page_cache_time(content)
        return {
            "content": content,
            "cached_at": cached_at,
            "age_seconds": age,
            "title": entry.get("title", ""),
            "path": entry.get("path", path),
            "node_name": entry.get("node_name", ""),
            "cache_time": cache_time,
            # May it be shown instead of fetching? Only within the time the
            # page itself allows - NomadNet's rule.
            "fresh": bool(cache_time and age is not None and age < cache_time),
        }

    @staticmethod
    def _read_page(page_file: str, entry: Dict[str, Any]) -> Optional[str]:
        """
        A stored page as it arrived from the node.

        Files written before "exact" went through text mode, which on
        Windows wrote "\\n" as "\\r\\n" ("\\r\\n" as "\\r\\r\\n"). That is
        undone exactly by turning every "\\r\\n" back into "\\n"; a lone
        "\\r" was written as it was.
        """
        try:
            with open(page_file, "rb") as handle:
                data = handle.read()
        except OSError:
            return None
        if not entry.get("exact") and os.name == "nt":
            data = data.replace(b"\r\n", b"\n")
        return data.decode("utf-8", errors="replace")

    def node_pages(self, node_hash: str) -> List[Dict[str, Any]]:
        """One node's saved pages, newest first, with whether each may
        still be shown instead of fetching. For the node info panel."""
        node_dir = self._node_dir(node_hash)
        if not node_dir or not os.path.isdir(node_dir):
            return []
        now = time.time()
        max_age = self.settings.get("max_age_days", 0)
        pages = []
        for page_id, entry in self._read_index(node_dir).items():
            if not isinstance(entry, dict):
                continue
            page_file = os.path.join(node_dir, page_id + ".mu")
            if not os.path.exists(page_file):
                continue
            cached_at = entry.get("cached_at", 0)
            age = now - cached_at if cached_at else None
            if max_age and age is not None and age > max_age * 86400:
                continue
            cache_time = entry.get("cache_time")
            if not isinstance(cache_time, int):
                cache_time = self.page_cache_time(self._read_page(page_file, entry) or "")
            pages.append({
                "path": entry.get("path", ""),
                "title": entry.get("title", ""),
                "size": entry.get("size", 0),
                "visits": entry.get("visits", 0),
                "age_seconds": age,
                "cache_time": cache_time,
                "fresh": bool(cache_time and age is not None and age < cache_time),
                "partial": bool(entry.get("partial")),
            })
        pages.sort(key=lambda p: p["age_seconds"] if p["age_seconds"] is not None else 1e12)
        return pages

    def summary(self) -> Dict[str, Dict[str, int]]:
        """Per node: pages saved, and how many a visit would take from the
        cache now. For the dots of the node list."""
        out: Dict[str, Dict[str, int]] = {}
        if not os.path.isdir(self.root):
            return out
        for name in os.listdir(self.root):
            if not self._safe_hash(name):
                continue
            pages = self.node_pages(name)
            if pages:
                live_only = sum(1 for p in pages if p["partial"] or not p["cache_time"])
                usable = sum(1 for p in pages if p["fresh"] and not p["partial"])
                out[name] = {
                    "count": len(pages),
                    # Would open from the cache now.
                    "usable": usable,
                    # Always read live: partials and #!c=0 pages.
                    "live_only": live_only,
                    # Older than the node allows: the next visit reloads them.
                    "expired": len(pages) - usable - live_only,
                }
        return out

    def known_name(self, node_hash: str) -> str:
        """
        The node's name as stored with any of its cached pages, or "".
        Used when the node has not announced since rBrowser started: its
        pages can still be opened from the cache, and the title should say
        whose they are rather than show the bare hash.
        """
        node_dir = self._node_dir(node_hash)
        if not node_dir or not os.path.isdir(node_dir):
            return ""
        newest = ("", 0)
        for entry in self._read_index(node_dir).values():
            name = entry.get("node_name", "") if isinstance(entry, dict) else ""
            when = entry.get("cached_at", 0) if isinstance(entry, dict) else 0
            if name and when >= newest[1]:
                newest = (name, when)
        return newest[0]

    def forget(self, node_hash: Optional[str] = None) -> int:
        """Drop one node's pages, or everything. Returns files removed."""
        import shutil
        removed = 0
        with self.lock:
            if node_hash:
                node_dir = self._node_dir(node_hash)
                if node_dir and os.path.isdir(node_dir):
                    removed = len([f for f in os.listdir(node_dir) if f.endswith(".mu")])
                    shutil.rmtree(node_dir, ignore_errors=True)
                    self.__dict__.get("_index_cache", {}).clear(); self.__dict__.get("_text_cache", {}).clear()
            else:
                if os.path.isdir(self.root):
                    for name in os.listdir(self.root):
                        d = os.path.join(self.root, name)
                        if os.path.isdir(d):
                            removed += len([f for f in os.listdir(d) if f.endswith(".mu")])
                    shutil.rmtree(self.root, ignore_errors=True)
                    self.__dict__.get("_index_cache", {}).clear(); self.__dict__.get("_text_cache", {}).clear()
                    os.makedirs(self.root, exist_ok=True)
        return removed

    # ---------------------------------------------------------------- #
    # Search                                                           #
    # ---------------------------------------------------------------- #

    @staticmethod
    def _extract_title(content: str) -> tuple:
        """
        A page's title, and whether it is really one.

        A Micron heading starts with '>'. When a page has none, the first
        line with words on it is shown instead, because a name is better
        than a blank - but the caller is told, because that line is body
        text and must not be ranked as though the author had titled the
        page with it. On a one-line page the two would otherwise be the
        same string, and every short page would outrank everything.

        Never a "#!c=0" header, a comment, or a line of ASCII/Braille art:
        a logo drawn in Braille was showing up as the title of whole nodes.
        """
        lines = content.splitlines()[:60]
        for line in lines:
            stripped = line.strip()
            if stripped.startswith(">"):
                title = plain_line(stripped.lstrip(">"))
                if has_words(title):
                    return title[:80], True

        for line in lines:
            if line.lstrip().startswith("#"):
                continue
            title = plain_line(line)
            if has_words(title):
                return title[:80], False

        return "", False

    # Every field a query is matched against, and what a match in it is
    # worth. A page whose title is what you typed is a better answer than
    # one that happens to mention it in passing, and the ranking is what
    # makes a search over a few hundred pages usable rather than merely
    # correct.
    SEARCH_FIELDS = (
        ("title", 10),
        ("node_name", 8),
        ("operator_name", 8),
        ("path", 6),
        ("node_hash", 6),
        ("operator_lxmf_address", 5),
        ("content", 1),
    )

    @staticmethod
    def _normalise_query(query: str) -> str:
        """
        A hash can be pasted in any of the spellings Reticulum prints.

        <a1b2…>, a1:b2:…, or bare hex all mean the same destination, so the
        delimiters come out before matching. Done to the query only - the
        stored hash is already bare hex.
        """
        return query.replace("<", "").replace(">", "").replace(":", "").strip().lower()

    def search(self, query: str, exact_words: bool = False, limit: Optional[int] = None,
               span: int = 120) -> List[Dict[str, Any]]:
        """
        Search the pages already visited. Never touches the network.

        Every word must appear somewhere, but not all in the same field: a
        node name plus a word from the page body is a perfectly good query.
        """
        self.last_total = 0
        query = (query or "").strip()
        if not query:
            return []

        # limit: None = the setting, 0 = all of them. span: snippet length.
        if limit is None:
            limit = self.settings.get("search_limit", 50) or 50
        span = max(60, min(int(span or 120), 600))
        words = [w for w in re.split(r"\s+", self._normalise_query(query)) if w]
        if not words:
            return []

        results: List[Dict[str, Any]] = []

        if not os.path.isdir(self.root):
            return []

        with os.scandir(self.root) as found:
            node_hashes = sorted(d.name for d in found if d.is_dir())
        for node_hash in node_hashes:
            node_dir = os.path.join(self.root, node_hash)
            index = self._read_index_cached(node_dir)

            for page_id, entry in index.items():
                page_file = os.path.join(node_dir, page_id + ".mu")
                read = self._search_text(page_file)
                if read is None:
                    continue
                content, lower, title, title_is_heading, plain_slot = read
                fields = {
                    "title": title.lower(),
                    "node_name": str(entry.get("node_name", "")).lower(),
                    "operator_name": str(entry.get("operator_name", "")).lower(),
                    "path": str(entry.get("path", "")).lower(),
                    "node_hash": node_hash.lower(),
                    "operator_lxmf_address": str(entry.get("operator_lxmf_address", "")).lower(),
                    "content": lower,
                }

                # A "title" that is only the first line of a short page is
                # body text wearing a hat; rank it as body text.
                title_weight = 10 if title_is_heading else 2

                score = 0
                matched_fields = set()
                all_words_found = True

                for word in words:
                    word_score = 0
                    for field, weight in self.SEARCH_FIELDS:
                        haystack = fields[field]
                        if not haystack:
                            continue
                        if field == "title":
                            weight = title_weight
                        if self._field_matches(haystack, word, exact_words):
                            word_score = max(word_score, weight)
                            matched_fields.add(field)
                    if word_score == 0:
                        all_words_found = False
                        break
                    score += word_score

                if not all_words_found:
                    continue

                # A page read more often is more likely to be the one being
                # looked for, but only as a tie-breaker - it must never
                # outweigh matching the title.
                score += min(int(entry.get("visits", 0)), 5)

                results.append({
                    "node_hash": node_hash,
                    "node_name": entry.get("node_name", ""),
                    "operator_name": entry.get("operator_name", ""),
                    "operator_lxmf_address": entry.get("operator_lxmf_address", ""),
                    "path": entry.get("path", ""),
                    "title": title,
                    "cached_at": entry.get("cached_at", 0),
                    "size": entry.get("size", 0),
                    "visits": entry.get("visits", 0),
                    "score": score,
                    "matched": sorted(matched_fields),
                    "_content": content,
                    "_plain": plain_slot,
                })

        # Best match first; among equals, the most recently read. Sorting on
        # the pair in one pass keeps that order stable.
        results.sort(key=lambda r: (r["score"], r.get("cached_at", 0)), reverse=True)
        self.last_total = len(results)
        results = results[:limit] if limit else results
        # Snippets only for what is shown.
        # The readable text of a page is worked out once and kept with it:
        # done at every search it took most of the time (0.4 s for 111 hits).
        for r in results:
            slot = r.pop("_plain")
            if slot[0] is None:
                slot[0] = plain_text(r["_content"])
            r.pop("_content")
            r["snippet"] = self._snippet("", words, span, plain=slot[0])
        return results

    def _search_text(self, page_file: str):
        """(content, content lowered, title, title_is_heading) of a stored
        page, kept in memory until the file changes: the search read every
        file again at each key (0.5 s for 150 pages).
        Dropped with its node's index (every change of a page writes it)."""
        cache = self.__dict__.setdefault("_text_cache", {})
        if page_file in cache:
            return cache[page_file]
        try:
            with open(page_file, "r", encoding="utf-8", errors="replace") as handle:
                content = handle.read()
        except OSError:
            return None
        # Worked out again from the page: titles saved by older versions
        # could be a Braille logo or "#!c=0".
        title, title_is_heading = self._extract_title(content)
        value = (content, content.lower(), title, title_is_heading, [None])
        cache[page_file] = value
        return value

    @staticmethod
    def _field_matches(haystack: str, word: str, exact_words: bool) -> bool:
        if not exact_words:
            return word in haystack
        # Whole words only. A hash prefix deliberately stops matching here -
        # that is what the caller asked for - while a full hash still does,
        # because the characters around it (quotes, slashes, line ends) are
        # all word boundaries.
        return re.search(r"\b" + re.escape(word) + r"\b", haystack) is not None

    def list_pages(self) -> List[Dict[str, Any]]:
        """Every page in the cache, newest first. Reads only the indexes, so
        this stays cheap however much content is stored."""
        results: List[Dict[str, Any]] = []
        if not os.path.isdir(self.root):
            return results

        for node_hash in os.listdir(self.root):
            node_dir = os.path.join(self.root, node_hash)
            if not os.path.isdir(node_dir):
                continue
            for entry in self._read_index_cached(node_dir).values():
                # Only the index is read here: a title saved by an older
                # version that is a drawing or a header is left out.
                saved_title = str(entry.get("title", ""))
                tidy = "" if saved_title.lstrip().startswith("#") else plain_line(saved_title)
                results.append({
                    "node_hash": node_hash,
                    "node_name": entry.get("node_name", ""),
                    "operator_name": entry.get("operator_name", ""),
                    "operator_lxmf_address": entry.get("operator_lxmf_address", ""),
                    "path": entry.get("path", ""),
                    "title": tidy if has_words(tidy) else "",
                    "cached_at": entry.get("cached_at", 0),
                    "size": entry.get("size", 0),
                    "visits": entry.get("visits", 0),
                })

        results.sort(key=lambda r: r.get("cached_at", 0), reverse=True)
        return results

    @staticmethod
    def _snippet(content: str, words: List[str], span: int = 120, plain: Optional[str] = None) -> str:
        """The words around the first match, in the page's readable text."""
        if plain is None:
            plain = plain_text(content)
        low = plain.lower()
        for word in words:
            at = low.find(word)
            if at >= 0:
                start = max(0, at - span // 3)
                end = min(len(plain), at + span)
                prefix = "..." if start > 0 else ""
                suffix = "..." if end < len(plain) else ""
                return prefix + plain[start:end] + suffix
        return plain[:span] + ("..." if len(plain) > span else "")

    # ---------------------------------------------------------------- #
    # Housekeeping                                                     #
    # ---------------------------------------------------------------- #

    def stats(self) -> Dict[str, Any]:
        nodes = 0
        pages = 0
        total = 0
        if os.path.isdir(self.root):
            for name in os.listdir(self.root):
                node_dir = os.path.join(self.root, name)
                if not os.path.isdir(node_dir):
                    continue
                nodes += 1
                for f in os.listdir(node_dir):
                    full = os.path.join(node_dir, f)
                    try:
                        total += os.path.getsize(full)
                    except OSError:
                        continue
                    if f.endswith(".mu"):
                        pages += 1
        return {"nodes": nodes, "pages": pages, "bytes": total,
                "settings": dict(self.settings)}

    def prune(self) -> Dict[str, int]:
        """Drop expired pages, then the oldest ones until the cache fits.

        Called after a store rather than on a timer: the only moment the
        cache can grow is when something has just been added.
        """
        max_age = self.settings.get("max_age_days", 0)
        max_bytes = (self.settings.get("max_total_mb", 0) or 0) * 1024 * 1024
        now = time.time()
        expired = 0
        trimmed = 0

        with self.lock:
            if not os.path.isdir(self.root):
                return {"expired": 0, "trimmed": 0}

            everything = []
            for name in sorted(os.listdir(self.root)):
                node_dir = os.path.join(self.root, name)
                if not os.path.isdir(node_dir):
                    continue
                index = self._read_index(node_dir)
                changed = False

                for page_id in list(index.keys()):
                    entry = index[page_id]
                    page_file = os.path.join(node_dir, page_id + ".mu")
                    cached_at = entry.get("cached_at", 0)
                    if max_age and cached_at and (now - cached_at) > max_age * 86400:
                        try:
                            os.unlink(page_file)
                        except OSError:
                            pass
                        del index[page_id]
                        changed = True
                        expired += 1
                        continue
                    try:
                        size = os.path.getsize(page_file)
                    except OSError:
                        del index[page_id]
                        changed = True
                        continue
                    everything.append((cached_at, size, node_dir, page_id, page_file))

                if changed:
                    self._write_index(node_dir, index)

            if max_bytes:
                total = sum(e[1] for e in everything)
                everything.sort(key=lambda e: e[0])       # oldest first
                while total > max_bytes and everything:
                    _, size, node_dir, page_id, page_file = everything.pop(0)
                    try:
                        os.unlink(page_file)
                    except OSError:
                        pass
                    index = self._read_index(node_dir)
                    index.pop(page_id, None)
                    self._write_index(node_dir, index)
                    total -= size
                    trimmed += 1

        return {"expired": expired, "trimmed": trimmed}


__all__ = ["PageCache"]
