"""
nomadnetwork:// and rbrowser:// links that open in rBrowser.

Registered with the system, a click on such a link (on rmap, in a chat, in
a document) runs "rBrowser.py --open <link>". That process does not become a
second rBrowser: it looks for the one already running on the saved port,
starts it if there is none, and opens the page in the rBrowser page already
open on this computer (a new tab in it, see LinkInbox), or else in the
system browser as http://<rBrowser>/?url=<link>, which the page understands.

Where the registration lives:
  Windows  HKCU\\Software\\Classes\\<scheme> (this user only, no admin)
  Linux    ~/.local/share/applications/rbrowser-links.desktop + xdg-mime
Other systems (macOS needs an app bundle) and the Docker image: not offered.

The command uses pythonw on Windows, so a click on a link never flashes a
console; when rBrowser has to be started, it gets its own console window as
if started by hand.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

SCHEMES = ("nomadnetwork", "rbrowser")
DESKTOP_FILE = "rbrowser-links.desktop"
_HASH_RE = re.compile(r"[a-fA-F0-9]{32}")


def _script() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rBrowser.py")


def _python(windowless: bool) -> str:
    exe = sys.executable
    if os.name == "nt":
        folder, name = os.path.split(exe)
        want = "pythonw.exe" if windowless else "python.exe"
        if name.lower() in ("python.exe", "pythonw.exe") and os.path.exists(os.path.join(folder, want)):
            return os.path.join(folder, want)
    return exe


def handler_command() -> List[str]:
    """What the system runs for a link, with the link appended."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--open"]
    return [_python(windowless=True), _script(), "--open"]


def platform_support() -> Optional[str]:
    """None when links can be registered here, else why not."""
    if os.path.exists("/.dockerenv"):
        return "rBrowser runs in Docker: links are registered on the computer, not in the container"
    if os.name == "nt" or sys.platform.startswith("linux"):
        return None
    return "only on Windows and Linux for now"


# ---------------------------------------------------------------------- #
# Windows                                                                #
# ---------------------------------------------------------------------- #

def _win_command_line() -> str:
    return " ".join(f'"{part}"' for part in handler_command()) + ' "%1"'


def _win_read(scheme: str) -> Optional[str]:
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{scheme}\shell\open\command") as key:
            return str(winreg.QueryValueEx(key, "")[0])
    except OSError:
        pass
    # Registered for the whole machine by another program.
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"{scheme}\shell\open\command") as key:
            return str(winreg.QueryValueEx(key, "")[0])
    except OSError:
        return None


def _win_register(scheme: str) -> None:
    import winreg
    base = rf"Software\Classes\{scheme}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f"URL:{scheme} link")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    # The name browsers show when they ask "open this link with...?";
    # without it, the program's file name: pythonw.exe.
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open") as key:
        winreg.SetValueEx(key, "FriendlyAppName", 0, winreg.REG_SZ, "rBrowser")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, _win_command_line())


def _win_unregister(scheme: str) -> None:
    import winreg
    base = rf"Software\Classes\{scheme}"
    for sub in (r"\shell\open\command", r"\shell\open", r"\shell", ""):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, base + sub)
        except OSError:
            pass


# ---------------------------------------------------------------------- #
# Linux                                                                  #
# ---------------------------------------------------------------------- #

def _desktop_path() -> str:
    data = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(data, "applications", DESKTOP_FILE)


