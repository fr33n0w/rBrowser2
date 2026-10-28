#!/usr/bin/env bash
# rBrowser installer for Linux, Raspberry Pi, macOS and Termux (Android).
#
# Everything stays in this folder: it installs the Python packages of
# requirements.txt, makes sure Reticulum reaches rmap.world (rns_setup.py:
# a basic config if you have none, rmap.world added or switched on if not),
# puts the folder of rnsd & co. on your PATH if it is missing, and on Linux
# can set rBrowser up as a system service. Run it again at any time.
#
#   bash install.sh

set -u
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*"; exit 1; }
ask()  { # ask "question" default(y/n)
    local answer hint="[y/N]"; [ "$2" = "y" ] && hint="[Y/n]"
    read -r -p "$1 $hint " answer || answer=""
    answer="${answer:-$2}"
    case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

TERMUX=no
if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *com.termux* ]]; then TERMUX=yes; fi
OS="$(uname -s)"
case "$OS" in
    MINGW*|MSYS*|CYGWIN*) fail "On Windows use install.bat (double-click it, or run it in cmd)." ;;
esac

say "rBrowser installer - folder: $DIR"

# ─── Python 3.9 or newer, with pip ───
if [ "$TERMUX" = yes ]; then
    # python-cryptography is Termux's prebuilt one, so pip does not have to
    # build it from source; the tools stay in case pip still wants to.
    say "Termux: installing Python, cryptography and the build tools"
    pkg install -y python python-psutil python-cryptography clang rust binutils make cmake pkg-config libffi openssl libsodium || fail "pkg install failed"
    # maturin (the Rust builder) stops without it on Android.
    export ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-$(getprop ro.build.version.sdk 2>/dev/null || echo 24)}"
fi
PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 \
       && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
        PY="$(command -v "$candidate")"; break
    fi
done
[ -n "$PY" ] || fail "Python 3.9 or newer is needed. Debian, Pi OS, Ubuntu: sudo apt install python3 python3-pip - macOS: https://www.python.org"
echo "Python: $("$PY" --version 2>&1) ($PY)"

if ! "$PY" -m pip --version >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1 && ask "pip is missing. Install it now (sudo apt install python3-pip)?" y; then
        sudo apt-get install -y python3-pip || fail "Could not install pip"
    else
        fail "pip is missing: install python3-pip, then run this script again."
    fi
fi

# ─── Python packages ───
say "Installing the Python packages (requirements.txt)"
# --no-warn-script-location: the PATH is taken care of below.
PIP_OPTS="--no-warn-script-location"
USER_OPTS="--user --break-system-packages"
VENV="$DIR/.venv"
USE_VENV=no

use_venv() { # the packages in .venv, in this folder: the system Python untouched
    if [ ! -x "$VENV/bin/python" ]; then
        if ! "$PY" -m venv "$VENV"; then
            rm -rf "$VENV"
            if command -v apt-get >/dev/null 2>&1 && ask "The venv module is missing. Install it now (sudo apt install python3-venv)?" y; then
                sudo apt-get install -y python3-venv && "$PY" -m venv "$VENV" || fail "Could not make the venv"
            else
                fail "Could not make the venv: install python3-venv, then run this script again."
            fi
        fi
    fi
    PY="$VENV/bin/python"
    USE_VENV=yes
    echo "Python of the venv: $PY"
}

choose_target() { # externally-managed system: the user picks where the packages go
    echo
    echo "This system protects its own Python (externally-managed): pip will not put"
    echo "packages into it. Where should rBrowser's packages go?"
    echo "  1) A venv in this folder (.venv): nothing changes outside this folder."
    echo "     Start rBrowser with .venv/bin/python rBrowser.py"
    echo "  2) Your user (~/.local) with --user --break-system-packages, as the"
    echo "     Reticulum manual does: rnsd & co. shared with your other programs."
    local choice
    read -r -p "Choose 1 or 2 [1]: " choice || choice=""
    case "${choice:-1}" in
        1) use_venv ;;
        2) PIP_OPTS="$PIP_OPTS $USER_OPTS" ;;
        *) fail "Not installed. Run again and choose 1 or 2." ;;
    esac
}

if [ -x "$VENV/bin/python" ]; then
    # Installed in the venv before: it stays there.
    use_venv
