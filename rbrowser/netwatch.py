"""
Settings > System > Internet check (off by default). Reticulum keeps saying
"connected" while the line behind the router is dead: its TCP interfaces
notice late, and RRC later still. When switched on, every PROBE_EVERY seconds
a TCP connection is opened to the hosts the user chose (nothing sent, closed
at once); one answering is enough. Down after DOWN_AFTER failed rounds in a
row, up again at the first answer. Each change is one line in the terminal,
and the status bar and a notification in the page show it.
Off, nothing is contacted at all. Kept in settings/netwatch.json.

While it is down, what goes to the internet by itself waits instead of
filling the log with errors: the update check (updates.py), the RMAP
download (rmap.py) and the Dynamic DNS (remote.py) ask offline() first, and
the last two are woken by on_change() when the network is back. Reticulum
(NomadNet, LXMF, RRC) is left alone: it may run over LoRa without internet,
and it reconnects by itself.
"""

from __future__ import annotations

import json
import os
import re
import socket
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

SETTINGS_FILE = os.path.join("settings", "netwatch.json")
# Only a suggestion shown in Settings: nothing is contacted until the user
# switches the check on, and any host can be put there instead.
DEFAULT_HOSTS = "1.1.1.1:443, 9.9.9.9:443"
PROBE_EVERY = 15.0
PROBE_TIMEOUT = 4.0
DOWN_AFTER = 2
MAX_HOSTS = 4

_HOST_RE = re.compile(r"^[A-Za-z0-9.\-]{1,253}$|^\[[0-9A-Fa-f:.]{2,45}\]$")


def parse_hosts(text: Any) -> List[Tuple[str, int]]:
    """"host:port, host:port" (port 443 when left out). Raises ValueError."""
    out: List[Tuple[str, int]] = []
    for part in re.split(r"[,\s]+", str(text or "").strip()):
        if not part:
            continue
        host, port = part, 443
        m = re.match(r"^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$", part)
        if not m:
            raise ValueError(f"Not a host: {part}")
        host = m.group(1)
        if m.group(2):
            port = int(m.group(2))
        if not _HOST_RE.match(host) or not 0 < port < 65536:
            raise ValueError(f"Not a host: {part}")
        out.append((host.strip("[]"), port))
    if not out:
        raise ValueError("Put at least one host, like 1.1.1.1:443")
    if len(out) > MAX_HOSTS:
        raise ValueError(f"At most {MAX_HOSTS} hosts")
    return out


_current: Optional["NetWatch"] = None          # the running one (start())
_listeners: List[Callable[[bool], None]] = []


def offline() -> bool:
    """True only while the check is on and the network is down."""
    return _current is not None and _current.state == "down"


def on_change(listener: Callable[[bool], None]) -> None:
    """listener(online) when the network goes down (False) or comes back (True)."""
    _listeners.append(listener)


def reachable(probes: List[Tuple[str, int]], timeout: float = PROBE_TIMEOUT) -> bool:
    for host, port in probes:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            continue
    return False


def _took(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {seconds % 3600 // 60}m"


class NetWatch:
    def __init__(self, path: Optional[str] = SETTINGS_FILE,
                 probe: Optional[Callable[[List[Tuple[str, int]]], bool]] = None,
                 every: float = PROBE_EVERY, down_after: int = DOWN_AFTER,
                 clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self.probe = probe or reachable
        self.every = every
        self.down_after = down_after
        self.clock = clock
        self.enabled = False
        self.hosts_text = DEFAULT_HOSTS
        self.hosts = parse_hosts(DEFAULT_HOSTS)
        self.state = "off"              # "unknown", "up", "down" once on
        self.since: Optional[float] = None
        self.fails = 0
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._wake = threading.Event()
        self._load()

    # --- settings --------------------------------------------------------

    def _load(self) -> None:
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8") as fh:
                saved = json.load(fh)
            hosts_text = str(saved.get("hosts") or DEFAULT_HOSTS)
            self.hosts = parse_hosts(hosts_text)
            self.hosts_text = hosts_text
            self.enabled = saved.get("enabled") is True
        except (OSError, ValueError, AttributeError):
            pass
        self.state = "unknown" if self.enabled else "off"

    def settings(self) -> Dict[str, Any]:
        return {"enabled": self.enabled, "hosts": self.hosts_text, "default_hosts": DEFAULT_HOSTS}

    def update(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        enabled = incoming.get("enabled", self.enabled) is True
        hosts_text = str(incoming.get("hosts", self.hosts_text) or "").strip()
        try:
            hosts = parse_hosts(hosts_text)
        except ValueError as exc:
            return {"status": "error", "error": str(exc)}
        with self._lock:
            was = self.enabled
            self.enabled, self.hosts, self.hosts_text = enabled, hosts, ", ".join(
                f"[{h}]:{p}" if ":" in h else f"{h}:{p}" for h, p in hosts)
            if not enabled:
                self.state, self.since, self.fails = "off", None, 0
            elif not was:
                self.state, self.since, self.fails = "unknown", None, 0
            woke = was and not enabled and self is _current
        if self.path:
            try:
                from .fileio import atomic_write_json
                atomic_write_json(self.path, {"enabled": self.enabled, "hosts": self.hosts_text})
            except OSError as exc:
                return {"status": "error", "error": f"Could not save it: {exc}"}
        if enabled and not was:
            print(f"🔗 Internet check on: {self.hosts_text}")
        elif was and not enabled:
            print("🔗 Internet check off")
        if woke:
            # Switched off while down: what waited goes on.
            for listener in list(_listeners):
                try:
                    listener(True)
                except Exception:
                    pass
        self._wake.set()     # check at once with the new hosts
        return {"status": "success", **self.settings()}

    # --- the check -------------------------------------------------------

    def check(self) -> str:
        """One round; prints a line when the state changes."""
        with self._lock:
            if not self.enabled:
                return self.state
            hosts = list(self.hosts)
        ok = self.probe(hosts)
        now = self.clock()
        changed = None
        with self._lock:
            if not self.enabled:
                return self.state
            if ok:
                self.fails = 0
                if self.state == "down":
                    print(f"🟢 Network connected (it was down for {_took(now - (self.since or now))})")
                    changed = True
                if self.state != "up":
                    self.state, self.since = "up", now
            else:
                self.fails += 1
                if self.fails >= self.down_after and self.state != "down":
                    print("⚠️ Disconnected from the network, waiting for reconnect...")
                    self.state, self.since = "down", now
                    changed = False
            state = self.state
        if changed is not None and self is _current:
            for listener in list(_listeners):
                try:
                    listener(changed)
                except Exception:
                    pass
        return state

    def status(self) -> Dict[str, Any]:
        with self._lock:
            down_for = self.clock() - self.since if self.state == "down" and self.since else None
            return {"internet": self.state, "internet_down_for": down_for}

    def start(self) -> None:
        global _current
        if self._thread is not None:
            return
        _current = self

        def loop() -> None:
            while True:
                try:
                    self.check()
                except Exception:
                    pass
                self._wake.wait(self.every)
                self._wake.clear()

        self._thread = threading.Thread(target=loop, name="rbrowser-netwatch", daemon=True)
        self._thread.start()


__all__ = ["NetWatch", "parse_hosts", "reachable", "offline", "on_change", "DEFAULT_HOSTS"]
