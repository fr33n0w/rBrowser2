"""
Reticulum's own interfaces, watched (always on, nothing is sent). Reticulum
says "connected" - to rnsd, or started here - while every interface that
reaches the network is down: a phone out of coverage, the Wi-Fi gone. Its
only sign is RNS's own "attempting to reconnect" warning.

Every CHECK_EVERY seconds the interface states are read (from rnsd over its
RPC when rBrowser is one of its clients, else from this Reticulum). The
shared instance's own plumbing (LocalServerInterface, LocalClientInterface)
and the peers a server interface spawns are left out. An interface going
down or coming back is one line in the terminal; with none of them up the
status bar turns red and the page says so. An RNode on the air with the
internet gone is still up: Reticulum is still connected, over the radio.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional

CHECK_EVERY = 5.0
LOCAL_TYPES = ("LocalServerInterface", "LocalClientInterface")


def network_interfaces(stats: Any) -> Dict[str, Dict[str, Any]]:
    """{name: {"label", "type", "online"}} of the interfaces that reach the
    network, out of Reticulum's get_interface_stats()."""
    from .web_browser import interface_label
    out: Dict[str, Dict[str, Any]] = {}
    for entry in (stats or {}).get("interfaces", []) if isinstance(stats, dict) else []:
        kind = str(entry.get("type") or "")
        if kind in LOCAL_TYPES or entry.get("parent_interface_name"):
            continue
        name = str(entry.get("name") or kind)
        out[name] = {"label": interface_label(name), "type": kind, "online": bool(entry.get("status"))}
    return out


class RnsWatch:
    def __init__(self, reticulum: Callable[[], Any], clock: Callable[[], float] = time.time) -> None:
        self.reticulum = reticulum           # returns the RNS.Reticulum in use (or None)
        self.clock = clock
        self.interfaces: Dict[str, Dict[str, Any]] = {}
        self.since: Optional[float] = None   # when the last one went down
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._read_failed = False

    def status(self) -> Dict[str, Any]:
        with self._lock:
            online = sum(1 for i in self.interfaces.values() if i["online"])
            return {"rns_ifaces_online": online, "rns_ifaces_total": len(self.interfaces),
                    "rns_offline_for": self.clock() - self.since if self.interfaces and not online and self.since else None}

    def check(self) -> None:
        """One reading: what changed since the last is printed."""
        r = self.reticulum()
        if r is None:
            return
        try:
            now = network_interfaces(r.get_interface_stats())
        except Exception as exc:
            if not self._read_failed:
                print(f"⚠️ Could not read Reticulum's interfaces: {exc}")
                self._read_failed = True
            return
        self._read_failed = False
        with self._lock:
            before, first = self.interfaces, not self.interfaces
            self.interfaces = now
            was_up = any(i["online"] for i in before.values())
            is_up = any(i["online"] for i in now.values())
        for name, info in now.items():
            old = before.get(name)
            if first:
                if not info["online"]:
                    print(f"🔴 Reticulum interface down: {info['label']} ({info['type']}) - Reticulum is reconnecting")
            elif old is not None and old["online"] != info["online"]:
                if info["online"]:
                    print(f"🟢 Reticulum interface up again: {info['label']}")
                else:
                    print(f"🔴 Reticulum interface down: {info['label']} ({info['type']}) - Reticulum is reconnecting")
        if now and not is_up and (first or was_up):
            with self._lock:
                self.since = self.clock()
            print("🔴 No Reticulum interface is up: offline until one reconnects")
        elif is_up and not first and not was_up and before:
            print("🟢 Reticulum is reaching the network again")

    def _loop(self) -> None:
        while True:
            try:
                self.check()
            except Exception as exc:          # never let the watch die
                print(f"⚠️ Interface check failed: {exc}")
            time.sleep(CHECK_EVERY)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="rns-watch", daemon=True)
        self._thread.start()
