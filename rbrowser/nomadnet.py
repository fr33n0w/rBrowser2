#!/usr/bin/env python3
"""
NomadNet protocol helpers.

This module contains the low-level helpers that interact with Reticulum
NomadNet nodes. They are intentionally focused on network communication and
avoid any direct dependency on Flask or higher-level application concerns.
"""

from __future__ import annotations

import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import RNS
import RNS.vendor.umsgpack as msgpack


def _clean_hash(destination_hash: str) -> bytes:
    """Convert NomadNet destination hash strings into raw bytes."""
    stripped = destination_hash.replace("<", "").replace(">", "").replace(":", "")
    return bytes.fromhex(stripped)


# Base budget on top of whatever the network says the path costs. NomadNet
# uses the same number (Browser.DEFAULT_TIMEOUT).
BASE_TIMEOUT = 10


def _reticulum() -> Optional[RNS.Reticulum]:
    """The running Reticulum instance, or None if we cannot reach it."""
    try:
        return RNS.Reticulum.get_instance()
    except Exception:
        return None


def adaptive_timeout(destination_hash: bytes, base: float = BASE_TIMEOUT) -> float:
    """
    How long to wait for this particular destination.

    A fixed wall-clock timeout is wrong on Reticulum: 30 seconds is generous
    over TCP and far too short over LoRa, where a single hop can take most of
    that just to carry the packet. Declaring "Timeout" on a node that is simply
    answering slowly is the single worst behaviour a Reticulum browser can
    have, and it is what rBrowser used to do.

    RNS can tell us what the path actually costs - get_first_hop_timeout()
    accounts for the next hop interface's bitrate - so ask instead of guessing.
    This is the same formula NomadNet's own browser uses (Browser.path_timeout).
    """
    r = _reticulum()
    if r is None:
        return base * 3

    try:
        first_hop = r.get_first_hop_timeout(destination_hash) or 0
        medium = r.get_medium_path_timeout() or 0
        return max(base + first_hop, medium, base)
    except Exception as exc:
        print(f"⚠️ NomadNet: Could not compute adaptive timeout ({exc}), falling back")
        return base * 3


# Path requests this rBrowser sent, by destination: when.
#
# The answer to a path request is an announce, and rnsd hands it to its
# local clients as an ordinary one (Transport.py, "TODO: Shouldn't the
# context be PATH_RESPONSE ...?"). So opening a node, even one gone for
# weeks, made it look as if it had just announced: a transport node replied
# with its cached copy and the node appeared in the list.
# is_replayed_announce() tells the two apart.
_path_requests: Dict[bytes, float] = {}

PATH_RESPONSE_WINDOW = 120          # s after our request: may be the answer
STALE_IF_OURS = 10 * 60             # older than this, then it is the answer
# Older than this, nobody's live announce, even unasked (another program on
# the same rnsd asked). Generous, because the time is the sender's clock and
# a node whose clock is off by that much would never be listed. Transport
# nodes keep paths for up to a week, so the stale copies are older still.
STALE_ALWAYS = 12 * 60 * 60


def request_path(destination_hash: bytes) -> None:
    """RNS.Transport.request_path, remembering that we asked."""
    _path_requests[destination_hash] = time.time()
    if len(_path_requests) > 500:
        cutoff = time.time() - PATH_RESPONSE_WINDOW
        for key in [k for k, t in _path_requests.items() if t < cutoff]:
            _path_requests.pop(key, None)
    RNS.Transport.request_path(destination_hash)


def announce_emitted(destination_hash: bytes) -> Optional[int]:
    """When the newest announce we hold for it was sent, by the sender's
    clock (the last 5 bytes of the announce's random blob)."""
    try:
        entry = RNS.Transport.path_table.get(destination_hash)
        if not entry:
            return None
        # A module constant of RNS/Transport.py; RNS.Transport is the class.
        idx = getattr(sys.modules.get("RNS.Transport"), "IDX_PT_RANDBLOBS", 4)
        return RNS.Transport.timebase_from_random_blobs(entry[idx]) or None
    except Exception:
        return None


def is_replayed_announce(destination_hash: bytes) -> bool:
    """
    A cached copy of an old announce rather than a live one: the answer to a
    path request (ours, or another program's on the same rnsd).

    Read from the time the node itself wrote into the announce. A node
    whose clock is clearly wrong (an ESP32 with no time set says 1970) is
    trusted unless we have just asked for its path.
    """
    now = time.time()
    emitted = announce_emitted(destination_hash)
    plausible = emitted is not None and 1577836800 < emitted < now + 86400   # 2020 .. tomorrow
    age = now - emitted if plausible else None

    if age is not None and age > STALE_ALWAYS:
        return True
    asked = _path_requests.get(destination_hash)
    if asked and now - asked < PATH_RESPONSE_WINDOW:
        return age is None or age > STALE_IF_OURS
    return False


