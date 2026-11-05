"""
Settings > System Setup > Autostart on boot: rBrowser starts by itself when
the computer starts, set from the page, with no installer and no admin rights.

How, by system (the first that this computer has):
- Windows: a .cmd in the user's Startup folder, run at login, which starts
  rBrowser in a minimized window (closing that window stops it).
- Termux: a script in ~/.termux/boot/, run at boot by the Termux:Boot app.
- macOS: a LaunchAgent (~/Library/LaunchAgents), at login. Not cron: there
  crontab may ask for permissions, or be refused, from a background program.
- Linux with cron: an @reboot line in the user's crontab, run at
  boot even with nobody logged in.
- Linux with systemd and no cron: a user service (~/.config/systemd/user),
  at boot if lingering can be switched on for the user, else at login.
- Linux desktop with neither: ~/.config/autostart/*.desktop, at desktop login.
The output of the last start goes to settings/autostart.log (not on Windows,
where the window shows it).

Each rBrowser folder has its own entry, named or marked after the folder, so
two installs never switch off each other's. Switching off removes the entries
of this folder whatever the method.

The system service of install.sh (/etc/systemd/system/rbrowser.service) needs
sudo: it is shown as on, with the command that switches it off, never changed
from here. In Docker the container's restart policy does this job: no switch.

The command is the one a restart uses (server_settings.restart_command): the
same Python and options, without --host/--port, so the started rBrowser takes
them from settings/server.json.
"""

from __future__ import annotations

import hashlib
import os
import shlex
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_FILE = os.path.join(APP_DIR, "settings", "autostart.log")
SYSTEM_SERVICE = "/etc/systemd/system/rbrowser.service"
# The comment that ends our crontab line: the folder tells the installs apart.
CRON_MARK = "# rBrowser2 autostart:"
# Reticulum and the network take a while after boot: rBrowser waits for them.
BOOT_DELAY = 20
TAG = hashlib.sha256(os.path.normcase(APP_DIR).encode("utf-8")).hexdigest()[:8]
NAME = f"rbrowser2-{TAG}"


def _is_mac() -> bool:
    return sys.platform == "darwin"


def _command() -> List[str]:
    from .server_settings import restart_command
    return restart_command()


def _home(*parts: str) -> str:
    return os.path.join(os.path.expanduser("~"), *parts)


def _shell_line(command: List[str]) -> str:
    return (f"sleep {BOOT_DELAY} && cd {shlex.quote(APP_DIR)} && "
            f"{' '.join(shlex.quote(c) for c in command)} > {shlex.quote(LOG_FILE)} 2>&1")


def _write(path: str, text: str, executable: bool = False) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    if executable:
        os.chmod(path, 0o755)


def _remove(path: str) -> None:
    if os.path.isfile(path):
        os.remove(path)


# ---------------------------------------------------------------- Windows

def _startup_dir() -> str:
    return os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows",
                        "Start Menu", "Programs", "Startup")


def _startup_file() -> str:
    return os.path.join(_startup_dir(), f"rBrowser2 autostart {TAG}.cmd")


def _windows_script(command: List[str]) -> str:
    return "\r\n".join((
        "@echo off",
        "rem rBrowser2 autostart, set in Settings > System Setup. Delete this file to stop it.",
        # As on the other systems: Reticulum (rnsd) and the network first.
        f"timeout /t {BOOT_DELAY} /nobreak >nul",
        f'cd /d "{APP_DIR}"',
        f'start "rBrowser2" /min {subprocess.list2cmdline(command)}',
        "",
    ))


# ---------------------------------------------------------------- Termux

def _termux_file() -> str:
    return _home(".termux", "boot", f"{NAME}.sh")


def _termux_script(command: List[str]) -> str:
    # The wake lock keeps Android from putting Termux to sleep.
    return "\n".join(("#!/data/data/com.termux/files/usr/bin/sh",
                      "# rBrowser2 autostart, set in Settings > System Setup. Delete this file to stop it.",
                      "termux-wake-lock",
                      _shell_line(command), ""))


# ---------------------------------------------------------------- cron

def _cron_escape(text: str) -> str:
    # A bare % in a crontab line is a newline to cron.
    return text.replace("%", r"\%")


