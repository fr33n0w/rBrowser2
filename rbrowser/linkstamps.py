"""Link stamps on all CPU cores on Windows and macOS.

RNS computes the link request stamp (RNS 1.6.1+, NomadNet 1.5.1 nodes ask cost
17.8) on all cores on Linux and Android, but on one core on Windows and macOS.
Here the same search runs in separate worker processes (stamp_worker.py); the
stamp is the same kind RNS makes and the node checks it as usual. Workers are
plain scripts, not multiprocessing: on Windows that would re-run rBrowser.py.
Falls back to RNS's own function when workers cannot start (e.g. compiled app).
"""
import os
import queue
import subprocess
import sys
import threading

import RNS

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stamp_worker.py")
_original = None


def cores() -> int:
    return max(1, min(16, (os.cpu_count() or 2) - 1))


def generate_stamped_key(material, stamp_cost):
    """Drop-in for RNS.Stamps.generate_stamped_key, used by RNS.Link."""
    from RNS import Stamps
    if material is None:
        material = b""
    if getattr(sys, "frozen", False) or "__compiled__" in globals() or not os.path.isfile(WORKER):
        return _original(material=material, stamp_cost=stamp_cost)
    if material in Stamps.active_jobs:
        raise RuntimeError("Duplicate stamped key generation job")
    target = Stamps.target_from_fp(Stamps.cost_to_fp(stamp_cost))
    limit = max(30, float(getattr(RNS.Transport, "LINK_STAMP_TIMEOUT", 15)) + 10)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    found = queue.Queue()
    procs = []
    Stamps.active_jobs[material] = False
    try:
        for _ in range(cores()):
            p = subprocess.Popen([sys.executable, WORKER, material.hex(), format(target, "x"), str(limit)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                 text=True, creationflags=flags)
            procs.append(p)
            threading.Thread(target=lambda p=p: found.put(p.stdout.readline()), daemon=True).start()
        alive = len(procs)
        while alive:
            if Stamps.active_jobs.get(material):
                return None, None  # cancelled by the link's own timeout
            try:
                line = found.get(timeout=0.2)
            except queue.Empty:
                continue
            parts = line.split()
            if len(parts) == 2:
                prv, pub = bytes.fromhex(parts[0]), bytes.fromhex(parts[1])
                return (prv, pub), Stamps.stamp_value(material, pub)
            alive -= 1  # a worker gave up or failed
        return None, None
    except Exception as exc:
        RNS.log(f"Multi-core link stamp failed ({exc}), using one core", RNS.LOG_WARNING)
        if not procs:
            Stamps.active_jobs.pop(material, None)
            return _original(material=material, stamp_cost=stamp_cost)
        return None, None
    finally:
        for p in procs:
            try:
                p.kill()
            except Exception:
                pass
        Stamps.active_jobs.pop(material, None)


def install() -> None:
    """Longer link stamp limit; on Windows and macOS also all cores (Linux and Android have them already)."""
    global _original
    # every client in this process (LXMF, RRC, BBS, radio), not only NomadNet pages
    if getattr(RNS.Transport, "LINK_STAMP_TIMEOUT", 300) < 300:
        RNS.Transport.LINK_STAMP_TIMEOUT = 300
    if not (sys.platform.startswith("win") or sys.platform == "darwin"):
        return
    link_module = sys.modules.get("RNS.Link")
    if link_module is None or not hasattr(link_module, "generate_stamped_key"):
        return
    if link_module.generate_stamped_key is generate_stamped_key:
        return
    _original = link_module.generate_stamped_key
    link_module.generate_stamped_key = generate_stamped_key
