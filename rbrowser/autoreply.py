"""
Automatic replies of the messenger: rules, away message and echo bot.

The same logic as esp32nomad_lxmf's node (Lxmf.cpp), plus "away":

- Rules, one per line, "word = reply": the first that matches wins, case
  and spaces at the ends ignored. "hel*" matches what starts with "hel",
  "*" matches anything (put it last). Replies come with the title
  "Auto-Reply".
- Away (off / on / scheduled every day from-to): when no rule matched, the
  away message, ONCE per sender in each away period - telling someone
  twice that you are away is noise. Title "Away".
- Echo: when nothing above answered, the message back (or a template with
  {msg}). Title "Echo Bot".

One message gets one reply at most, never more. No reply at all to:
messages that are automatic replies themselves (their title is one of
ours, the same esp32nomad uses - two bots would answer each other for
ever), messages older than STALE_SECONDS (a sync from a propagation node
brings back old ones), and senders over FLOOD_REPLIES replies in
FLOOD_WINDOW seconds: they get silence for FLOOD_PAUSE seconds, and no
"slow down" - answering a flood is another flood.

Placeholders in replies: {name} our announced name, {msg} what they wrote,
{sender} their name, {address} our LXMF address, {time} now (HH:MM).
"""

import time
from typing import Any, Callable, Dict, Optional, Tuple

TITLE_RULE = "Auto-Reply"
TITLE_AWAY = "Away"
TITLE_ECHO = "Echo Bot"
AUTO_TITLES = {TITLE_RULE.lower(), TITLE_AWAY.lower(), TITLE_ECHO.lower(), "auto reply", "autoreply"}

STALE_SECONDS = 600
FLOOD_REPLIES = 5
FLOOD_WINDOW = 60
FLOOD_PAUSE = 600
MAX_RULES_CHARS = 4000
MAX_TEXT_CHARS = 1000

DEFAULT_RULES = "ping = pong\nhello = Hello from {name}! This is an automatic reply."
DEFAULT_AWAY = "I'm away right now: I will read your message later."
AWAY_MODES = ("off", "on", "scheduled")


def clean_hhmm(value: Any, default: str) -> str:
    try:
        h, m = str(value).strip().split(":")
        h, m = int(h), int(m)
        if 0 <= h < 24 and 0 <= m < 60:
            return f"{h:02d}:{m:02d}"
    except (ValueError, AttributeError):
        pass
    return default


def find_rule(rules: str, text: str) -> Optional[str]:
    said = " ".join(str(text or "").split()).lower()
    for line in str(rules or "").splitlines():
        if "=" not in line:
            continue
        key, reply = line.split("=", 1)
        key = " ".join(key.split()).lower()
        reply = reply.strip()
        if not key or not reply:
            continue
        if key == "*":
            return reply
        if key.endswith("*"):
            if said.startswith(key[:-1].rstrip()):
                return reply
        elif said == key:
            return reply
    return None


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def away_period(settings: Dict[str, Any], now: float) -> Optional[str]:
    """None when not away; else a key naming the current away period, so
    each sender is told once per period."""
    mode = settings.get("away_mode")
    if mode == "on":
        return f"on:{settings.get('away_since') or 0}"
    if mode != "scheduled":
        return None
    start, end = _minutes(settings["away_from"]), _minutes(settings["away_to"])
    t = time.localtime(now)
    cur = t.tm_hour * 60 + t.tm_min
    if start == end:
        return None
    if start < end:
        return f"day:{time.strftime('%Y-%m-%d', t)}" if start <= cur < end else None
    # Over midnight: 22:00-08:00. Before the end, the period began yesterday.
    if cur >= start:
        return f"night:{time.strftime('%Y-%m-%d', t)}"
    if cur < end:
        return f"night:{time.strftime('%Y-%m-%d', time.localtime(now - 86400))}"
    return None


def fill(template: str, values: Dict[str, str]) -> str:
    out = str(template)
    for key, value in values.items():
        out = out.replace("{" + key + "}", value)
    return out[:MAX_TEXT_CHARS * 4]


class AutoReply:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self._flood: Dict[str, Dict[str, float]] = {}
        self._away_told: Dict[str, str] = {}
        self.sent = {"rule": 0, "away": 0, "echo": 0}

    def any_on(self, s: Dict[str, Any]) -> bool:
        return bool(s.get("autoreply_on") or s.get("echo_on") or s.get("away_mode") in ("on", "scheduled"))

    def _flooding(self, peer: str, now: float) -> bool:
        entry = self._flood.setdefault(peer, {"start": now, "count": 0, "until": 0})
        if entry["until"] > now:
            return True
        if now - entry["start"] >= FLOOD_WINDOW:
            entry.update(start=now, count=0, until=0)
        entry["count"] += 1
        if entry["count"] > FLOOD_REPLIES:
            entry["until"] = now + FLOOD_PAUSE
            return True
        return False

    def decide(self, s: Dict[str, Any], peer: str, text: str, title: str, ts: float,
               values: Dict[str, str]) -> Optional[Tuple[str, str]]:
        """(title, text) of the reply to send, or None."""
        if not self.any_on(s):
            return None
        now = self.clock()
        if str(title or "").strip().lower() in AUTO_TITLES:
            return None
        if ts and now - ts > STALE_SECONDS:
            return None
        if not str(text or "").strip():
            return None
        values = {**values, "msg": str(text)[:MAX_TEXT_CHARS], "time": time.strftime("%H:%M", time.localtime(now))}

        reply = None
        if s.get("autoreply_on"):
            rule = find_rule(s.get("autoreply_rules", ""), text)
            if rule:
                reply = (TITLE_RULE, fill(rule, values), "rule")
        if reply is None:
            period = away_period(s, now)
            if period and self._away_told.get(peer) != period:
                reply = (TITLE_AWAY, fill(s.get("away_text") or DEFAULT_AWAY, values), "away")
        if reply is None and s.get("echo_on"):
            template = s.get("echo_text") or ""
            reply = (TITLE_ECHO, fill(template, values) if template else values["msg"], "echo")
        if reply is None:
            return None
        if self._flooding(peer, now):
            return None
        if reply[2] == "away":
            self._away_told[peer] = away_period(s, now)
        self.sent[reply[2]] += 1
        return reply[0], reply[1]