def _cron_line(command: List[str]) -> str:
    return _cron_escape(f"@reboot {_shell_line(command)} {CRON_MARK} {APP_DIR}")


def _crontab_read() -> str:
    # No crontab yet: exit code 1 and "no crontab for ..." on stderr.
    done = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10)
    return done.stdout if done.returncode == 0 else ""


def _crontab_write(text: str) -> None:
    done = subprocess.run(["crontab", "-"], input=text, capture_output=True, text=True, timeout=10)
    if done.returncode != 0:
        raise OSError((done.stderr or "crontab refused the change").strip())


def _ours(line: str) -> bool:
    return line.rstrip().endswith(_cron_escape(f"{CRON_MARK} {APP_DIR}"))


def _cron_on() -> bool:
    return bool(shutil.which("crontab")) and any(_ours(l) for l in _crontab_read().splitlines())


def _cron_set(on: bool, command: List[str]) -> None:
    lines = [l for l in _crontab_read().splitlines() if not _ours(l)]
    if on:
        lines.append(_cron_line(command))
    _crontab_write("\n".join(lines) + "\n" if lines else "")


# ---------------------------------------------------------------- systemd --user

def _unit_file() -> str:
    return _home(".config", "systemd", "user", f"{NAME}.service")


def _unit(command: List[str]) -> str:
    return "\n".join((
        "[Unit]",
        "Description=rBrowser2 autostart (Settings > System Setup)",
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        f"WorkingDirectory={APP_DIR}",
        "Environment=PYTHONUNBUFFERED=1",
        f"ExecStartPre=/bin/sleep {BOOT_DELAY}",
        f"ExecStart={' '.join(shlex.quote(c) for c in command)}",
        f"StandardOutput=file:{LOG_FILE}",
        "StandardError=inherit",
        "",
        "[Install]",
        "WantedBy=default.target",
        ""))


def _systemctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=20)


def _has_user_systemd() -> bool:
    return (os.path.isdir("/run/systemd/system") and bool(shutil.which("systemctl"))
            and _systemctl("is-system-running").returncode in (0, 1))


def _linger() -> bool:
    """Lingering: the user's services start at boot, not at login. Allowed
    to the user on most distributions; refused, the service waits for a login."""
    if not shutil.which("loginctl"):
        return False
    user = os.environ.get("USER") or ""
    done = subprocess.run(["loginctl", "show-user", user, "-p", "Linger"], capture_output=True, text=True, timeout=10)
    if "Linger=yes" in done.stdout:
        return True
    return subprocess.run(["loginctl", "enable-linger"], capture_output=True, timeout=20).returncode == 0


def _systemd_set(on: bool, command: List[str]) -> None:
    if on:
        _write(_unit_file(), _unit(command))
        _systemctl("daemon-reload")
        done = _systemctl("enable", f"{NAME}.service")
        if done.returncode != 0:
            raise OSError((done.stderr or "systemctl refused").strip())
    elif os.path.isfile(_unit_file()):
        _systemctl("disable", f"{NAME}.service")
        _remove(_unit_file())
        _systemctl("daemon-reload")


# ---------------------------------------------------------------- desktop login

def _desktop_file() -> str:
    return _home(".config", "autostart", f"{NAME}.desktop")


def _desktop_entry(command: List[str]) -> str:
    return "\n".join(("[Desktop Entry]", "Type=Application", "Name=rBrowser2",
                      "Comment=rBrowser2 autostart (Settings > System Setup)",
                      f"Exec=sh -c {shlex.quote(_shell_line(command))}",
                      "Terminal=false", "X-GNOME-Autostart-enabled=true", ""))


# ---------------------------------------------------------------- macOS

def _launchd_file() -> str:
    return _home("Library", "LaunchAgents", f"world.{NAME}.plist")


