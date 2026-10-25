"""
Writing a JSON file so that a reader never sees half of it.

Written to a temporary file next to it, then swapped in with os.replace.
On Windows the swap fails (WinError 32 / 5) while anything else has the
target open for a moment - an antivirus scan, the search indexer, or a
second rBrowser using the same settings folder - so it is tried again a
few times before giving up. The temporary name carries the process and
thread, so two writers never share it.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any


def atomic_write_json(path: str, data: Any, attempts: int = 5, **dump_kwargs: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, **dump_kwargs)
        for attempt in range(attempts):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == attempts - 1:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


__all__ = ["atomic_write_json"]
