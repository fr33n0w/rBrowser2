"""
Where rBrowser listens, and restarting it from the page.

The command line options (--host, --port) can also be set from the settings
panel. They are saved to settings/server.json. An option given explicitly on
the command line still wins when rBrowser is started by hand, which is what
anyone typing it expects; a restart from the page re-launches with the saved
values in place of the old ones.

Changing either one needs a restart, because the web server is already bound
to the old address. The restart is done here rather than left to the user:
the old process starts the new one and exits, and the new one waits for the
old one to be gone before it touches Reticulum, so the two never fight over
the shared instance or the port.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 5000
WAIT_PID_ENV = "RBROWSER_WAIT_PID"
# systemd sets INVOCATION_ID for every service it runs. There a restart is
# an exit with this code (not 0), and Restart=on-failure starts rBrowser again.
SYSTEMD_ENV = "INVOCATION_ID"
SYSTEMD_RESTART_CODE = 75

_HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                          r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")


def valid_host(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        ipaddress.ip_address(text)
        return text
    except ValueError:
        pass
    return text if _HOSTNAME_RE.match(text) else None


def valid_port(value: Any) -> Optional[int]:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


class ServerSettings:
    """Saved host/port, what the command line forced, and what is running."""

    FILE = os.path.join("settings", "server.json")

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path or self.FILE
        self.saved: Dict[str, Any] = {"host": DEFAULT_HOST, "port": DEFAULT_PORT}
        # <name>.local on the home network (mdns.py), "" = off. Kept apart
        # from host/port: it applies at once, with no restart.
        self.local_name = ""
        self.cli: Dict[str, Any] = {}
        self.running: Dict[str, Any] = {}
        self.has_file = False
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                self.has_file = True
                stored = json.load(handle)
        except FileNotFoundError:
            return
        except Exception as exc:
            print(f"⚠️ Could not read {self.path}, using defaults: {exc}")
            return
        if isinstance(stored, dict):
            host = valid_host(stored.get("host"))
            port = valid_port(stored.get("port"))
            if host:
                self.saved["host"] = host
            if port:
                self.saved["port"] = port
            from .mdns import valid_name
            self.local_name = valid_name(stored.get("local_name")) or ""

    def resolve(self, cli_host: Optional[str], cli_port: Optional[int]) -> Dict[str, Any]:
        """What to listen on: the command line where given, else saved."""
        self.cli = {}
        if cli_host is not None:
            self.cli["host"] = cli_host
        if cli_port is not None:
            self.cli["port"] = cli_port
        self.running = {"host": self.cli.get("host", self.saved["host"]),
                        "port": self.cli.get("port", self.saved["port"])}
        # Nothing ever saved from the page: what is running IS the setting.
        # Otherwise the defaults would count as "saved", and a restart of an
        # instance started with --port 5099 would move it to 5000 - on top
        # of whatever else is listening there.
        if not self.has_file:
            self.saved = dict(self.running)
        return dict(self.running)

    def save(self, host: Any = None, port: Any = None, local_name: Any = None) -> Dict[str, Any]:
        from .mdns import valid_name, local_name as announcer
        name = self.local_name
        if local_name is not None:
            name = valid_name(local_name)
            if name is None:
                raise ValueError(f"Not a valid local name: {local_name} "
                                 "(letters, digits and '-', like rbrowser)")
        new = dict(self.saved)
        if host is not None:
            checked = valid_host(host)
            if not checked:
                raise ValueError(f"Not a valid host: {host}")
            new["host"] = checked
        if port is not None:
            checked_port = valid_port(port)
            if not checked_port:
                raise ValueError(f"Not a valid port: {port}")
            new["port"] = checked_port

        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(dict(new, local_name=name), handle, indent=2)
        os.replace(tmp, self.path)
        self.saved = new
        self.has_file = True
        if name != self.local_name:
            self.local_name = name
            if self.running:
                announcer.start(name, self.running["host"], self.running["port"])
        return self.describe()

    def start_local_name(self) -> None:
        """At startup, once the web server listens."""
        if self.local_name and self.running:
            from .mdns import local_name as announcer
            announcer.start(self.local_name, self.running["host"], self.running["port"])

    def restart_required(self) -> bool:
        """A restart from the page would listen somewhere else than now."""
        return bool(self.running) and (self.saved["host"] != self.running.get("host")
                                       or self.saved["port"] != self.running.get("port"))

    def can_restart(self) -> bool:
        """
        Only when started through rBrowser.py main(), which is what fills in
        `running`. Under `waitress-serve rBrowser:app` (the Docker image) the
        listening address belongs to whoever launched it, and re-running
        sys.argv would start the wrong program.
        """
        return bool(self.running)

    def describe(self) -> Dict[str, Any]:
        from .mdns import available, local_name as announcer
        return {
            "status": "success",
            "saved": dict(self.saved),
            "local_name": dict(announcer.state, name=self.local_name, available=available()),
            "running": dict(self.running),
            "cli": dict(self.cli),
            "restart_required": self.restart_required(),
            "can_restart": self.can_restart(),
        }


# ---------------------------------------------------------------------- #
# Restart                                                                #
# ---------------------------------------------------------------------- #

def _strip_server_args(args: List[str]) -> List[str]:
    """Drop --host/--port (both spellings) so the new values replace them."""
    out: List[str] = []
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg in ("--host", "--port"):
            skip = True
            continue
        if arg.startswith("--host=") or arg.startswith("--port="):
            continue
        out.append(arg)
    return out


def _interpreter_flags() -> List[str]:
    """
    Options given to Python itself (-u, -X utf8 ...), which sys.argv does not
    contain. sys.orig_argv (3.10+) is the full original command line: what
    sits between the interpreter and the script are those options.
    """
    orig = list(getattr(sys, "orig_argv", []) or [])
    extra = len(orig) - len(sys.argv)
    return orig[1:extra] if extra > 1 else []


def restart_command(argv: Optional[List[str]] = None,
                    executable: Optional[str] = None,
                    frozen: Optional[bool] = None,
                    interpreter_flags: Optional[List[str]] = None) -> List[str]:
    """
    The command line that starts rBrowser again: the same one, minus
    --host/--port, so the new process takes them from settings/server.json.
    Passing them again would make every restarted rBrowser look as if it had
    been started with those options typed by hand.
    """
    argv = list(sys.argv if argv is None else argv)
    executable = executable or sys.executable
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    # A frozen build (PyInstaller) is its own executable; a script needs the
    # interpreter in front of it, with the same options it was given.
    if frozen:
        base = [executable]
    else:
        flags = _interpreter_flags() if interpreter_flags is None else list(interpreter_flags)
        base = [executable] + flags + [os.path.abspath(argv[0])]
    return base + _strip_server_args(argv[1:])


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        SYNCHRONIZE = 0x00100000
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            # 0 = WAIT_OBJECT_0: the process has ended.
            return kernel32.WaitForSingleObject(handle, 0) != 0
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_previous_instance(timeout: float = 30.0) -> None:
    """
    Called first thing at startup. If this process was started by a restart,
    wait for the old one to exit before Reticulum or the web server start.
    """
    value = os.environ.pop(WAIT_PID_ENV, "")
    try:
        pid = int(value)
    except ValueError:
        return
    if pid == os.getpid():
        return
    print(f"⏳ Waiting for the previous rBrowser (PID {pid}) to exit...")
    deadline = time.time() + timeout
    while time.time() < deadline and _pid_alive(pid):
        time.sleep(0.2)
    # A moment more for the OS to release the listening socket.
    time.sleep(0.5)


def _save_rns_state() -> None:
    """Before a restart: links closed politely, path table and known
    identities saved. Not RNS.Reticulum.exit_handler(): it detaches the
    interfaces, and the reader thread of a client of a shared instance (rnsd
    running) then calls RNS.exit() = os._exit(0) on its own. That raced the
    restart: exec never came (Linux), or the exit code was 0 instead of 75
    and systemd left rBrowser stopped. exec or exit close the sockets anyway."""
    try:
        import RNS
    except Exception:
        return
    links = list(getattr(RNS.Transport, "active_links", [])) + list(getattr(RNS.Transport, "pending_links", []))
    for link in links:
        try:
            link.teardown()
        except Exception:
            pass
    if links:
        time.sleep(0.15)   # the teardown packets leave, as RNS waits too
    for handler in (RNS.Transport.exit_handler, RNS.Identity.exit_handler):
        try:
            handler()
        except Exception:
            pass


def restart_mode(under_systemd: bool, os_name: str = os.name) -> str:
    """How this process starts its successor.
    "systemd": exit with SYSTEMD_RESTART_CODE, systemd starts it again.
    "exec": Linux/macOS, the same process becomes the new one (same PID):
            started in a terminal it stays there, and Ctrl+C still stops it.
            A separate child would be left in the background once the old
            process exits, out of reach of Ctrl+C.
    "spawn": Windows, a new process, then this one exits."""
    if under_systemd:
        return "systemd"
    return "spawn" if os_name == "nt" else "exec"


def schedule_restart(host: str, port: int, delay: float = 1.0) -> List[str]:
    """
    Restart rBrowser on host:port after `delay` seconds, long enough for the
    HTTP response announcing it to reach the page. host:port must already be
    what settings/server.json holds: the new process reads them from there.
    """
    command = restart_command()

    def _go() -> None:
        time.sleep(delay)
        print("=" * 90)
        print(f"🔄 Restarting rBrowser on {host}:{port} ...")
        print("=" * 90)
        env = dict(os.environ)
        env[WAIT_PID_ENV] = str(os.getpid())
        # Say goodbye to the network: the new process announces the name again.
        try:
            from .mdns import local_name as announcer
            announcer.stop()
        except Exception:
            pass
        # The tunnel too: the new process starts its own (os._exit below
        # would leave cloudflared running on its own).
        try:
            from . import remote
            if remote.current:
                remote.current.shutdown()
        except Exception:
            pass

        # As a systemd service (install.sh: Restart=on-failure) the new process
        # must not be started from here: a clean exit stops the unit and
        # systemd kills everything in it, the new process too. Instead this
        # one ends with an error code and systemd starts rBrowser again.
        under_systemd = bool(os.environ.get(SYSTEMD_ENV))
        mode = restart_mode(under_systemd)

        # The new process is started FIRST (Windows), and it waits for this
        # PID to disappear before it touches Reticulum or the port.
        if mode == "spawn":
            try:
                _spawn(command, env)
            except Exception as exc:
                print(f"❌ Could not start the new rBrowser, staying up: {exc}")
                return

        # Saving RNS state is worth a few seconds, not a hang.
        closer = threading.Thread(target=_save_rns_state, daemon=True)
        closer.start()
        closer.join(timeout=5)
        if mode == "exec":
            # The real output (the terminal, a log file) is still open and
            # the new rBrowser keeps it. Every socket is closed by exec
            # (Python opens them non-inheritable), the port included. Same
            # PID: the new process skips wait_for_previous_instance.
            for stream in (sys.__stdout__, sys.__stderr__):
                try:
                    stream.flush()
                except Exception:
                    pass
            try:
                os.execve(command[0], command, env)
            except OSError as exc:
                print(f"❌ Could not restart in place ({exc}), starting a new process", file=sys.__stderr__)
                try:
                    _spawn(command, env)
                except Exception:
                    pass
        os._exit(SYSTEMD_RESTART_CODE if under_systemd else 0)

    threading.Thread(target=_go, name="rbrowser-restart", daemon=True).start()
    return command


def _spawn(command: List[str], env: Dict[str, str]) -> None:
    """Start the new rBrowser on the same console / output as this one."""
    # The output handles are passed explicitly. Left implicit, Windows only
    # hands a child the parent's console; when the output goes to a file (a
    # launcher, a log redirect) the new process had no stdout at all and died
    # on its first write. __stdout__ rather than stdout, in case something
    # has already replaced sys.stdout.
    streams: Dict[str, Any] = {}
    for name, stream in (("stdout", sys.__stdout__), ("stderr", sys.__stderr__)):
        try:
            stream.flush()
            stream.fileno()
            streams[name] = stream
        except Exception:
            streams[name] = subprocess.DEVNULL

    kwargs: Dict[str, Any] = dict(env=env, cwd=os.getcwd(), stdin=subprocess.DEVNULL, **streams)
    if os.name == "nt":
        # If rBrowser runs inside a Windows job object (some launchers,
        # service wrappers and terminals use one), the job can kill every
        # process in it when this one exits - the new rBrowser included.
        # Breaking away avoids that; where the job forbids it, start it
        # normally.
        CREATE_BREAKAWAY_FROM_JOB = 0x01000000
        try:
            subprocess.Popen(command, creationflags=CREATE_BREAKAWAY_FROM_JOB, **kwargs)
            return
        except OSError:
            pass
    subprocess.Popen(command, **kwargs)

__all__ = ["ServerSettings", "restart_command", "schedule_restart",
           "wait_for_previous_instance", "valid_host", "valid_port",
           "DEFAULT_HOST", "DEFAULT_PORT"]
