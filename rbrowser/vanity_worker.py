"""
One process of the vanity address search (see rbrowser/vanity.py).

Run by path, not as part of the rbrowser package, so it loads nothing but
`cryptography`: a few MB per process instead of the whole browser.

    python vanity_worker.py <hex> [lxmf|identity] [start|end]

The LXMF address of an identity is
    sha256(name_hash + identity_hash)[:16]
    identity_hash = sha256(x25519_public + ed25519_public)[:16]
    name_hash     = sha256("lxmf.delivery")[:10]
so a search can keep one Ed25519 key and only draw new X25519 keys: half the
work per try. The result is still an ordinary random identity. "identity"
matches the identity hash itself (what RRC hubs show), one hash less.
"end" looks for the characters at the end of the 16-byte address instead.

Writes to stdout, one line each:
    tries <n>        every second or so, the tries since the previous line
    found <hex>      the 64-byte private key (x25519 + ed25519), then exits
Stops when stdin closes: rBrowser closed it, quit, or was restarted.
"""

import sys

# The script's own folder is rbrowser/, whose module names (links, history,
# auth...) must not shadow anything this process imports.
if sys.path and sys.path[0]:
    sys.path.pop(0)

import hashlib
import os
import threading
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import (Encoding, NoEncryption,
                                                          PrivateFormat, PublicFormat)

NAME_HASH = hashlib.sha256(b"lxmf.delivery").digest()[:10]
RAW, PUB, PRV = Encoding.Raw, PublicFormat.Raw, PrivateFormat.Raw


def matcher(prefix):
    """Compare bytes, not hex strings: an odd last digit is a nibble."""
    whole = bytes.fromhex(prefix[: len(prefix) // 2 * 2])
    n = len(whole)
    if len(prefix) % 2:
        nibble = int(prefix[-1], 16) << 4
        return lambda h: h[:n] == whole and (h[n] & 0xF0) == nibble
    return lambda h: h[:n] == whole


def end_matcher(suffix):
    """The same at the end of a 16-byte hash: an odd first digit is the low
    nibble of the byte before the whole ones."""
    whole = bytes.fromhex(suffix[len(suffix) % 2:])
    cut = 16 - len(whole)
    if len(suffix) % 2:
        nibble = int(suffix[0], 16)
        return lambda h: h[cut:] == whole and (h[cut - 1] & 0x0F) == nibble
    return lambda h: h[cut:] == whole


def watch_stdin():
    """rBrowser holds our stdin open; EOF means it is gone, so are we."""
    try:
        while sys.stdin.read(1):
            pass
    except Exception:
        pass
    os._exit(0)


def main():
    prefix = sys.argv[1].lower()
    on_identity = len(sys.argv) > 2 and sys.argv[2] == "identity"
    at_end = len(sys.argv) > 3 and sys.argv[3] == "end"
    match = end_matcher(prefix) if at_end else matcher(prefix)
    threading.Thread(target=watch_stdin, daemon=True).start()
    # Low priority: rBrowser and the rest of the machine come first. On
    # Windows rBrowser starts us below normal already.
    if hasattr(os, "nice"):
        try:
            os.nice(10)
        except OSError:
            pass

    ed = Ed25519PrivateKey.generate()
    ed_pub = ed.public_key().public_bytes(RAW, PUB)
    sha = hashlib.sha256
    tries, last = 0, time.monotonic()
    while True:
        for _ in range(500):
            x = X25519PrivateKey.generate()
            id_hash = sha(x.public_key().public_bytes(RAW, PUB) + ed_pub).digest()[:16]
            if match(id_hash if on_identity else sha(NAME_HASH + id_hash).digest()[:16]):
                key = (x.private_bytes(RAW, PRV, NoEncryption())
                       + ed.private_bytes(RAW, PRV, NoEncryption()))
                print(f"tries {tries + 1}", flush=True)
                print(f"found {key.hex()}", flush=True)
                return
            tries += 1
        now = time.monotonic()
        if now - last >= 1:
            print(f"tries {tries}", flush=True)
            tries, last = 0, now


if __name__ == "__main__":
    main()
