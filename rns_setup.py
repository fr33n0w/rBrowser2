"""
The Reticulum part of install.sh and install.bat: makes sure Reticulum can
reach the network through rmap.world.

- No config yet: writes a basic one with rmap.world.
- A config with rmap.world switched on: left as it is.
- rmap.world there but switched off (enabled = no): asks to switch it on.
- No rmap.world: asks to add it (the other interfaces stay as they are).

The old file is kept as config.before-rbrowser before any change. Standard
library only: it runs before anything else is installed.

    python rns_setup.py [--iface backbone|tcp] [--yes]
"""

import argparse
import os
import re
import shutil
import sys

HOST = "rmap.world"
PORT = 4242
TRUE = {"yes", "true", "on", "1", "y"}

HEADER = """# Reticulum config written by the rBrowser installer.
# The full example: rnsd --exampleconfig

[reticulum]
  enable_transport = False
  share_instance = Yes
  instance_name = default

[logging]
  loglevel = 4

[interfaces]

  # One public entry point to start with: rmap.world.
  # Port 4343 is the same server and is less crowded: to use it,
  # change target_port below.
  # Add more than one server, so you stay connected when one is down:
  # the lists are on https://rmap.world and in the RMAP client in rBrowser.
"""


def interface_block(kind: str, comment: str = "") -> str:
    # BackboneInterface is the faster TCP of Reticulum, Linux and Android only.
    if kind == "backbone":
        body = f"    type = BackboneInterface\n    enabled = yes\n    remote = {HOST}\n    target_port = {PORT}\n"
    else:
        body = f"    type = TCPClientInterface\n    enabled = yes\n    target_host = {HOST}\n    target_port = {PORT}\n"
    return f"{comment}  [[{HOST}]]\n{body}"


def find_config() -> str:
    home = os.path.expanduser("~")
    places = [os.path.join(home, ".config", "reticulum", "config"), os.path.join(home, ".reticulum", "config")]
    if os.name != "nt":
        places.insert(0, "/etc/reticulum/config")
    # Reticulum's own order: the first one found is the one it uses.
    return next((p for p in places if os.path.isfile(p)), "")


def value_of(line: str) -> str:
    return line.split("=", 1)[1].split("#", 1)[0].strip().strip("\"'").lower()


def sections(lines):
    """The [[interfaces]] of the file: (name, first line, end line) of each,
    and the name of the last top-level [section]."""
    found, top, current = [], None, None
    for i, raw in enumerate(lines):
        line = raw.strip()
        if line.startswith("#") or not line.startswith("["):
            continue
        if current:
            found.append((current[0], current[1], i))
            current = None
        if line.startswith("[[") and top == "interfaces":
            current = (line.strip("[] "), i)
        elif not line.startswith("[["):
            top = line.strip("[] ").lower()
    if current:
        found.append((current[0], current[1], len(lines)))
    return found, top


def rmap_state(lines):
    """'on' when an rmap.world interface is switched on, 'off' when there is
    one but none on (with the first of them), 'none' when there is none."""
    found, _ = sections(lines)
    off = None
    for name, start, end in found:
        keys = {}
        for raw in lines[start + 1:end]:
            line = raw.strip()
            if "=" in line and not line.startswith("#"):
                keys[line.split("=", 1)[0].strip().lower()] = value_of(line)
        if not any(HOST in keys.get(k, "") for k in ("target_host", "remote")):
            continue
        # As Reticulum reads it: switched on only by enabled or
        # interface_enabled saying so; neither of them means off.
        if keys.get("enabled") in TRUE or keys.get("interface_enabled") in TRUE:
            return "on", (name, start, end)
        off = off or (name, start, end)
    return ("off", off) if off else ("none", None)


def switch_on(lines, start, end):
    done = False
    for i in range(start + 1, end):
        m = re.match(r"^(\s*)(interface_enabled|enabled)(\s*=\s*)(.*)$", lines[i], re.I)
        if m:
            lines[i] = f"{m.group(1)}{m.group(2)}{m.group(3)}yes\n"
            done = True
    if not done:
        indent = re.match(r"^(\s*)", lines[start]).group(1) + "  "
        lines.insert(start + 1, f"{indent}enabled = yes\n")
    return lines


def ask(question: str, yes: bool) -> bool:
    if yes:
        return True
    try:
        # A BOM can come first when the answer is piped in (PowerShell).
        answer = input(f"{question} [Y/n] ").lstrip("﻿").strip().lower()
    except EOFError:
        answer = ""
    return answer == "" or answer.startswith("y")


def save(path: str, lines) -> None:
    shutil.copy2(path, path + ".before-rbrowser")
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.writelines(lines)
    print(f"The old file is kept as {path}.before-rbrowser")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--iface", choices=("backbone", "tcp"),
                        default="backbone" if sys.platform.startswith("linux") else "tcp")
    parser.add_argument("--yes", action="store_true", help="no questions: yes to every change")
    args = parser.parse_args()

    path = find_config()
    if not path:
        path = os.path.join(os.path.expanduser("~"), ".reticulum", "config")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(HEADER + "\n" + interface_block(args.iface))
        print(f"Written: {path} ({HOST}, port {PORT})")
        return 0

    print(f"You already have one: {path}")
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = handle.readlines()
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    state, where = rmap_state(lines)
    writable = os.access(path, os.W_OK)

    if state == "on":
        print(f"It has {HOST}, switched on: left as it is.")
        return 0

    if state == "off":
        name, start, end = where
        print(f"It has {HOST} ([[{name}]]) but switched off (enabled = no): Reticulum does not connect to it.")
        if writable and ask(f"Switch [[{name}]] on?", args.yes):
            save(path, switch_on(lines, start, end))
            print(f"[[{name}]] switched on.")
        else:
            print(f"Left as it is. To connect, set enabled = yes under [[{name}]] in {path}")
        return 0

    _, top = sections(lines)
    # Added at the end: it lands in [interfaces] only if that is the last
    # section, as it is in the configs Reticulum writes.
    if top == "interfaces" and writable and \
            ask(f"It has no {HOST} server. Add it (your other interfaces stay as they are)?", args.yes):
        lines.append("\n" + interface_block(args.iface, "  # Added by the rBrowser installer: a public entry point"
                                                         " (port 4343 = same server, less crowded).\n"))
        save(path, lines)
        print(f"Added {HOST}.")
    else:
        print("Left as it is. To reach the network add a server under [interfaces], for example:\n")
        print(interface_block(args.iface))
    return 0


if __name__ == "__main__":
    sys.exit(main())
