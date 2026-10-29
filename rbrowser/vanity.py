"""
Vanity LXMF addresses: an identity whose LXMF address starts with chosen
characters (c4f3..., cafe...).

An address is a hash of the identity's public keys, so it cannot be chosen,
only searched for: new random keys until one gives an address with the
prefix. Each hex character more is 16 times the work. The result is an
ordinary identity, as random and as safe as any other.

Two kinds: "lxmf" puts the prefix on the LXMF address (the contact address,
what people see most), "identity" on the identity hash itself (what RRC hubs
show next to a nick). Both at once would multiply the work; one per search.
The characters go at the start ("start") or at the end ("end"): same work.

The search runs in separate processes (rbrowser/vanity_worker.py), one per
CPU core but one, at low priority, so rBrowser stays responsive. One search
at a time. The key found stays in memory until it is saved as an identity
(identities.import_profile) or discarded: nothing is written before.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vanity_worker.py")
MAX_PREFIX = 8
SLOW_PREFIX = 7            # from here on the dialog warns: hours, not minutes
_PREFIX_RE = re.compile(r"^[0-9a-f]{1,%d}$" % MAX_PREFIX)

# Windows: no console window per worker, below-normal priority.
_WIN_FLAGS = 0x08000000 | 0x00004000 if os.name == "nt" else 0


def clean_prefix(value: Any) -> str:
    """The prefix as lowercase hex, or ValueError saying what is wrong."""
    text = str(value or "").strip().lower()
    if not text:
        raise ValueError("Type the characters the address should start with")
    bad = sorted(set(ch for ch in text if ch not in "0123456789abcdef"))
    if bad:
        raise ValueError("Only 0-9 and a-f: not " + " ".join(bad))
    if len(text) > MAX_PREFIX:
        raise ValueError(f"At most {MAX_PREFIX} characters")
    return text


KINDS = ("lxmf", "identity")


def clean_kind(value: Any) -> str:
    kind = str(value or "lxmf").strip().lower()
    if kind not in KINDS:
        raise ValueError("Search on the LXMF address or the identity hash")
    return kind


POSITIONS = ("start", "end")


def clean_position(value: Any) -> str:
    position = str(value or "start").strip().lower()
    if position not in POSITIONS:
        raise ValueError("The characters go at the start or at the end")
    return position


def worker_count() -> int:
    """Processes for a search. Above 4 threads the CPU is most likely
    hyperthreaded: measured on a 6-core/12-thread laptop, 6 processes gave
    25.8k tries/s and 11 gave 26.9k, with the machine at 100%. So half the
    threads there; on small boards (Pi Zero: 4 cores) all but one."""
    threads = os.cpu_count() or 2
    return max(1, min(16, threads // 2 if threads > 4 else threads - 1))


def _spawn(prefix: str, kind: str = "lxmf", position: str = "start") -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, WORKER, prefix, kind, position],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, creationflags=_WIN_FLAGS)


def measure_rate(seconds: float = 2.0) -> float:
    """Tries per second of every worker together, measured by running them:
    one process times the number of processes is far too optimistic (they
    share cores, caches and the clock speed drops with the load)."""
    procs = [_spawn("ffffffff") for _ in range(worker_count())]
    lock = threading.Lock()
    counts: List[tuple] = []          # (time, tries) as reported

    def read(proc):
        for line in proc.stdout:
            kind, _, value = line.strip().partition(" ")
            if kind == "tries":
                with lock:
                    counts.append((time.time(), int(value)))

    for proc in procs:
        threading.Thread(target=read, args=(proc,), daemon=True).start()
    try:
        # Starting the processes takes a moment (a second on Windows): the
        # clock runs from the first report of all of them.
        deadline = time.time() + 15
        while time.time() < deadline:
            with lock:
                if len(counts) >= len(procs):
                    break
            time.sleep(0.05)
        with lock:
            begin = time.time()
            first = len(counts)
        time.sleep(seconds)
        with lock:
            done = sum(n for _, n in counts[first:])
            elapsed = time.time() - begin
    finally:
        for proc in procs:
            try:
                proc.kill()
            except Exception:
                pass
    return done / elapsed if elapsed > 0 else 0.0


class VanitySearch:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._procs: List[subprocess.Popen] = []
        self._rate: Optional[float] = None       # all workers together
        self._measure_lock = threading.Lock()
        self._reset()

    def _reset(self) -> None:
        self.state = "idle"          # idle | running | found | error
        self.prefix = ""
        self.kind = "lxmf"
        self.position = "start"
        self.tries = 0
        self.started = 0.0
        self.ended = 0.0
        self.key: Optional[bytes] = None
        self.address = ""
        self.error = ""
        self._recent: List[tuple] = []    # (time, tries) for the current speed

    # -- estimates -------------------------------------------------------- #

    def rate_estimate(self) -> float:
        """Tries per second with every worker: measured once (2 s of real
        work), then kept up to date by the searches themselves."""
        with self._measure_lock:
            if self._rate is None:
                if self.state == "running":
                    return 0.0
                self._rate = measure_rate()
            return self._rate

    def estimate(self, prefix: Any) -> Dict[str, Any]:
        prefix = clean_prefix(prefix)
        expected = 16 ** len(prefix)
        rate = self.rate_estimate()
        return {"prefix": prefix, "expected": expected, "rate": round(rate),
                "seconds": expected / rate if rate else None,
                "workers": worker_count(), "slow": len(prefix) >= SLOW_PREFIX}

    # -- search ----------------------------------------------------------- #

    def start(self, prefix: Any, kind: Any = "lxmf", position: Any = "start") -> None:
        prefix = clean_prefix(prefix)
        kind = clean_kind(kind)
        position = clean_position(position)
        with self._lock:
            if self.state == "running":
                raise ValueError("A search is already running")
            if self.state == "found":
                raise ValueError("Save or discard the address found first")
            self._reset()
            self.prefix, self.kind, self.position = prefix, kind, position
            self.started = time.time()
            self.state = "running"
            for _ in range(worker_count()):
                proc = _spawn(prefix, kind, position)
                self._procs.append(proc)
                threading.Thread(target=self._read, args=(proc,), daemon=True).start()

    def _read(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            kind, _, value = line.strip().partition(" ")
            with self._lock:
                if proc not in self._procs:
                    return
                if kind == "tries":
                    self.tries += int(value)
                    self._recent.append((time.time(), self.tries))
                    self._recent = self._recent[-30:]
                    # Past the start-up, the real speed is the best estimate
                    # for the next search.
                    if time.time() - self.started > 10:
                        rate = self._current_rate()
                        if rate:
                            self._rate = rate
                elif kind == "found" and self.state == "running":
                    self._found(bytes.fromhex(value))
                    return
        with self._lock:
            # A worker that ended without finding (crash, missing module)
            if proc in self._procs and self.state == "running":
                err = (proc.stderr.read() or "").strip().splitlines()
                self.error = err[-1] if err else f"search process ended (code {proc.poll()})"
                self.state = "error"
                self.ended = time.time()
                self._kill()

    def _found(self, key: bytes) -> None:
        import RNS
        identity = RNS.Identity.from_bytes(key)
        address = ""
        if identity:
            address = (identity.hash.hex() if self.kind == "identity"
                       else RNS.Destination.hash(identity, "lxmf", "delivery").hex())
        self.ended = time.time()
        self._kill()
        if not (address.endswith(self.prefix) if self.position == "end" else address.startswith(self.prefix)):
            # The worker's shortcut disagrees with RNS: never hand that out.
            self.state, self.error = "error", "the key found does not give that address"
            return
        self.key, self.address, self.state = key, address, "found"

    def _kill(self) -> None:
        procs, self._procs = self._procs, []
        for proc in procs:
            try:
                proc.stdin.close()     # the worker exits on EOF...
            except Exception:
                pass
            try:
                proc.kill()            # ...or now
            except Exception:
                pass

    def stop(self) -> None:
        with self._lock:
            self._kill()
            self._reset()

    def take_key(self) -> bytes:
        with self._lock:
            if self.state != "found" or not self.key:
                raise ValueError("No address found to save")
            return self.key

    def discard(self) -> None:
        self.stop()

    # -- state for the page ---------------------------------------------- #

    def _current_rate(self) -> float:
        if len(self._recent) < 2:
            return 0.0
        (t0, n0), (t1, n1) = self._recent[0], self._recent[-1]
        return (n1 - n0) / (t1 - t0) if t1 > t0 else 0.0

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            now = self.ended or time.time()
            rate = self._current_rate()
            expected = 16 ** len(self.prefix) if self.prefix else 0
            # The search has no memory: the chance it would have finished by
            # now is 1-(1-p)^tries; the average wait ahead stays the same.
            chance = 1 - (1 - 1 / expected) ** self.tries if expected else 0
            return {
                "state": self.state, "prefix": self.prefix, "kind": self.kind, "position": self.position,
                "tries": self.tries,
                "rate": round(rate), "elapsed": round(now - self.started) if self.started else 0,
                "expected": expected, "chance": round(chance, 4),
                "average_seconds": expected / rate if rate else None,
                "workers": len(self._procs) or worker_count(),
                # The search runs here, on the rBrowser server, whatever
                # device the page is open on: the dialog says which machine.
                "host": socket.gethostname(), "threads": os.cpu_count() or 1,
                "address": self.address, "error": self.error,
            }


search = VanitySearch()
