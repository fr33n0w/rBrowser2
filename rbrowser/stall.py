"""
When the web server's queue grows (all its threads busy), write where every
thread is stuck to settings/stall.log: a frozen server shows its cause there.
"""
import logging
import os
import re
import sys
import threading
import time
import traceback

PATH = os.path.join("settings", "stall.log")
DEPTH = 10          # queue depth that counts as stuck
EVERY = 30          # seconds between two dumps
MAX_BYTES = 2_000_000


class _StallHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.last = 0.0
        self.busy = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        m = re.search(r"depth is (\d+)", record.getMessage())
        if not m or int(m.group(1)) < DEPTH or time.time() - self.last < EVERY:
            return
        if not self.busy.acquire(blocking=False):
            return
        try:
            self.last = time.time()
            dump(f"queue depth {m.group(1)}")
        finally:
            self.busy.release()


def dump(reason: str) -> None:
    try:
        names = {t.ident: t.name for t in threading.enumerate()}
        lines = [f"===== {time.strftime('%Y-%m-%d %H:%M:%S')} {reason}, {len(names)} threads\n"]
        for ident, frame in sys._current_frames().items():
            lines.append(f"--- {names.get(ident, '?')} ({ident})\n")
            lines.extend(traceback.format_stack(frame))
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        if os.path.exists(PATH) and os.path.getsize(PATH) > MAX_BYTES:
            os.replace(PATH, PATH + ".1")
        with open(PATH, "a", encoding="utf-8") as handle:
            handle.writelines(lines)
        print(f"⚠️ Web server busy ({reason}): threads written to {PATH}")
    except Exception:
        pass


def install() -> None:
    logging.getLogger("waitress.queue").addHandler(_StallHandler())