def _wait_for_path(destination_hash: bytes, timeout: Optional[float] = None) -> bool:
    """
    Ensure Reticulum has a path to the destination before continuing.

    Returns True when a path becomes available inside the timeout window.
    """
    if RNS.Transport.has_path(destination_hash):
        return True

    if timeout is None:
        timeout = adaptive_timeout(destination_hash)

    request_path(destination_hash)
    start_time = time.time()

    while not RNS.Transport.has_path(destination_hash):
        if time.time() - start_time > timeout:
            return False
        time.sleep(0.1)

    return True


def _await_link(link: RNS.Link, timeout: Optional[float] = None) -> bool:
    """Block until the link is ACTIVE, or the timeout expires."""
    if timeout is None:
        timeout = max(BASE_TIMEOUT, getattr(link, "establishment_timeout", 0) or 0)
    deadline = time.time() + timeout
    while link.status != RNS.Link.ACTIVE:
        if link.status == RNS.Link.CLOSED or time.time() > deadline:
            return False
        time.sleep(0.05)
    return True


def response_bytes(receipt: Any) -> bytes:
    """
    Normalise whatever RNS handed back into bytes.

    A response is not always bytes any more: above a size threshold RNS
    delivers the transfer as an open file handle (io.BufferedReader) instead of
    holding it all in memory, and that is exactly the case for the media and
    file transfers we care about.
    """
    data = getattr(receipt, "response", None)
    if data is None:
        return b""
    if isinstance(data, bytes):
        return data
    if isinstance(data, str):
        return data.encode("utf-8")
    if isinstance(data, list):
        parts = []
        for item in data:
            if isinstance(item, bytes):
                parts.append(item)
            elif isinstance(item, str):
                parts.append(item.encode("latin1"))
        return b"".join(parts)
    if hasattr(data, "read"):
        try:
            if hasattr(data, "seek"):
                data.seek(0)
            content = data.read()
            if hasattr(data, "close"):
                data.close()
            return content if isinstance(content, bytes) else str(content).encode("latin1")
        except Exception as exc:
            print(f"❌ NomadNet: Error reading response file object: {exc}")
            return b""
    return b""


def response_name(receipt: Any, fallback: str = "") -> str:
    """
    The filename the serving node attached to its response, if any.

    NomadNet answers media and file requests with a metadata dict carrying the
    real name - which matters because the node may have converted the file (a
    .png served as .webp), so the name in the URL is not the name of the bytes
    you received.
    """
    try:
        metadata = getattr(receipt, "metadata", None)
        if isinstance(metadata, dict):
            name = metadata.get("name") or metadata.get(b"name")
            if isinstance(name, bytes):
                return name.decode("utf-8", errors="replace")
            if isinstance(name, str):
                return name
    except Exception:
        pass
    return fallback


def safe_attachment_name(name: Any, fallback: str = "attachment") -> str:
    """
    Make a node-supplied filename safe to hand to a browser download.

    The name comes from the remote node and goes straight into a save dialog,
    so it is untrusted input: strip control characters, keep only the last
    path component, drop a drive prefix and any leading dots, and cap the
    length. Port of NomadNet's Conversation.safe_attachment_name, so a file
    saved here gets the same name NomadNet would give it.
    """
    try:
        if isinstance(name, bytes):
            name = name.decode("utf-8", errors="replace")
        elif not isinstance(name, str):
            name = str(name) if name is not None else ""
    except Exception:
        name = ""

    name = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", name)
    parts = re.split(r"[/\\]", name)
    name = parts[-1] if parts else ""
    if ":" in name:
        name = name.split(":")[-1]
    name = name.lstrip(".")
    if not name or name in (".", ".."):
        return fallback
    if len(name) > 200:
        base, ext = os.path.splitext(name)
        ext = ext[:16]
        name = base[:200 - len(ext)] + ext
    return name


