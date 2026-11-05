"""
Settings > System Setup > Shortcuts: an rBrowser2 icon on the desktop and in
the system's app menu, which opens rBrowser in its own window (--app). If this
rBrowser is already running, the icon only opens a window on it.

Where, by system:
- Windows: rBrowser2.lnk on the Desktop and in the Start menu. Pinning to the
  taskbar cannot be done by a program on Windows 10/11: the user right-clicks
  the Start menu entry > Pin to taskbar. The .lnk carries the window's app id
  (appwindow.APP_ID), so the pinned icon and the open window are one button.
- Linux desktop: a .desktop file in ~/.local/share/applications (the app menu,
  where "Add to panel/favourites" is) and a copy on the Desktop.
- macOS: rBrowser2.command on the Desktop (drag it to the Dock). No app menu.
Termux, Docker and Linux without a desktop: not offered.

One icon per system, called rBrowser2: it is on for the folder it starts, and
switching it on from another rBrowser folder moves it there (like the links).
"""

from __future__ import annotations

import os
import shlex
import sys
from typing import Any, Dict, List, Optional

from .autostart import APP_DIR

LOGO_PNG = os.path.join(APP_DIR, "templates", "logo-256.png")
ICO_FILE = os.path.join(APP_DIR, "settings", "rbrowser2.ico")
KINDS = ("desktop", "menu")


def _command() -> List[str]:
    if getattr(sys, "frozen", False) or "__compiled__" in globals():
        return [sys.executable, "--app"]
    from .links import _python
    return [_python(windowless=True), os.path.join(APP_DIR, "rBrowser.py"), "--app"]


def _home(*parts: str) -> str:
    return os.path.join(os.path.expanduser("~"), *parts)


def system() -> Optional[str]:
    """windows, linux, mac or None (no desktop to put an icon on)."""
    if os.name == "nt":
        return "windows"
    if os.path.exists("/.dockerenv") or "com.termux" in os.environ.get("PREFIX", ""):
        return None
    if sys.platform == "darwin":
        return "mac"
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_CURRENT_DESKTOP"):
        return "linux"
    return None


# ---------------------------------------------------------------- folders

def _windows_folder(csidl: int) -> str:
    """Desktop (0x10) or Start menu Programs (0x02): the real ones, also when
    moved (OneDrive)."""
    import ctypes
    buf = ctypes.create_unicode_buffer(260)
    if ctypes.windll.shell32.SHGetFolderPathW(None, csidl, None, 0, buf) != 0:
        raise OSError("Windows did not say where that folder is")
    return buf.value


