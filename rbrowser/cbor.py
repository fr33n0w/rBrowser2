"""
A small CBOR codec (RFC 8949) for RRC, so rBrowser needs no extra package.

RRC frames are CBOR maps with integer keys holding ints, byte strings, text,
lists, maps, booleans and null (3-RRC). That is all this handles, plus floats
on the way in. Decoding is strict about lengths and depth: frames come from
the network.
"""

from __future__ import annotations

import struct
from typing import Any, Tuple

MAX_DEPTH = 16
MAX_ITEMS = 10000          # per array or map: a frame is at most a few hundred bytes anyway


class CBORError(ValueError):
    pass


def _head(major: int, value: int) -> bytes:
    if value < 24:
        return bytes([(major << 5) | value])
    if value < 0x100:
        return bytes([(major << 5) | 24, value])
    if value < 0x10000:
        return bytes([(major << 5) | 25]) + struct.pack(">H", value)
    if value < 0x100000000:
        return bytes([(major << 5) | 26]) + struct.pack(">I", value)
    if value < 0x10000000000000000:
        return bytes([(major << 5) | 27]) + struct.pack(">Q", value)
    raise CBORError("integer too big")


def dumps(value: Any) -> bytes:
    out = bytearray()
    _encode(value, out, 0)
    return bytes(out)


def _encode(value: Any, out: bytearray, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise CBORError("nested too deep")
    if value is None:
        out.append(0xF6)
    elif value is True:
        out.append(0xF5)
    elif value is False:
        out.append(0xF4)
    elif isinstance(value, int):
        out += _head(0, value) if value >= 0 else _head(1, -1 - value)
    elif isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        out += _head(2, len(data)) + data
    elif isinstance(value, str):
        data = value.encode("utf-8")
        out += _head(3, len(data)) + data
    elif isinstance(value, (list, tuple)):
        out += _head(4, len(value))
        for item in value:
            _encode(item, out, depth + 1)
    elif isinstance(value, dict):
        out += _head(5, len(value))
        for key, item in value.items():
            _encode(key, out, depth + 1)
            _encode(item, out, depth + 1)
    elif isinstance(value, float):
        out.append(0xFB)
        out += struct.pack(">d", value)
    else:
        raise CBORError(f"cannot encode {type(value).__name__}")


def loads(data: bytes) -> Any:
    value, pos = _decode(bytes(data), 0, 0)
    if pos != len(data):
        raise CBORError("trailing bytes")
    return value


def _length(buf: bytes, pos: int, info: int) -> Tuple[int, int]:
    if info < 24:
        return info, pos
    sizes = {24: 1, 25: 2, 26: 4, 27: 8}
    if info not in sizes:
        raise CBORError("indefinite or reserved length")
    n = sizes[info]
    if pos + n > len(buf):
        raise CBORError("truncated")
    return int.from_bytes(buf[pos:pos + n], "big"), pos + n


def _decode(buf: bytes, pos: int, depth: int) -> Tuple[Any, int]:
    if depth > MAX_DEPTH:
        raise CBORError("nested too deep")
    if pos >= len(buf):
        raise CBORError("truncated")
    initial = buf[pos]
    pos += 1
    major, info = initial >> 5, initial & 0x1F
    if major == 7:
        if info == 20:
            return False, pos
        if info == 21:
            return True, pos
        if info in (22, 23):
            return None, pos
        formats = {25: (">e", 2), 26: (">f", 4), 27: (">d", 8)}
        if info in formats:
            fmt, n = formats[info]
            if pos + n > len(buf):
                raise CBORError("truncated")
            return struct.unpack(fmt, buf[pos:pos + n])[0], pos + n
        raise CBORError("unsupported simple value")
    value, pos = _length(buf, pos, info)
    if major == 0:
        return value, pos
    if major == 1:
        return -1 - value, pos
    if major in (2, 3):
        if pos + value > len(buf):
            raise CBORError("truncated")
        data = buf[pos:pos + value]
        pos += value
        return (data if major == 2 else data.decode("utf-8", "replace")), pos
    if major == 4:
        if value > MAX_ITEMS:
            raise CBORError("array too long")
        items = []
        for _ in range(value):
            item, pos = _decode(buf, pos, depth + 1)
            items.append(item)
        return items, pos
    if major == 5:
        if value > MAX_ITEMS:
            raise CBORError("map too long")
        result = {}
        for _ in range(value):
            key, pos = _decode(buf, pos, depth + 1)
            item, pos = _decode(buf, pos, depth + 1)
            if isinstance(key, (list, dict)):
                raise CBORError("unhashable map key")
            result[key] = item
        return result, pos
    if major == 6:                      # a tag: the value it wraps
        return _decode(buf, pos, depth + 1)
    raise CBORError("unknown major type")
