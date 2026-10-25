"""
Remote access (Settings > System > Remote access).

Two independent pieces:

- Tunnel: rBrowser reachable from outside the LAN with no router port
  opened, through a Cloudflare "quick tunnel" (cloudflared, free, no
  account). cloudflared calls out to Cloudflare and gets a random
  https://xxx.trycloudflare.com address that leads here. The address changes
  each time the tunnel starts. cloudflared is downloaded once from its
  GitHub releases into bin/ when it is not already installed.
  Cloudflare sees the traffic (it holds the https end): the access password
  is what keeps strangers out, so the tunnel refuses to start without it.

- Dynamic DNS: for who opened a port on the router by hand. A name
  (afraid.org, DuckDNS or dynv6, all free) kept pointed at this public IP:
  the IP is checked every DDNS_CHECK seconds, the provider told when it
  changes (and once a day anyway).

Requests through a tunnel or a reverse proxy come from 127.0.0.1. ProxyFix
below gives them back the address of who really sent them (the header the
proxy adds), so "this computer gets in without a password" and the other
localhost-only calls never apply to them, and wrong passwords lock that
address, not everybody. Only for requests from this computer: from the LAN
the headers are ignored, nobody fakes being someone else.
"""

from __future__ import annotations

import ipaddress
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

SETTINGS_FILE = os.path.join("settings", "remote.json")
BIN_DIR = "bin"
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
DDNS_CHECK = 300            # seconds between public IP checks
DDNS_REFRESH = 86400        # told again even with no change
IP_SOURCES = ("https://api.ipify.org", "https://ipv4.icanhazip.com")
DDNS_PROVIDERS = ("afraid", "duckdns", "dynv6")
LOCAL = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
TUNNEL_MARK = "rbrowser.via_proxy"


PID_FILE = os.path.join("settings", "cloudflared.pid")
current: Optional["Remote"] = None      # the running one, for the restart and the exit


def _log(text: str) -> None:
    # A console that cannot show an emoji must not stop the tunnel.
    try:
        print(text)
    except Exception:
        try:
            print(text.encode("ascii", "replace").decode("ascii"))
        except Exception:
            pass


def _is_cloudflared(pid: int) -> bool:
    """Only that PID, and only if it really is cloudflared (never by name)."""
    try:
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=10, creationflags=flags).stdout
            return "cloudflared" in out.lower()
        with open(f"/proc/{pid}/comm", "r") as handle:
            return "cloudflared" in handle.read()
    except Exception:
        return False


def _kill_leftover() -> None:
    """A cloudflared left by an rBrowser that did not close (a crash): its
    old address would stay open for ever. Stopped here, by its saved PID."""
    try:
        with open(PID_FILE, "r") as handle:
            pid = int(handle.read().strip())
    except (OSError, ValueError):
        return
    if pid and pid != os.getpid() and _is_cloudflared(pid):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=10,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                os.kill(pid, 15)
            _log(f"🔌 Old cloudflared (PID {pid}) stopped")
        except Exception:
            pass
    try:
        os.remove(PID_FILE)
    except OSError:
        pass


# ---------------------------------------------------------------- proxy fix

class ProxyFix:
    """WSGI wrapper: a request from this computer carrying a proxy header
    gets the forwarded address as REMOTE_ADDR (or a placeholder that is
    never local when the header is unreadable)."""

    HEADERS = ("HTTP_CF_CONNECTING_IP", "HTTP_X_FORWARDED_FOR", "HTTP_X_REAL_IP", "HTTP_FORWARDED")

    def __init__(self, app: Any) -> None:
        self.app = app

    def __call__(self, environ: Dict[str, Any], start_response: Any) -> Any:
        if environ.get("REMOTE_ADDR") in LOCAL:
            for name in self.HEADERS:
                value = environ.get(name)
                if not value:
                    continue
                environ[TUNNEL_MARK] = True
                environ["REMOTE_ADDR"] = self._address(name, value)
                break
        return self.app(environ, start_response)

    @staticmethod
    def _address(name: str, value: str) -> str:
        first = value.split(",")[0].strip()
        if name == "HTTP_FORWARDED":
            m = re.search(r'for="?\[?([0-9a-fA-F.:]+)', first)
            first = m.group(1) if m else ""
        try:
            ip = ipaddress.ip_address(first)
            if not ip.is_loopback:
                return str(ip)
        except ValueError:
            pass
        return "0.0.0.0"            # remote, address unknown