def _linux_default(scheme: str) -> Optional[str]:
    try:
        out = subprocess.run(["xdg-mime", "query", "default", f"x-scheme-handler/{scheme}"],
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _linux_register() -> None:
    path = _desktop_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    exec_line = " ".join(f'"{part}"' for part in handler_command()) + " %u"
    mime = "".join(f"x-scheme-handler/{s};" for s in SCHEMES)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("[Desktop Entry]\nType=Application\nName=rBrowser\n"
                     f"Exec={exec_line}\nNoDisplay=true\nTerminal=false\nMimeType={mime}\n")
    for scheme in SCHEMES:
        subprocess.run(["xdg-mime", "default", DESKTOP_FILE, f"x-scheme-handler/{scheme}"],
                       capture_output=True, timeout=10)


def _linux_unregister() -> None:
    try:
        os.remove(_desktop_path())
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------- #
# Status, register, unregister                                           #
# ---------------------------------------------------------------------- #

def status() -> Dict[str, Any]:
    """{'supported', 'reason', 'registered', 'schemes': {scheme: ours|other|none}, 'other'}"""
    reason = platform_support()
    result: Dict[str, Any] = {"supported": reason is None, "reason": reason or "",
                              "registered": False, "schemes": {}, "other": ""}
    if reason:
        return result
    for scheme in SCHEMES:
        if os.name == "nt":
            command = _win_read(scheme)
            if not command:
                state = "none"
            elif _script().lower() in command.lower() or (getattr(sys, "frozen", False)
                                                          and sys.executable.lower() in command.lower()):
                state = "ours"
            else:
                state, result["other"] = "other", command
        else:
            default = _linux_default(scheme)
            if not default:
                state = "none"
            elif default == DESKTOP_FILE and os.path.exists(_desktop_path()):
                state = "ours"
            else:
                state, result["other"] = "other", default
        result["schemes"][scheme] = state
    result["registered"] = all(s == "ours" for s in result["schemes"].values())
    return result


def register() -> Dict[str, Any]:
    reason = platform_support()
    if reason:
        raise RuntimeError(reason)
    if os.name == "nt":
        for scheme in SCHEMES:
            _win_register(scheme)
    else:
        _linux_register()
    print(f"🔗 Links registered: {', '.join(s + '://' for s in SCHEMES)} open in rBrowser")
    return status()


def unregister() -> Dict[str, Any]:
    """Removes only what is rBrowser's: another program's handler is left alone."""
    current = status()
    if not current["supported"]:
        return current
    if os.name == "nt":
        for scheme, state in current["schemes"].items():
            if state == "ours":
                _win_unregister(scheme)
    elif any(s == "ours" for s in current["schemes"].values()):
        _linux_unregister()
    print("🔗 Links no longer open in rBrowser")
    return status()


# ---------------------------------------------------------------------- #
# rBrowser.py --open <link>                                              #
# ---------------------------------------------------------------------- #

def page_link(link: str) -> str:
    """
    The link as the page's address bar takes it, or "" if it holds no node
    address. rbrowser://x is nomadnetwork://x; a bare hash is accepted too.
    """
    text = urllib.parse.unquote(str(link or "").strip())
    for scheme in SCHEMES:
        prefix = scheme + ":"
        if text.lower().startswith(prefix):
            text = text[len(prefix):].lstrip("/")
            break
    # Some programs hand over "nomadnetwork://hash/" with the slash added.
    match = _HASH_RE.match(text)
    if not match:
        return ""
    rest = text[match.end():]
    if rest in ("", "/"):
        rest = ""
    return "nomadnetwork://" + match.group(0).lower() + rest


def _base_url(host: str, port: int) -> str:
    if host in ("0.0.0.0", "", "::", "localhost"):
        host = "127.0.0.1"
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{port}"


def _is_rbrowser(base: str, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(base + "/api/status", timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
            return isinstance(data, dict) and "instance" in data and "running" in data
    except Exception:
        return False


def _start_rbrowser(port_forced: Optional[int]) -> None:
    if getattr(sys, "frozen", False):
        command = [sys.executable]
    else:
        command = [_python(windowless=False), _script()]
    if port_forced:
        command += ["--port", str(port_forced)]
    kwargs: Dict[str, Any] = dict(cwd=os.path.dirname(_script()), stdin=subprocess.DEVNULL)
    if os.name == "nt":
        CREATE_NEW_CONSOLE = 0x00000010
        kwargs["creationflags"] = CREATE_NEW_CONSOLE
    else:
        # No terminal to show it in: the output goes to a file next to it.
        log = open(os.path.join(os.path.dirname(_script()), "rbrowser.log"), "a", encoding="utf-8")
        kwargs.update(stdout=log, stderr=log, start_new_session=True)
    subprocess.Popen(command, **kwargs)


def _tell(message: str) -> None:
    """pythonw has nowhere to print: on Windows the message is a dialog."""
    print(message)
    if os.name == "nt" and (sys.stdout is None or "pythonw" in os.path.basename(sys.executable).lower()):
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "rBrowser", 0x40)
        except Exception:
            pass


# Each running rBrowser leaves a note of where it listens, so a link goes to
# the one that is actually running - also one started with --port, which
# the saved settings know nothing about.
RUNNING_DIR = os.path.join("settings", "running")


def record_running(host: str, port: int) -> None:
    import atexit
    _forget_dead()
    path = os.path.join(RUNNING_DIR, f"{os.getpid()}.json")
    try:
        from .fileio import atomic_write_json
        atomic_write_json(path, {"pid": os.getpid(), "host": host, "port": int(port), "started": time.time()})
    except OSError:
        return

    def _forget() -> None:
        try:
            os.remove(path)
        except OSError:
            pass
    atexit.register(_forget)


def _forget_dead() -> None:
    """Notes of rBrowsers that were killed (no atexit): at each start, not
    only when a link is opened - over 100 had piled up."""
    from .server_settings import _pid_alive
    try:
        names = os.listdir(RUNNING_DIR)
    except OSError:
        return
    for name in names:
        try:
            pid = int(name.split(".")[0])
        except ValueError:
            continue
        if pid != os.getpid() and not _pid_alive(pid):
            try:
                os.remove(os.path.join(RUNNING_DIR, name))
            except OSError:
                pass


def running_instances() -> List[Dict[str, Any]]:
    """The rBrowsers that left a note and still answer, newest first."""
    from .server_settings import _pid_alive
    found = []
    try:
        names = os.listdir(RUNNING_DIR)
    except OSError:
        return []
    for name in names:
        path = os.path.join(RUNNING_DIR, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                note = json.load(handle)
            alive = _pid_alive(int(note["pid"]))
        except Exception:
            alive, note = False, None
        if not alive:
            # Left behind by one that did not exit cleanly.
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        found.append(note)
    found.sort(key=lambda n: -float(n.get("started") or 0))
    return [n for n in found if _is_rbrowser(_base_url(n["host"], n["port"]), timeout=1.0)]


# A link goes to the rBrowser page already open on this computer, as a new
# tab in it, rather than to a new browser tab. Every open page says who it
# is on each status poll (every 2 s); --open leaves the link here for the
# one in use - on this computer, the one focused or shown most recently -
# and the page picks it up on its next poll. A phone with rBrowser open on
# the LAN never gets it.
PAGE_ALIVE_S = 6.0


def _local_addresses() -> set:
    import socket
    found = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            found.add(info[4][0])
    except OSError:
        pass
    try:
        # The address of the default route, which getaddrinfo can miss.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            found.add(probe.getsockname()[0])
    except OSError:
        pass
    return found


class LinkInbox:
    def __init__(self) -> None:
        import threading
        self._lock = threading.Lock()
        self._pages: Dict[str, Dict[str, Any]] = {}
        self._waiting: Dict[str, List[str]] = {}
        self._local: Optional[set] = None

    def seen(self, page: str, address: str, visible: bool, focused: bool) -> List[str]:
        """A page polled: note it, and hand it the links left for it."""
        if not page or len(page) > 64:
            return []
        now = time.time()
        with self._lock:
            note = self._pages.setdefault(page, {"address": address, "focused": 0.0, "visible": 0.0})
            note.update(address=address, seen=now)
            if visible:
                note["visible"] = now
            if focused:
                note["focused"] = now
            for old in [p for p, n in self._pages.items() if now - n["seen"] > 3600]:
                self._pages.pop(old, None)
                self._waiting.pop(old, None)
            return self._waiting.pop(page, [])

    def deliver(self, url: str) -> bool:
        """Leave the link for the page in use here; False if there is none."""
        if self._local is None:
            self._local = _local_addresses()
        now = time.time()
        with self._lock:
            pages = [(p, n) for p, n in self._pages.items()
                     if now - n["seen"] < PAGE_ALIVE_S and n["address"] in self._local]
            if not pages:
                return False
            page, _ = max(pages, key=lambda pn: (pn[1]["focused"], pn[1]["visible"], pn[1]["seen"]))
            self._waiting.setdefault(page, []).append(url)
            return True


inbox = LinkInbox()


def _hand_to_page(base: str, target: str) -> bool:
    """Give the link to an rBrowser page already open; True if one took it."""
    body = json.dumps({"url": target}).encode("utf-8")
    request = urllib.request.Request(base + "/api/open-link", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return bool(json.loads(response.read().decode("utf-8", "replace")).get("delivered"))
    except Exception:
        return False


def _raise_browser_window() -> None:
    """Bring forward the browser window showing rBrowser (Windows only).
    Allowed because the browser that ran us was in front; when rBrowser is
    not the tab on screen in its window, its title is not there and the
    page's own title blinks instead."""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        found: List[int] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def check(hwnd, _):
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                if buffer.value.startswith("rBrowser"):
                    found.append(hwnd)
            return True

        user32.EnumWindows(check, 0)
        if found:
            SW_RESTORE = 9
            if user32.IsIconic(found[0]):
                user32.ShowWindow(found[0], SW_RESTORE)
            user32.SetForegroundWindow(found[0])
    except Exception:
        pass


def open_link(link: str, port_forced: Optional[int] = None, wait: float = 60.0) -> int:
    """rBrowser.py --open: find or start rBrowser, then show the page."""
    import webbrowser
    from .server_settings import ServerSettings

    saved = ServerSettings().saved
    host, port = saved["host"], saved["port"]
    if port_forced:
        port = port_forced
    else:
        # The one running, if any: the most recently started.
        running = running_instances()
        if running:
            host, port = running[0]["host"], running[0]["port"]
    base = _base_url(host, port)
    target = page_link(link)
    url = base + "/" + (("?url=" + urllib.parse.quote(target, safe="")) if target else "")

    if not _is_rbrowser(base):
        try:
            _start_rbrowser(port_forced)
        except Exception as exc:
            _tell(f"Could not start rBrowser: {exc}")
            return 1
        deadline = time.time() + wait
        while time.time() < deadline and not _is_rbrowser(base, timeout=1.0):
            time.sleep(0.5)
        if not _is_rbrowser(base):
            _tell(f"rBrowser did not start on {base} within {int(wait)} s.")
            return 1
    elif target and _hand_to_page(base, target):
        _raise_browser_window()
        return 0
    webbrowser.open(url)
    if link and not target:
        _tell(f"Not a NomadNet address: {link}")
    return 0


__all__ = ["SCHEMES", "status", "register", "unregister", "page_link", "open_link", "inbox",
           "handler_command", "platform_support"]
