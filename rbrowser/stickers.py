"""
Sticker packs for RRC (Settings > RRC Client > Stickers)
========================================================

Nothing comes with rBrowser: the user downloads the packs from their
official sources, unchanged. Each pack is kept as one file per emoji,
named by its code points ("1f600.svg", "1f468-200d-1f469.png"; lower case,
without FE0F), in settings/stickers/<pack>/, with index.json beside them.

A sticker in a room is the emoji as the body plus our envelope key
(rrc.K_STICKER) [pack, code points]: who has the pack sees the picture,
everyone else the emoji.

Telegram sets come through the Bot API with the user's own bot token
(getStickerSet, getFile), kept in settings/stickers/telegram.json and never
sent to the page: settings/stickers/tg/<set>/<file_unique_id>.<webp|webm|tgs>,
plus <id>.thumb.<webp|jpg> for the moving ones. Key [tg-<set>, file_unique_id].
"""

import gzip
import hashlib
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

STICKERS_DIR = os.path.join("settings", "stickers")
USER_AGENT = "rBrowser"
CHUNK = 256 * 1024

def _log(text: str) -> None:
    try:
        print(text)
    except Exception:
        try:
            print(text.encode("ascii", "replace").decode())
        except Exception:
            pass


PACKS: Dict[str, Dict[str, Any]] = {
    "openmoji": {
        "name": "OpenMoji",
        "author": "HfG Schwäbisch Gmünd",
        "license": "CC BY-SA 4.0",
        "home": "https://openmoji.org/",
        "url": "https://github.com/hfg-gmuend/openmoji/releases/download/17.0.0/openmoji-svg-color.zip",
        "download_mb": 5.1,
        "disk_mb": 13,
        "ext": "svg",
    },
    "twemoji": {
        "name": "Twemoji",
        "author": "Twitter, Inc. and other contributors",
        "license": "CC BY 4.0",
        "home": "https://github.com/jdecked/twemoji",
        "url": "https://github.com/jdecked/twemoji/archive/refs/tags/v17.0.3.zip",
        "download_mb": 10.1,
        "disk_mb": 10,
        "ext": "svg",
    },
    "fluent3d": {
        "name": "Fluent Emoji 3D",
        "author": "Microsoft",
        "license": "MIT",
        "home": "https://github.com/microsoft/fluentui-emoji",
        "url": "https://github.com/microsoft/fluentui-emoji/archive/refs/heads/main.zip",
        "download_mb": 146,
        "disk_mb": 54,
        "ext": "png",
    },
}

_HEXSEQ = re.compile(r"^[0-9a-f]{2,6}(-[0-9a-f]{2,6}){0,9}$")
_PACK_ID = re.compile(r"^[a-z0-9]{1,16}$")

# Telegram sets, imported by the user with their own bot token: pack "tg-<set
# name in lower case>", one file per sticker named by its file_unique_id.
TG_PREFIX = "tg-"
TG_DIR = "tg"
TG_API = "https://api.telegram.org"
_TG_PACK = re.compile(r"^tg-[a-z0-9_]{1,64}$")
_TG_NAME = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_TG_KEY = re.compile(r"^[A-Za-z0-9_-]{6,40}$")
_TG_TOKEN = re.compile(r"^[0-9]{4,15}:[A-Za-z0-9_-]{20,64}$")
TG_EXTS = ("webp", "webm", "tgs")
TG_MAX_FILE = 1024 * 1024           # Telegram's own caps are 512 KB webp, 256 KB webm, 64 KB tgs
TG_MAX_JSON = 8 * 1024 * 1024       # a tgs unpacked
TG_MAX_STICKERS = 200
TG_THREADS = 4

# Animated (tgs) stickers are drawn by lottie-web, downloaded on request.
LOTTIE_URL = "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js"
LOTTIE_SHA256 = "23cd2c01be3d4da8bb664645d03afaff40879c62dc5f8dfe075ab3aa35c108f3"
LOTTIE_FILE = "lottie_light.min.js"


