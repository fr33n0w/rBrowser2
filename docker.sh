#!/usr/bin/env bash
# Build and start rBrowser in Docker (Linux, Raspberry Pi).
# The container has its own Reticulum, set up from the "config" file of this
# folder; your identities, settings and cache live in Docker volumes.
#
#   bash docker.sh          build (the first time) and start
#   bash docker.sh stop     stop it (the volumes are kept)

set -u
cd "$(dirname "$0")" || exit 1

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*"; exit 1; }

compose_cmd() {
    if docker compose version >/dev/null 2>&1; then echo "docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"
    fi
}

DC="$(compose_cmd)"
if [ -z "$DC" ]; then
    command -v apt-get >/dev/null 2>&1 || fail "Docker and Docker Compose are needed: https://docs.docker.com/engine/install/"
    read -r -p "Docker is not installed. Install it now (sudo apt install docker.io docker-compose)? [Y/n] " answer || answer=""
    case "${answer:-y}" in [yY]*) ;; *) exit 1 ;; esac
    sudo apt-get update && sudo apt-get install -y docker.io docker-compose || fail "Could not install Docker"
    sudo usermod -aG docker "$(id -un)"
    echo "You are in the docker group from your next login; until then this script uses sudo."
    DC="$(compose_cmd)"
    [ -n "$DC" ] || fail "Docker Compose not found after the install"
fi

# Not in the docker group (yet): through sudo.
SUDO=""
docker info >/dev/null 2>&1 || SUDO="sudo"

if [ "${1:-}" = "stop" ]; then
    $SUDO $DC down
    exit $?
fi

say "Building and starting rBrowser (the first build takes a while: about 9 minutes on a Pi Zero 2 W)"
$SUDO $DC up -d --build || fail "docker compose failed (see above)"

say "rBrowser is starting in Docker"
echo "Open http://localhost:5000 (from another device: http://THIS-MACHINE-IP:5000)"
echo "  Log:     $SUDO $DC logs -f rbrowser"
echo "  Stop:    bash docker.sh stop"
echo "  Update:  bash docker.sh   (rebuilds with the files of this folder)"
echo "  Reset:   $SUDO $DC down -v   (deletes identities, settings and cache!)"
