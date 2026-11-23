"""Micron and Markdown in RRC messages, as NomadNet draws them.

NomadNet (ui/textui/Channels.py) splits a message into links, mentions and
text; the text goes through Markdown (RNS rngit MarkdownToMicron), then its
escaped Micron tags (the bar U+00A6 in place of the backtick) become real
ones and the layout tags are dropped. Here the same, the result as segments
for the page: ["t", text] drawn as usual (links), ["m", micron] by rrcMcHtml.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

try:
    from RNS.Utilities.rngit.util import MarkdownToMicron
    _MDC = MarkdownToMicron(max_width=80, syntax_highlighter=None, url_scope=None)
except Exception:                       # an RNS without rngit: Micron only
    _MDC = None

TAG = "¦"

# nomadnet/util.py unescape_micron / strip_escaped_micron / strip_non_formatting_tags
_UNESCAPE = [(re.compile(TAG + r"([FB][0-9a-fA-F]{3})"), r"`\1"),
             (re.compile(TAG + r"([FB]T[0-9a-fA-F]{6})"), r"`\1"),
             (re.compile(TAG + r"([!*_=])"), r"`\1"),
             (re.compile(TAG + r"(f`b)"), r"`\1"),
             (re.compile(TAG + r"([fb<>{])"), r"`\1")]
_ESCAPED = re.compile(TAG + r"(?:[FB][0-9a-fA-F]{3}|[FB]T[0-9a-fA-F]{6}|[!*_=]|f`b|[fb<>{])")
_COLOUR = re.compile(TAG + r"[FB](?:[0-9a-fA-F]{3}|T[0-9a-fA-F]{6})")
_LAYOUT = re.compile(r"`[<>{rcl]")

# What NomadNet keeps out of Markdown (links, #rooms, @mentions) plus the
# links only rBrowser draws (http, rrc://), so an underscore in them is not
# read as italics. Not inside code, as NomadNet.
_KEEP = re.compile(
    r"\bhttps?://[^\s<>\"']*[^\s<>\"'.,;:!?)\]]"
    r"|\brrc://[0-9a-fA-F]{32}\S*"
    r"|(?<!\w)lxmf(?:@|://)[0-9a-fA-F]{32}(?!\w)"
    r"|(?<![@\w/])[0-9a-fA-F]{32}(?::/\S*)?(?!\w)"
    r"|(?<!\w)#[A-Za-z0-9][A-Za-z0-9_\-]{0,62}"
    r"|(?<![A-Za-z0-9_])@[A-Za-z0-9_]+(?![A-Za-z0-9_])")
_FENCE = re.compile(r"```[^\n]*\n.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"(?<!`)`[^`\n]+`")

# A span starting with one of these would be a heading or a comment for the
# Micron parser: NomadNet keeps that character out of it.
_YANK = (">", "#")


def unescape(text: str) -> str:
    for pat, rep in _UNESCAPE:
        text = pat.sub(rep, text)
    return _LAYOUT.sub("", text)


def strip_escaped(text: str) -> str:
    """The message without its tags: what a reader without colours sees."""
    return _ESCAPED.sub("", text)


def pick_body(text: str, options: Any, max_bytes: int) -> str:
    """What goes out for a message with rBrowser's colours: the first of the
    page's Micron versions (exact, compact) that is the text plus tags and
    fits the hub; else the text alone."""
    if isinstance(options, str):
        options = [options]
    for mc in options if isinstance(options, (list, tuple)) else []:
        if (isinstance(mc, str) and mc != text and strip_escaped(mc) == text
                and len(mc.encode("utf-8")) <= max_bytes):
            return mc
    return text


def has_art(text: str) -> bool:
    """Colours set by the sender (not by Markdown): drawn as art, no wrapping."""
    return bool(_COLOUR.search(text))


def _code_regions(text: str) -> List[tuple]:
    regions = [(m.start(), m.end()) for m in _FENCE.finditer(text)]
    for m in _INLINE_CODE.finditer(text):
        if not any(s <= m.start() < e for s, e in regions):
            regions.append((m.start(), m.end()))
    return regions


def _micron(span: str, markdown: bool) -> str:
    # The tags are kept away from Markdown, which in NomadNet reads the * and
    # _ of ¦* ¦_ as its own italics (a NomadNet bug, fixed here on purpose).
    if markdown and _MDC is not None:
        tags: List[str] = []

        def hide(m: "re.Match[str]") -> str:
            tags.append(m.group())
            return f"\x02{len(tags) - 1}\x03"

        try:
            done = _MDC.format_block(_ESCAPED.sub(hide, span))
            span = re.sub(r"\x02(\d+)\x03", lambda m: tags[int(m.group(1))], done)
        except Exception:
            pass
    return unescape(span)


def segments(text: str, markdown: bool = True) -> Optional[List[List[str]]]:
    """The message as NomadNet draws it, or None if that is the plain text
    (nothing for Markdown or Micron to change: the page draws it as before)."""
    text = str(text or "")
    if not text:
        return None
    code = _code_regions(text)
    out: List[List[str]] = []
    changed = False
    pos = 0

    def add_text(span: str) -> None:
        nonlocal changed
        if not span:
            return
        yanked = span[0] if span[0] in _YANK else ""
        body = span[len(yanked):]
        mc = _micron(body, markdown) if body else ""
        plain = mc == body and "`" not in body and "\\" not in body
        if yanked:
            out.append(["t", yanked])
        if plain:
            out.append(["t", body])
        else:
            out.append(["m", mc])
            changed = True

    for m in _KEEP.finditer(text):
        if any(m.start() < e and m.end() > s for s, e in code):
            continue
        add_text(text[pos:m.start()])
        out.append(["t", m.group()])
        pos = m.end()
    add_text(text[pos:])
    return out if changed else None


def annotate(line: Dict[str, Any], markdown: bool = True) -> None:
    """Adds to a message line what the page needs to draw it as NomadNet
    does: mc (segments), art. A message with rBrowser's own colours (fmt)
    is drawn with those, its tags only taken out of the text."""
    text = line.get("text") or ""
    if TAG not in text and not markdown:
        return
    if line.get("fmt"):
        return
    if line.get("kind") == "action":
        line["text"] = strip_escaped(text)          # NomadNet: /me without colours
        return
    reply = re.match(r"> [^\n]*\n", text)
    body = text[reply.end():] if reply else text
    segs = segments(body, markdown)
    if segs:
        line["mc"] = segs
        if reply:
            line["mc_reply"] = True
        if has_art(body):
            line["art"] = True
    if TAG in text:
        line["text"] = strip_escaped(text)          # reply, copy, notifications: no raw tags