def tg_set_name(link: Any) -> Optional[str]:
    """The set name from tg://addstickers?set=X, t.me/addstickers/X or X."""
    text = str(link or "").strip()
    m = re.search(r"[?&]set=([A-Za-z0-9_]+)", text) or re.search(r"t(?:elegram)?\.me/addstickers/([A-Za-z0-9_]+)", text)
    name = m.group(1) if m else text
    return name if _TG_NAME.match(name) else None


def _magic(ext: str, data: bytes) -> bool:
    if ext == "webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if ext == "webm":
        return data[:4] == b"\x1a\x45\xdf\xa3"
    if ext == "tgs":
        return data[:2] == b"\x1f\x8b"
    if ext == "jpg":
        return data[:3] == b"\xff\xd8\xff"
    return False


def _emoji_cp(emoji: Any) -> Optional[str]:
    return norm_cp("-".join(f"{ord(c):x}" for c in str(emoji or "")))


def norm_cp(value: Any) -> Optional[str]:
    """Code points as we name the files: lower case, "-" between them,
    without FE0F (the packs disagree on it). None if it is not that."""
    parts = [p for p in re.split(r"[\s_\-]+", str(value or "").strip().lower()) if p and p != "fe0f"]
    cp = "-".join(parts)
    return cp if _HEXSEQ.match(cp) else None