def prepare_request_data(form_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    """
    Build the request dict a NomadNet node expects, with the right prefixes.

    NomadNet draws a hard line between two kinds of parameter
    (Browser.retrieve_url and __get_link_request_data):

      var_<name>    a literal written into the link or the URL,
                    `[Go`hash:/page/x.mu`action=delete]
      field_<name>  the current value of a form input on the page the link
                    sits on, named in the link's field list

    rBrowser used to send BOTH prefixes for every value, on the theory that
    whichever one the node reads, it will find it. That works on a node that
    only looks at one of them and misleads any node that distinguishes: a
    literal arrives looking like a submitted form field, and a form field
    arrives looking like a link literal.

    Worse, the two call paths disagreed: a fresh link sent both prefixes, a
    re-used cached link sent only field_. The same click produced different
    payloads depending on whether a link happened to be cached.

    The page already knows which is which and labels them in "_meta"; that
    label is what this function honours. _meta itself is bookkeeping and is
    never sent - it used to be forwarded as a field called "_meta" holding a
    dictionary.
    """
    if not form_data:
        return None

    meta = form_data.get("_meta") or {}
    prepared: Dict[str, str] = {}

    for key, value in form_data.items():
        if key == "_meta":
            continue

        # An already prefixed key is passed through untouched.
        if key.startswith("var_") or key.startswith("field_"):
            prepared[key] = str(value)
            continue

        kind = meta.get(key)
        if kind == "static":
            prepared["var_" + key] = str(value)
        elif kind == "field":
            prepared["field_" + key] = str(value)
        else:
            # No label: treat it as a form field, which is what an unlabelled
            # value from a form submission is.
            prepared["field_" + key] = str(value)

    return prepared or None


def _recall_destination(destination_hash: bytes) -> Optional[RNS.Identity]:
    """Recall an identity for the provided destination hash."""
    identity = RNS.Identity.recall(destination_hash)
    if not identity:
        print("❌ NomadNet: Could not recall identity for destination "
              f"{RNS.prettyhexrep(destination_hash)[:16]}...")
    return identity


# Other things an address can be, to say what it is when it is not a
# NomadNet node (same names as rmap's services).
KNOWN_ASPECTS = {
    "lxmf.delivery": "an LXMF address (a person's inbox)",
    "lxmf.propagation": "an LXMF propagation node",
    "rrc.hub": "an RRC chat hub",
    "retibbs.bbs": "a RetiBBS board",
    "partyline.relay": "a Party Line voice relay",
    "rnstransport.discovery.interface": "a discoverable interface",
}


def not_a_node(destination_hash: bytes, identity: RNS.Identity) -> Optional[Dict[str, Any]]:
    """
    The error to answer with when this hash is not a NomadNet node, or None.

    A link opened to it as "nomadnetwork.node" goes to a destination that
    does not exist (the hash is made from the identity AND the name), so it
    would only time out. A page that links "hash" alone to an RRC hub or an
    LXMF address leads here. Nothing is sent to find out: the identity is
    already known, the hash is worked out for each name.
    """
    if RNS.Destination.hash_from_name_and_identity("nomadnetwork.node", identity) == destination_hash:
        return None
    kind = next((label for aspect, label in KNOWN_ASPECTS.items()
                 if RNS.Destination.hash_from_name_and_identity(aspect, identity) == destination_hash),
                "another kind of Reticulum destination")
    message = f"Not a NomadNet node: this address is {kind}, it has no pages."
    print(f"⚠️ NomadNet: {RNS.prettyhexrep(destination_hash)[:16]}... is not a NomadNet node ({kind})")
    return {"error": message, "content": message, "message": message,
            "status": "error", "not_a_node": True}


@dataclass
class RequestResult:
    """Simple container for asynchronous NomadNet responses."""

    data: Any = None
    received: bool = False
    rtt: Optional[float] = None
    name: str = ""
    error: str = ""


class NomadNetBrowser:
    """
    High-level NomadNet page fetch helper.

    Instances are short lived and typically created per request, receiving
    a reference to the owning web browser instance for caching and identity
    management.
    """

    def __init__(self, main_browser: "NomadNetWebBrowser", destination_hash: str) -> None:
        self.main_browser = main_browser
        self.destination_hash = _clean_hash(destination_hash)

        self.destination: Optional[RNS.Destination] = None
        self.link: Optional[RNS.Link] = None
        self.result = RequestResult()
        self.response_event = threading.Event()
        self.page_path: str = "/page/index.mu"
        self.form_data: Optional[Dict[str, Any]] = None
        self.ping_start_time: Optional[float] = None

    # ------------------------------------------------------------------ #
    # Page fetching                                                      #
    # ------------------------------------------------------------------ #

    def fetch_page(
        self,
        page_path: str = "/page/index.mu",
        form_data: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Fetch a page from the remote NomadNet node."""
        try:
            pretty_hash = RNS.prettyhexrep(self.destination_hash)[:16]
            if timeout is None:
                timeout = adaptive_timeout(self.destination_hash)
            print(f"🔍 Checking path to {pretty_hash} (timeout {timeout:.0f}s)...")

            if not _wait_for_path(self.destination_hash, timeout=timeout):
                return {"error": "No path", "content": "No path to destination", "status": "error"}

            identity = _recall_destination(self.destination_hash)
            if not identity:
                return {"error": "No identity", "content": "Could not recall identity", "status": "error"}
            wrong = not_a_node(self.destination_hash, identity)
            if wrong:
                return wrong

            print("✅ Path found, establishing connection...")

            self.destination = RNS.Destination(
                identity,
                RNS.Destination.OUT,
                RNS.Destination.SINGLE,
                "nomadnetwork",
                "node",
            )
            self.link = RNS.Link(self.destination)
            self.result = RequestResult()
            self.response_event.clear()

            self.page_path = page_path
            self.form_data = form_data or None

            if self.form_data:
                print(f"🌐 Requesting page: {page_path} with form data: {self.form_data}")
            else:
                print(f"🌐 Requesting page: {page_path}")

            self.link.set_link_established_callback(self._on_link_established)
            # Two budgets, not one: the link has to come up first, and only
            # then does the request itself start spending time. Sharing a
            # single budget meant a slow link establishment ate the whole
            # allowance and the request was reported as timed out before the
            # node had been asked anything.
            success = self.response_event.wait(timeout=timeout * 2)

            # A failed request is an error, never a page: returned as
            # content, "Request failed" was shown and saved in the cache over
            # the good copy.
            if success and self.result.received and self.result.error:
                return {"error": self.result.error, "content": self.result.error, "status": "error"}
            if success and self.result.received:
                return {
                    "content": self.result.data or "Empty response",
                    "status": "success",
                    "error": None,
                }

            return {"error": "Timeout", "content": "Request timeout", "status": "error"}

        except Exception as exc:  # pragma: no cover - defensive logging
            print(f"❌ NomadNet: Exception during fetch: {exc}")
            return {"error": str(exc), "content": f"Exception: {exc}", "status": "error"}

    def _on_link_established(self, link: RNS.Link) -> None:
        """Handle the moment the Reticulum link is established."""
        try:
            if self.form_data:
                print(f"🔗 Link established, requesting: {self.page_path} with data: {self.form_data}")
                prefixed_data = prepare_request_data(self.form_data)
                print(f"📝 Request data: {prefixed_data}")
                link.request(
                    self.page_path,
                    data=prefixed_data,
                    response_callback=self._on_response,
                    failed_callback=self._on_request_failed,
                )
                return

            print(f"🔗 Link established, requesting: {self.page_path}")
            link.request(
                self.page_path,
                data=None,
                response_callback=self._on_response,
                failed_callback=self._on_request_failed,
            )

        except Exception as exc:
            print(f"❌ NomadNet: Request error: {exc}")
            self.result = RequestResult(received=True, error=f"Request error: {exc}")
            self.response_event.set()

    def _on_response(self, receipt: RNS.RequestReceipt) -> None:
        """Process successful responses."""
        try:
            data = receipt.response
            if data:
                if isinstance(data, bytes):
                    try:
                        decoded = data.decode("utf-8")
                        self.result.data = decoded
                        print(f"✅ Received {len(decoded)} characters")
                    except UnicodeDecodeError:
                        self.result.data = f"Binary data: {data.hex()[:200]}..."
                        print(f"⚠️ NomadNet: Received binary data: {len(data)} bytes")
                else:
                    text = str(data)
                    self.result.data = text
                    print(f"✅ Received text data: {len(text)} characters")
            else:
                self.result.data = "Empty response"
                print("⚠️ NomadNet: Empty response received")

            self.result.received = True
            self.response_event.set()

        except Exception as exc:
            print(f"❌ NomadNet: Response processing error: {exc}")
            self.result = RequestResult(received=True, error=f"Response error: {exc}")
            self.response_event.set()

    def _on_request_failed(self, _receipt: RNS.RequestReceipt) -> None:
        """Handle failed requests."""
        print(f"❌ NomadNet: request to {RNS.prettyhexrep(self.destination_hash)} failed")
        self.result = RequestResult(received=True, error="Request failed")
        self.response_event.set()

    # ------------------------------------------------------------------ #
    # Ping & fingerprint helpers                                         #
    # ------------------------------------------------------------------ #

    def ping_node(self, node_hash: str) -> Dict[str, Any]:
        """Convenience wrapper around send_ping for compatibility."""
        try:
            print(f"Pinging node {node_hash[:16]}...")
            browser = NomadNetBrowser(self.main_browser, node_hash)
            return browser.send_ping()
        except Exception as exc:
            print(f"Ping failed: {exc}")
            return {"error": f"Ping failed: {exc}", "message": "", "status": "error"}

    def send_ping(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        Measure reachability and round-trip time to the node.

        This used to open a link and then download /page/index.mu, timing the
        whole thing. That is not a ping: it measures how big and how slow the
        node's front page is, so a node with a heavy index looked far away
        when it was not, and the number changed if the operator edited a page.

        RNS already measures the real round-trip during link establishment and
        exposes it as link.rtt. Reading that costs one link setup and not a
        single byte of page content - which on LoRa is the difference between
        a ping and a download.
        """
        try:
            pretty_hash = RNS.prettyhexrep(self.destination_hash)[:16]
            if timeout is None:
                timeout = adaptive_timeout(self.destination_hash)
            print(f"Pinging {pretty_hash} (timeout {timeout:.0f}s)...")

            if not _wait_for_path(self.destination_hash, timeout=timeout):
                return {"error": "No path", "message": "No path to destination", "status": "error"}

            identity = _recall_destination(self.destination_hash)
            if not identity:
                return {"error": "No identity", "message": "Could not recall identity", "status": "error"}
            wrong = not_a_node(self.destination_hash, identity)
            if wrong:
                return wrong

            print("✅ Path found, establishing link to measure round-trip time...")
            destination = RNS.Destination(
                identity,
                RNS.Destination.OUT,
                RNS.Destination.SINGLE,
                "nomadnetwork",
                "node",
            )

            started = time.time()
            self.link = RNS.Link(destination)

            if not _await_link(self.link, timeout=timeout):
                return {"error": "Timeout", "message": "Could not establish link", "status": "error"}

            # link.rtt is what RNS measured during establishment. Fall back to
            # our own wall clock only if it is somehow not populated.
            rtt = getattr(self.link, "rtt", None)
            measured = "link RTT"
            if not rtt:
                rtt = time.time() - started
                measured = "link setup time"

            hops = RNS.Transport.hops_to(self.destination_hash)
            hops_str = f", {hops} hop{'' if hops == 1 else 's'}" if isinstance(hops, int) and hops < 128 else ""

            try:
                self.link.teardown()
            except Exception:
                pass

            print(f"✅ Pong! RTT: {rtt:.3f}s ({measured}){hops_str}")
            return {
                "message": f"Pong received! Round-trip time: {rtt:.3f}s{hops_str}",
                "rtt": rtt,
                "hops": hops if isinstance(hops, int) and hops < 128 else None,
                "status": "success",
                "error": None,
            }

        except Exception as exc:
            print(f"❌ NomadNet: Exception during ping: {exc}")
            return {"error": str(exc), "message": f"Exception: {exc}", "status": "error"}

    def send_fingerprint(self, timeout: float = 30) -> Dict[str, Any]:
        """
        Send fingerprint using RNS link.identify() like MeshChat.
        Mirrors the legacy behaviour from the monolithic implementation.
        """
        try:
            pretty_hash = RNS.prettyhexrep(self.destination_hash)[:16]
            print(f"Sending fingerprint to {pretty_hash}...")

            cached_links = getattr(self.main_browser, "nomadnet_cached_links", {})
            existing_link = cached_links.get(self.destination_hash)

            if existing_link and existing_link.status == RNS.Link.ACTIVE:
                print("Using existing cached link for identity establishment")
                self._identify_over_link(existing_link)
                return {"message": "Identity established on existing link", "status": "success", "error": None}

            response = self.main_browser.fetch_page(self.destination_hash.hex(), "/page/index.mu")

            if response["status"] == "success":
                cached_links = getattr(self.main_browser, "nomadnet_cached_links", {})
                link = cached_links.get(self.destination_hash)
                if link:
                    self._identify_over_link(link)
                    return {"message": "Identity established on new link", "status": "success", "error": None}

            return {"error": "Could not reach the node to identify - no link could be set up. "
                             "It may be offline or slow to answer: try again in a moment.",
                    "message": "Could not create or identify on link", "status": "error"}

        except Exception as exc:
            print(f"Exception during fingerprint send: {exc}")
            return {"error": str(exc), "message": f"Exception: {exc}", "status": "error"}

    def _identify_over_link(self, link: RNS.Link) -> None:
        """Attach identity information to a link and cache LXMF destination."""
        identity = self.main_browser.identity
        link.identify(identity)
        lxmf_dest_hash = RNS.Destination.hash(identity, "lxmf", "delivery")
        link.fingerprint_data = {"dest": lxmf_dest_hash.hex()}
        # Remembered on the link so a later change of identity knows which
        # links are still presenting the old one and must be closed.
        link.rbrowser_identity_hash = identity.hash.hex()

        print(f"Identity established on link: {RNS.prettyhexrep(identity.hash)}")
        print(f"LXMF dest stored: {lxmf_dest_hash.hex()}")


def split_file_request(file_path: str):
    """
    "/file/artifact`g=x|a=Manual.pdf" -> ("/file/artifact", {"var_g": "x",
    "var_a": "Manual.pdf"}). Variables after the backtick are request data,
    as NomadNet sends them, not part of the path.
    """
    path, _, fields = file_path.partition("`")
    request_data = {}
    for field in fields.split("|") if fields else []:
        key, sep, value = field.partition("=")
        if sep and key:
            request_data["var_" + key] = value
    return path, request_data


def _fallback_filename(file_path: str) -> str:
    """
    A name for a download whose node did not send one: the last path part,
    or for an /file/artifact`...|a=Manual.pdf style link, the variable that
    looks like a file name.
    """
    path, _, fields = file_path.partition("`")
    for field in reversed(fields.split("|")) if fields else []:
        value = field.partition("=")[2].replace("+", " ")
        if "." in value and "/" not in value:
            return value
    return path.rstrip("/").split("/")[-1] or "download"


class CancelToken:
    """
    Lets the web page stop a file download it started. Closing the download
    box used to only hide it: the transfer went on to the end over the mesh
    and the file then sat in memory with nobody to collect it.

    The download binds itself once it exists; a cancel that arrives earlier
    (still finding a path) is remembered and applied when it binds.
    """

    def __init__(self) -> None:
        self.cancelled = False
        self._target = None
        self._lock = threading.Lock()

    def bind(self, target) -> None:
        with self._lock:
            self._target = target
            cancelled = self.cancelled
        if cancelled:
            target.cancel()

    def cancel(self) -> None:
        with self._lock:
            self.cancelled = True
            target = self._target
        if target is not None:
            target.cancel()


class NomadNetFileBrowser:
    """Helper for downloading binary files from NomadNet nodes."""

    def __init__(self, main_browser: "NomadNetWebBrowser", destination_hash: str) -> None:
        self.main_browser = main_browser
        self.destination_hash = _clean_hash(destination_hash)

        self.destination: Optional[RNS.Destination] = None
        self.link: Optional[RNS.Link] = None
        self.result = RequestResult()
        self.response_event = threading.Event()
        self.file_path: str = ""
        self.receipt = None
        self.cancelled = False

    def cancel(self) -> None:
        """
        Stop the transfer without closing the link: the link is usually the
        page's own (and may be the identified one), so only this request's
        incoming resource is cancelled. Marking the receipt failed is RNS's
        own way to do that - its next progress step cancels the resource -
        and the direct cancel covers a transfer that is between steps.
        """
        self.cancelled = True
        receipt = self.receipt
        if receipt is not None:
            try:
                receipt.status = RNS.RequestReceipt.FAILED
            except Exception:
                pass
            link = self.link
            request_id = getattr(receipt, "request_id", None)
            if link is not None and request_id is not None:
                for resource in list(getattr(link, "incoming_resources", [])):
                    if getattr(resource, "request_id", None) == request_id:
                        try:
                            resource.cancel()
                        except Exception:
                            pass
        self.response_event.set()

    def fetch_file(self, file_path: str, timeout: Optional[float] = None, progress_callback=None,
                   cancel_token: Optional[CancelToken] = None) -> Dict[str, Any]:
        """Fetch a binary file from the remote node with optional progress tracking."""
        cancelled = {"error": "Cancelled", "content": b"", "status": "cancelled"}
        if cancel_token is not None:
            cancel_token.bind(self)
        try:
            pretty_hash = RNS.prettyhexrep(self.destination_hash)[:16]
            if timeout is None:
                # Files are big: give the transfer itself a far longer budget
                # than a page request, on top of the path cost.
                timeout = adaptive_timeout(self.destination_hash, base=60)
            print(f"🔍 Checking path to {pretty_hash} for file (timeout {timeout:.0f}s)...")

            if not _wait_for_path(self.destination_hash, timeout=timeout):
                return {"error": "No path", "content": b"", "status": "error"}
            if self.cancelled:
                return cancelled

            identity = _recall_destination(self.destination_hash)
            if not identity:
                return {"error": "No identity", "content": b"", "status": "error"}

            # A file link can carry variables after a backtick:
            #   :/file/artifact`g=reticulum|r=reticulum|a=Manual.pdf
            # They are request data (var_g, var_r, ...), not part of the path -
            # NomadNet sends them that way. Sent as part of the path, the node
            # looked for a file that does not exist and the download came
            # back empty.
            path, request_data = split_file_request(file_path)
            self.file_path = path
            self.request_data = request_data or None
            self.result = RequestResult()
            self.response_event.clear()
            self.progress_callback = progress_callback

            # The link the page is on, when there is one. It may be the one
            # you identified on: a node that serves files only to identified
            # users refused them on a fresh anonymous link - again an empty
            # download. NomadNet downloads on the page's link too.
            link = self.main_browser.nomadnet_cached_links.get(self.destination_hash)
            if link and link.status == RNS.Link.ACTIVE:
                print(f"📁 Requesting file: {path} (re-using page link)")
                self.link = link
                self._on_link_established(link)
            else:
                print("✅ Path found, establishing connection for file transfer...")
                self.destination = RNS.Destination(
                    identity,
                    RNS.Destination.OUT,
                    RNS.Destination.SINGLE,
                    "nomadnetwork",
                    "node",
                )
                self.link = RNS.Link(self.destination)
                self.main_browser.nomadnet_cached_links[self.destination_hash] = self.link
                print(f"📁 Requesting file: {path}")
                self.link.set_link_established_callback(self._on_link_established)
            success = self.response_event.wait(timeout=timeout * 2)

            if self.cancelled:
                print(f"🛑 Download of {path.split('/')[-1] or 'file'} cancelled")
                return cancelled

            if success and self.result.received:
                if self.result.error:
                    # The node sent a Micron page instead of a file: a refusal
                    # or an error notice. Report it rather than saving it.
                    return {"error": self.result.error, "content": b"",
                            "filename": "", "status": "error"}
                return {
                    "content": self.result.data or b"",
                    "filename": self.result.name or _fallback_filename(file_path),
                    "status": "success",
                    "error": None,
                }

            return {"error": "Timeout", "content": b"", "status": "error"}

        except Exception as exc:
            print(f"❌ NomadNet: Exception during file fetch: {exc}")
            return {"error": str(exc), "content": b"", "status": "error"}

    def _on_link_established(self, link: RNS.Link) -> None:
        if self.cancelled:
            return
        try:
            # Extract filename from path for cleaner logging
            filename = self.file_path.split('/')[-1] or "file"
            print(f"📁 Download of {filename} started")
            
            # Define progress handler
            def on_progress(receipt):
                if self.progress_callback:
                    progress = receipt.progress  # 0.0 to 1.0
                    self.progress_callback(progress)
                    # Removed: print statement here
            
            self.receipt = link.request(
                self.file_path,
                data=getattr(self, "request_data", None),
                response_callback=self._on_response,
                failed_callback=self._on_request_failed,
                progress_callback=on_progress,
            )
            if self.cancelled:
                # Cancelled while the request was being sent.
                self.cancel()
        except Exception as exc:
            print(f"❌ NomadNet: File request error: {exc}")
            self.result = RequestResult(data=b"", received=True)
            self.response_event.set()

    def _on_response(self, receipt: RNS.RequestReceipt) -> None:
        """
        Interpret a /file/ response exactly as NomadNet's own client does
        (Browser.file_received). The three shapes mean three different things
        and must not be lumped together:

          io.BufferedReader + metadata  the transfer itself; the real name is
                                        in metadata["name"]
          [name, data]                  legacy two element form, name first
          bytes                         NOT a file. A node answers a refused
                                        request with a Micron page - the
                                        "Request Not Allowed" notice - encoded
                                        as utf-8. Saving those bytes handed the
                                        user a file containing the refusal
                                        message, named as if it were the file
                                        they asked for.
        """
        try:
            data = getattr(receipt, "response", None)
            url_name = self.file_path.split("/")[-1] or "download"

            if isinstance(data, bytes):
                try:
                    markup = data.decode("utf-8")
                except UnicodeDecodeError:
                    # Raw bytes that are not text: no metadata, no name, but
                    # it is plausibly the file. Take it.
                    self.result.data = data
                    self.result.name = safe_attachment_name(url_name)
                    self.result.received = True
                    print(f"✅ Download of {self.result.name} completed ({len(data)} bytes)")
                    self.response_event.set()
                    return

                self.result.data = b""
                self.result.name = ""
                self.result.error = markup.strip()
                self.result.received = True
                print(f"❌ NomadNet: Node refused the file request for {url_name}")
                self.response_event.set()
                return

            if isinstance(data, list) and len(data) == 2 and not hasattr(data[0], "read"):
                # [file_name, file_data] - name first, payload second.
                name, payload = data
                if isinstance(payload, str):
                    payload = payload.encode("utf-8")
                self.result.data = payload if isinstance(payload, bytes) else b""
                self.result.name = safe_attachment_name(name, fallback=url_name)
            else:
                self.result.data = response_bytes(receipt)
                self.result.name = safe_attachment_name(
                    response_name(receipt, fallback=url_name), fallback=url_name)

            if self.result.name != url_name:
                print(f"✅ Download of {url_name} completed as {self.result.name} "
                      f"({len(self.result.data)} bytes)")
            else:
                print(f"✅ Download of {self.result.name} completed "
                      f"({len(self.result.data)} bytes)")

            self.result.received = True
            self.response_event.set()

        except Exception as exc:
            print(f"❌ NomadNet: File response processing error: {exc}")
            self.result = RequestResult(data=b"", received=True)
            self.response_event.set()

    def _on_request_failed(self, _receipt: RNS.RequestReceipt) -> None:
        print("❌ NomadNet: File request failed")
        self.result = RequestResult(data=b"", received=True)
        self.response_event.set()


class NomadNetMediaBrowser:
    """
    Fetch an inline image from a NomadNet node.

    NomadNet 1.4.x serves images through a single "/media" request handler
    rather than one handler per file (Node.py: register_media). The request
    carries a dict - {"path": "/media/pic.png", "key": None} - and the node
    answers with the file plus a metadata dict holding the name it actually
    sent. Anything that is not already WebP is converted on the node side, so
    the name you get back is frequently not the name you asked for.
    """

    # What a node is willing to serve at all (Node.MEDIA_EXTS).
    MEDIA_EXTS = (".webp", ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tiff")

    def __init__(self, main_browser: "NomadNetWebBrowser", destination_hash: str) -> None:
        self.main_browser = main_browser
        self.destination_hash = _clean_hash(destination_hash)
        self.link: Optional[RNS.Link] = None
        self.result = RequestResult()
        self.response_event = threading.Event()
        self.media_path: str = ""

    def fetch_media(self, media_path: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        try:
            # ":/media/x" is "this node's /media/x". Drop the colon before
            # deciding whether the /media/ prefix is there, or it gets a
            # second one and the node is asked for a path that does not exist.
            media_path = media_path.lstrip(":")
            if not media_path.startswith("/media/"):
                media_path = "/media/" + media_path.lstrip("/")

            ext = ("." + media_path.rsplit(".", 1)[-1].lower()) if "." in media_path else ""
            if ext not in self.MEDIA_EXTS:
                return {"error": f"Unsupported media type: {ext or 'none'}",
                        "content": b"", "filename": "", "status": "error"}

            if timeout is None:
                timeout = adaptive_timeout(self.destination_hash, base=30)

            if not _wait_for_path(self.destination_hash, timeout=timeout):
                return {"error": "No path", "content": b"", "filename": "", "status": "error"}

            # Re-use the link the page is already holding whenever we can.
            # A page with eight images must not open eight links: that is
            # eight handshakes of airtime for nothing. This is what NomadNet
            # does too (Browser.__load_image).
            link = self.main_browser.nomadnet_cached_links.get(self.destination_hash)
            reused = bool(link and link.status == RNS.Link.ACTIVE)

            if not reused:
                identity = _recall_destination(self.destination_hash)
                if not identity:
                    return {"error": "No identity", "content": b"", "filename": "", "status": "error"}
                destination = RNS.Destination(
                    identity, RNS.Destination.OUT, RNS.Destination.SINGLE,
                    "nomadnetwork", "node",
                )
                link = RNS.Link(destination)
                if not _await_link(link, timeout=timeout):
                    return {"error": "Timeout", "content": b"", "filename": "",
                            "status": "error"}
                self.main_browser.nomadnet_cached_links[self.destination_hash] = link

            self.link = link
            self.media_path = media_path
            self.result = RequestResult()
            self.response_event.clear()

            print(f"🖼️ Requesting media: {media_path}"
                  f"{' (re-using page link)' if reused else ''}")

            link.request(
                "/media",
                data={"path": media_path, "key": None},
                response_callback=self._on_response,
                failed_callback=self._on_failed,
            )

            if self.response_event.wait(timeout=timeout * 2) and self.result.received:
                if not self.result.data:
                    return {"error": "Empty response", "content": b"", "filename": "",
                            "status": "error"}
                return {"content": self.result.data, "filename": self.result.name,
                        "status": "success", "error": None}

            return {"error": "Timeout", "content": b"", "filename": "", "status": "error"}

        except Exception as exc:
            print(f"❌ NomadNet: Exception during media fetch: {exc}")
            return {"error": str(exc), "content": b"", "filename": "", "status": "error"}

    def _on_response(self, receipt: RNS.RequestReceipt) -> None:
        try:
            self.result.data = response_bytes(receipt)
            self.result.name = response_name(
                receipt, fallback=self.media_path.split("/")[-1] or "image")
            self.result.received = True
            print(f"✅ Media {self.result.name} received ({len(self.result.data)} bytes)")
        except Exception as exc:
            print(f"❌ NomadNet: Media response error: {exc}")
            self.result = RequestResult(data=b"", received=True)
        finally:
            self.response_event.set()

    def _on_failed(self, _receipt: RNS.RequestReceipt) -> None:
        print(f"❌ NomadNet: Media request failed: {self.media_path}")
        self.result = RequestResult(data=b"", received=True)
        self.response_event.set()


class NomadNetAnnounceHandler:
    """Reticulum announce handler façade."""

    def __init__(self, browser: "NomadNetWebBrowser") -> None:
        self.browser = browser
        self.aspect_filter = "nomadnetwork.node"

    def received_announce(
        self,
        destination_hash: bytes,
        announced_identity: RNS.Identity,
        app_data: Optional[bytes],
    ) -> None:
        self.browser.process_nomadnet_announce(destination_hash, announced_identity, app_data)


class LXMFAnnounceHandler:
    """
    Listens for LXMF delivery announces to learn operator names.

    A node announce carries the node's name and nothing else - NomadNet's
    Node.py sets app_data to exactly that. The operator's display name
    travels on their own LXMF announce instead, which is a different
    destination but the same identity: NomadNetworkApp builds both the node
    destination and the LXMF delivery destination from self.identity.

    So the two can be matched up by identity hash, and the name costs
    nothing to learn - these announces arrive on their own whether or not
    anybody is listening. Nothing here ever transmits.
    """

    def __init__(self, browser: "NomadNetWebBrowser") -> None:
        self.browser = browser
        self.aspect_filter = "lxmf.delivery"

    def received_announce(
        self,
        destination_hash: bytes,
        announced_identity: RNS.Identity,
        app_data: Optional[bytes],
    ) -> None:
        try:
            self.browser.process_lxmf_announce(destination_hash, announced_identity, app_data)
        except Exception as exc:
            # An operator name is a nicety; never let one break announce
            # processing for everything else.
            print(f"Ignoring malformed LXMF announce: {exc}")


def operator_lxmf_address(identity: RNS.Identity) -> Optional[str]:
    """
    The LXMF address of whoever runs a node, derived from its announce.

    Both destinations come from the operator's one identity, so this is a
    local calculation over bytes already in hand - no lookup, no request,
    nothing on the air.
    """
    if identity is None:
        return None
    try:
        return RNS.Destination.hash(identity, "lxmf", "delivery").hex()
    except Exception as exc:
        print(f"Could not derive the operator address: {exc}")
        return None


def decode_lxmf_display_name(app_data: Optional[bytes]) -> Optional[str]:
    """
    The display name out of an LXMF announce.

    LXMF has sent two shapes over the years: plain UTF-8, and msgpack of
    [display_name, stamp_cost] once stamps arrived. Both appear on the
    network today, so both are read.
    """
    if not app_data:
        return None

    try:
        unpacked = msgpack.unpackb(app_data)
        if isinstance(unpacked, (list, tuple)) and unpacked:
            name = unpacked[0]
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            if isinstance(name, str) and name.strip():
                return name.strip()[:64]
            return None
        if isinstance(unpacked, bytes):
            return unpacked.decode("utf-8", errors="replace").strip()[:64] or None
        if isinstance(unpacked, str):
            return unpacked.strip()[:64] or None
    except Exception:
        pass

    try:
        name = app_data.decode("utf-8").strip()
        return name[:64] or None
    except Exception:
        return None


# Circular imports are only needed for type checking.
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from .web_browser import NomadNetWebBrowser