# Debian 12+, Pi OS, Ubuntu 23.04+: known before trying, no failed try first.
elif "$PY" -c 'import os, sys, sysconfig; sys.exit(0 if os.path.exists(os.path.join(sysconfig.get_paths()["stdlib"], "EXTERNALLY-MANAGED")) else 1)' 2>/dev/null; then
    choose_target
fi
LOG="$(mktemp 2>/dev/null || echo /tmp/rbrowser-pip.log)"
# shellcheck disable=SC2086
if "$PY" -m pip install $PIP_OPTS -r requirements.txt 2>&1 | tee "$LOG"; [ "${PIPESTATUS[0]}" -ne 0 ]; then
    # Refused anyway (the check above missed it): the same question.
    if grep -q "externally-managed-environment" "$LOG" && [ "$USE_VENV" = no ] && [[ "$PIP_OPTS" != *"$USER_OPTS"* ]]; then
        choose_target
        # shellcheck disable=SC2086
        "$PY" -m pip install $PIP_OPTS -r requirements.txt || fail "pip install failed (see above)."
    else
        fail "pip install failed (see above). On Termux check that rustc --version works, then run again."
    fi
fi
rm -f "$LOG"

# ─── rnsd, rnstatus... on the PATH ───
# Not the venv's bin: its python would come before the system one.
if [ "$USE_VENV" = yes ]; then
    USER_BIN="$VENV/bin"
    echo "rnsd, rnstatus and the other Reticulum programs are in $USER_BIN"
else
    USER_BIN="$("$PY" -m site --user-base 2>/dev/null)/bin"
fi
if [ "$USE_VENV" = no ] && [ -x "$USER_BIN/rnsd" ] && ! command -v rnsd >/dev/null 2>&1; then
    LINE="export PATH=\"$USER_BIN:\$PATH\""
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ] || continue
        grep -qsF "$USER_BIN" "$rc" || printf '\n# Reticulum programs (rnsd, rnstatus...), added by the rBrowser installer\n%s\n' "$LINE" >> "$rc"
    done
    export PATH="$USER_BIN:$PATH"
    echo "rnsd, rnstatus and the other Reticulum programs are now on your PATH ($USER_BIN)."
    echo "Open a new terminal for that to apply there too."
fi

# ─── Reticulum config: rmap.world there and switched on ───
say "Reticulum configuration"
# BackboneInterface is the faster TCP of Reticulum, on Linux and Android;
# macOS has the plain TCP client.
if [ "$OS" = "Linux" ]; then IFACE=backbone; else IFACE=tcp; fi
"$PY" rns_setup.py --iface "$IFACE" || warn "The Reticulum config was not checked (see above)"

# ─── Linux: a system service, if you want it ───
SERVICE=no
if [ "$TERMUX" = no ] && [ "$OS" = "Linux" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    echo
    if ask "Start rBrowser by itself at every boot (system service)?" n; then
        UNIT="[Unit]
Description=rBrowser - NomadNet browser for Reticulum
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$DIR
Environment=PYTHONUNBUFFERED=1
Environment=PATH=$USER_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$PY -u rBrowser.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target"
        if printf '%s\n' "$UNIT" | sudo tee /etc/systemd/system/rbrowser.service >/dev/null \
           && sudo systemctl daemon-reload && sudo systemctl enable --now rbrowser.service; then
            SERVICE=yes
        else
            warn "The service was not set up (see above). You can still start rBrowser by hand."
        fi
    fi
fi

# ─── Done ───
say "Done!"
if [ "$SERVICE" = yes ]; then
    echo "rBrowser is running as a service and starts at every boot."
    echo "  Status:   systemctl status rbrowser"
    echo "  Log:      journalctl -u rbrowser -f"
    echo "  Stop:     sudo systemctl stop rbrowser      (at boot: sudo systemctl disable rbrowser)"
else
    echo "Start rBrowser with:"
    echo
    if [ "$USE_VENV" = yes ]; then
        echo "  cd \"$DIR\" && .venv/bin/python rBrowser.py"
    else
        echo "  cd \"$DIR\" && $(basename "$PY") rBrowser.py"
    fi
    [ "$TERMUX" = yes ] && echo "  (Termux: run termux-wake-lock first, so Android does not pause it)"
fi
echo
echo "Then open http://localhost:5000 in your browser."
echo "Only the NomadNet browser is on at first: switch on LXMF, RRC, BBS and RMAP in Settings when you want them."
