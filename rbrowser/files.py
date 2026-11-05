"""
Settings > File Downloads: where NomadNet downloads go, and the files rBrowser has,
to see, open, show in their folder or delete without leaving rBrowser.

Two places, kept apart:
  nomadnet  the download folder, the user's Downloads/rBrowser unless
            chosen otherwise (settings/files.json). Only its own files,
            no subfolders: it is rBrowser's, never the whole Downloads.
  lxmf      what the LXMF chats received, downloads/<contact>/<file>
            inside rBrowser (messenger.DOWNLOADS_DIR).

Open and Show act on the computer running rBrowser, so they are only
answered to a page opened on that computer; Open never starts a program
(an .exe, a script...): those can only be shown in their folder.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from typing import Any, Dict, List, Optional

from .fileio import atomic_write_json

SETTINGS_FILE = os.path.join("settings", "files.json")

# Opened with a double click these would run something, not show it.
RUNNABLE = {".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".vbe", ".js", ".jse",
            ".wsf", ".wsh", ".hta", ".lnk", ".url", ".reg", ".jar", ".py", ".pyw", ".sh", ".bash",
            ".command", ".app", ".desktop", ".run", ".bin", ".appimage", ".deb", ".rpm", ".pkg", ".dmg"}


def _user_downloads() -> str:
    """The user's Downloads folder: on Linux the one named in
    ~/.config/user-dirs.dirs (it can be "Scaricati"), else ~/Downloads."""
    home = os.path.expanduser("~")
    if sys.platform.startswith("linux"):
        try:
            with open(os.path.join(home, ".config", "user-dirs.dirs"), encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("XDG_DOWNLOAD_DIR="):
                        value = line.split("=", 1)[1].strip().strip('"').replace("$HOME", home)
                        if value:
                            return value
        except OSError:
            pass
    return os.path.join(home, "Downloads")


def default_folder() -> str:
    return os.path.join(_user_downloads(), "rBrowser")


def _lxmf_root() -> str:
    from .messenger import DOWNLOADS_DIR
    return os.path.abspath(DOWNLOADS_DIR)


def _entry(path: str, rel: str, **extra: Any) -> Dict[str, Any]:
    st = os.stat(path)
    return {"name": os.path.basename(path), "rel": rel, "size": st.st_size, "mtime": st.st_mtime, **extra}


class Files:
    def __init__(self, path: str = SETTINGS_FILE):
        self.path = path
        self.lock = threading.Lock()
        self.folder = default_folder()
        # The save window; off (the default) = straight into the folder, so
        # every download is in the list. A phone always saves on itself.
        self.ask = False
        try:
            import json
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data.get("folder"), str) and data["folder"].strip():
                self.folder = data["folder"]
            self.ask = bool(data.get("ask", False))
        except (OSError, ValueError, AttributeError):
            pass

    # Settings ------------------------------------------------------------

    def settings(self) -> Dict[str, Any]:
        return {"folder": os.path.abspath(self.folder), "default_folder": default_folder(), "ask": self.ask,
                "lxmf_folder": _lxmf_root()}

    def update(self, data: Dict[str, Any]) -> Dict[str, Any]:
        folder = data.get("folder", self.folder)
        folder = os.path.abspath(os.path.expanduser(str(folder or "").strip() or default_folder()))
        if os.path.exists(folder) and not os.path.isdir(folder):
            return {"status": "error", "error": "That is a file, not a folder"}
        try:
            os.makedirs(folder, exist_ok=True)
        except OSError as exc:
            return {"status": "error", "error": f"Cannot use that folder: {exc}"}
        with self.lock:
            self.folder = folder
            if "ask" in data:
                self.ask = bool(data["ask"])
            atomic_write_json(self.path, {"folder": self.folder, "ask": self.ask}, indent=1)
        return {"status": "success", **self.settings()}

    # The files -----------------------------------------------------------

    def root(self, kind: str) -> Optional[str]:
        if kind == "nomadnet":
            return os.path.abspath(self.folder)
        if kind == "lxmf":
            return _lxmf_root()
        return None

    def resolve(self, kind: str, rel: Any) -> Optional[str]:
        """A file of that list, never anything outside its folder."""
        root = self.root(kind)
        rel = str(rel or "").replace("\\", "/")
        if not root or not rel or rel.startswith("/") or ".." in rel.split("/"):
            return None
        depth = 1 if kind == "nomadnet" else 2        # lxmf: <contact>/<file>
        if len(rel.split("/")) != depth:
            return None
        full = os.path.abspath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            return None
        return full

    def list(self) -> Dict[str, Any]:
        nomadnet: List[Dict[str, Any]] = []
        root = self.root("nomadnet")
        try:
            for name in os.listdir(root):
                full = os.path.join(root, name)
                if os.path.isfile(full) and not name.startswith("."):
                    nomadnet.append(_entry(full, name))
        except OSError:
            pass
        lxmf: List[Dict[str, Any]] = []
        root = self.root("lxmf")
        try:
            for contact in os.listdir(root):
                folder = os.path.join(root, contact)
                if not os.path.isdir(folder):
                    continue
                for name in os.listdir(folder):
                    full = os.path.join(folder, name)
                    if os.path.isfile(full) and not name.startswith("."):
                        lxmf.append(_entry(full, f"{contact}/{name}", contact=contact))
        except OSError:
            pass
        newest = lambda e: -e["mtime"]      # noqa: E731
        return {"status": "success", "nomadnet": sorted(nomadnet, key=newest),
                "lxmf": sorted(lxmf, key=newest), **self.settings()}

    def save(self, name: str, data: bytes) -> str:
        """Into the download folder, "name (2).ext" when taken. Returns the
        name it got."""
        from .messenger import safe_filename
        folder = self.root("nomadnet")
        os.makedirs(folder, exist_ok=True)
        fname = safe_filename(name, "download")
        stem, dot, ext = fname.rpartition(".")
        if not dot:
            stem, ext = fname, ""
        candidate, n = fname, 1
        while True:
            try:
                # "x": never over a file already there.
                with open(os.path.join(folder, candidate), "xb") as handle:
                    handle.write(data)
                return candidate
            except FileExistsError:
                n += 1
                candidate = f"{stem} ({n}){'.' + ext if ext else ''}"

    def delete(self, kind: str, rel: Any, messenger: Any = None) -> Dict[str, Any]:
        path = self.resolve(kind, rel)
        if not path:
            return {"status": "error", "error": "No such file"}
        if kind == "lxmf" and messenger is not None and hasattr(messenger, "forget_file_path"):
            # The chat then shows it as deleted, not as a file that is missing.
            messenger.forget_file_path(str(rel).replace("\\", "/"))
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            return {"status": "error", "error": f"Could not delete it: {exc}"}
        return {"status": "success"}

    def open(self, kind: str, rel: Any, show: bool) -> Dict[str, Any]:
        path = self.resolve(kind, rel)
        if not path:
            return {"status": "error", "error": "No such file"}
        if not show and os.path.splitext(path)[1].lower() in RUNNABLE:
            return {"status": "error", "error": "A program or a script is not opened from here: "
                                                "use Show in folder, and look at it first"}
        return _launch(path, select=show)

    def open_folder(self, kind: str) -> Dict[str, Any]:
        root = self.root(kind)
        if not root:
            return {"status": "error", "error": "No such folder"}
        try:
            os.makedirs(root, exist_ok=True)
        except OSError as exc:
            return {"status": "error", "error": str(exc)}
        return _launch(root, select=False)


def _launch(path: str, select: bool) -> Dict[str, Any]:
    """Open a file or a folder with the system, or show a file selected in
    its folder (select)."""
    try:
        if os.name == "nt":
            if select:
                subprocess.Popen(["explorer", "/select,", path])
            else:
                os.startfile(path)        # noqa: S606 - the user's own click, never a program
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path] if select else ["open", path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(path) if select else path])
    except OSError as exc:
        return {"status": "error", "error": str(exc)}
    return {"status": "success"}


def is_local(address: Optional[str]) -> bool:
    """The page was opened on the computer running rBrowser."""
    return str(address or "") in ("127.0.0.1", "::1", "::ffff:127.0.0.1") or str(address or "").startswith("127.")


__all__ = ["Files", "default_folder", "is_local", "RUNNABLE"]