def clean_sticker(value: Any) -> Optional[List[str]]:
    """[pack, code points] from an envelope or the page, or None."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    pack, cp = value
    if isinstance(pack, str) and _TG_PACK.match(pack):
        return [pack, cp] if isinstance(cp, str) and _TG_KEY.match(cp) else None
    if not isinstance(pack, str) or not _PACK_ID.match(pack):
        return None
    cp = norm_cp(cp) if isinstance(cp, str) else None
    return [pack, cp] if cp else None


def _private(cp: str) -> bool:
    """OpenMoji's own extras live in the private use areas: no emoji to
    hang them on."""
    first = int(cp.split("-")[0], 16)
    return 0xE000 <= first <= 0xF8FF or first >= 0xF0000


def _openmoji(z: zipfile.ZipFile) -> Dict[str, zipfile.ZipInfo]:
    out = {}
    for info in z.infolist():
        name = info.filename.rsplit("/", 1)[-1]
        if info.is_dir() or not name.lower().endswith(".svg"):
            continue
        cp = norm_cp(name[:-4])
        if cp and not _private(cp):
            out.setdefault(cp, info)
    return out


def _twemoji(z: zipfile.ZipFile) -> Dict[str, zipfile.ZipInfo]:
    out = {}
    for info in z.infolist():
        if info.is_dir() or "/assets/svg/" not in info.filename or not info.filename.endswith(".svg"):
            continue
        cp = norm_cp(info.filename.rsplit("/", 1)[-1][:-4])
        if cp:
            out.setdefault(cp, info)
    return out


def _fluent3d(z: zipfile.ZipFile) -> Dict[str, zipfile.ZipInfo]:
    """assets/<Name>/metadata.json says the emoji; its picture is in
    <Name>/3D/, or <Name>/Default/3D/ for those with skin tones."""
    by_dir: Dict[str, List[zipfile.ZipInfo]] = {}
    metas = []
    for info in z.infolist():
        if info.is_dir():
            continue
        parts = info.filename.split("/")
        if len(parts) < 4 or parts[1] != "assets":
            continue
        folder = "/".join(parts[:3])
        if parts[-1] == "metadata.json" and len(parts) == 4:
            metas.append((folder, info))
        elif parts[-1].endswith(".png") and parts[-2] == "3D" and (len(parts) == 5 or parts[3] == "Default"):
            by_dir.setdefault(folder, []).append(info)
    out = {}
    for folder, info in metas:
        try:
            meta = json.loads(z.read(info).decode("utf-8"))
        except Exception:
            continue
        cp = norm_cp(meta.get("unicode"))
        pngs = by_dir.get(folder)
        if cp and pngs:
            out.setdefault(cp, sorted(pngs, key=lambda i: len(i.filename))[0])
    return out


PICKERS = {"openmoji": _openmoji, "twemoji": _twemoji, "fluent3d": _fluent3d}


class Stickers:
    def __init__(self, root: str = STICKERS_DIR) -> None:
        self.root = root
        self.lock = threading.Lock()
        self.jobs: Dict[str, Dict[str, Any]] = {}     # pack -> {"state", "done", "total", "error"}
        self._index: Dict[str, Dict[str, Any]] = {}
        self.revision = 0

    # ------------------------------------------------------------ installed

    def _dir(self, pack: str) -> str:
        if pack.startswith(TG_PREFIX):
            return os.path.join(self.root, TG_DIR, pack[len(TG_PREFIX):])
        return os.path.join(self.root, pack)

    def _known(self, pack: str) -> bool:
        return pack in PACKS or bool(_TG_PACK.match(pack))

    def index(self, pack: str) -> Optional[Dict[str, Any]]:
        if not isinstance(pack, str) or not self._known(pack):
            return None
        with self.lock:
            if pack in self._index:
                return self._index[pack]
        path = os.path.join(self._dir(pack), "index.json")
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            return None
        field = "items" if pack.startswith(TG_PREFIX) else "cps"
        if not isinstance(data, dict) or not isinstance(data.get(field), list):
            return None
        with self.lock:
            self._index[pack] = data
        return data

    def installed(self) -> List[str]:
        return [p for p in PACKS if self.index(p)] + self.tg_packs()

    def tg_packs(self) -> List[str]:
        try:
            names = sorted(os.listdir(os.path.join(self.root, TG_DIR)))
        except OSError:
            return []
        return [TG_PREFIX + n for n in names if _TG_PACK.match(TG_PREFIX + n) and self.index(TG_PREFIX + n)]

    def file_for(self, pack: str, cp: Any, thumb: bool = False) -> Optional[str]:
        """The file of one sticker, or None (not installed, no such emoji)."""
        if isinstance(pack, str) and pack.startswith(TG_PREFIX):
            return self._tg_file(pack, cp, thumb)
        cp = norm_cp(cp)
        idx = self.index(pack)
        if not cp or not idx or cp not in set(idx["cps"]):
            return None
        path = os.path.join(self._dir(pack), f"{cp}.{PACKS[pack]['ext']}")
        return path if os.path.isfile(path) else None

    def _tg_file(self, pack: str, key: Any, thumb: bool) -> Optional[str]:
        idx = self.index(pack)
        if not idx or not isinstance(key, str) or not _TG_KEY.match(key):
            return None
        item = next((i for i in idx["items"] if i.get("id") == key), None)
        if not item:
            return None
        if thumb:
            if not item.get("thumb"):
                return None
            name = f"{key}.thumb.{item['thumb']}"
        else:
            name = f"{key}.{item['ext']}"
        path = os.path.join(self._dir(pack), name)
        return path if os.path.isfile(path) else None

    def status(self) -> Dict[str, Any]:
        packs = []
        for pid, meta in PACKS.items():
            idx = self.index(pid)
            with self.lock:
                job = dict(self.jobs.get(pid) or {})
            packs.append({"id": pid, "kind": "emoji", "name": meta["name"], "author": meta["author"],
                          "license": meta["license"], "home": meta["home"],
                          "download_mb": meta["download_mb"], "disk_mb": meta.get("disk_mb"),
                          "ext": meta["ext"], "installed": bool(idx),
                          "count": len(idx["cps"]) if idx else 0,
                          "size_mb": idx.get("size_mb") if idx else None,
                          "cps": idx["cps"] if idx else [], "job": job or None})
        tg = self.tg_packs()
        with self.lock:
            pending = [p for p in self.jobs if p.startswith(TG_PREFIX) and p not in tg]
        for pid in tg + pending:
            idx = self.index(pid) if pid in tg else None
            with self.lock:
                job = dict(self.jobs.get(pid) or {})
            items = [{k: i.get(k) for k in ("id", "cp", "ext", "thumb", "emoji")} for i in idx["items"]] if idx else []
            packs.append({"id": pid, "kind": "tg", "set": idx.get("set") if idx else pid[len(TG_PREFIX):],
                          "name": (idx.get("title") if idx else None) or pid[len(TG_PREFIX):],
                          "author": "Telegram", "license": "", "home": f"https://t.me/addstickers/{idx.get('set') if idx else pid[len(TG_PREFIX):]}",
                          "installed": bool(idx), "count": len(items),
                          "size_mb": idx.get("size_mb") if idx else None,
                          "items": items, "job": job or None})
        conf = self._tg_conf()
        with self.lock:
            lottie_job = dict(self.jobs.get("lottie") or {}) or None
        return {"status": "success", "packs": packs, "revision": self.revision,
                "telegram": {"token": bool(conf.get("token")), "bot": conf.get("bot") or "",
                             "lottie": bool(self.lottie_path()), "lottie_job": lottie_job}}

    # ------------------------------------------------------------- telegram

    def _tg_conf_path(self) -> str:
        return os.path.join(self.root, "telegram.json")

    def _tg_conf(self) -> Dict[str, Any]:
        try:
            with open(self._tg_conf_path(), encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _hide(text: Any, token: str) -> str:
        text = str(text)
        return text.replace(token, "<token>") if token else text

    def _tg_call(self, token: str, method: str, params: Dict[str, Any]) -> Any:
        url = f"{TG_API}/bot{token}/{method}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read(TG_MAX_JSON).decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                data = json.loads(exc.read(65536).decode("utf-8"))
            except Exception:
                raise RuntimeError(f"Telegram: HTTP {exc.code}") from None
        if not isinstance(data, dict) or not data.get("ok"):
            desc = data.get("description") if isinstance(data, dict) else None
            raise RuntimeError(f"Telegram: {self._hide(desc or 'request failed', token)}")
        return data.get("result")

    def _tg_fetch(self, token: str, file_id: str) -> Tuple[bytes, str]:
        """A file by id: its bytes and the extension Telegram gives it."""
        info = self._tg_call(token, "getFile", {"file_id": file_id})
        path = str((info or {}).get("file_path") or "")
        if not path or ".." in path:
            raise RuntimeError("Telegram: no file path")
        url = f"{TG_API}/file/bot{token}/{urllib.parse.quote(path)}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(TG_MAX_FILE + 1)
        if len(data) > TG_MAX_FILE:
            raise RuntimeError("Telegram: file too big")
        return data, path.rsplit(".", 1)[-1].lower()

    def set_token(self, token: Any) -> Dict[str, Any]:
        token = str(token or "").strip()
        if not token:
            try:
                os.remove(self._tg_conf_path())
            except OSError:
                pass
            with self.lock:
                self.revision += 1
            return {"status": "success", "bot": ""}
        if not _TG_TOKEN.match(token):
            return {"status": "error", "error": "That is not a bot token (it looks like 123456:ABC...)"}
        try:
            me = self._tg_call(token, "getMe", {})
        except Exception as exc:
            return {"status": "error", "error": self._hide(exc, token)}
        bot = str((me or {}).get("username") or "")
        os.makedirs(self.root, exist_ok=True)
        with open(self._tg_conf_path(), "w", encoding="utf-8") as handle:
            json.dump({"token": token, "bot": bot}, handle)
        with self.lock:
            self.revision += 1
        return {"status": "success", "bot": bot}

    def tg_import(self, link: Any) -> Dict[str, Any]:
        name = tg_set_name(link)
        if not name:
            return {"status": "error", "error": "Paste a link like tg://addstickers?set=NAME or t.me/addstickers/NAME"}
        token = self._tg_conf().get("token")
        if not token:
            return {"status": "error", "error": "Add your Telegram bot token first"}
        pack = TG_PREFIX + name.lower()
        with self.lock:
            job = self.jobs.get(pack)
            if job and job.get("state") in ("download", "unpack"):
                return {"status": "success", "running": True, "pack": pack}
            self.jobs[pack] = {"state": "download", "done": 0, "total": 0, "error": None}
            self.revision += 1
        threading.Thread(target=self._tg_job, args=(pack, name, token), name=f"stickers-{pack}", daemon=True).start()
        return {"status": "success", "pack": pack}

    def _tg_one(self, token: str, work: str, sticker: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        key = str(sticker.get("file_unique_id") or "")
        if not _TG_KEY.match(key):
            return None
        ext = "tgs" if sticker.get("is_animated") else "webm" if sticker.get("is_video") else "webp"
        data, _ = self._tg_fetch(token, str(sticker.get("file_id") or ""))
        if not _magic(ext, data):
            return None
        with open(os.path.join(work, f"{key}.{ext}"), "wb") as out:
            out.write(data)
        size = len(data)
        thumb = None
        tinfo = sticker.get("thumbnail") or sticker.get("thumb")
        if ext != "webp" and isinstance(tinfo, dict) and tinfo.get("file_id"):
            try:
                tdata, text = self._tg_fetch(token, str(tinfo["file_id"]))
                text = "jpg" if text in ("jpg", "jpeg") else text
                if text in ("webp", "jpg") and _magic(text, tdata):
                    with open(os.path.join(work, f"{key}.thumb.{text}"), "wb") as out:
                        out.write(tdata)
                    thumb, size = text, size + len(tdata)
            except Exception:
                pass
        emoji = str(sticker.get("emoji") or "")[:16]
        return {"id": key, "emoji": emoji, "cp": _emoji_cp(emoji), "ext": ext, "thumb": thumb, "size": size}

    def _tg_job(self, pack: str, name: str, token: str) -> None:
        work = self._dir(pack) + ".new"
        try:
            got = self._tg_call(token, "getStickerSet", {"name": name}) or {}
            stickers = [s for s in (got.get("stickers") or []) if isinstance(s, dict)][:TG_MAX_STICKERS]
            if not stickers:
                raise RuntimeError("The set has no stickers")
            self._set(pack, total=len(stickers), state="download")
            shutil.rmtree(work, ignore_errors=True)
            os.makedirs(work)
            done = [0]

            def one(sticker):
                try:
                    return self._tg_one(token, work, sticker)
                except Exception:
                    return None
                finally:
                    with self.lock:
                        done[0] += 1
                    self._set(pack, done=done[0])

            with ThreadPoolExecutor(max_workers=TG_THREADS) as pool:
                items = [i for i in pool.map(one, stickers) if i]
            if not items:
                raise RuntimeError("No sticker could be downloaded")
            size = sum(i.pop("size") for i in items)
            index = {"pack": pack, "set": str(got.get("name") or name), "title": str(got.get("title") or name)[:64],
                     "items": items, "size_mb": round(size / 1e6, 1), "installed": int(time.time()),
                     "source": "telegram"}
            with open(os.path.join(work, "index.json"), "w", encoding="utf-8") as handle:
                json.dump(index, handle)
            final = self._dir(pack)
            shutil.rmtree(final, ignore_errors=True)
            os.replace(work, final)
            with self.lock:
                self._index[pack] = index
                self.jobs.pop(pack, None)
                self.revision += 1
        except Exception as exc:
            shutil.rmtree(work, ignore_errors=True)
            error = self._hide(exc, token)
            self._set(pack, state="error", error=error if error.startswith("Telegram") else f"Import failed: {error}")
            _log(f"⚠️ Stickers: Telegram set {name} not imported: {error}")
            return
        _log(f"🙂 Stickers: Telegram set {name} imported ({len(items)})")

    def tg_json(self, path: str) -> Optional[bytes]:
        """A tgs unpacked: the Lottie JSON lottie-web draws."""
        try:
            with gzip.open(path, "rb") as handle:
                data = handle.read(TG_MAX_JSON + 1)
        except Exception:
            return None
        return data if len(data) <= TG_MAX_JSON else None

    # --------------------------------------------------------------- lottie

    def lottie_path(self) -> Optional[str]:
        path = os.path.join(self.root, LOTTIE_FILE)
        return path if os.path.isfile(path) else None

    def lottie_install(self) -> Dict[str, Any]:
        try:
            request = urllib.request.Request(LOTTIE_URL, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(2 * 1024 * 1024)
        except Exception as exc:
            return {"status": "error", "error": f"Download failed: {exc}"}
        if hashlib.sha256(data).hexdigest() != LOTTIE_SHA256:
            return {"status": "error", "error": "Download failed: the file is not the expected one"}
        os.makedirs(self.root, exist_ok=True)
        with open(os.path.join(self.root, LOTTIE_FILE), "wb") as out:
            out.write(data)
        with self.lock:
            self.revision += 1
        _log("🙂 Stickers: lottie-web installed (animated Telegram stickers)")
        return {"status": "success"}

    def lottie_remove(self) -> Dict[str, Any]:
        try:
            os.remove(os.path.join(self.root, LOTTIE_FILE))
        except OSError:
            pass
        with self.lock:
            self.revision += 1
        return {"status": "success"}

    # ------------------------------------------------------------- download

    def install(self, pack: Any) -> Dict[str, Any]:
        pack = str(pack or "")
        if pack not in PACKS:
            return {"status": "error", "error": "No such sticker pack"}
        with self.lock:
            job = self.jobs.get(pack)
            if job and job.get("state") in ("download", "unpack"):
                return {"status": "success", "running": True}
            self.jobs[pack] = {"state": "download", "done": 0, "total": 0, "error": None}
            self.revision += 1
        threading.Thread(target=self._install_job, args=(pack,), name=f"stickers-{pack}", daemon=True).start()
        return {"status": "success"}

    def _set(self, pack: str, **values: Any) -> None:
        with self.lock:
            self.jobs.setdefault(pack, {}).update(values)
            self.revision += 1

    def _install_job(self, pack: str) -> None:
        meta = PACKS[pack]
        os.makedirs(self.root, exist_ok=True)
        part = os.path.join(self.root, f"{pack}.zip.part")
        work = os.path.join(self.root, f"{pack}.new")
        try:
            request = urllib.request.Request(meta["url"], headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response, open(part, "wb") as handle:
                total = int(response.headers.get("Content-Length") or 0)
                self._set(pack, total=total)
                done = 0
                while True:
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    self._set(pack, done=done)
            self._set(pack, state="unpack")
            shutil.rmtree(work, ignore_errors=True)
            os.makedirs(work)
            size = 0
            with zipfile.ZipFile(part) as z:
                chosen = PICKERS[pack](z)
                if not chosen:
                    raise RuntimeError("No stickers found in the download")
                for cp, info in chosen.items():
                    data = z.read(info)
                    size += len(data)
                    with open(os.path.join(work, f"{cp}.{meta['ext']}"), "wb") as out:
                        out.write(data)
            index = {"pack": pack, "cps": sorted(chosen), "size_mb": round(size / 1e6, 1),
                     "installed": int(time.time()), "source": meta["url"], "license": meta["license"]}
            with open(os.path.join(work, "index.json"), "w", encoding="utf-8") as handle:
                json.dump(index, handle)
            final = self._dir(pack)
            shutil.rmtree(final, ignore_errors=True)
            os.replace(work, final)
            with self.lock:
                self._index[pack] = index
                self.jobs.pop(pack, None)
                self.revision += 1
        except Exception as exc:
            shutil.rmtree(work, ignore_errors=True)
            self._set(pack, state="error", error=f"Download failed: {exc}")
            _log(f"⚠️ Stickers: {meta['name']} not installed: {exc}")
            return
        finally:
            try:
                os.remove(part)
            except OSError:
                pass
        _log(f"🙂 Stickers: {meta['name']} installed ({len(index['cps'])})")

    def remove(self, pack: Any) -> Dict[str, Any]:
        pack = str(pack or "")
        if not self._known(pack):
            return {"status": "error", "error": "No such sticker pack"}
        with self.lock:
            job = self.jobs.get(pack)
            if job and job.get("state") in ("download", "unpack"):
                return {"status": "error", "error": "Still downloading"}
            self._index.pop(pack, None)
            self.jobs.pop(pack, None)
            self.revision += 1
        shutil.rmtree(self._dir(pack), ignore_errors=True)
        return {"status": "success"}
