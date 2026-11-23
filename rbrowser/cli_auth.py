"""
rBrowser.py --set-password and --guest-setup: the access password and Guest
mode from the terminal, so a server is locked before its first start.
Both write settings/auth.json through Auth (same checks as the Settings page)
and refuse while this folder's rBrowser runs: it would save its old copy over them.
"""

from __future__ import annotations

import getpass
import sys
from typing import Any, Dict, Optional

from . import auth as auth_mod

CLIENT_NAMES = {"nomadnet": "NomadNet pages", "rrc": "RRC chat", "bbs": "BBS client",
                "messenger": "LXMF Messenger", "rmap": "RMAP"}


def _running() -> bool:
    """A live process behind a note in settings/running. Not by asking the
    page: with the password on, /api/status answers only after a login."""
    import json
    import os
    from .links import RUNNING_DIR
    from .server_settings import _pid_alive
    try:
        names = os.listdir(RUNNING_DIR)
    except OSError:
        return False
    for name in names:
        try:
            with open(os.path.join(RUNNING_DIR, name), encoding="utf-8") as handle:
                if _pid_alive(int(json.load(handle)["pid"])):
                    return True
        except Exception:
            continue
    return False


def _ask(text: str, default: str = "") -> str:
    try:
        value = input(f"{text} [{default}]: " if default else f"{text}: ").strip()
    except EOFError:
        value = ""
    return value or default


def _yes(text: str, default: bool) -> bool:
    while True:
        value = _ask(text + " (y/n)", "y" if default else "n").lower()
        if value in ("y", "yes", "n", "no"):
            return value.startswith("y")


def _new_password(what: str) -> Optional[str]:
    """Typed twice, hidden. None after three tries."""
    for _ in range(3):
        try:
            first = getpass.getpass(f"{what} (at least {auth_mod.MIN_LENGTH} characters): ")
            second = getpass.getpass("Again: ")
        except EOFError:
            return None
        if len(first) < auth_mod.MIN_LENGTH:
            print(f"Too short: at least {auth_mod.MIN_LENGTH} characters.")
        elif first != second:
            print("The two do not match.")
        else:
            return first
    return None


def _apply(auth: Any, incoming: Dict[str, Any]) -> int:
    error = auth.update_here(incoming)
    if error:
        print(f"❌ {error} Nothing was changed.")
        return 1
    print(f"✅ Saved in {auth_mod.AUTH_FILE}")
    return 0


def _start() -> Optional[Any]:
    if _running():
        print("❌ rBrowser is running from this folder: stop it first, then run this again.")
        return None
    return auth_mod.Auth()


def set_password() -> int:
    auth = _start()
    if auth is None:
        return 1
    if auth.data["hash"]:
        print("An access password is already set: the new one replaces it and logs every browser out.")
    password = _new_password("New access password")
    if password is None:
        print("❌ Nothing was changed.")
        return 1
    code = _apply(auth, {"password": password, "enabled": True})
    if code == 0:
        print("   The access password is ON: every browser must log in "
              "(this computer too only with \"Ask on this computer too\", in Settings).")
    return code


def guest_setup() -> int:
    auth = _start()
    if auth is None:
        return 1
    data = auth.data
    if not (data["enabled"] and data["hash"]):
        print("❌ Guest mode needs the access password on: run rBrowser.py --set-password first.")
        return 1
    print("Guest mode: other people use this rBrowser without the Settings. Enter keeps [the current value].")
    if not _yes("Guest mode on", data["guest_enabled"]):
        return _apply(auth, {"guest_enabled": False})
    incoming: Dict[str, Any] = {"guest_enabled": True}
    open_access = _yes("No guest password (an \"Enter as guest\" button on the login page)", data["guest_open"])
    incoming["guest_open"] = open_access
    if not open_access and (not data["guest_hash"] or _yes("Set a new guest password", not data["guest_hash"])):
        password = None
        for _ in range(3):
            password = _new_password("Guest password")
            if password is None or not auth._matches(password):
                break
            print("That is your access password: pick another one for the guests.")
            password = None
        if password is None:
            print("❌ Nothing was changed.")
            return 1
        incoming["guest_password"] = password
    while True:
        value = _ask(f"Guests in at once (1-{auth_mod.GUEST_MAX_TOP})", str(data["guest_max"]))
        if value.isdigit() and 1 <= int(value) <= auth_mod.GUEST_MAX_TOP:
            incoming["guest_max"] = int(value)
            break
    print("What guests may use:")
    for key, name in CLIENT_NAMES.items():
        incoming["guest_" + key] = _yes("  " + name, data["guest_" + key])
    incoming["guest_favorites"] = _yes("Guests see your favorites", data["guest_favorites"])
    incoming["guest_history"] = _yes("Guests see your history", data["guest_history"])
    hub = _ask("Fixed RRC hub for guests (32 hex characters, - for none)", data["guest_rrc_hub"] or "-")
    incoming["guest_rrc_hub"] = "" if hub == "-" else hub
    incoming["guest_rrc_hub_on"] = hub != "-"
    incoming["guest_access_log"] = _yes("Log guest logins, logouts and kicks", data["guest_access_log"])
    incoming["guest_log"] = _yes("Log what guests do", data["guest_log"])
    incoming["guest_log_lxmf"] = incoming["guest_log"] and _yes("  with the text of their LXMF messages",
                                                                 data["guest_log_lxmf"])
    return _apply(auth, incoming)


def run(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")    # emoji on a cp1252 console
        except Exception:
            pass
    try:
        return set_password() if "--set-password" in argv else guest_setup()
    except KeyboardInterrupt:
        print("\n❌ Stopped: nothing was changed.")
        return 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