def _xdg_desktop() -> str:
    try:
        with open(_home(".config", "user-dirs.dirs"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("XDG_DESKTOP_DIR="):
                    value = line.split("=", 1)[1].strip().strip('"').replace("$HOME", _home())
                    if value:
                        return value
    except OSError:
        pass
    return _home("Desktop")


def path(kind: str, where: Optional[str] = None) -> Optional[str]:
    where = where or system()
    if where == "windows":
        return os.path.join(_windows_folder(0x10 if kind == "desktop" else 0x02), "rBrowser2.lnk")
    if where == "linux":
        folder = _xdg_desktop() if kind == "desktop" else _home(".local", "share", "applications")
        return os.path.join(folder, "rbrowser2.desktop")
    if where == "mac" and kind == "desktop":
        return os.path.join(_home("Desktop"), "rBrowser2.command")
    return None


def _ours(target: str) -> bool:
    """The icon starts this folder's rBrowser (a .lnk keeps the paths in UTF-16)."""
    try:
        with open(target, "rb") as handle:
            data = handle.read(65536)
    except OSError:
        return False
    if os.name == "nt":
        # a:\SCRIPTS and A:\scripts are the same folder
        return any(APP_DIR.lower().encode(enc) in data.lower() for enc in ("utf-8", "utf-16-le"))
    return any(APP_DIR.encode(enc) in data for enc in ("utf-8", "utf-16-le"))


# ---------------------------------------------------------------- Windows .lnk

def _ico() -> str:
    """The logo as a .ico (Pillow comes with the app version); "" without it."""
    try:
        from PIL import Image
        os.makedirs(os.path.dirname(ICO_FILE), exist_ok=True)
        Image.open(LOGO_PNG).convert("RGBA").save(
            ICO_FILE, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
        return ICO_FILE
    except Exception:
        return ICO_FILE if os.path.isfile(ICO_FILE) else ""


def _write_lnk(target: str, command: List[str], icon: str) -> None:
    """IShellLinkW + its property store (the app id) + IPersistFile, by ctypes."""
    import ctypes
    import subprocess
    from ctypes import wintypes
    from .appwindow import APP_ID

    class GUID(ctypes.Structure):
        _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

    class PROPERTYKEY(ctypes.Structure):
        _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]

    class PROPVARIANT(ctypes.Structure):
        _fields_ = [("vt", wintypes.USHORT), ("r1", wintypes.WORD), ("r2", wintypes.WORD), ("r3", wintypes.WORD),
                    ("value", ctypes.c_wchar_p), ("pad", ctypes.c_void_p)]

    def guid(d1, d2, d3, *d4):
        return GUID(d1, d2, d3, (ctypes.c_ubyte * 8)(*d4))

    def method(obj, index, *args):
        table = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *args)(table[index])

    clsid_link = guid(0x00021401, 0, 0, 0xC0, 0, 0, 0, 0, 0, 0, 0x46)
    iid_link = guid(0x000214F9, 0, 0, 0xC0, 0, 0, 0, 0, 0, 0, 0x46)
    iid_file = guid(0x0000010B, 0, 0, 0xC0, 0, 0, 0, 0, 0, 0, 0x46)
    iid_store = guid(0x886D8EEB, 0x8CF2, 0x4446, 0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99)
    key = PROPERTYKEY(guid(0x9F4C2855, 0x9F79, 0x4B39, 0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3), 5)

    ole32 = ctypes.windll.ole32
    ole32.CoInitialize(None)
    link = ctypes.c_void_p()
    if ole32.CoCreateInstance(ctypes.byref(clsid_link), None, 1, ctypes.byref(iid_link), ctypes.byref(link)) != 0:
        raise OSError("Could not create the shortcut (ShellLink)")
    held = [link]
    try:
        # IShellLinkW: SetDescription 7, SetWorkingDirectory 9, SetArguments 11, SetIconLocation 17, SetPath 20
        method(link, 20, ctypes.c_wchar_p)(link, command[0])
        method(link, 11, ctypes.c_wchar_p)(link, subprocess.list2cmdline(command[1:]))
        method(link, 9, ctypes.c_wchar_p)(link, APP_DIR)
        method(link, 7, ctypes.c_wchar_p)(link, "rBrowser2 - NomadNet browser")
        if icon:
            method(link, 17, ctypes.c_wchar_p, ctypes.c_int)(link, icon, 0)
        store = ctypes.c_void_p()
        if method(link, 0, ctypes.c_void_p, ctypes.c_void_p)(link, ctypes.byref(iid_store), ctypes.byref(store)) == 0:
            held.append(store)
            value = PROPVARIANT()
            value.vt = 31                            # VT_LPWSTR
            value.value = APP_ID
            method(store, 6, ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT))(
                store, ctypes.byref(key), ctypes.byref(value))
            method(store, 7)(store)
        persist = ctypes.c_void_p()
        if method(link, 0, ctypes.c_void_p, ctypes.c_void_p)(link, ctypes.byref(iid_file), ctypes.byref(persist)) != 0:
            raise OSError("Could not save the shortcut (IPersistFile)")
        held.append(persist)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if method(persist, 6, ctypes.c_wchar_p, wintypes.BOOL)(persist, target, True) != 0:
            raise OSError(f"Could not write {target}")
    finally:
        for obj in reversed(held):
            method(obj, 2)(obj)