def _launchd_plist(command: List[str]) -> str:
    # Only written, not loaded: launchd reads it at the next login. Loading
    # it now (RunAtLoad) would start a second rBrowser beside this one.
    from xml.sax.saxutils import escape
    args = "".join(f"\n        <string>{escape(c)}</string>" for c in ["/bin/sh", "-c", _shell_line(command)])
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>world.{NAME}</string>
    <key>ProgramArguments</key>
    <array>{args}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"""


# ---------------------------------------------------------------- choice

def method() -> Optional[str]:
    """How autostart is done here: windows, termux, cron, systemd, desktop, or None."""
    if os.name == "nt":
        return "windows"
    if os.path.exists("/.dockerenv"):
        return None
    if "com.termux" in os.environ.get("PREFIX", ""):
        return "termux"
    if _is_mac():
        return "launchd"
    if shutil.which("crontab"):
        return "cron"
    if _has_user_systemd():
        return "systemd"
    if os.environ.get("XDG_CURRENT_DESKTOP") or os.path.isdir(_home(".config", "autostart")):
        return "desktop"
    return None


HOW = {
    "windows": "Windows Startup folder, at login",
    "termux": "~/.termux/boot, needs the Termux:Boot app (open it once after installing it)",
    "launchd": "macOS LaunchAgent, at login",
    "cron": "crontab @reboot, at boot",
    "systemd": "systemd user service",
    "desktop": "desktop autostart, at login",
}


def _on_where() -> List[str]:
    """The methods that have an entry for this folder now."""
    found = []
    if os.name == "nt":
        return ["windows"] if os.path.isfile(_startup_file()) else []
    if os.path.isfile(_termux_file()):
        found.append("termux")
    if os.path.isfile(_launchd_file()):
        found.append("launchd")
    if shutil.which("crontab") and _cron_on():
        found.append("cron")
    if os.path.isfile(_unit_file()):
        found.append("systemd")
    if os.path.isfile(_desktop_file()):
        found.append("desktop")
    return found


def status() -> Dict[str, Any]:
    out: Dict[str, Any] = {"status": "success", "supported": True, "on": False,
                           "how": "", "fixed": False, "note": ""}
    if os.name != "nt" and os.path.exists(SYSTEM_SERVICE):
        out.update(on=True, fixed=True, how="system service (install.sh)",
                   note="Set up by install.sh as a system service. To switch it off: "
                        "sudo systemctl disable rbrowser")
        return out
    try:
        where = _on_where()
        chosen = method()
    except (OSError, subprocess.SubprocessError) as exc:
        out.update(supported=False, note=f"Could not read the autostart: {exc}")
        return out
    if where:
        out.update(on=True, how=HOW[where[0]])
        out["note"] = _startup_file() if where[0] == "windows" else f"Log of the last start: {LOG_FILE}"
    elif chosen:
        out["how"] = HOW[chosen]
    elif os.path.exists("/.dockerenv"):
        out.update(supported=False, note="In Docker: the container's restart policy starts rBrowser "
                                         "(restart: unless-stopped in docker-compose.yaml).")
    else:
        out.update(supported=False, note="No way to start programs at boot found here "
                                         "(no cron, no systemd, no desktop).")
    return out


def set_on(on: bool) -> Dict[str, Any]:
    current = status()
    if current["fixed"] or not current["supported"]:
        raise ValueError(current["note"] or "Autostart cannot be changed here")
    command = _command()
    if not on:
        for where in _on_where():
            if where == "windows":
                _remove(_startup_file())
            elif where == "termux":
                _remove(_termux_file())
            elif where == "launchd":
                _remove(_launchd_file())
            elif where == "cron":
                _cron_set(False, command)
            elif where == "systemd":
                _systemd_set(False, command)
            elif where == "desktop":
                _remove(_desktop_file())
        return status()
    chosen = method()
    if chosen == "windows":
        _write(_startup_file(), _windows_script(command))
    elif chosen == "termux":
        _write(_termux_file(), _termux_script(command), executable=True)
    elif chosen == "launchd":
        _write(_launchd_file(), _launchd_plist(command))
    elif chosen == "cron":
        _cron_set(True, command)
    elif chosen == "systemd":
        _systemd_set(True, command)
        result = status()
        if not _linger():
            result["note"] = "Starts at login: lingering (start at boot) was refused here. " + result["note"]
        return result
    elif chosen == "desktop":
        _write(_desktop_file(), _desktop_entry(command))
    return status()
