"""
A name on the local network: rbrowser.local (or another), announced with
mDNS, so a phone or another computer at home reaches rBrowser without its IP.

mDNS (multicast DNS) is how .local names work: nothing to configure on a
router, every device on the network asks "who is rbrowser.local?" and this
answers with its own address. Windows 10+, macOS, iOS, Android and Linux
(with Avahi) all ask this way.

It needs the zeroconf package (pip install zeroconf). Without it the setting
says so and nothing else changes. It only makes sense when rBrowser listens
on the network (host 0.0.0.0 or a LAN address): on 127.0.0.1 nobody else
could connect anyway, and the name is not announced.

Also published: an _http._tcp service called "rBrowser", which the network
browsers of some systems list.
"""

from __future__ import annotations

import atexit
import ipaddress
import re
import socket
import threading
from typing import Any, Dict, List, Optional

_NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def valid_name(value: Any) -> Optional[str]:
    """'rbrowser', 'rbrowser.local' -> 'rbrowser'; '' -> '' (off); bad -> None."""
    text = str(value or "").strip().lower()
    if text.endswith(".local"):
        text = text[:-len(".local")]
    if not text:
        return ""
    return text if _NAME_RE.match(text) else None


def available() -> bool:
    try:
        import zeroconf  # noqa: F401
        return True
    except ImportError:
        return False


def lan_addresses(bind_host: str) -> List[str]:
    """The IPv4 addresses to announce: the one bound to, or every LAN one."""
    if bind_host not in ("0.0.0.0", "", "::"):
        try:
            ip = ipaddress.ip_address(bind_host)
            return [str(ip)] if ip.version == 4 and not ip.is_loopback else []
        except ValueError:
            return []
    # The address the default route goes out from (nothing is sent): the
    # home network. Every address of the machine would also announce the
    # virtual adapters (VMware, VPNs), which a phone may try and not reach.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))
            address = probe.getsockname()[0]
            if address and not ipaddress.ip_address(address).is_loopback:
                return [address]
    except (OSError, ValueError):
        pass
    # No default route (an offline LAN): every non-loopback IPv4 address.
    found: List[str] = []
    try:
        import ifaddr
        for adapter in ifaddr.get_adapters():
            for entry in adapter.ips:
                if not isinstance(entry.ip, str):
                    continue            # IPv6 comes as a tuple
                ip = ipaddress.ip_address(entry.ip)
                if not (ip.is_loopback or ip.is_link_local):
                    found.append(entry.ip)
    except Exception:
        pass
    return sorted(set(found))


class LocalName:
    """Announces <name>.local while rBrowser runs; one per process."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.zc = None
        self.info = None
        self.state: Dict[str, Any] = {"active": False, "name": "", "addresses": [], "error": ""}
        # On the way out the name is withdrawn ("goodbye"), so the network
        # does not keep pointing at a closed rBrowser until it times out.
        atexit.register(self.stop)

    def start(self, name: str, bind_host: str, port: int) -> Dict[str, Any]:
        self.stop()
        state: Dict[str, Any] = {"active": False, "name": name, "addresses": [], "error": ""}
        if not name:
            self.state = state
            return dict(state)
        if bind_host in LOOPBACK_HOSTS:
            state["error"] = "rBrowser listens on this computer only (host 127.0.0.1): the name is not announced"
        elif not available():
            state["error"] = "the zeroconf package is missing: pip install zeroconf"
        else:
            addresses = lan_addresses(bind_host)
            if not addresses:
                state["error"] = "no network address found to announce"
            else:
                try:
                    from zeroconf import IPVersion, ServiceInfo, Zeroconf
                    info = ServiceInfo(
                        "_http._tcp.local.", f"rBrowser ({name})._http._tcp.local.",
                        addresses=[socket.inet_aton(a) for a in addresses],
                        port=int(port), server=f"{name}.local.", properties={"path": "/"})
                    zc = Zeroconf(ip_version=IPVersion.V4Only)
                    zc.register_service(info, allow_name_change=True)
                    with self.lock:
                        self.zc, self.info = zc, info
                    state.update(active=True, addresses=addresses)
                except Exception as exc:
                    state["error"] = f"could not announce the name: {exc}"
        if state["active"]:
            print(f"📡 Local name: http://{name}.local:{port} ({', '.join(state['addresses'])})")
        if state["error"]:
            print(f"⚠️ Local name {name}.local: {state['error']}")
        self.state = state
        return dict(state)

    def stop(self) -> None:
        with self.lock:
            zc, info, self.zc, self.info = self.zc, self.info, None, None
        if zc is None:
            return
        try:
            if info is not None:
                zc.unregister_service(info)
        except Exception:
            pass
        try:
            zc.close()
        except Exception:
            pass


local_name = LocalName()

__all__ = ["LocalName", "local_name", "valid_name", "available", "lan_addresses"]
