"""rBrowser as a desktop program: the page in a window of its own (--app).

A second process ("rBrowser.py --window"), started by the server process
when it is launched with --app. pywebview wants the main thread for its
windows, and the server process keeps its main thread for Reticulum (signal
handlers), so the two cannot share a process.

- Closing the main window ends this process, and the server process stops
  when it sees that (rBrowser.py). The server stopping (Shut down from the
  page, a crash) or restarting (a new instance in /api/status, which opens
  its own window) closes this one.
- window.open() from the page (a client in its own window, "Open in a new
  window", links between the windows) is turned into calls to WindowApi by
  the page itself (rbrowser.js, appWindowOpen): pages of this rBrowser open
  as windows of the app, one per name, brought forward when already open;
  anything else goes to the web browser. Left to pywebview, window.open('')
  handed about:blank to the system, which asked what program should open it.
- Minimizing goes to the tray or to the taskbar, as chosen in the tray menu
  (settings/window.json). Without pystray there is no tray, nothing else
  changes.
- The web storage is kept in settings/webview (pywebview starts private by
  default): the preferences the page keeps in localStorage survive.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import threading
import time
import urllib.request
import webbrowser
from typing import Any, Dict, Optional

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREFS = os.path.join(APP_DIR, "settings", "window.json")
STORAGE = os.path.join(APP_DIR, "settings", "webview")
TITLE = "rBrowser2"
BACKGROUND = "#0d1117"          # the page's background (style.css)
MAIN ="rbrowser-main"          # the main page's window name (rbrowser.js)
# The clients' own windows (rbrowser.js openAppTab: "rbrowser-app-<kind>").
CLIENT_TITLES = {"lxmf": "LXMF Client", "rrc": "RRC Client", "bbs": "BBS Client", "rmap": "RMAP Client"}


def _version() -> str:
    """The version in version.txt (lines with # are comments), or ''."""
    try:
        with open(os.path.join(APP_DIR, "version.txt"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return ""


def _splash_html() -> str:
    """What the main window shows from the first moment, while rBrowser
    starts and the server does not answer yet: the page's own splash
    (index.html, style.css .rb-splash), which takes over when it loads."""
    import base64
    try:
        with open(os.path.join(APP_DIR, "templates", "logo.png"), "rb") as fh:
            logo = "data:image/png;base64," + base64.b64encode(fh.read()).decode("ascii")
    except OSError:
        logo = ""
    version = _version()
    sub = "Standalone Reticulum Browser" + (f" &middot; v{version}" if version else "")
    img = f'<img src="{logo}" alt="">' if logo else ""
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{TITLE}</title><style>
html, body {{ margin: 0; height: 100%; background: {BACKGROUND}; overflow: hidden; }}
body {{ display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
       background: radial-gradient(circle at 50% 42%, #1a1033 0%, {BACKGROUND} 60%);
       font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }}
img {{ width: 240px; height: 240px; animation: pulse 2.4s ease-in-out infinite; will-change: transform; }}
@keyframes pulse {{ 0%, 100% {{ transform: scale(1); }} 50% {{ transform: scale(1.03); }} }}
.name {{ color: #e6edf3; font-size: 26px; font-weight: 700; letter-spacing: .5px; }}
.sub {{ color: #8b949e; font-size: 13px; }}
</style></head><body>{img}<div class="name">{TITLE}</div><div class="sub">{sub}</div></body></html>"""


def window_title(name: str) -> str:
    """Each window says what it is, also in the taskbar previews: the main
    one "rBrowser2 v2.0.6b", a client's "rBrowser2 - LXMF Client"."""
    if name == MAIN:
        version = _version()
        return f"{TITLE} v{version}" if version else TITLE
    kind = name[len("rbrowser-app-"):] if name.startswith("rbrowser-app-") else ""
    return f"{TITLE} - {CLIENT_TITLES[kind]}" if kind in CLIENT_TITLES else TITLE


def available() -> Optional[str]:
    """Why --app cannot open a window here, or None."""
    import importlib.util
    if importlib.util.find_spec("webview") is None:
        return ("--app needs pywebview: run the installer again and answer yes to the app version, "
                "or pip install -r requirements-app.txt")
    return None


def _load_prefs() -> Dict[str, Any]:
    try:
        with open(PREFS, encoding="utf-8") as handle:
            prefs = json.load(handle)
        return prefs if isinstance(prefs, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_prefs(prefs: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(PREFS), exist_ok=True)
        with open(PREFS, "w", encoding="utf-8") as handle:
            json.dump(prefs, handle, indent=2)
    except OSError:
        pass


LOGO_PNG = os.path.join(APP_DIR, "templates", "logo-256.png")


def _icon_image(size: int = 64):
    """The icon of the windows and of the tray: the logo (logo-256.png),
    or drawn here if that file is missing."""
    from PIL import Image, ImageDraw
    try:
        return Image.open(LOGO_PNG).convert("RGBA").resize((size, size), Image.LANCZOS)
    except Exception:
        pass
    s = size / 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2 * s, 2 * s, 62 * s, 62 * s), fill=(20, 24, 28, 255), outline=(0, 200, 120, 255),
              width=max(1, round(5 * s)))
    d.line((22 * s, 46 * s, 22 * s, 20 * s), fill=(0, 200, 120, 255), width=max(1, round(7 * s)))
    d.arc((20 * s, 18 * s, 46 * s, 40 * s), start=180, end=300, fill=(0, 200, 120, 255),
          width=max(1, round(7 * s)))
    return img


def _icon_file() -> Optional[str]:
    """The same icon as a .ico, for the windows and the taskbar."""
    path = os.path.join(STORAGE, "rbrowser2.ico")
    try:
        os.makedirs(STORAGE, exist_ok=True)
        _icon_image(256).save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
        return path
    except Exception:
        return None


APP_ID = "rBrowser2.App"


def set_window_app_id(hwnd: int, app_id: str = APP_ID) -> bool:
    """The same id on one window (its property store, PKEY_AppUserModel_ID).
    The process-wide id (_taskbar_identity) is ignored for a packaged Python,
    the Microsoft Store one: its windows stayed in the Python group, with
    Python's icon. Set on each window, it holds there too."""
    if os.name != "nt" or not hwnd:
        return False
    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

    class PROPERTYKEY(ctypes.Structure):
        _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]

    class PROPVARIANT(ctypes.Structure):
        _fields_ = [("vt", wintypes.USHORT), ("r1", wintypes.WORD), ("r2", wintypes.WORD), ("r3", wintypes.WORD),
                    ("value", ctypes.c_wchar_p), ("pad", ctypes.c_void_p)]

    def guid(d1, d2, d3, *d4):
        return GUID(d1, d2, d3, (ctypes.c_ubyte * 8)(*d4))

    iid_store = guid(0x886D8EEB, 0x8CF2, 0x4446, 0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99)
    key = PROPERTYKEY(guid(0x9F4C2855, 0x9F79, 0x4B39, 0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3), 5)
    ctypes.windll.ole32.CoInitialize(None)
    store = ctypes.c_void_p()
    if ctypes.windll.shell32.SHGetPropertyStoreForWindow(wintypes.HWND(hwnd), ctypes.byref(iid_store),
                                                          ctypes.byref(store)) != 0 or not store:
        return False
    table = ctypes.cast(store, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    # IPropertyStore: QueryInterface, AddRef, Release, GetCount, GetAt, GetValue, SetValue, Commit
    release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(table[2])
    set_value = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(PROPERTYKEY),
                                   ctypes.POINTER(PROPVARIANT))(table[6])
    commit = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(table[7])
    value = PROPVARIANT()
    value.vt = 31                                    # VT_LPWSTR
    value.value = app_id
    try:
        return set_value(store, ctypes.byref(key), ctypes.byref(value)) == 0 and commit(store) == 0
    finally:
        release(store)


def set_dark_title_bar(hwnd: int) -> bool:
    """A dark title bar on Windows 10/11, as the page is dark: the default
    white one stood out. DWMWA_USE_IMMERSIVE_DARK_MODE is 20, or 19 on the
    Windows 10 builds before 20H1; then the frame is redrawn."""
    if os.name != "nt" or not hwnd:
        return False
    import ctypes
    on = ctypes.c_int(1)
    done = False
    for attribute in (20, 19):
        if ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attribute, ctypes.byref(on), ctypes.sizeof(on)) == 0:
            done = True
            break
    def redraw():
        user32 = ctypes.windll.user32
        # SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x1 | 0x2 | 0x4 | 0x20)
        # Only WM_NCACTIVATE repaints the whole bar: the redraws alone left it
        # white with just the title on black. Sent off and back to the state
        # the window is in, so an inactive one does not look active.
        active = 1 if user32.GetForegroundWindow() == hwnd else 0
        user32.SendMessageW(hwnd, 0x0086, 1 - active, 0)
        user32.SendMessageW(hwnd, 0x0086, active, 0)
    # Set as the window appears, the old white bar stayed until the frame was
    # drawn again: drawn again once it is on the screen too.
    redraw()
    for delay in (0.5, 2.0):
        threading.Timer(delay, redraw).start()
    return done


def set_dark_webview(window) -> bool:
    """WebView2's own panels dark too, like the downloads box that opens at
    the top right when a file is saved (it was white): the profile's
    preferred colour scheme. Windows only (window.native is the WinForms
    form, its .webview the WebView2 control), on the window's own thread,
    once WebView2 is ready (the page has loaded)."""
    if os.name != "nt":
        return False
    try:
        import System
        from Microsoft.Web.WebView2.Core import CoreWebView2PreferredColorScheme
        form = window.native

        def apply():
            # WebView2 is only touched from its own thread.
            form.webview.CoreWebView2.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark

        form.Invoke(System.Action(apply))
        return True
    except Exception:
        return False


def set_download_folder(window, folder: str) -> bool:
    """Where WebView2's save window opens (Profile.DefaultDownloadFolderPath).
    Windows only, on the window's own thread like set_dark_webview."""
    if os.name != "nt":
        return False
    try:
        import System
        form = window.native

        def apply():
            form.webview.CoreWebView2.Profile.DefaultDownloadFolderPath = folder

        form.Invoke(System.Action(apply))
        return True
    except Exception:
        return False


def _taskbar_identity() -> None:
    """Windows groups taskbar buttons by program: as python.exe the windows
    joined the terminals' group and took Python's icon. An id of its own
    gives them their own button, with the icon above."""
    if os.name != "nt":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("rBrowser2.App")
    except Exception:
        pass


def _status(url: str) -> Optional[Dict[str, Any]]:
    """/api/status, {} when the server answers but refuses (the access
    password asked on this computer too), None when nothing answers."""
    import urllib.error
    try:
        with urllib.request.urlopen(f"{url}/api/status", timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError:
        return {}
    except Exception:
        return None


def _wait_for_server(url: str, seconds: float = 20.0) -> None:
    end = time.time() + seconds
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=2).close()
            return
        except Exception:
            time.sleep(0.3)


class Windows:
    """The app's windows by name, as window.open() names them in the page."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.named: Dict[str, Any] = {}
        self.lock = threading.Lock()
        self.unnamed = itertools.count(1)   # _blank windows: a new one every time
        self.minimized: Dict[int, bool] = {}  # id(window) -> minimized (or hidden in the tray)
        # id(window) -> (x, y, width, height) when last seen on screen: a
        # window shown again where Windows parks the minimized ones (-32000)
        # is put back there.
        self.geometry: Dict[int, tuple] = {}
        self.api = WindowApi(self)

    def create(self, url: Optional[str], name: str, width: int = 1280, height: int = 820,
               html: Optional[str] = None):
        import webview
        # Dark like the page while it loads, not a white flash.
        window = webview.create_window(window_title(name), url, html=html, width=width, height=height,
                                       min_size=(400, 300), js_api=self.api, text_select=True,
                                       background_color=BACKGROUND)
        self.named[name] = window
        self.minimized[id(window)] = False
        self.geometry[id(window)] = (None, None, width, height)

        def gone():
            with self.lock:
                if self.named.get(name) is window:
                    del self.named[name]
                self.minimized.pop(id(window), None)
                self.geometry.pop(id(window), None)

        def state(minimized):
            def on_event():
                self.minimized[id(window)] = minimized
            return on_event

        def remember(*_):
            try:
                x, y, w, h = window.x, window.y, window.width, window.height
            except Exception:
                return
            if x is not None and x > -10000 and y > -10000:
                self.geometry[id(window)] = (x, y, w, h)
        def own_taskbar_button():
            # window.native: the WinForms form on Windows (None elsewhere).
            # Its own taskbar button, and a dark title bar like the page.
            try:
                hwnd = int(window.native.Handle.ToInt64())
            except Exception:
                return
            for apply in (set_window_app_id, set_dark_title_bar):
                try:
                    apply(hwnd)
                except Exception:
                    pass
        window.events.closed += gone
        window.events.shown += own_taskbar_button
        window.events.loaded += lambda: set_dark_webview(window)
        window.events.minimized += state(True)
        window.events.restored += state(False)
        window.events.maximized += state(False)
        window.events.moved += remember
        window.events.resized += remember
        return window

    def on_screen(self, window) -> None:
        """Back where it was if it came back where Windows parks the
        minimized windows: shown, but off the screen and at the minimum size."""
        try:
            if window.x is None or window.x > -10000:
                return
            x, y, w, h = self.geometry.get(id(window)) or (None, None, 1280, 820)
            window.resize(w, h)
            window.move(80 if x is None else x, 60 if y is None else y)
        except Exception:
            pass

    def ours(self, url: str) -> bool:
        return url == self.base or url.startswith(self.base + "/")

    def open(self, url: str, name: str) -> None:
        with self.lock:
            window = self.named.get(name) if name else None
        if window is not None:
            self.focus(name)
            return
        self.create(url, name or f"rbrowser-window-{next(self.unnamed)}", 1100, 760)

    def focus(self, name: str) -> None:
        with self.lock:
            window = self.named.get(name)
        if window is None:
            return
        # show() brings it forward (Show + Activate, on the window's own
        # thread). restore() only for a minimized one: it would also shrink
        # a maximized window. Not on_top, which pywebview sets from the
        # calling thread on Windows: from the page's call it hung the app.
        try:
            if self.minimized.get(id(window)):
                window.restore()
            window.show()
        except Exception:
            pass
        self.on_screen(window)

    def close_all(self) -> None:
        with self.lock:
            windows = list(self.named.values())
        for window in windows:
            try:
                window.destroy()
            except Exception:
                pass


class WindowApi:
    """Called from the page (window.pywebview.api) in place of window.open()."""

    def __init__(self, windows: Windows) -> None:
        self._windows = windows

    def open_window(self, url: str, name: str = "") -> bool:
        url = str(url or "")
        if self._windows.ours(url):
            self._windows.open(url, str(name or ""))
            return True
        return self.open_external(url)

    def focus_window(self, name: str) -> bool:
        self._windows.focus(str(name or ""))
        return True

    def set_download_folder(self, folder: str) -> bool:
        """Settings > File Downloads: the save window opens in this folder.
        The windows share one profile, so one window is enough."""
        folder = str(folder or "")
        if not folder or not os.path.isabs(folder):
            return False
        try:
            os.makedirs(folder, exist_ok=True)
        except OSError:
            return False
        with self._windows.lock:
            windows = list(self._windows.named.values())
        return any(set_download_folder(window, folder) for window in windows)

    def open_external(self, url: str) -> bool:
        url = str(url or "")
        if url.startswith(("http://", "https://", "mailto:")):
            webbrowser.open(url)
            return True
        return False


def run_window(argv) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--window", action="store_true")
    parser.add_argument("--url", default="http://127.0.0.1:5000")
    parser.add_argument("--parent", type=int, default=0)
    args, _ = parser.parse_known_args(argv[1:])

    import psutil
    import webview
    try:
        import pystray
    except ImportError:
        pystray = None

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    prefs = _load_prefs()
    prefs.setdefault("minimize_to_tray", True)

    _taskbar_identity()
    windows = Windows(args.url)
    # At once, with the splash: the page itself comes when the server
    # answers (watch_server), which while Reticulum starts can take seconds.
    main = windows.create(None, MAIN, html=_splash_html())
    state = {"closing": False}
    icon = None

    def quit_all(*_):
        if state["closing"]:
            return
        state["closing"] = True
        if icon is not None:
            try:
                icon.stop()
            except Exception:
                pass
        windows.close_all()

    # The main window closed: the app ends, the client windows with it.
    main.events.closed += quit_all

    if pystray is not None:
        def show(*_):
            windows.focus(MAIN)

        def toggle_tray(*_):
            prefs["minimize_to_tray"] = not prefs["minimize_to_tray"]
            _save_prefs(prefs)

        icon = pystray.Icon("rBrowser2", _icon_image(), TITLE, menu=pystray.Menu(
            pystray.MenuItem("Open rBrowser2", show, default=True),
            pystray.MenuItem("Minimize to tray", toggle_tray, checked=lambda item: prefs["minimize_to_tray"]),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit rBrowser2", quit_all),
        ))

        def on_minimized():
            if prefs["minimize_to_tray"]:
                # Back to normal first, then hidden: a window hidden while
                # minimized keeps the parked position (-32000) and came back
                # off the screen, at the minimum size.
                main.restore()
                main.hide()

        main.events.minimized += on_minimized

    def watch_server():
        _wait_for_server(args.url)
        first = (_status(args.url) or {}).get("instance")
        if not state["closing"]:
            main.load_url(args.url + "/")
        # Gone (Shut down, a crash) or restarted (another instance, which
        # opens its own window): nothing left for this one to show.
        misses = 0
        while not state["closing"]:
            time.sleep(2)
            if args.parent and not psutil.pid_exists(args.parent):
                quit_all()
                return
            status = _status(args.url)
            if status is None:
                misses += 1
                if misses >= 15:
                    quit_all()
                    return
                continue
            misses = 0
            now = status.get("instance")
            if first is not None and now is not None and now != first:
                quit_all()
                return

    if icon is not None:
        try:
            icon.run_detached()
        except Exception as exc:
            # macOS wants the tray on the main thread, which the window has.
            print(f"⚠️ No tray icon here: {exc}")
            icon = None
            main.events.minimized -= on_minimized
    threading.Thread(target=watch_server, name="rbrowser-window-watch", daemon=True).start()
    webview.start(private_mode=False, storage_path=STORAGE, icon=_icon_file())
    quit_all()
    return 0