def _windows_move(source: Optional[str], target: str) -> None:
    """Put the .lnk in place (or delete it, source None) through cmd. The
    Microsoft Store Python writes into AppData land in its own private copy
    (the Start menu never sees them); a child process writes the real one."""
    import subprocess
    # First the private copy, if there is one (else the real one, replaced anyway).
    try:
        os.remove(target)
    except OSError:
        pass
    args = ["move", "/y", source, target] if source else ["del", "/f", "/q", target]
    subprocess.run(["cmd", "/c", *args], capture_output=True, timeout=20,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if source and os.path.exists(source):
        os.remove(source)
        raise OSError(f"Could not write {target}")


# ---------------------------------------------------------------- Linux, macOS

def _desktop_entry(command: List[str]) -> str:
    return "\n".join(("[Desktop Entry]", "Type=Application", "Name=rBrowser2",
                      "Comment=NomadNet browser for Reticulum",
                      f"Exec={' '.join(shlex.quote(c) for c in command)}",
                      f"Path={APP_DIR}", f"Icon={LOGO_PNG}", "Terminal=false",
                      "Categories=Network;", "StartupWMClass=rBrowser2", ""))


def _mac_script(command: List[str]) -> str:
    return "\n".join(("#!/bin/sh", f"cd {shlex.quote(APP_DIR)}",
                      f"exec {' '.join(shlex.quote(c) for c in command)}", ""))


def _write_text(target: str, text: str) -> None:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.chmod(target, 0o755)


def _trust(target: str) -> None:
    """GNOME/Cinnamon want a desktop icon marked trusted, or they ask first."""
    import shutil
    import subprocess
    if shutil.which("gio"):
        subprocess.run(["gio", "set", target, "metadata::trusted", "true"], capture_output=True, timeout=10)


# ---------------------------------------------------------------- status, switches

HINT = {
    "windows": "Pin to the taskbar: right-click rBrowser2 in the Start menu > Pin to taskbar.",
    "linux": "From the app menu you can add it to the panel or the favourites.",
    "mac": "Drag it from the Desktop to the Dock to keep it there.",
}


def status() -> Dict[str, Any]:
    where = system()
    out: Dict[str, Any] = {"status": "success", "supported": bool(where), "system": where,
                           "desktop": False, "menu": False, "menu_supported": where in ("windows", "linux"),
                           "hint": HINT.get(where, ""), "note": ""}
    if not where:
        out["note"] = "No desktop here (server, Docker or Termux): nothing to put an icon on."
        return out
    from .appwindow import available
    why_not = available()
    if why_not:
        out.update(supported=False, note="The icons open rBrowser in its own window. " + why_not)
        return out
    try:
        for kind in KINDS:
            target = path(kind, where)
            out[kind] = bool(target) and _ours(target)
    except OSError as exc:
        out.update(supported=False, note=str(exc))
    return out


def set_on(kind: str, on: bool) -> Dict[str, Any]:
    if kind not in KINDS:
        raise ValueError("Unknown shortcut")
    current = status()
    if not current["supported"]:
        raise ValueError(current["note"] or "Shortcuts cannot be made here")
    where = current["system"]
    target = path(kind, where)
    if not target:
        raise ValueError("Not available on this system")
    if not on:
        if _ours(target):
            if where == "windows":
                _windows_move(None, target)
            else:
                os.remove(target)
        return status()
    command = _command()
    if where == "windows":
        temp = os.path.join(APP_DIR, "settings", "rBrowser2.lnk.tmp")
        _write_lnk(temp, command, _ico())
        _windows_move(temp, target)
    elif where == "linux":
        _write_text(target, _desktop_entry(command))
        if kind == "desktop":
            _trust(target)
    else:
        _write_text(target, _mac_script(command))
    return status()
