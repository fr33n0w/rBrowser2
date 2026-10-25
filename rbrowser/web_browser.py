"""
High level management for the rBrowser NomadNet client.

`NomadNetWebBrowser` coordinates the Reticulum connection, caches announce
information about nodes, and exposes helpers used by the Flask API.
"""

from __future__ import annotations

import queue
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional

import RNS
from . import rnsquiet
import RNS.vendor.umsgpack as msgpack


def _patch_rpc_retry() -> None:
    """
    rnsd answers RPC (link RSSI/SNR, "destination data used"...) on a socket
    opened with a backlog of 1. On Windows a second client connecting at the
    same moment - rBrowser, another LXMF client, bots on the same rnsd - is
    refused at once (WinError 10061, "Shared instance RPC failed"), and the
    packet being handled is dropped with a traceback. A refused connection is
    tried again a few times, a few ms apart.
    """
    if getattr(RNS.Reticulum, "_rbrowser_rpc_retry", False) or not hasattr(RNS.Reticulum, "get_rpc_client"):
        return
    original = RNS.Reticulum.get_rpc_client

    def get_rpc_client(self):
        for attempt in range(5):
            try:
                return original(self)
            except ConnectionRefusedError:
                if attempt == 4:
                    raise
                time.sleep(0.02 * (attempt + 1))

    RNS.Reticulum.get_rpc_client = get_rpc_client
    RNS.Reticulum._rbrowser_rpc_retry = True


from .favorites import Favorites
from .hidden_nodes import HiddenNodes
from .history import History
from .pagecache import PageCache
from .visits import Visits
from .identities import EPHEMERAL, IdentityManager, clean_node_hash
from .messenger import Messenger
from .retibbs import RetiBBS
from .nomadnet import (
    decode_lxmf_display_name,
    operator_lxmf_address,
    LXMFAnnounceHandler,
    adaptive_timeout,
    prepare_request_data,
    NomadNetAnnounceHandler,
    NomadNetBrowser,
    NomadNetFileBrowser,
    NomadNetMediaBrowser,
    _clean_hash,
    is_replayed_announce,
    request_path,
)


def interface_label(interface: str) -> str:
    """
    The name an interface was given in the Reticulum config, out of its
    description: "TCPInterface[rmap bbone/rmap.world:4343]" -> "rmap bbone".
    Anything else comes back as it is.
    """
    text = str(interface or "").strip()
    if "[" in text and text.endswith("]"):
        inner = text[text.index("[") + 1:-1]
        name = inner.split("/", 1)[0].strip()
        return name or inner or text
    return text


