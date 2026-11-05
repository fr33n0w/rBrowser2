"""rBrowser.py --info: the state of the rBrowser running on this computer,
then its log as it is written, until Ctrl+C.

For an rBrowser whose terminal is not in sight: started as a service, as
the app (--app), on a server over ssh. It asks the running one through its
own web API, so it works the same with the .py and with the program.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from .links import _base_url, running_instances
from .server_settings import ServerSettings

TAGS = re.compile(r"<[^>]*>")


def _get(base: str, path: str) -> Dict[str, Any]:
    with urllib.request.urlopen(base + path, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _find(port_forced: Optional[int]) -> Optional[str]:
    if port_forced:
        return _base_url("127.0.0.1", port_forced)
    running = running_instances()
    if running:
        return _base_url(running[0]["host"], running[0]["port"])
    saved = ServerSettings().saved
    return _base_url(saved["host"], saved["port"])


def _summary(base: str) -> None:
    status = _get(base, "/api/status")
    conn = _get(base, "/api/connection-status")
    try:
        version = _get(base, "/api/version").get("local", "?")
    except Exception:
        version = "?"
    try:
        usage = _get(base, "/api/usage")
    except Exception:
        usage = {}
    try:
        addresses = _get(base, "/api/server-settings").get("addresses") or {}
    except Exception:
        addresses = {}

    print(f"rBrowser {version} at {base}")
    if addresses.get("local"):
        print(f"  This device   {addresses['local']}")
        for url in addresses.get("lan") or []:
            print(f"  Home network  {url}")
        for pub in addresses.get("public") or []:
            print(f"  Internet      {pub['url']} ({pub['kind']})")
    print(f"  Status        {TAGS.sub('', conn.get('message', '?')).strip()}")
    ifaces = status.get("interfaces") or {}
    print(f"  Interfaces    {ifaces.get('rns_ifaces_online', 0)} online of {ifaces.get('rns_ifaces_total', 0)}")
    print(f"  Identity      {status.get('identity_hash', '?')}")
    print(f"  NomadNet      {status.get('unique_nodes', 0)} nodes, {status.get('total_announces', 0)} announces")
    heard = status.get("heard") or {}
    names = {"lxmf": "LXMF peers", "propagation": "Propagation", "rrc": "RRC hubs", "bbs": "BBS", "rmap": "RMAP"}
    for key, label in names.items():
        v = heard.get(key)
        if v is None:
            continue
        print(f"  {label:<13} {v if isinstance(v, int) else v.get('live', 0)}")
    if usage.get("status") == "success":
        line = f"  Process       PID {usage.get('pid')}, CPU {usage.get('cpu')}%, RAM {round(usage.get('rss_mb', 0))} MB"
        bat = usage.get("battery")
        if bat:
            line += f", battery {bat['percent']}%{' plugged in' if bat.get('plugged') else ''}"
        print(line)


def run_info(port_forced: Optional[int] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    base = _find(port_forced)
    try:
        _summary(base)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print(f"rBrowser at {base} asks for the access password: --info works from the computer it runs on.")
        else:
            print(f"rBrowser at {base} answered {exc.code}.")
        return 1
    except Exception:
        print(f"No rBrowser answering at {base}. Started on another port? Try --info --port N")
        return 1

    print()
    print("Log (all categories), Ctrl+C to stop:")
    try:
        log = _get(base, "/api/log")
    except Exception:
        print("  This rBrowser is older and has no log to give (/api/log).")
        return 0
    for line in log.get("lines", [])[-30:]:
        print(line)
    last = log.get("last", 0)
    try:
        while True:
            time.sleep(1)
            try:
                log = _get(base, f"/api/log?after={last}")
            except Exception:
                print("rBrowser stopped answering.")
                return 0
            if log.get("last", 0) < last:
                last = 0                  # restarted: a new count
                continue
            for line in log.get("lines", []):
                print(line)
            last = log.get("last", last)
    except KeyboardInterrupt:
        return 0