# ---------------------------------------------------------------- settings

def _default() -> Dict[str, Any]:
    return {"tunnel_on": False,
            "ddns_on": False, "ddns_provider": "afraid", "ddns_url": "", "ddns_domain": "", "ddns_token": ""}


def _clean(data: Dict[str, Any]) -> Dict[str, Any]:
    out = _default()
    out["tunnel_on"] = bool(data.get("tunnel_on"))
    out["ddns_on"] = bool(data.get("ddns_on"))
    if data.get("ddns_provider") in DDNS_PROVIDERS:
        out["ddns_provider"] = data["ddns_provider"]
    url = str(data.get("ddns_url") or "").strip()[:300]
    # Only afraid.org's own update address: this computer calls it, so not
    # any URL somebody pastes.
    host = urllib.parse.urlsplit(url).hostname or "" if url.startswith(("http://", "https://")) else ""
    out["ddns_url"] = url if (host == "afraid.org" or host.endswith(".afraid.org")) and not re.search(r"\s", url) else ""
    domain = str(data.get("ddns_domain") or "").strip().lower()[:253]
    out["ddns_domain"] = domain if re.fullmatch(r"[a-z0-9.-]*", domain) else ""
    token = str(data.get("ddns_token") or "").strip()[:200]
    out["ddns_token"] = token if re.fullmatch(r"[A-Za-z0-9_.-]*", token) else ""
    return out


def _mask(value: str) -> str:
    return (value[:4] + "…" + value[-4:]) if len(value) > 12 else ("…" if value else "")


# ---------------------------------------------------------------- cloudflared

def _asset() -> Optional[str]:
    system, machine = platform.system(), platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64",
            "armv7l": "arm", "armv6l": "arm", "i386": "386", "i686": "386", "x86": "386"}.get(machine)
    if not arch:
        return None
    if system == "Windows":
        # No Windows ARM build: the x64 one runs there in emulation.
        return f"cloudflared-windows-{'amd64' if arch == 'arm64' else arch}.exe"
    if system == "Linux":
        return f"cloudflared-linux-{arch}"
    if system == "Darwin":
        return f"cloudflared-darwin-{arch}.tgz"
    return None


def _local_binary() -> str:
    return os.path.join(BIN_DIR, "cloudflared.exe" if os.name == "nt" else "cloudflared")


def find_cloudflared() -> Optional[str]:
    mine = _local_binary()
    if os.path.isfile(mine):
        return os.path.abspath(mine)
    return shutil.which("cloudflared")


def _termux() -> bool:
    return "com.termux" in os.environ.get("PREFIX", "")


