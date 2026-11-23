"""
rB2 Monitor (Settings > System Setup): everything rBrowser is doing, in one
JSON for the MON tab. Read only: it reads what the parts already keep, sends
nothing on the network. Owner only (auth.GUEST_NEVER).
Each section is read on its own: one failing leaves the others.
"""

from __future__ import annotations

import os
import platform
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import RNS

IFACE_KEYS = ("type", "status", "mode", "bitrate", "rxb", "txb", "rxs", "txs", "clients", "peers",
              "announce_queue", "held_announces", "incoming_announce_frequency",
              "outgoing_announce_frequency", "txdrp", "rssi", "snr", "frequency", "sf", "txpower",
              "channel_load_short", "airtime_short", "noise_floor", "battery_percent", "ifac_netname",
              "autoconnect_source")
TOTAL_KEYS = ("rxb", "txb", "rxs", "txs", "rxpps", "txpps", "rxpkts", "txpkts", "arxf", "atxf",
              "prxf", "ptxf", "transport_id", "transport_uptime")


def _safe(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception as exc:
        return {"error": str(exc) or type(exc).__name__}


def _plain(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)


def _version() -> str:
    try:
        with open("version.txt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return "?"


def system(browser: Any, guests: Optional[int]) -> Dict[str, Any]:
    return {"version": _version(), "uptime": time.time() - browser.start_time, "pid": os.getpid(),
            "python": platform.python_version(), "os": f"{platform.system()} {platform.release()}",
            "machine": platform.node(), "threads": threading.active_count(), "guests": guests,
            "state": browser.connection_state, "error": browser.reticulum_error}


def network(browser: Any, addresses: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"addresses": addresses}
    nw = getattr(browser, "netwatch", None)
    if nw is not None:
        st = nw.status()
        out["internet"] = {"state": st.get("internet"), "down_for": st.get("internet_down_for"),
                           "method": nw.method, "target": nw.describe() if nw.enabled else "",
                           "last_check": nw.last_check, "last_ok": nw.last_ok,
                           "last_ms": getattr(nw, "last_ms", None), "every": nw.every}
    remote = getattr(browser, "remote", None)
    if remote is not None:
        s = remote.status()
        cfg = s.get("settings") or {}
        tunnel = s.get("tunnel") or {}
        out["tunnel"] = {"state": tunnel.get("state"), "url": tunnel.get("url"), "error": tunnel.get("error")}
        out["ddns"] = {"on": bool(cfg.get("ddns_on")), "provider": cfg.get("ddns_provider"),
                       "domain": cfg.get("ddns_domain"), **{k: v for k, v in (s.get("ddns") or {}).items()
                                                            if k in ("state", "ip", "at", "error")}}
    return out


def reticulum(browser: Any) -> Dict[str, Any]:
    r = browser.reticulum
    out: Dict[str, Any] = {
        "version": getattr(RNS, "__version__", "?"),
        "ready": bool(browser.reticulum_ready),
        "shared": bool(getattr(r, "is_connected_to_shared_instance", False)) if r else None,
        "transport": bool(_safe(RNS.Reticulum.transport_enabled)) if r else None,
        "identity": browser.identity.hash.hex() if browser.identity else None,
        "links": len(getattr(RNS.Transport, "active_links", []) or []),
        "pending_links": len(getattr(RNS.Transport, "pending_links", []) or []),
    }
    watch = browser.rnswatch
    raw = getattr(watch, "raw", None)
    out["read_at"] = getattr(watch, "raw_at", 0) or None
    if raw:
        out["totals"] = {k: _plain(raw.get(k)) for k in TOTAL_KEYS if k in raw}
        ifaces: List[Dict[str, Any]] = []
        from .rnswatch import LOCAL_TYPES
        from .web_browser import interface_label
        for e in raw.get("interfaces", []):
            if str(e.get("type")) in LOCAL_TYPES or e.get("parent_interface_name"):
                continue
            row = {k: _plain(e.get(k)) for k in IFACE_KEYS if e.get(k) is not None}
            row["name"] = interface_label(str(e.get("name") or e.get("type")))
            ifaces.append(row)
        out["interfaces"] = ifaces
    return out


def lxmf(browser: Any) -> Dict[str, Any]:
    m = getattr(browser, "messenger", None)
    if m is None:
        return {"enabled": False}
    s = m.settings
    out: Dict[str, Any] = {"enabled": bool(s.get("enabled")), "offline": bool(s.get("offline")),
                           "running": m.destination is not None,
                           "address": m.destination.hash.hex() if m.destination is not None else None,
                           "identity": browser.identities.name_of(s["identity"]),
                           "name": m.current_display_name(), "last_announce": m.last_announce or None,
                           "error": m.error, "outbound": len(getattr(m, "_outbound", {}) or {})}
    if not out["enabled"]:
        return out
    out["peers"] = {"live": len(m.peers.live), "known": len(m.peers.peers)}
    sync = m.sync_status()
    node = sync.get("node") or {}
    out["propagation"] = {"mode": sync.get("mode"), "node": node.get("hash"), "node_name": node.get("name"),
                          "heard": sync.get("heard"), "sync": (sync.get("sync") or {}).get("text"),
                          "last_sync": (sync.get("sync") or {}).get("last_sync"),
                          "set_aside": len(sync.get("set_aside") or {})}
    day = time.time() - 86400
    count = {"identities": 0, "chats": 0, "in": 0, "out": 0, "in_24h": 0, "out_24h": 0,
             "failed": 0, "sending": 0, "unread": 0}
    for listener in m._owner_listeners():
        count["identities"] += 1
        store = listener.store
        with store.lock:
            convs = list(store.data.values())
        for conv in convs:
            count["chats"] += 1
            count["unread"] += int(conv.get("unread", 0) or 0)
            for msg in list(conv.get("messages") or []):
                d = "in" if msg.get("dir") == "in" else "out"
                count[d] += 1
                if (msg.get("ts") or 0) >= day:
                    count[d + "_24h"] += 1
                state = msg.get("state")
                if d == "out" and state == "failed":
                    count["failed"] += 1
                elif d == "out" and state in ("sending", "propagating", "outbound"):
                    count["sending"] += 1
    out["messages"] = count
    out["transfers"] = len(m.incoming_transfers())
    return out


def rrc(browser: Any) -> Dict[str, Any]:
    c = getattr(browser, "rrc", None)
    if c is None:
        return {"enabled": False}
    out: Dict[str, Any] = {"enabled": bool(c.settings.get("enabled")), "nick": c.settings.get("nick")}
    if not out["enabled"]:
        return out
    out["heard"] = {"live": len(c.live), "known": len(c.heard)}
    hubs = []
    with c.lock:
        sessions = list(c._owner_sessions.values())
        guest_sessions = sum(len(v) for v in getattr(c, "_guest_sessions", {}).values()) \
            if isinstance(getattr(c, "_guest_sessions", None), dict) else 0
    for h in sessions:
        hubs.append({"name": h.name or h.address[:12], "address": h.address, "state": h.state,
                     "rtt": h.rtt, "rooms": max(0, len(h.rooms) - 1), "reconnects": h.reconnects,
                     "users": sum(h.room_users.values()) if h.room_users else None,
                     "unread": sum(r.unread for r in h.rooms.values()),
                     "waiting": len(h.waiting), "last_rx": h.last_rx or None, "error": h.error})
    out["hubs"] = hubs
    out["guest_hubs"] = guest_sessions
    return out


def bbs(browser: Any) -> Dict[str, Any]:
    b = getattr(browser, "retibbs", None)
    if b is None:
        return {"enabled": False}
    out: Dict[str, Any] = {"enabled": bool(b.settings.get("enabled")), "running": bool(b._registered)}
    if not out["enabled"]:
        return out
    out["heard"] = {"live": len(b.live), "known": len(b.heard)}
    out["sessions"] = [{"name": s.name or s.address[:12], "address": s.address, "state": s.state,
                        "rtt": s.rtt, "area": s.area, "error": s.error}
                       for s in list(b._owner_sessions.values())]
    return out


def nomadnet(browser: Any) -> Dict[str, Any]:
    links = browser._owner_links
    out: Dict[str, Any] = {"nodes": len(browser.nomadnet_nodes), "links": len(links),
                           "guest_watches": len(getattr(browser, "_guest_nomad", {}) or {}),
                           "last_announce": browser.last_announce_time,
                           "favorites": len(browser.favorites.load())}
    cache = browser.page_cache
    out["cache_on"] = bool(cache.settings.get("enabled", True))
    rmap = getattr(browser, "rmap", None)
    if rmap is not None:
        st = rmap.status()
        out["rmap"] = {"enabled": bool(st["settings"].get("enabled")), "nodes": rmap.count(),
                       "fetched_at": st.get("fetched_at"), "error": st.get("error")}
    return out


def identities(browser: Any) -> Dict[str, Any]:
    ids = browser.identities
    snap = ids.snapshot()
    uses = browser.identity_uses(snap.get("active"))
    rows = [{"name": p["name"], "identity": p.get("identity_hash"), "lxmf": p.get("lxmf_address"),
             "active": p["id"] == snap.get("active"), "used_in": uses.get(p["id"], []),
             "loadable": p.get("loadable", True)} for p in snap.get("profiles", [])]
    return {"profiles": rows, "bindings": len(snap.get("bindings") or []),
            "auto_identify": bool(snap.get("auto_identify")), "identified": len(browser.identified_nodes())}


def snapshot(browser: Any, addresses: Dict[str, Any], guests: Optional[int]) -> Dict[str, Any]:
    return {
        "status": "success",
        "now": time.time(),
        "system": _safe(lambda: system(browser, guests)),
        "network": _safe(lambda: network(browser, addresses)),
        "reticulum": _safe(lambda: reticulum(browser)),
        "announces": _safe(browser.announces.stats),
        "lxmf": _safe(lambda: lxmf(browser)),
        "rrc": _safe(lambda: rrc(browser)),
        "bbs": _safe(lambda: bbs(browser)),
        "nomadnet": _safe(lambda: nomadnet(browser)),
        "identities": _safe(lambda: identities(browser)),
    }