class NomadNetWebBrowser:
    """Main controller for rBrowser runtime state."""

    def __init__(self) -> None:
        self.reticulum: Optional[RNS.Reticulum] = None
        # Profiles, ephemeral identity and per-node bindings. `self.identity`
        # below is always whichever one is active right now.
        self.identities: Optional[IdentityManager] = None
        self.nomadnet_nodes: Dict[str, Dict[str, Any]] = {}
        self.running = False
        self.announce_count = 0
        self.start_time = time.time()
        self.last_announce_time: Optional[float] = None
        self.connection_state = "initializing"
        self.reticulum_ready = False
        # Why the connection failed, for the status bar. Reticulum is brought
        # up after the web server, so the page is there to show it.
        self.reticulum_error: Optional[str] = None

        self._status_cache: Optional[Dict[str, Any]] = None
        self._status_cache_time: Optional[float] = None
        self._cache_lock = threading.Lock()
        self.cache_duration = 1.0

        self.nomadnet_cached_links: Dict[bytes, RNS.Link] = {}

        # destination hash -> (timestamp, hop info). See get_node_hops().
        self._hops_cache: Dict[str, Any] = {}
        # Bumped whenever the node set changes, so the API can tell a poller
        # "nothing moved" without re-serialising everything.
        self.nodes_revision = 0

        # Pages the user has visited, kept on disk. Only ever written to as
        # the result of a page the user asked for: see rbrowser/pagecache.py.
        self.page_cache = PageCache()
        # How often you opened each node's pages: rbrowser/visits.py.
        self.visits = Visits()
        # The pages you opened, newest first: rbrowser/history.py.
        self.history = History()

        # identity hash -> operator display name, learned from LXMF
        # announces. A node announce does not carry the operator's name, but
        # it does carry the identity, and the operator's LXMF destination is
        # built from that same identity.
        self.operator_names: Dict[str, str] = {}

        # Favorites on disk, and the background search for the names of
        # those added by hash alone. See rbrowser/favorites.py.
        # Nodes left out of the list (rbrowser/hidden_nodes.py).
        self.hidden_nodes = HiddenNodes()
        self.favorites = Favorites()
        self.favorites.local_name = self.known_node_name
        self.favorites.network_name = self.request_node_name
        self.favorites.connected = lambda: self.reticulum_ready
        self.favorites.start()

        # The default profile is the same nomadnet_browser_identity file
        # rBrowser has always used, created on first run as before. Loading
        # keys needs no Reticulum instance, so the identity settings work
        # while the connection is still coming up.
        self.identities = IdentityManager()

        # Timed ephemeral identities are changed here, by the server, so the
        # change happens on time whether or not a page is open.
        threading.Thread(target=self._ephemeral_timer, name="ephemeral-timer",
                         daemon=True).start()

        # Work that has to run on the main thread (an LXMRouter installs
        # signal handlers), queued from the web server's threads and run by
        # the main loop in rBrowser.py.
        self.main_thread_tasks: "queue.Queue" = queue.Queue()
        # The LXMF messenger: rbrowser/messenger.py. Off until enabled.
        self.messenger = Messenger(self)
        # The RetiBBS client: rbrowser/retibbs.py. Off until enabled.
        self.retibbs = RetiBBS(self)
        # RMAP integration: rbrowser/rmap.py. Plain HTTPS to rmap.world,
        # only while it is on; does not need Reticulum.
        from .rmap import Rmap
        self.rmap = Rmap()
        # The RRC chat client: rbrowser/rrc.py. Off until enabled.
        from .rrc import RRC
        self.rrc = RRC(self)

        print("=" * 90)
        from . import updates
        print(f"🌐 rBrowser v{updates.local_version()} - Standalone Reticulum Browser - https://github.com/fr33n0w/rBrowser2")
        print("=" * 90)

        # Reticulum is NOT started here any more. It used to be, which meant
        # the web server could only start once Reticulum was up - and if it
        # never came up the process exited before a page was ever served,
        # with nothing on screen to say why. The caller now starts the web
        # server first and then calls init_reticulum().

    # ------------------------------------------------------------------ #
    # Reticulum initialisation                                           #
    # ------------------------------------------------------------------ #

    def init_reticulum(self) -> bool:
        """
        Bring up Reticulum and register the announce handlers. Must run in
        the main thread: RNS.Reticulum() installs signal handlers. Returns
        whether it worked; a failure is kept in reticulum_error for the page
        instead of ending the process.
        """
        try:
            self.connection_state = "connecting"
            self.reticulum_error = None
            print("🔗 Connecting to Reticulum...")
            RNS.loglevel = RNS.LOG_CRITICAL

            self.reticulum = self._ensure_reticulum_instance()

            self.nomadnet_handler = NomadNetAnnounceHandler(self)
            RNS.Transport.register_announce_handler(self.nomadnet_handler)

            # Listening for LXMF announces as well is what lets the node
            # list show who runs a node. It is purely passive: these
            # announces are already crossing the network.
            self.lxmf_handler = LXMFAnnounceHandler(self)
            RNS.Transport.register_announce_handler(self.lxmf_handler)

            self.reticulum_ready = True
            self.connection_state = "connected"

            if self.identity:
                print(f"🟢 Reticulum Connected! 🔑 Browser identity: {RNS.prettyhexrep(self.identity.hash)}"
                      f" ({self.identities.name_of(self.identities.active_id)})")
            else:
                print("🟢 Reticulum Connected! (no identity hash available)")
            print("=" * 90)
            self.messenger.start_on_main_thread()
            self.retibbs.start()
            self.rrc.start()
            return True

        except Exception as exc:
            self.reticulum_ready = False
            self.connection_state = "failed"
            self.reticulum_error = str(exc) or type(exc).__name__
            print(f"❌ Failed to initialise Reticulum: {self.reticulum_error}")
            print("   The web interface stays up and shows this in its status bar.")
            return False

    def run_main_thread_tasks(self) -> None:
        """Run what the web server's threads queued for the main thread."""
        while True:
            try:
                task = self.main_thread_tasks.get_nowait()
            except queue.Empty:
                return
            try:
                task()
            except Exception as exc:
                print(f"⚠️ Main thread task failed: {exc}")

    def _ensure_reticulum_instance(self) -> RNS.Reticulum:
        """Obtain or create a Reticulum instance. Raises on failure."""
        _patch_rpc_retry()
        try:
            if hasattr(RNS.Reticulum, "get_instance"):
                instance = RNS.Reticulum.get_instance()
                if instance:
                    print("🔄 Using existing Reticulum instance")
                    return instance
            return RNS.Reticulum()
        except Exception as exc:
            if "reinitialise" in str(exc).lower() or "already running" in str(exc).lower():
                print("⚠️ Reticulum already running - attempting to use existing instance...")
                instance = getattr(RNS.Reticulum, "get_instance", lambda: None)()
                if not instance:
                    raise RuntimeError("Reticulum is already running but its instance "
                                       "cannot be reached") from exc
                print("✅ Connected to existing Reticulum instance")
                return instance
            raise

    def _not_connected(self, **extra: Any) -> Optional[Dict[str, Any]]:
        """
        The answer for any network action asked for before Reticulum is up
        (or after it failed), instead of letting RNS fail in its own way.
        None when connected.
        """
        if self.reticulum_ready:
            return None
        why = ("Reticulum failed to start: " + self.reticulum_error) if self.reticulum_error \
            else "Reticulum is not connected yet - wait a moment and try again"
        result = {"status": "error", "error": why}
        result.update(extra)
        return result

    # ------------------------------------------------------------------ #
    # Announce handling                                                  #
    # ------------------------------------------------------------------ #

    def process_nomadnet_announce(
        self,
        destination_hash: bytes,
        announced_identity: RNS.Identity,
        app_data: Optional[bytes],
    ) -> None:
        """Process incoming announce messages from NomadNet nodes."""
        hash_str = RNS.prettyhexrep(destination_hash)
        clean_hash_str = hash_str.replace("<", "").replace(">", "").replace(":", "")

        node_name = self._decode_node_name(app_data, hash_str)

        # The answer to a path request, not an announce (see
        # is_replayed_announce): the list shows nodes that announced, and
        # opening a node that is long gone must not put it there. Its name
        # is still worth having, for a favorite added by hash.
        if is_replayed_announce(destination_hash):
            print(f"↩️ Path response for {clean_hash_str[:16]} ({node_name}): "
                  "an old copy of its announce, not listed")
            if not node_name.startswith("Node_"):
                self.favorites.on_announce(clean_hash_str, node_name)
            return

        self.announce_count += 1
        self.last_announce_time = time.time()

        if node_name.startswith("EmptyNode_") or node_name.startswith("BinaryNode_") or node_name == "UNKNOWN":
            print(f"Filtered test node: {hash_str[:16]} -> {node_name}")
            return

        node_entry = self._list_node(hash_str, clean_hash_str, node_name, announced_identity,
                                     app_data, datetime.now())
        node_entry["node_announce_count"] += 1
        # Heard now: no longer just a node from the known announces.
        node_entry.pop("from_known", None)

        if self.connection_state == "connected":
            self.connection_state = "active"
            print("🟢 Connection state updated to ACTIVE (received first valid announce)")

        print(
            "🌐 NomadNet Announce #"
            f"{self.announce_count}: {clean_hash_str} -> {node_name} "
            f"(node announces: {node_entry['node_announce_count']})"
        )

        # A favorite added by hash alone gets its name from this announce.
        if not node_name.startswith("Node_"):
            self.favorites.on_announce(clean_hash_str, node_name)

        # A fresh announce can mean a new path, so stop trusting the cached
        # hop count for this node.
        self._hops_cache.pop(clean_hash_str, None)
        self.nodes_revision += 1

    def _list_node(self, hash_str: str, clean_hash_str: str, node_name: str,
                   announced_identity: Optional[RNS.Identity], app_data: Optional[bytes],
                   seen: datetime) -> Dict[str, Any]:
        """The node's entry in the list, created or brought up to date."""
        relative = "Just now"
        node_entry = self.nomadnet_nodes.setdefault(
            hash_str,
            {
                "hash": clean_hash_str,
                "name": node_name,
                "last_seen": seen.isoformat(),
                "announce_count": self.announce_count,
                "node_announce_count": 0,
                "app_data_length": len(app_data) if app_data else 0,
                "last_seen_relative": relative,
            },
        )
        node_entry["name"] = node_name
        node_entry["last_seen"] = seen.isoformat()
        node_entry["app_data_length"] = len(app_data) if app_data else 0
        node_entry["last_seen_relative"] = relative

        # Who runs this node. Derived from the announced identity, not asked
        # for: the operator's LXMF destination and the node destination are
        # built from the same identity, so the address falls out of the
        # announce we already have. The name only appears once that operator
        # announces on LXMF too, which may be never.
        identity_hash = None
        if announced_identity is not None:
            try:
                identity_hash = announced_identity.hash.hex()
            except Exception:
                identity_hash = None

        if identity_hash:
            node_entry["identity_hash"] = identity_hash
            operator_address = operator_lxmf_address(announced_identity)
            if operator_address:
                node_entry["operator_lxmf_address"] = operator_address
            known_name = self.operator_names.get(identity_hash)
            if known_name:
                node_entry["operator_name"] = known_name
        return node_entry

    def add_known_node(self, destination_hash: bytes, identity: RNS.Identity,
                       app_data: Optional[bytes], heard: datetime) -> None:
        """
        A node from Reticulum's known announces (node_prefill.py), listed as
        last seen when that announce came in. Not counted as an announce:
        nothing was received now.
        """
        hash_str = RNS.prettyhexrep(destination_hash)
        clean_hash_str = hash_str.replace("<", "").replace(">", "").replace(":", "")
        node_name = self._decode_node_name(app_data, hash_str)
        if node_name.startswith(("EmptyNode_", "BinaryNode_")) or node_name == "UNKNOWN":
            return
        entry = self._list_node(hash_str, clean_hash_str, node_name, identity, app_data, heard)
        # Shown with its own mark until the node announces while we listen.
        entry["from_known"] = True
        self.nodes_revision += 1

    def process_lxmf_announce(
        self,
        destination_hash: bytes,
        announced_identity: RNS.Identity,
        app_data: Optional[bytes],
    ) -> None:
        """
        Learn an operator's name from their LXMF announce.

        Nothing is fetched and nothing is answered; this only reads what was
        already going past. If the identity belongs to a node we have heard
        from, the name is attached to it and the list shows who runs it.
        """
        if announced_identity is None:
            return

        name = decode_lxmf_display_name(app_data)
        if not name:
            return

        try:
            identity_hash = announced_identity.hash.hex()
        except Exception:
            return

        if self.operator_names.get(identity_hash) == name:
            return
        self.operator_names[identity_hash] = name

        # Attach it to any node already known to run on this identity.
        touched = False
        for entry in list(self.nomadnet_nodes.values()):
            if entry.get("identity_hash") == identity_hash and entry.get("operator_name") != name:
                entry["operator_name"] = name
                touched = True

        if touched:
            self.nodes_revision += 1
            print(f"👤 Operator of a known node identified as {name}")

    @staticmethod
    def _decode_node_name(app_data: Optional[bytes], hash_str: str) -> str:
        if app_data:
            try:
                return app_data.decode("utf-8")
            except Exception:
                try:
                    decoded = msgpack.unpackb(app_data)
                    if isinstance(decoded, str):
                        return decoded
                    return f"Node_{hash_str[:8]}"
                except Exception:
                    return f"BinaryNode_{hash_str[:8]}"
        return f"EmptyNode_{hash_str[:8]}"

    # ------------------------------------------------------------------ #
    # Cache-aware helpers                                                #
    # ------------------------------------------------------------------ #

    def get_cached_status(self) -> Dict[str, Any]:
        """Return cached status information used by the status API."""
        with self._cache_lock:
            now = time.time()

            if (
                self._status_cache is not None
                and self._status_cache_time is not None
                and now - self._status_cache_time < self.cache_duration
            ):
                return self._status_cache

            app_uptime = now - self.start_time
            has_nodes = bool(self.nomadnet_nodes)
            time_since_last_announce = (
                now - self.last_announce_time if self.last_announce_time else None
            )

            self._status_cache = {
                "app_uptime": app_uptime,
                "has_nodes": has_nodes,
                "time_since_last_announce": time_since_last_announce,
                "node_count": len(self.nomadnet_nodes),
                "announce_count": self.announce_count,
                "connection_state": getattr(self, "connection_state", "connected"),
                "reticulum_ready": getattr(self, "reticulum_ready", False),
                "reticulum_error": getattr(self, "reticulum_error", None),
            }
            self._status_cache_time = now
            return self._status_cache

    def get_nodes(self):
        current_time = datetime.now()
        for node in list(self.nomadnet_nodes.values()):
            last_seen = datetime.fromisoformat(node["last_seen"])
            diff = current_time - last_seen

            if diff.total_seconds() < 60:
                node["last_seen_relative"] = "Just now"
            elif diff.total_seconds() < 3600:
                minutes = int(diff.total_seconds() / 60)
                node["last_seen_relative"] = f"{minutes}m ago"
            else:
                hours = int(diff.total_seconds() / 3600)
                node["last_seen_relative"] = f"{hours}h ago"

        return list(self.nomadnet_nodes.values())

    def set_node_hidden(self, node_hash: str, hidden: bool, name: str = "") -> bool:
        """Hide a node from the list, or bring it back. The list is rebuilt
        on the next poll (nodes_revision)."""
        changed = (self.hidden_nodes.hide(node_hash, name) if hidden
                   else self.hidden_nodes.unhide(node_hash))
        if changed:
            self.nodes_revision += 1
        return changed

    # ------------------------------------------------------------------ #
    # Page & file access                                                 #
    # ------------------------------------------------------------------ #

    def fetch_file(self, node_hash: str, file_path: str, progress_callback=None,
                   cancel_token=None) -> Dict[str, Any]:
        """Fetch a file from a NomadNet node with optional progress tracking."""
        not_ready = self._not_connected(content=b"")
        if not_ready:
            return not_ready
        try:
            print(f"📁 NomadNetWebBrowser.fetch_file called: {file_path} from {node_hash[:16]}...")
            browser = NomadNetFileBrowser(self, node_hash)
            return browser.fetch_file(file_path, progress_callback=progress_callback,
                                      cancel_token=cancel_token)
        except Exception as exc:
            print(f"❌ File fetch failed: {exc}")
            return {"error": f"File fetch failed: {exc}", "content": b"", "status": "error"}

    def fetch_media(self, node_hash: str, media_path: str) -> Dict[str, Any]:
        """Fetch an inline image from a NomadNet node."""
        not_ready = self._not_connected(content=b"", filename="")
        if not_ready:
            return not_ready
        try:
            browser = NomadNetMediaBrowser(self, node_hash)
            return browser.fetch_media(media_path)
        except Exception as exc:
            print(f"❌ Media fetch failed: {exc}")
            return {"error": f"Media fetch failed: {exc}", "content": b"",
                    "filename": "", "status": "error"}

    # ------------------------------------------------------------------ #
    # Identity                                                           #
    # ------------------------------------------------------------------ #

    @property
    def identity(self) -> Optional[RNS.Identity]:
        """The identity in use right now: a profile, or the ephemeral one."""
        return self.identities.active_identity() if self.identities else None

    def identities_snapshot(self) -> Dict[str, Any]:
        names = {str(e.get("hash", "")).lower(): e.get("name", "")
                 for e in list(self.nomadnet_nodes.values())}
        snap = self.identities.snapshot(names)
        snap["identified_nodes"] = self.identified_nodes()
        return snap

    def _drop_links(self, only_identified_as_other: bool) -> int:
        """
        Tear down cached links. A link that has been identified on stays
        identified for as long as it lives, so after a change of identity it
        would keep presenting the old one: those have to go. With
        only_identified_as_other False, every link goes - used when the
        ephemeral identity is replaced, so nothing ties the next page load
        to the previous ones.
        """
        current = self.identity.hash.hex() if self.identity else None
        dropped = 0
        for dest, link in list(self.nomadnet_cached_links.items()):
            presented = getattr(link, "rbrowser_identity_hash", None)
            if only_identified_as_other and (not presented or presented == current):
                continue
            try:
                link.teardown()
            except Exception:
                pass
            self.nomadnet_cached_links.pop(dest, None)
            dropped += 1
        if dropped:
            print(f"🔌 Closed {dropped} link{'s' if dropped != 1 else ''} after an identity change")
        return dropped

    def switch_identity(self, profile_id: str) -> None:
        if profile_id == self.identities.active_id:
            return
        self.identities.set_active(profile_id)
        self._drop_links(only_identified_as_other=True)
        print(f"🔑 Now using identity {self.identities.name_of(profile_id)}: "
              f"{RNS.prettyhexrep(self.identity.hash)}")

    def rotate_ephemeral(self) -> list:
        dropped_nodes = self.identities.rotate_ephemeral()
        if self.identities.active_id == EPHEMERAL:
            self._drop_links(only_identified_as_other=False)
            print(f"🎭 New ephemeral identity: {RNS.prettyhexrep(self.identity.hash)}")
        return dropped_nodes

    def _ephemeral_timer(self) -> None:
        while True:
            time.sleep(1)
            try:
                due = self.identities.next_rotation()
                if due is not None and time.time() >= due:
                    self.rotate_ephemeral()
            except Exception as exc:
                print(f"⚠️ Timed ephemeral identity change failed: {exc}")
                time.sleep(10)

    def keep_ephemeral(self, name: Any) -> Dict[str, Any]:
        was_active = self.identities.active_id == EPHEMERAL
        profile = self.identities.keep_ephemeral(name)
        # Same key under a new name: links identified with it still present
        # the identity that is now active, so they stay open.
        if was_active:
            print(f"💾 Ephemeral identity kept as \"{profile['name']}\"")
        return profile

    def is_identified_to(self, node_hash: str) -> bool:
        """Is the open link to this node one we have identified on?"""
        try:
            link = self.nomadnet_cached_links.get(_clean_hash(node_hash))
        except Exception:
            return False
        return bool(link and link.status == RNS.Link.ACTIVE
                    and getattr(link, "rbrowser_identity_hash", None))

    def auto_identifies_to(self, node_hash: str) -> bool:
        """Will auto-identify identify to this node when one of its pages opens?"""
        ids = self.identities
        return bool(ids and ids.state.get("auto_identify") and ids.binding_for(node_hash))

    def identified_nodes(self) -> list:
        """Nodes with a live link we are identified on, as hex hashes."""
        return [dest.hex() for dest, link in self.nomadnet_cached_links.items()
                if link.status == RNS.Link.ACTIVE and getattr(link, "rbrowser_identity_hash", None)]

    def link_quality(self, node_hash: str) -> Dict[str, Any]:
        """
        What the link to this node looks like right now.

        Used to decide whether loading a page's images is a good idea: on a
        fast link they should just appear, on a slow one an unattended image
        load is somebody else's airtime. The thresholds are NomadNet's
        (Browser.should_load_images).
        """
        try:
            destination_hash = _clean_hash(node_hash)
            link = self.nomadnet_cached_links.get(destination_hash)
            rtt = getattr(link, "rtt", None) if link else None
            rate = None
            if link:
                try:
                    rate = link.get_expected_rate()
                except Exception:
                    rate = None

            hops = RNS.Transport.hops_to(destination_hash)
            if not isinstance(hops, int) or hops >= 128:
                hops = None

            fast = bool(rtt and rtt < 1.5 and rate and rate > 10000)
            return {"rtt": rtt, "rate": rate, "hops": hops, "fast": fast,
                    "known": bool(rtt or rate)}
        except Exception as exc:
            print(f"Could not assess link quality: {exc}")
            return {"rtt": None, "rate": None, "hops": None, "fast": False, "known": False}

    def _node_entry_for(self, node_hash: str) -> Optional[Dict[str, Any]]:
        clean = str(node_hash).replace("<", "").replace(">", "").replace(":", "").strip().lower()
        for entry in list(self.nomadnet_nodes.values()):
            if str(entry.get("hash", "")).lower() == clean:
                return entry
        return None

    def node_name_for(self, node_hash: str) -> str:
        """
        The announced name of a node, or failing that the name stored with
        its cached pages (a node that has not announced since startup).

        In between, the announce Reticulum remembers: opening a node sends a
        path request, and the answer to it is the node's announce - so a
        node never seen in the list still has its name by the time its page
        arrives, without anything extra going out.
        """
        entry = self._node_entry_for(node_hash)
        if entry and entry.get("name"):
            return entry["name"]
        remembered = self.known_node_name(node_hash)
        if remembered:
            # A favorite waiting for this name gets it now.
            self.favorites.on_announce(str(node_hash).lower(), remembered)
            return remembered
        try:
            return self.page_cache.known_name(str(node_hash).lower())
        except Exception:
            return ""

    def operator_for(self, node_hash: str) -> Dict[str, str]:
        """
        Who runs a node: the derived LXMF address, and the name if the
        operator has also announced on LXMF. Either may be missing.
        """
        entry = self._node_entry_for(node_hash)
        if not entry:
            return {}
        return {
            "name": entry.get("operator_name", ""),
            "address": entry.get("operator_lxmf_address", ""),
        }

    def fetch_page(
        self,
        node_hash: str,
        page_path: str = "/page/index.mu",
        form_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Fetch a NomadNet page, reusing cached links whenever possible."""
        not_ready = self._not_connected(content="")
        if not_ready:
            return not_ready
        try:
            print(f"Fetching {page_path} from {node_hash[:16]}...")
            destination_hash = _clean_hash(node_hash)

            cached_link = self.nomadnet_cached_links.get(destination_hash)
            if cached_link and cached_link.status == RNS.Link.ACTIVE:
                print("Using existing cached link for page request")
                return self._request_via_cached_link(cached_link, page_path, form_data)

            print("Creating new browser instance (no cached link available)")
            browser = NomadNetBrowser(self, node_hash)
            response = browser.fetch_page(page_path, form_data)

            if response["status"] == "success" and getattr(browser, "link", None):
                self.nomadnet_cached_links[destination_hash] = browser.link
                print("Stored new link in cache")

            return response

        except Exception as exc:
            print(f"Fetch failed: {exc}")
            return {"error": f"Fetch failed: {exc}", "content": "", "status": "error"}

    def _request_via_cached_link(
        self,
        link: RNS.Link,
        page_path: str,
        form_data: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        processed_form_data = self._prepare_form_data(form_data)
        final_form_data = dict(processed_form_data)

        if getattr(link, "fingerprint_data", None):
            final_form_data.update(link.fingerprint_data)
            print(f"Including fingerprint data (no field_ prefix): {link.fingerprint_data}")

        print(f"Final form data being sent: {final_form_data}")

        result = {"data": None, "received": False, "error": None}
        response_event = threading.Event()

        def on_response(receipt):
            try:
                if receipt.response:
                    data = receipt.response
                    if isinstance(data, bytes):
                        result["data"] = data.decode("utf-8")
                    else:
                        result["data"] = str(data)
                else:
                    result["data"] = "Empty response"
                result["received"] = True
                response_event.set()
            except Exception as exc:
                result["error"] = f"Response error: {exc}"
                result["received"] = True
                response_event.set()

        # An error, never page content: see NomadNetBrowser.fetch_page.
        def on_failed(_receipt):
            result["error"] = "Request failed"
            result["received"] = True
            response_event.set()

        link.request(
            page_path,
            data=final_form_data or None,
            response_callback=on_response,
            failed_callback=on_failed,
        )

        # Same adaptive budget as a fresh fetch: the link being already up
        # says nothing about how slow the path underneath it is.
        timeout = adaptive_timeout(link.destination.hash) * 2
        success = response_event.wait(timeout=timeout)
        if success and result["received"] and result["error"]:
            return {"error": result["error"], "content": result["error"], "status": "error"}
        if success and result["received"]:
            return {"content": result["data"] or "Empty response", "status": "success", "error": None}

        return {"error": "Timeout", "content": "Request timeout on cached link", "status": "error"}

    @staticmethod
    def _prepare_form_data(form_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """One shared implementation, so a cached link and a fresh one send
        byte-identical request data. They used to differ."""
        processed = prepare_request_data(form_data) or {}
        if processed:
            print(f"Processed form data: {processed}")
        return processed

    # ------------------------------------------------------------------ #
    # Misc helpers                                                       #
    # ------------------------------------------------------------------ #

    def start_monitoring(self) -> None:
        self.running = True
        print("=" * 90)
        print("📡 Started NomadNet announce monitoring")
        print("=" * 90)
        # Settings > NomadNet Browser > Node list: start with the recent announces Reticulum
        # already knows (off by default).
        try:
            from .node_prefill import prefill
            prefill(self)
        except Exception as exc:
            print(f"⚠️ Could not fill the node list from known announces: {exc}")

    # How long a hop count is considered current. Paths do change, but they
    # change when the network re-routes - not several times a second, which
    # is how often the node list used to ask.
    HOPS_CACHE_TTL = 30.0

    def get_node_hops(self, destination_hash: str) -> Dict[str, Any]:
        """
        Hops and next hop to a destination, memoised.

        This is called once per node per /api/nodes request, and the node list
        polls every two seconds. With a couple of hundred announced nodes that
        was some eighteen thousand path-table lookups a minute to redraw a
        number that had not moved. The cache is dropped for a node as soon as
        it announces again, so a genuine path change still shows up at once.
        """
        now = time.time()
        cached = self._hops_cache.get(destination_hash)
        if cached:
            # Out of date: the old value now, a fresh one from the background.
            # Each lookup is a call to the shared instance; with hundreds of
            # nodes expiring together the list waited seconds for them.
            if now - cached[0] >= self.HOPS_CACHE_TTL:
                self._queue_hops_refresh(destination_hash)
            return cached[1]

        info = self._lookup_node_hops(destination_hash)
        self._hops_cache[destination_hash] = (now, info)
        return info

    def _queue_hops_refresh(self, destination_hash: str) -> None:
        pending = self.__dict__.setdefault("_hops_pending", set())
        if destination_hash in pending:
            return
        pending.add(destination_hash)
        wake = self.__dict__.setdefault("_hops_wake", threading.Event())
        if not getattr(self, "_hops_worker", None):
            self._hops_worker = threading.Thread(target=self._hops_refresh_loop, name="hops-refresh", daemon=True)
            self._hops_worker.start()
        wake.set()

    def _hops_refresh_loop(self) -> None:
        """One lookup at a time, in the background, for the stale entries."""
        while True:
            self._hops_wake.wait()
            self._hops_wake.clear()
            while self._hops_pending:
                destination_hash = self._hops_pending.pop()
                try:
                    info = self._lookup_node_hops(destination_hash)
                    self._hops_cache[destination_hash] = (time.time(), info)
                except Exception as exc:
                    print(f"Could not refresh the path to {destination_hash[:16]}: {exc}")

    def _lookup_node_hops(self, destination_hash: str) -> Dict[str, Any]:
        """Actually ask RNS. Always go through get_node_hops() instead."""
        try:
            dest_hash = _clean_hash(destination_hash) if isinstance(destination_hash, str) else destination_hash
            if not RNS.Transport.has_path(dest_hash):
                return {"hops": "Unknown", "next_hop_interface": "Unknown", "interface": ""}
            # The hop count survives the trip through the shared instance.
            hops = RNS.Transport.hops_to(dest_hash)

            # The interface does not: attached to a shared instance (rnsd,
            # or another program holding it), every path here goes "via
            # Local shared instance". The interface that counts is the one
            # the shared instance uses, and it says so over its local RPC -
            # one call, nothing sent on the network.
            interface = ""
            try:
                if self.reticulum is not None:
                    name = self.reticulum.get_next_hop_if_name(dest_hash)
                    if name and name != "None":
                        interface = str(name)
            except Exception as exc:
                print(f"Could not ask for the next hop interface: {exc}")

            if interface:
                return {"hops": hops, "next_hop_interface": f"via {interface_label(interface)}",
                        "interface": interface}

            next_hop_info = "Unknown"
            try:
                next_hop_hash = RNS.Transport.next_hop(dest_hash)
                if next_hop_hash:
                    next_hop_if = RNS.Transport.next_hop_interface(dest_hash)
                    if next_hop_if and hasattr(next_hop_if, "name"):
                        next_hop_info = f"via {next_hop_if.name}"
                    else:
                        next_hop_info = f"via {RNS.prettyhexrep(next_hop_hash)[:16]}..."
            except Exception as exc:
                print(f"Error using next_hop functions: {exc}")

            if next_hop_info == "Unknown" and hasattr(RNS.Transport, "path_table"):
                path_entry = RNS.Transport.path_table.get(dest_hash)  # type: ignore[attr-defined]
                if path_entry:
                    for attr in ["next_hop", "via", "interface", "receiving_interface"]:
                        if hasattr(path_entry, attr):
                            value = getattr(path_entry, attr)
                            if value and hasattr(value, "name"):
                                next_hop_info = f"via {value.name}"
                                break
                            if isinstance(value, bytes):
                                next_hop_info = f"via {RNS.prettyhexrep(value)[:16]}..."
                                break

            return {"hops": hops if hops is not None else "Unknown", "next_hop_interface": next_hop_info,
                    "interface": ""}

        except Exception as exc:
            print(f"Error getting path info to {destination_hash}: {exc}")
            return {"hops": "Unknown", "next_hop_interface": "Unknown", "interface": ""}

    def get_node_path_info(self, destination_hash: str) -> Dict[str, Any]:
        """Backward compatible alias used by the API routes."""
        return self.get_node_hops(destination_hash)

    def send_fingerprint(self, node_hash: str) -> Dict[str, Any]:
        """Send identity fingerprint to a NomadNet node."""
        not_ready = self._not_connected(message="")
        if not_ready:
            return not_ready
        try:
            print(f"NomadNetWebBrowser.send_fingerprint called for {node_hash[:16]}...")
            browser = NomadNetBrowser(self, node_hash)
            result = browser.send_fingerprint()
            if result.get("status") == "success":
                # The first identity used on a node is the one auto-identify
                # will use there from now on.
                self.identities.record_identify(clean_node_hash(node_hash))
                result["profile_id"] = self.identities.active_id
                result["profile_name"] = self.identities.name_of(self.identities.active_id)
            return result
        except Exception as exc:
            print(f"Identity fingerprint send failed: {exc}")
            return {"error": f"Identity fingerprint send failed: {exc}", "message": "", "status": "error"}

    def ping_node(self, node_hash: str) -> Dict[str, Any]:
        """Ping a NomadNet node to check reachability."""
        not_ready = self._not_connected(message="")
        if not_ready:
            return not_ready
        try:
            print(f"Pinging node {node_hash[:16]}...")
            browser = NomadNetBrowser(self, node_hash)
            return browser.send_ping()
        except Exception as exc:
            print(f"Ping failed: {exc}")
            return {"error": f"Ping failed: {exc}", "message": "", "status": "error"}

    def _shared_has_path(self, dest_hash: bytes) -> bool:
        """Whether the shared instance (rnsd) has a path, over its RPC."""
        try:
            if self.reticulum is None or not self.reticulum.is_connected_to_shared_instance:
                return False
            return self.reticulum.get_next_hop(dest_hash) is not None
        except Exception:
            return False

    def _shared_path_info(self, dest_hash: bytes) -> Optional[Dict[str, Any]]:
        """Hops and interface of the shared instance's path, for when this
        program has not been handed its copy yet. Reads the whole path table,
        so only once, at the end."""
        try:
            if self.reticulum is None or not self.reticulum.is_connected_to_shared_instance:
                return None
            for entry in self.reticulum.get_path_table() or []:
                if entry.get("hash") == dest_hash:
                    interface = str(entry.get("interface", ""))
                    return {"hops": entry.get("hops"), "interface": interface,
                            "next_hop_interface": f"via {interface_label(interface)}"}
        except Exception as exc:
            print(f"Could not read the shared path table: {exc}")
        return None

    def request_fresh_path(self, node_hash: str) -> Dict[str, Any]:
        """
        Forget the path to a node and ask the network for a new one, like
        rnpath -d followed by rnpath. For a node that has just announced and
        still cannot be reached: the path held may lead through a hop that
        is gone. Waits for the answer at least 45 s, longer on a slow path.
        """
        not_ready = self._not_connected(message="")
        if not_ready:
            return not_ready
        node_hash = clean_node_hash(node_hash)
        if not node_hash:
            return {"status": "error", "error": "Not a node address"}
        try:
            dest_hash = bytes.fromhex(node_hash)
            start = time.time()
            before = self._lookup_node_hops(dest_hash)
            # The shared instance can hold a path this program was never
            # handed (it answered an earlier request itself).
            local_path = RNS.Transport.has_path(dest_hash)
            had_path = local_path or self._shared_has_path(dest_hash)
            if had_path and not local_path:
                before = self._shared_path_info(dest_hash) or before
            if had_path:
                # Both copies: the shared instance's (over its RPC), and the
                # one this program keeps from the announces passed to it.
                try:
                    if self.reticulum is not None:
                        self.reticulum.drop_path(dest_hash)
                except Exception as exc:
                    print(f"Could not drop the path in the shared instance: {exc}")
                # expire_path only marks the path old; it goes at the next
                # clean-up of the tables, and until then has_path() is still
                # True and the shared instance answers our request with the
                # very path being dropped. Here it goes at once; the shared
                # instance cleans up within a second (its job loop runs every
                # 250 ms and the drop asks for a clean-up).
                try:
                    with RNS.Transport.path_table_lock:
                        RNS.Transport.path_table.pop(dest_hash, None)
                except Exception:
                    pass
                time.sleep(1.0)
            self._hops_cache.pop(node_hash, None)

            request_path(dest_hash)      # remembered: its answer is not an announce
            # As long as a slow page is given, never under 45 s: with 16 s
            # the answer came in after we had said "no path", and the page
            # loading alongside got through.
            deadline = start + max(45.0, adaptive_timeout(dest_hash) * 2)
            found = False
            last_rpc = 0.0
            while time.time() < deadline:
                if RNS.Transport.has_path(dest_hash):
                    found = True
                    break
                # The shared instance learns the path first, and traffic goes
                # through it even before the copy reaches this program.
                if time.time() - last_rpc >= 1.0:
                    last_rpc = time.time()
                    if self._shared_has_path(dest_hash):
                        found = True
                        break
                time.sleep(0.2)
            elapsed = time.time() - start
            self._hops_cache.pop(node_hash, None)

            if not found:
                return {"status": "error", "had_path": had_path,
                        "before": before, "elapsed": elapsed,
                        "error": f"No answer in {elapsed:.0f} s"}
            after = self._lookup_node_hops(dest_hash)
            if not isinstance(after.get("hops"), int):
                after = self._shared_path_info(dest_hash) or after
            return {"status": "success", "had_path": had_path,
                    "before": before, "after": after, "elapsed": elapsed}
        except Exception as exc:
            print(f"Path request for {node_hash[:16]} failed: {exc}")
            return {"status": "error", "error": f"Path request failed: {exc}"}

    def check_path(self, node_hash: str) -> Dict[str, Any]:
        """
        The path held to a node right now, from the shared instance's path
        table (or this program's): hops, the next hop, when it was learned
        and when it expires. Reads tables only; nothing is sent.
        """
        not_ready = self._not_connected(message="")
        if not_ready:
            return not_ready
        node_hash = clean_node_hash(node_hash)
        if not node_hash:
            return {"status": "error", "error": "Not an address"}
        dest_hash = bytes.fromhex(node_hash)
        entry = None
        try:
            for row in (self.reticulum.get_path_table() or []) if self.reticulum else []:
                if row.get("hash") == dest_hash:
                    entry = row
                    break
        except Exception as exc:
            print(f"Could not read the path table: {exc}")
        now = time.time()
        if entry is None:
            if not RNS.Transport.has_path(dest_hash):
                return {"status": "success", "known": False}
            info = self._lookup_node_hops(dest_hash)
            return {"status": "success", "known": True, "hops": info.get("hops"),
                    "via": info.get("next_hop_interface", ""), "learned_ago": None, "expires_in": None}
        via_hash = entry.get("via")
        return {
            "status": "success",
            "known": True,
            "hops": entry.get("hops"),
            "via": f"via {interface_label(str(entry.get('interface', '')))}",
            "next_hop": via_hash.hex() if isinstance(via_hash, bytes) else None,
            "learned_ago": max(0, round(now - entry["timestamp"])) if entry.get("timestamp") else None,
            "expires_in": round(entry["expires"] - now) if entry.get("expires") else None,
        }

    def check_lxmf_reachable(self, address: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        Is anyone listening on an operator's LXMF address? The address comes
        from the node's identity and always exists on paper, but only a
        program that registers lxmf.delivery answers on it: NomadNet does,
        page servers such as rns_server_page.py do not. A path held here or
        in the shared instance means it announced; otherwise one path
        request, nothing else is sent. Unlike request_fresh_path, a known
        path is kept. timeout: how long to wait for the answer (the RRC
        Check uses 20 s: what exists answers in a few seconds).
        """
        not_ready = self._not_connected(message="")
        if not_ready:
            return not_ready
        address = clean_node_hash(address)
        if not address:
            return {"status": "error", "error": "Not an LXMF address"}
        try:
            dest_hash = bytes.fromhex(address)
            start = time.time()
            if RNS.Transport.has_path(dest_hash) or self._shared_has_path(dest_hash):
                return {"status": "success", "reachable": True, "known": True,
                        "path": self._shared_path_info(dest_hash) or self._lookup_node_hops(dest_hash),
                        "elapsed": 0.0}
            request_path(dest_hash)      # remembered: its answer is not an announce
            deadline = start + (timeout if timeout else max(30.0, adaptive_timeout(dest_hash)))
            last_rpc = 0.0
            while time.time() < deadline:
                found = RNS.Transport.has_path(dest_hash)
                if not found and time.time() - last_rpc >= 1.0:
                    last_rpc = time.time()
                    found = self._shared_has_path(dest_hash)
                if found:
                    return {"status": "success", "reachable": True, "known": False,
                            "path": self._shared_path_info(dest_hash) or self._lookup_node_hops(dest_hash),
                            "elapsed": time.time() - start}
                time.sleep(0.2)
            return {"status": "success", "reachable": False, "elapsed": time.time() - start}
        except Exception as exc:
            print(f"LXMF check for {address[:16]} failed: {exc}")
            return {"status": "error", "error": f"Path request failed: {exc}"}

    # ------------------------------------------------------------------ #
    # Node names, for favorites added by hash                            #
    # ------------------------------------------------------------------ #

    def known_node_name(self, node_hash: str) -> Optional[str]:
        """
        The name of a NomadNet node from what is already here: the node
        list, then the announces Reticulum remembers. Sends nothing.
        """
        node_hash = clean_node_hash(node_hash)
        if not node_hash:
            return None
        for entry in list(self.nomadnet_nodes.values()):
            if entry.get("hash") == node_hash and entry.get("name"):
                return entry["name"]
        if not self.reticulum_ready:
            return None
        try:
            destination_hash = bytes.fromhex(node_hash)
            identity = rnsquiet.recall(destination_hash)
            if identity is None:
                return None
            # Only a NomadNet node's announce carries its name. The same
            # hash cannot belong to anything else, but check: app_data of
            # some other destination would be read as a name otherwise.
            expected = RNS.Destination.hash_from_name_and_identity("nomadnetwork.node", identity)
            if expected != destination_hash:
                return None
            app_data = rnsquiet.recall_app_data(destination_hash)
            if not app_data:
                return None
            name = self._decode_node_name(app_data, RNS.prettyhexrep(destination_hash))
            if name.startswith(("EmptyNode_", "BinaryNode_", "Node_")) or name == "UNKNOWN":
                return None
            return name.strip() or None
        except Exception as exc:
            print(f"Could not recall the name of {node_hash[:16]}: {exc}")
            return None

    def request_node_name(self, node_hash: str) -> Optional[str]:
        """
        Ask the network for a node's announce with one path request, and read
        the name from the answer. Waits as long as a page request would.
        """
        if not self.reticulum_ready:
            return None
        try:
            node_hash = clean_node_hash(node_hash)
            if not node_hash:
                return None
            destination_hash = bytes.fromhex(node_hash)
            request_path(destination_hash)      # remembered: its answer is not an announce
            # With no path yet the answer has to find its way first: never
            # less than 30 s, more on a slow path.
            deadline = time.time() + max(30.0, adaptive_timeout(destination_hash))
            while time.time() < deadline:
                name = self.known_node_name(node_hash)
                if name:
                    return name
                time.sleep(0.5)
            return self.known_node_name(node_hash)
        except Exception as exc:
            print(f"Name lookup for {node_hash[:16]} failed: {exc}")
            return None


__all__ = ["NomadNetWebBrowser"]