def download_cloudflared() -> str:
    if _termux():
        # The GitHub Linux build cannot read Android's DNS: Termux has its own.
        raise RuntimeError("On Termux install it once with: pkg install cloudflared")
    asset = _asset()
    if not asset:
        raise RuntimeError(f"No cloudflared for this system ({platform.system()} {platform.machine()}): "
                           "install it by hand, rBrowser finds it on the PATH")
    os.makedirs(BIN_DIR, exist_ok=True)
    target = _local_binary()
    part = target + ".part"
    _log(f"⬇️ Downloading cloudflared ({asset}) from GitHub…")
    request = urllib.request.Request(RELEASES + asset, headers={"User-Agent": "rBrowser"})
    with urllib.request.urlopen(request, timeout=60) as response, open(part, "wb") as handle:
        shutil.copyfileobj(response, handle)
    if asset.endswith(".tgz"):
        with tarfile.open(part) as archive:
            member = next(m for m in archive.getmembers() if m.isfile() and m.name.endswith("cloudflared"))
            with archive.extractfile(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
        os.remove(part)
    else:
        os.replace(part, target)
    if os.name != "nt":
        os.chmod(target, 0o755)
    _log(f"✅ cloudflared saved in {target}")
    return os.path.abspath(target)


# ---------------------------------------------------------------- manager

class Remote:
    def __init__(self, auth: Any) -> None:
        self.auth = auth
        self.lock = threading.RLock()
        self.port = 5000
        self.host = "127.0.0.1"
        self.settings = _default()
        self._load()
        self.proc: Optional[subprocess.Popen] = None
        self.tunnel_url = ""
        self.tunnel_state = "off"      # off / downloading / starting / on / error
        self.tunnel_error = ""
        self._stop = threading.Event()
        self._gen = 0                  # each start/stop: older tunnel loops give up
        self.ddns = {"state": "off", "ip": "", "last": 0.0, "told": 0.0, "result": ""}
        self._ddns_wake = threading.Event()

    def _load(self) -> None:
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            self.settings = _clean(stored if isinstance(stored, dict) else {})
        except FileNotFoundError:
            pass
        except Exception as exc:
            _log(f"⚠️ {SETTINGS_FILE} not readable: {exc}")

    def _save(self) -> None:
        from .fileio import atomic_write_json
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        atomic_write_json(SETTINGS_FILE, self.settings, indent=1)

    def password_ready(self) -> bool:
        data = getattr(self.auth, "data", {}) or {}
        return bool(data.get("enabled") and data.get("hash"))

    # --- start / stop ------------------------------------------------------

    def start(self, host: str, port: int) -> None:
        """At startup: what was left on comes back on."""
        global current
        current = self
        self.host = "127.0.0.1" if host in ("0.0.0.0", "::", "", None) else host
        self.port = int(port)
        _kill_leftover()
        threading.Thread(target=self._ddns_loop, name="rbrowser-ddns", daemon=True).start()
        if self.settings["tunnel_on"]:
            self._tunnel_up()

    def shutdown(self) -> None:
        self._stop.set()
        self._tunnel_down()

    def update(self, incoming: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            merged = dict(self.settings)
            for key in _default():
                if key in incoming:
                    merged[key] = incoming[key]
            # A masked token sent back means "unchanged".
            for key in ("ddns_url", "ddns_token"):
                if "…" in str(incoming.get(key) or ""):
                    merged[key] = self.settings[key]
            merged = _clean(merged)
            if merged["tunnel_on"] and not self.password_ready():
                return {"status": "error", "error": "Switch the access password on first (above): "
                                                    "through the tunnel anyone could open rBrowser"}
            if merged["ddns_on"] and not self._ddns_ready(merged):
                return {"status": "error", "error": "Fill in the DNS fields for the provider chosen"}
            was_on = self.settings["tunnel_on"]
            self.settings = merged
            self._save()
        if merged["tunnel_on"] and not was_on:
            self._tunnel_up()
        elif not merged["tunnel_on"] and was_on:
            self._tunnel_down()
        self.ddns["told"] = 0.0            # settings changed: tell the provider again
        self._ddns_wake.set()
        return self.status()

    def status(self) -> Dict[str, Any]:
        s = self.settings
        return {"status": "success",
                "settings": {**s, "ddns_url": _mask(s["ddns_url"]), "ddns_token": _mask(s["ddns_token"])},
                "password_ready": self.password_ready(),
                "tunnel": {"state": self.tunnel_state, "url": self.tunnel_url, "error": self.tunnel_error,
                           "installed": bool(find_cloudflared())},
                "ddns": dict(self.ddns), "providers": list(DDNS_PROVIDERS)}

    # --- tunnel --------------------------------------------------------------

    def _tunnel_up(self) -> None:
        self._tunnel_down(quiet=True)
        with self.lock:
            self._gen += 1
            gen = self._gen
            self.tunnel_state, self.tunnel_error, self.tunnel_url = "starting", "", ""
        threading.Thread(target=self._tunnel_loop, args=(gen,), name="rbrowser-tunnel", daemon=True).start()

    def _tunnel_down(self, quiet: bool = False) -> None:
        with self.lock:
            self._gen += 1
            proc, self.proc = self.proc, None
            self.tunnel_state, self.tunnel_url = "off", ""
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
            if not quiet:
                _log("🔌 Remote access tunnel stopped")
        try:
            os.remove(PID_FILE)
        except OSError:
            pass

    def _wanted(self, gen: int) -> bool:
        return self.settings["tunnel_on"] and not self._stop.is_set() and gen == self._gen

    def _tunnel_loop(self, gen: int) -> None:
        """cloudflared up, and up again when it dies, waiting longer each time."""
        wait = 5
        while self._wanted(gen):
            if not self.password_ready():
                self.tunnel_state, self.tunnel_error = "error", "The access password is off: tunnel not started"
                return
            try:
                binary = find_cloudflared()
                if not binary:
                    self.tunnel_state = "downloading"
                    binary = download_cloudflared()
                if not self._wanted(gen):
                    break
                self.tunnel_state = "starting"
                if self._run(binary, gen):
                    wait = 5                    # it worked for a while: quick retry
            except Exception as exc:
                if gen == self._gen:
                    self.tunnel_state, self.tunnel_error = "error", str(exc)
                _log(f"⚠️ Remote access tunnel: {exc}")
            for _ in range(wait):
                if not self._wanted(gen):
                    return
                time.sleep(1)
            if gen == self._gen:
                self.tunnel_url = ""
            wait = min(wait * 2, 300)

    def _run(self, binary: str, gen: int) -> bool:
        """True when it gave an address (then died): worth trying again soon."""
        command = [binary, "tunnel", "--no-autoupdate", "--url", f"http://{self.host}:{self.port}"]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", creationflags=flags)
        with self.lock:
            if not self._wanted(gen):
                proc.kill()
                return False
            self.proc = proc
        try:
            with open(PID_FILE, "w") as handle:
                handle.write(str(proc.pid))
        except OSError:
            pass
        got = False
        last = ""
        for line in proc.stderr:                    # cloudflared logs on stderr
            line = line.strip()
            if line:
                last = line
            found = TUNNEL_URL_RE.search(line)
            if found and not got and gen == self._gen:
                got = True
                self.tunnel_url, self.tunnel_state, self.tunnel_error = found.group(0), "on", ""
                _log(f"🌍 Remote access: {self.tunnel_url}")
        proc.wait()
        if self._wanted(gen):
            self.tunnel_state = "error"
            self.tunnel_error = f"cloudflared stopped (code {proc.returncode}): {last[-200:]}"
            _log(f"⚠️ {self.tunnel_error}")
        return got

    # --- dynamic DNS -------------------------------------------------------------

    @staticmethod
    def _ddns_ready(s: Dict[str, Any]) -> bool:
        if s["ddns_provider"] == "afraid":
            return bool(s["ddns_url"])
        return bool(s["ddns_domain"] and s["ddns_token"])

    @staticmethod
    def _get(url: str) -> str:
        request = urllib.request.Request(url, headers={"User-Agent": "rBrowser"})
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.read(2000).decode("utf-8", "replace").strip()

    def _public_ip(self) -> str:
        for source in IP_SOURCES:
            try:
                text = self._get(source)
                return str(ipaddress.ip_address(text))
            except Exception:
                continue
        raise RuntimeError("public IP not found (no internet?)")

    def _tell(self, ip: str) -> str:
        s = self.settings
        q = urllib.parse.quote
        if s["ddns_provider"] == "afraid":
            return self._get(s["ddns_url"])
        if s["ddns_provider"] == "duckdns":
            sub = s["ddns_domain"].removesuffix(".duckdns.org")
            answer = self._get(f"https://www.duckdns.org/update?domains={q(sub)}&token={q(s['ddns_token'])}&ip={q(ip)}")
            if answer != "OK":
                raise RuntimeError(f"DuckDNS said {answer or 'nothing'} (domain or token wrong?)")
            return "OK"
        answer = self._get(f"https://dynv6.com/api/update?hostname={q(s['ddns_domain'])}"
                           f"&token={q(s['ddns_token'])}&ipv4={q(ip)}")
        if "updated" not in answer and "unchanged" not in answer:
            raise RuntimeError(f"dynv6 said {answer[:120] or 'nothing'}")
        return answer

    def _ddns_loop(self) -> None:
        while not self._stop.is_set():
            self._ddns_wake.clear()
            if self.settings["ddns_on"] and self._ddns_ready(self.settings):
                try:
                    ip = self._public_ip()
                    now = time.time()
                    self.ddns["last"] = now
                    if ip != self.ddns["ip"] or now - self.ddns["told"] > DDNS_REFRESH:
                        answer = self._tell(ip)
                        self.ddns.update(ip=ip, told=now, state="ok", result=answer[:200])
                        _log(f"🌐 Dynamic DNS ({self.settings['ddns_provider']}): {ip}")
                    else:
                        self.ddns["state"] = "ok"
                except Exception as exc:
                    self.ddns.update(state="error", result=str(exc)[:200])
                    _log(f"⚠️ Dynamic DNS: {exc}")
            else:
                self.ddns.update(state="off", result="")
            self._ddns_wake.wait(DDNS_CHECK)
