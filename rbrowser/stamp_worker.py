"""One worker of the multi-core link stamp search (rbrowser/linkstamps.py).

Same search as RNS.Stamps._loop_key: random X25519 keys until
sha256(material + public key) <= target. Prints "private public" in hex and
exits; gives up by itself after the time limit, so it never outlives rBrowser.

  python stamp_worker.py <material hex> <target hex> <seconds>
"""
import hashlib
import sys
import time

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization

RAW = serialization.Encoding.Raw


def main():
    material = bytes.fromhex(sys.argv[1])
    target = int(sys.argv[2], 16)
    deadline = time.time() + float(sys.argv[3])
    sha = hashlib.sha256
    n = 0
    while True:
        key = X25519PrivateKey.generate()
        pub = key.public_key().public_bytes(RAW, serialization.PublicFormat.Raw)
        if int.from_bytes(sha(material + pub).digest(), "big") <= target:
            prv = key.private_bytes(RAW, serialization.PrivateFormat.Raw, serialization.NoEncryption())
            print(prv.hex(), pub.hex(), flush=True)
            return
        n += 1
        if n % 2000 == 0 and time.time() > deadline:
            return


if __name__ == "__main__":
    main()
