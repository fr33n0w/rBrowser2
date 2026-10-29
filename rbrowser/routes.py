"""
Flask route registration for rBrowser.

All web endpoints are defined here to keep the entrypoint lightweight. The
routes expect an instance of `NomadNetWebBrowser` to perform the underlying
operations.
"""

from __future__ import annotations

import io
import ipaddress
import json
import mimetypes
import os
import re
from typing import Any, Dict, Optional
import RNS
from . import rnsquiet, vanity
from flask import jsonify, render_template, request, send_file, send_from_directory, Response, abort
import time
import uuid
from urllib.parse import quote, urlsplit
from html import escape as html_escape
import threading

from .nomadnet import CancelToken

# Global storage for download progress
download_progress = {}
download_results = {}
download_cancels = {}

# "Check address aspect type": how long to wait for the path answer (and
# with it the announce). A LoRa path can take a while.
HASH_KIND_WAIT = 30

# settings/ui_prefs.json: read, changed and written by one request at a time.
_UI_PREFS_LOCK = threading.Lock()
_UI_PREFS_PATH = os.path.join("settings", "ui_prefs.json")


def _heard_counts(browser) -> dict:
    """How many of each kind were heard, for the status bar: only the
    clients that are on (one off listens to nothing). live = heard since
    rBrowser started, known = what the client's list holds (also from
    Reticulum's memory, or the saved file for the propagation nodes)."""
    out = {}
    msg = getattr(browser, "messenger", None)
    if msg is not None and msg.settings.get("enabled") and getattr(msg.peers, "_registered", False):
        out["lxmf"] = {"live": len(msg.peers.live), "known": len(msg.peers.peers)}
        out["propagation"] = {"live": len(msg.pn.live), "known": len(msg.pn.nodes)}
    rrc = getattr(browser, "rrc", None)
    if rrc is not None and rrc.settings.get("enabled") and getattr(rrc, "_registered", False):
        out["rrc"] = {"live": len(rrc.live), "known": len(rrc.heard)}
    bbs = getattr(browser, "retibbs", None)
    if bbs is not None and getattr(bbs, "_registered", False) and bbs.listening():
        out["bbs"] = {"live": len(bbs.live), "known": len(bbs.heard)}
    rmap = getattr(browser, "rmap", None)
    nodes = rmap.count() if rmap is not None else None
    if nodes is not None:
        out["rmap"] = nodes
    return out


def _read_ui_prefs() -> dict:
    try:
        with open(_UI_PREFS_PATH, encoding="utf-8") as fh:
            prefs = json.load(fh)
        return prefs if isinstance(prefs, dict) else {}
    except (OSError, ValueError):
        return {}

# /api/usage: this process, kept between calls (cpu_percent measures since
# the call before).
_USAGE_PROC = None
_USAGE_LAST = None        # (wall time, CPU time) of the last reading, without psutil


def _usage_without_psutil():
    """CPU (since the last reading, over all cores, as psutil gives it here)
    and resident memory of this process from os.times() and /proc/self/statm.
    None where /proc is missing (Windows, macOS)."""
    global _USAGE_LAST
    import os as _os
    import threading as _threading
    import time as _time
    try:
        with open("/proc/self/statm") as fh:
            rss = int(fh.read().split()[1]) * _os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return None
    t = _os.times()
    now, cpu_time = _time.monotonic(), t.user + t.system
    cpu = 0.0
    if _USAGE_LAST is not None and now > _USAGE_LAST[0]:
        cpu = 100.0 * (cpu_time - _USAGE_LAST[1]) / (now - _USAGE_LAST[0]) / (_os.cpu_count() or 1)
    _USAGE_LAST = (now, cpu_time)
    return {"pid": _os.getpid(), "cpu": round(max(cpu, 0.0), 1), "rss_mb": round(rss / 1048576, 1),
            "threads": _threading.active_count()}

def register_routes(app, browser) -> None:
    """Attach all routes to the provided Flask application."""

    # --- Access password (rbrowser/auth.py) ------------------------------
    from flask import session, redirect
    from .auth import OPEN_PATHS, LOGIN_PAGE, guest_blocked

    auth = getattr(browser, "auth", None)

    def _safe_next(value: Any) -> str:
        """Only a path of this site: never //other.site or a full URL. Control
        characters are refused too: a browser drops a tab or a newline, so
        "/<tab>/evil.site" would become //evil.site."""
        value = str(value or "/")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            return "/"
        return value if value.startswith("/") and not value.startswith("//") and "\\" not in value else "/"

    def _host_name(value: str) -> str:
        value = (value or "").strip().lower()
        if value.startswith("["):                       # [::1]:5000
            return value[1:value.find("]")] if "]" in value else value
        return value.rsplit(":", 1)[0] if value.count(":") == 1 else value

    def _trusted_host(name: str) -> bool:
        """A name another web site cannot point at this computer (DNS
        rebinding): an IP address, localhost, a .local mDNS name or a bare
        LAN name without dots."""
        try:
            ipaddress.ip_address(name)
            return True
        except ValueError:
            pass
        return (name == "localhost" or name.endswith(".localhost") or name.endswith(".local")
                or (bool(name) and "." not in name))

    def _open_door_refused() -> Optional[Any]:
        """Requests let in without a password (this computer, or the password
        off): only from rBrowser's own page. With the password asked, the
        session cookie (SameSite=Strict) already does this."""
        # Password off and the request from the internet (a port opened on
        # the router, Dynamic DNS): never an open rBrowser on the internet.
        try:
            public = ipaddress.ip_address(request.remote_addr or "").is_global
        except ValueError:
            public = False
        if public and (auth is None or not auth.data["enabled"]):
            return "rBrowser: from the internet only with the access password on (Settings > System Setup)", 403
        # DNS rebinding: evil.site resolving to 127.0.0.1 would be "the same
        # site" as the page and could read everything, keys included.
        if not _trusted_host(_host_name(request.host)):
            return "rBrowser: unknown host name - open rBrowser by its IP address or localhost", 403
        # Another web site making this browser call here (CSRF). Browsers
        # say whether a request comes from another site: only opening a page
        # from a link elsewhere (Telegram, a bookmark) is let through.
        if (request.headers.get("Sec-Fetch-Site") == "cross-site"
                and request.headers.get("Sec-Fetch-Mode") != "navigate"):
            return jsonify({"status": "error", "error": "Refused: request from another site"}), 403
        # And where a write comes from: it must be this very address.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("Origin")
            if origin is not None:
                parts = urlsplit(origin)
                if origin == "null" or (parts.netloc or "").lower() != (request.host or "").lower():
                    return jsonify({"status": "error", "error": "Refused: request from another site"}), 403
        return None

    @app.before_request
    def require_password():
        from .remote import TUNNEL_MARK
        # Through the tunnel (or a proxy) only with the password on: never
        # an open door to the internet, whatever the settings say.
        remote = getattr(browser, "remote", None)
        if request.environ.get(TUNNEL_MARK) and (remote is None or not remote.password_ready()):
            return "rBrowser: remote access needs the access password on", 403
        if auth is None or not auth.required(request.remote_addr):
            return _open_door_refused()
        if request.path in OPEN_PATHS:
            return None
        role = auth.session_role(session)
        if role == "guest":
            why = guest_blocked(request.method, request.path, auth.guest_rights())
            if why:
                return jsonify({"status": "error", "error": why, "guest": True}), 403
            return None
        if role:
            return None
        if request.path.startswith("/api/"):
            return jsonify({"status": "error", "error": "Password needed", "auth": False}), 401
        return redirect(f"/login?next={quote(_safe_next(request.full_path.rstrip('?')))}")

    # Content-Security-Policy on every page: a second line behind the
    # escaping, should something slip into a page (a node name, a chat line).
    # Scripts, styles, fonts and connections only from rBrowser itself, so
    # injected code can neither load more nor send anything out; no plugins,
    # no forms or <base> pointing elsewhere, no framing by other sites.
    # 'unsafe-inline' stays for scripts: the page still has onclick="..."
    # handlers. Images: the RMAP map tiles come from Esri.
    PAGE_CSP = ("default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob: https://server.arcgisonline.com; "
                "media-src 'self' data: blob:; "
                "font-src 'self' data:; "
                "connect-src 'self'; "
                "worker-src 'self' blob:; "
                "object-src 'none'; "
                "base-uri 'self'; "
                "form-action 'self'; "
                "frame-ancestors 'self'")

    @app.after_request
    def security_headers(response):
        if response.mimetype == "text/html":
            response.headers.setdefault("Content-Security-Policy", PAGE_CSP)
            response.headers.setdefault("X-Content-Type-Options", "nosniff")
            # A link out to the web does not tell the site rBrowser's
            # address (the tunnel's included).
            response.headers.setdefault("Referrer-Policy", "same-origin")
        return response

    @app.route("/login", methods=["GET", "POST"])
    def login():
        nxt = _safe_next(request.values.get("next"))
        if auth is None or not auth.required(request.remote_addr) or auth.session_ok(session):
            return redirect(nxt)
        error = ""
        if request.method == "POST":
            address = request.remote_addr or ""
            tag = auth.login(request.form.get("password"), address)
            if tag:
                session.clear()
                session.permanent = True
                session["auth"] = tag
                return redirect(nxt)
            wait = auth.locked(address)
            error = f"Too many wrong passwords: try again in {wait // 60 + 1} min" if wait else "Wrong password"
        page = LOGIN_PAGE.replace("{next}", html_escape(nxt, quote=True)).replace("{error}", html_escape(error))
        response = app.make_response(page)
        response.headers["Cache-Control"] = "no-store"
        return response, (429 if "Too many" in error else 200)

    @app.route("/logout", methods=["GET", "POST"])
    def logout():
        session.clear()
        return redirect("/login")

    def render_index():
        # Who this session is and the page's preferences, written into the
        # page: rbrowser.js reads them before the page builds itself (they
        # were two synchronous requests, deprecated in the browsers). Same
        # fields as GET /api/auth and GET /api/ui-prefs.
        page_auth = {}
        if auth is not None:
            page_auth = {"role": auth.role(session, request.remote_addr),
                         "guest": auth.status(request.remote_addr)["guest"]}
        with _UI_PREFS_LOCK:
            ui_prefs = _read_ui_prefs()
        return render_template("index.html", page_auth=page_auth, ui_prefs=ui_prefs)

    @app.route("/api/auth", methods=["GET", "POST"])
    def api_auth():
        if auth is None:
            return jsonify({"status": "error", "error": "Not available"}), 500
        if request.method == "GET":
            return jsonify({**auth.status(request.remote_addr),
                            "role": auth.role(session, request.remote_addr)})
        res = auth.update(request.get_json(silent=True) or {}, request.remote_addr or "")
        if res.get("status") == "success":
            # Whoever just set it stays in, with the new password's tag.
            session.permanent = True
            session["auth"] = res.pop("tag")
            # Password off: the tunnel goes off with it.
            remote = getattr(browser, "remote", None)
            if remote is not None and not res.get("enabled") and remote.settings.get("tunnel_on"):
                remote.update({"tunnel_on": False})
        return jsonify(res), (200 if res.get("status") == "success" else 400)

    @app.route("/api/remote", methods=["GET", "POST"])
    def api_remote():
        remote = getattr(browser, "remote", None)
        if remote is None:
            return jsonify({"status": "error", "error": "Not available"}), 500
        if request.method == "GET":
            return jsonify(remote.status())
        res = remote.update(request.get_json(silent=True) or {})
        return jsonify(res), (200 if res.get("status") == "success" else 400)

    @app.route("/")
    def index():
        response = app.make_response(render_index())
        # The app shell must never be cached. It carries no cache headers of
        # its own, so a browser is free to apply heuristic caching and keep
        # serving the previous version's page after an update - which looks
        # exactly like the update not having been applied, including buttons
        # for features that no longer exist. Versioned assets below can be
        # cached; this file cannot.
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    @app.route("/style.css")
    def serve_css():
        # Revalidated on every load, as the scripts: a changed stylesheet is
        # picked up by a plain reload (an unchanged one comes back as a 304).
        response = send_from_directory("templates", "style.css", mimetype="text/css")
        response.headers["Cache-Control"] = "no-cache"
        return response

    # One shared snapshot of the node list. The UI polls every two seconds and
    # several tabs poll independently; without this, each poll rebuilt the
    # whole list and re-walked the path table for every node.
    _nodes_snapshot = {"at": 0.0, "rev": -1, "payload": None}
    _NODES_SNAPSHOT_TTL = 1.5

    @app.route("/api/nodes")
    def api_nodes():
        now = time.time()
        rev = getattr(browser, "nodes_revision", 0)
        snap = _nodes_snapshot

        fresh = (snap["payload"] is not None
                 and snap["rev"] == rev
                 and now - snap["at"] < _NODES_SNAPSHOT_TTL)

        if not fresh:
            nodes = [n for n in browser.get_nodes()
                     if not browser.hidden_nodes.is_hidden(n["hash"])]
            for node in nodes:
                path_info = browser.get_node_path_info(node["hash"])
                node["hops"] = path_info["hops"]
                node["next_hop_interface"] = path_info["next_hop_interface"]
                node["interface"] = path_info.get("interface", "")
                node["visits"] = browser.visits.count(node["hash"])
            snap["payload"] = nodes
            snap["rev"] = rev
            snap["at"] = now

        response = jsonify(snap["payload"])
        # An ETag lets an unchanged poll come back as a bodiless 304 instead of
        # re-sending the entire list. fetch() handles the revalidation itself,
        # so the page code does not change at all.
        response.add_etag()
        return response.make_conditional(request)

    @app.route("/api/status")
    def api_status():
        from . import links
        # The page says who it is, so a nomadnetwork:// link clicked on
        # this computer opens in it (links.LinkInbox).
        open_links = links.inbox.seen(request.args.get("page", ""), request.remote_addr or "",
                                      request.args.get("visible") == "1",
                                      request.args.get("focused") == "1")
        return jsonify(
            {
                "running": browser.running,
                # Every kind, not only NomadNet's (announce_count, the list's own).
                "total_announces": browser.announces.count,
                "unique_nodes": len(browser.nomadnet_nodes),
                "identity_hash": RNS.prettyhexrep(browser.identity.hash)
                if browser.identity
                else None,
                # Changes on every start: lets the page tell a restarted
                # rBrowser from the old one still answering on the same port.
                "instance": browser.start_time,
                # Changes when the server names a favorite on its own, so
                # the page knows to reload the list.
                "favorites_revision": browser.favorites.revision,
                "open_links": open_links,
                "heard": _heard_counts(browser),
                # rbrowser/rnswatch.py: Reticulum's interfaces to the network, up / all.
                "interfaces": {k: v for k, v in browser.rnswatch.status().items() if k != "rns_offline_for"},
            }
        )

    @app.route("/api/open-link", methods=["POST"])
    def api_open_link():
        """rBrowser.py --open hands a clicked link to the page already open
        here. Only from this computer: nobody on the LAN pushes pages."""
        from . import links
        if request.remote_addr not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            abort(403)
        url = str((request.get_json(silent=True) or {}).get("url") or "").strip()
        if not url or len(url) > 2048:
            return jsonify({"delivered": False, "error": "no url"}), 400
        return jsonify({"delivered": links.inbox.deliver(url)})

    @app.route("/api/fetch/<node_hash>", methods=["GET", "POST"])
    def api_fetch_page(node_hash):
        page_path = request.args.get("path", "/page/index.mu")
        form_data = request.get_json() if request.method == "POST" else None
        # Reload always goes to the node. Anything the user submitted goes to
        # the node too: the answer to a form depends on what was sent, so a
        # stored copy of the same path would be the wrong page.
        force_fresh = request.args.get("fresh") in ("1", "true", "yes")
        # A page fetched while identified is that account's page ("logged in
        # as ..."), and with several identities a stored copy would show one
        # account's page to another. Those pages stay out of the cache both
        # ways: never stored, never served from it.
        identified = browser.is_identified_to(node_hash)
        cacheable = not form_data and page_path.startswith("/page/") and not identified
        # A node auto-identify will identify to: its stored page is the
        # anonymous one, about to be replaced. Going to the node instead
        # opens the link the identify then goes over. The page is still
        # stored, for when the node is unreachable.
        auto_target = browser.auto_identifies_to(node_hash)
        cache = browser.page_cache

        print(f"🌐 API Request: Fetching {page_path} from {node_hash[:16]}...")
        if form_data:
            # Field names only: the values can be a login's password.
            print(f"📝 Form fields: {', '.join(str(k) for k in form_data) if isinstance(form_data, dict) else '?'}")

        # A page shown in a tab is a visit, wherever it came from. Partials
        # and auto-reloads are not (the page sends partial=1 / visit=0).
        def count_visit():
            visits = getattr(browser, "visits", None)
            if visits and request.args.get("partial") != "1" \
                    and request.args.get("visit") != "0":
                visits.record(node_hash)
                # The same pages make the history (rbrowser/history.py).
                history = getattr(browser, "history", None)
                if history:
                    history.record(node_hash, page_path, browser.node_name_for(node_hash))

        caching_on = cache.settings.get("enabled", True)
        serving_on = caching_on and cache.settings.get("serve_from_cache", True)
        prior = cache.fetch(node_hash, page_path) if cacheable and caching_on else None

        # Why a page went to the node, for the status pill's tooltip.
        if not cacheable:
            live_reason = ("identified" if identified else
                           "form" if form_data else "not-a-page")
        elif not caching_on:
            live_reason = "cache-off"
        elif force_fresh:
            live_reason = "reload"
        elif not prior:
            live_reason = "not-saved"
        elif not serving_on:
            live_reason = "serving-off"
        elif auto_target:
            live_reason = "auto-identify"
        elif not prior.get("cache_time"):
            live_reason = "no-cache-header"
        elif not prior.get("fresh"):
            live_reason = "expired"
        else:
            live_reason = ""

        if cacheable and not force_fresh and not auto_target and serving_on:
            stored = prior
            # Only while the page allows it (#!c=, 12 h by default, never
            # for #!c=0). A dynamic page served from disk showed old numbers
            # next to live ones and made browsing such a node confusing.
            if stored and stored.get("fresh"):
                print(f"💾 Served {page_path} from the local cache")
                count_visit()
                return jsonify({
                    "status": "success",
                    "content": stored["content"],
                    "source": "cache",
                    "cached_at": stored.get("cached_at"),
                    "age_seconds": stored.get("age_seconds"),
                    "cache_time": stored.get("cache_time"),
                    "node_hash": node_hash,
                    "node_name": browser.node_name_for(node_hash),
                    "page_path": page_path,
                    # Only pages of links we are not identified on are cacheable.
                    "identified": False,
                })

        response = browser.fetch_page(node_hash, page_path, form_data)

        if response["status"] == "success":
            content_length = len(response.get("content", ""))
            print(f"✅ API Response: Successfully fetched {content_length} characters")
            response["source"] = "network"
            response["identified"] = identified
            count_visit()
            response["live_reason"] = live_reason
            response["cache_serving"] = serving_on
            response["cache_time"] = cache.page_cache_time(response.get("content", ""))
            if prior:
                response["previous_age_seconds"] = prior.get("age_seconds")
            if cacheable and caching_on:
                if cache.store(node_hash, page_path, response.get("content", ""),
                               browser.node_name_for(node_hash),
                               browser.operator_for(node_hash),
                               partial=request.args.get("partial") == "1"):
                    response["cached"] = True
                    cache.prune()
        else:
            print(f"❌ NomadNet page {node_hash[:16]}:{page_path} failed - {response.get('error', 'Unknown error')}")
            # The node is unreachable but we may have read this page before.
            # NomadNet does the same: an old copy beats a blank screen, as
            # long as it is labelled as old.
            if cacheable and caching_on:
                stored = prior
                if stored:
                    print(f"💾 Node unreachable, falling back to the cached copy of {page_path}")
                    count_visit()
                    return jsonify({
                        "status": "success",
                        "content": stored["content"],
                        "source": "cache-fallback",
                        "cached_at": stored.get("cached_at"),
                        "age_seconds": stored.get("age_seconds"),
                        "cache_time": stored.get("cache_time"),
                        "fetch_error": response.get("error", "Node unreachable"),
                        "node_hash": node_hash,
                        "node_name": browser.node_name_for(node_hash),
                        "page_path": page_path,
                    })

        # The title needs a name even for a node that has not announced
        # since startup; the cache remembers it.
        response.setdefault("node_name", browser.node_name_for(node_hash))
        return jsonify(response)

    # Inline images in Micron pages. The page asks for these only after the
    # user has opened it - there is no prefetching and no crawling here, the
    # browser fetches an image because a page you are looking at referenced it.
    _media_cache: Dict[str, Any] = {}
    _MEDIA_CACHE_MAX = 32

    @app.route("/api/media/<node_hash>")
    def api_fetch_media(node_hash):
        media_path = request.args.get("path", "")
        if not media_path:
            return jsonify({"error": "Missing path"}), 400

        key = f"{node_hash}:{media_path}"
        hit = _media_cache.get(key)
        if hit is None:
            result = browser.fetch_media(node_hash, media_path)
            if result["status"] != "success":
                print(f"❌ Media fetch failed: {result.get('error')}")
                return jsonify({"error": result.get("error", "Media fetch failed")}), 502

            hit = (result["content"], result.get("filename") or "image")
            # Small bounded cache so re-rendering a page, going back to it, or
            # opening it in another tab does not re-fetch the same bytes over
            # the radio. Dropped on restart, never written to disk.
            if len(_media_cache) >= _MEDIA_CACHE_MAX:
                _media_cache.pop(next(iter(_media_cache)))
            _media_cache[key] = hit

        content, filename = hit
        # The type comes from the path asked for (fetch_media accepts only
        # image extensions), never from the name the node answers with: a
        # node calling its file x.html would get a page of ours run.
        mimetype = _media_mimetype(media_path)
        if not mimetype.startswith("image/"):
            mimetype = "application/octet-stream"
        response = Response(content, mimetype=mimetype)
        response.headers["Cache-Control"] = "private, max-age=3600"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return response

    # ---------------------------------------------------------------- #
    # Visited page cache                                               #
    #                                                                  #
    # This is the search engine of version 2.0, and the difference from #
    # the crawler it replaces is the whole point: nothing below ever    #
    # requests a page. It can only find what you yourself have opened.  #
    # ---------------------------------------------------------------- #

    @app.route("/api/cache/stats")
    def api_cache_stats():
        return jsonify(browser.page_cache.stats())

    @app.route("/api/cache/settings", methods=["GET", "POST"])
    def api_cache_settings():
        if request.method == "POST":
            incoming = request.get_json(silent=True) or {}
            return jsonify(browser.page_cache.save_settings(incoming))
        return jsonify(dict(browser.page_cache.settings))

    @app.route("/api/cache/search")
    def api_cache_search():
        query = request.args.get("q", "")
        exact = request.args.get("exact") in ("1", "true", "yes")
        # limit: how many (0 = all; missing = the setting); span: snippet length.
        try:
            limit = int(request.args["limit"]) if "limit" in request.args else None
            span = int(request.args.get("span", 120))
        except ValueError:
            limit, span = None, 120
        results = browser.page_cache.search(query, exact_words=exact, limit=limit, span=span)
        return jsonify({"status": "success", "query": query, "count": len(results),
                        "total": getattr(browser.page_cache, "last_total", len(results)),
                        "results": results})

    @app.route("/api/cache/pages")
    def api_cache_pages():
        """Everything in the cache, newest first - the browsing history."""
        results = browser.page_cache.list_pages()
        total = len(results)
        try:
            limit = int(request.args.get("limit", 0))
        except ValueError:
            limit = 0
        if limit > 0:
            results = results[:limit]
        return jsonify({"status": "success", "count": len(results), "total": total,
                        "results": results})

    @app.route("/api/cache/summary")
    def api_cache_summary():
        """Saved pages per node, for the dots in the node list."""
        cache = browser.page_cache
        return jsonify({
            "status": "success",
            "nodes": cache.summary(),
            "serving": cache.settings.get("enabled", True)
                       and cache.settings.get("serve_from_cache", True),
        })

    @app.route("/api/cache/node/<node_hash>")
    def api_cache_node(node_hash):
        """What the cache holds for one node, for the node info panel."""
        cache = browser.page_cache
        pages = cache.node_pages(node_hash)
        return jsonify({
            "status": "success",
            "pages": pages,
            "count": len(pages),
            "bytes": sum(p.get("size", 0) for p in pages),
            "enabled": cache.settings.get("enabled", True),
            "serving": cache.settings.get("enabled", True)
                       and cache.settings.get("serve_from_cache", True),
            "identified": browser.is_identified_to(node_hash),
        })

    @app.route("/api/cache/clear", methods=["POST"])
    def api_cache_clear():
        payload = request.get_json(silent=True) or {}
        node_hash = payload.get("node_hash")
        removed = browser.page_cache.forget(node_hash)
        return jsonify({"status": "success", "removed": removed,
                        "scope": node_hash or "all"})

    # ---------------------------------------------------------------- #
    # Identity profiles - see rbrowser/identities.py                    #
    #                                                                  #
    # Every change here takes effect at once, without a restart.       #
    # ---------------------------------------------------------------- #

    def _identity_action(action):
        """Run a change and answer with the new state, or the reason not."""
        try:
            extra = action() or {}
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400
        except Exception as exc:
            print(f"❌ Identity action failed: {exc}")
            return jsonify({"status": "error", "error": str(exc)}), 500
        snap = browser.identities_snapshot()
        snap.update(extra)
        return jsonify(snap)

    @app.route("/api/identities")
    def api_identities():
        return jsonify(browser.identities_snapshot())

    @app.route("/api/identities/active", methods=["POST"])
    def api_identities_active():
        payload = request.get_json(silent=True) or {}
        return _identity_action(lambda: browser.switch_identity(str(payload.get("id", ""))))

    @app.route("/api/identities/create", methods=["POST"])
    def api_identities_create():
        payload = request.get_json(silent=True) or {}

        def create():
            profile = browser.identities.create_profile(payload.get("name"))
            if payload.get("activate"):
                browser.switch_identity(profile["id"])
            return {"created": profile["id"]}
        return _identity_action(create)

    @app.route("/api/identities/import", methods=["POST"])
    def api_identities_import():
        upload = request.files.get("file")
        if upload is None:
            return jsonify({"status": "error", "error": "No file received"}), 400
        # An RNS identity file is 64 bytes. Read a little more than that so an
        # oversized file is recognised as the wrong thing instead of truncated.
        key_bytes = upload.read(4096)
        name = request.form.get("name") or os.path.splitext(upload.filename or "")[0]
        return _identity_action(
            lambda: {"created": browser.identities.import_profile(key_bytes, name)["id"]})

    @app.route("/api/identities/<profile_id>/rename", methods=["POST"])
    def api_identities_rename(profile_id):
        payload = request.get_json(silent=True) or {}
        return _identity_action(lambda: browser.identities.rename(profile_id, payload.get("name")))

    @app.route("/api/identities/<profile_id>/delete", methods=["POST"])
    def api_identities_delete(profile_id):
        return _identity_action(lambda: browser.identities.delete(profile_id))

    @app.route("/api/identities/export-all")
    def api_identities_export_all():
        """
        Every saved identity in one zip, for a backup: one key file per
        identity (the same file Export gives, importable one by one) and
        identities.txt with each file's name, LXMF address and identity hash.
        """
        import zipfile
        snapshot = browser.identities.snapshot()
        buffer = io.BytesIO()
        lines = []
        used = set()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for profile in snapshot["profiles"]:
                path = browser.identities.profile_file(profile["id"])
                if not path or not os.path.exists(path):
                    continue
                safe = re.sub(r"[^A-Za-z0-9_-]+", "_", profile["name"]) or profile["id"]
                entry = f"rbrowser_identity_{safe}"
                if entry in used:
                    entry += f"_{profile['id']}"
                used.add(entry)
                archive.write(path, entry)
                lines.append(f"{entry}\n  name:          {profile['name']}\n"
                             f"  LXMF address:  {profile['lxmf_address']}\n"
                             f"  identity hash: {profile['identity_hash']}\n")
            archive.writestr("identities.txt",
                             "rBrowser identities. Each file is a private key: keep it safe.\n\n"
                             + "\n".join(lines))
        if not lines:
            return jsonify({"error": "No identity file to export"}), 404
        buffer.seek(0)
        response = send_file(buffer, mimetype="application/zip", as_attachment=True,
                             download_name=f"rbrowser_identities_{time.strftime('%Y%m%d')}.zip")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/identities/<profile_id>/export")
    def api_identities_export(profile_id):
        path = browser.identities.profile_file(profile_id)
        if not path or not os.path.exists(path):
            return jsonify({"error": "No identity file to export"}), 404
        safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", browser.identities.name_of(profile_id)) or profile_id
        response = send_file(os.path.abspath(path), mimetype="application/octet-stream",
                             as_attachment=True, download_name=f"rbrowser_identity_{safe_name}")
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/identities/ephemeral/toggle", methods=["POST"])
    def api_identities_ephemeral_toggle():
        """
        The ephemeral switch. On: use the throwaway identity instead of the
        saved ones. Off: back to the saved identity that was in use before.
        """
        payload = request.get_json(silent=True) or {}

        def toggle():
            if payload.get("on"):
                browser.switch_identity("ephemeral")
            else:
                browser.switch_identity(browser.identities.fixed_to_return_to())
        return _identity_action(toggle)

    @app.route("/api/identities/ephemeral/rotate", methods=["POST"])
    def api_identities_rotate():
        return _identity_action(lambda: {"dropped": browser.rotate_ephemeral()})

    @app.route("/api/identities/ephemeral/keep", methods=["POST"])
    def api_identities_keep():
        payload = request.get_json(silent=True) or {}
        return _identity_action(lambda: {"created": browser.keep_ephemeral(payload.get("name"))["id"]})

    @app.route("/api/identities/options", methods=["POST"])
    def api_identities_options():
        payload = request.get_json(silent=True) or {}
        auto = payload.get("auto_identify")
        return _identity_action(lambda: browser.identities.set_options(
            auto_identify=None if auto is None else bool(auto),
            ephemeral_mode=payload.get("ephemeral_mode"),
            ephemeral_interval=payload.get("ephemeral_interval")))

    @app.route("/api/identities/bindings", methods=["POST"])
    def api_identities_bindings():
        payload = request.get_json(silent=True) or {}
        return _identity_action(lambda: browser.identities.set_binding(
            payload.get("node"), payload.get("profile_id")))

    @app.route("/api/identities/migrate", methods=["POST"])
    def api_identities_migrate():
        """One-off: the auto-identify list the page kept in localStorage."""
        payload = request.get_json(silent=True) or {}
        auto = payload.get("auto_identify")
        return _identity_action(lambda: {"migrated": browser.identities.migrate_nodes(
            payload.get("nodes"), None if auto is None else bool(auto))})

    # Vanity address: an identity whose LXMF address starts with chosen
    # characters - see rbrowser/vanity.py. The key found never comes here:
    # only its address, until Save makes it an identity on disk.

    def _vanity_action(action):
        try:
            action()
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400
        except Exception as exc:
            print(f"❌ Vanity search: {exc}")
            return jsonify({"status": "error", "error": str(exc)}), 500
        return jsonify(dict(vanity.search.snapshot(), status="success"))

    @app.route("/api/vanity")
    def api_vanity():
        return jsonify(dict(vanity.search.snapshot(), status="success"))

    @app.route("/api/vanity/estimate", methods=["POST"])
    def api_vanity_estimate():
        payload = request.get_json(silent=True) or {}
        try:
            return jsonify(dict(vanity.search.estimate(payload.get("prefix")), status="success"))
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.route("/api/vanity/start", methods=["POST"])
    def api_vanity_start():
        payload = request.get_json(silent=True) or {}
        return _vanity_action(lambda: vanity.search.start(payload.get("prefix"), payload.get("kind"),
                                                          payload.get("position")))

    @app.route("/api/vanity/stop", methods=["POST"])
    def api_vanity_stop():
        return _vanity_action(vanity.search.stop)

    @app.route("/api/vanity/export")
    def api_vanity_export():
        """The key found as a file, the same file Settings > Export gives,
        without saving it here: for an identity meant for another rBrowser
        (or NomadNet, MeshChat, Sideband). The result stays in the dialog."""
        try:
            key = vanity.search.take_key()
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 404
        tag = ("id_" if vanity.search.kind == "identity" else "") + ("end_" if vanity.search.position == "end" else "")
        return send_file(io.BytesIO(key), mimetype="application/octet-stream", as_attachment=True,
                         download_name=f"rbrowser_identity_vanity_{tag}{vanity.search.prefix}")

    @app.route("/api/vanity/save", methods=["POST"])
    def api_vanity_save():
        payload = request.get_json(silent=True) or {}

        def save():
            key = vanity.search.take_key()
            profile = browser.identities.import_profile(
                key, payload.get("name") or (f"Vanity {'ID ' if vanity.search.kind == 'identity' else ''}"
                                             f"{'…' if vanity.search.position == 'end' else ''}{vanity.search.prefix}"))
            vanity.search.discard()
            if payload.get("activate"):
                browser.switch_identity(profile["id"])
            return {"created": profile["id"]}
        return _identity_action(save)

    # ---------------------------------------------------------------- #
    # Server options (the command line ones) and restart               #
    # ---------------------------------------------------------------- #

    def _server_settings():
        return getattr(browser, "server_settings", None)

    @app.route("/api/server-settings", methods=["GET", "POST"])
    def api_server_settings():
        settings = _server_settings()
        if settings is None:
            return jsonify({"status": "error", "error": "Server settings unavailable"}), 500
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            try:
                return jsonify(settings.save(payload.get("host"), payload.get("port"),
                                             payload.get("local_name")))
            except ValueError as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400
        return jsonify(settings.describe())

    @app.route("/api/node-list-settings", methods=["GET", "POST"])
    def api_node_list_settings():
        """Settings > NomadNet Browser > Node list: start with recent known announces
        (node_prefill.py). Turned on, the list is filled at once too."""
        from . import node_prefill
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            before = node_prefill.load()
            try:
                settings = node_prefill.save(payload)
            except ValueError as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400
            added = 0
            if settings["prefill"] and settings != before and browser.running:
                added = node_prefill.prefill(browser)
            return jsonify({"status": "success", "settings": settings, "added": added,
                            "choices": list(node_prefill.HOUR_CHOICES)})
        return jsonify({"status": "success", "settings": node_prefill.load(),
                        "choices": list(node_prefill.HOUR_CHOICES)})

    @app.route("/api/node-sort", methods=["GET", "POST"])
    def api_node_sort():
        """The order the node list is sorted by, kept in settings/node_list.json
        so every start (and every address rBrowser is opened from) gets it."""
        from . import node_prefill
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            try:
                settings = node_prefill.save({"sort": payload.get("sort")})
            except ValueError as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400
            return jsonify({"status": "success", "sort": settings["sort"]})
        # null until chosen once: the page then keeps the order it had in
        # localStorage (the old place) and writes it here.
        return jsonify({"status": "success",
                        "sort": node_prefill.load()["sort"] if node_prefill.sort_saved() else None})

    @app.route("/api/links", methods=["GET", "POST"])
    def api_links():
        """nomadnetwork:// and rbrowser:// links opening in rBrowser (links.py).
        Registered on the computer rBrowser runs on; applies at once."""
        from . import links
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            try:
                return jsonify(links.register() if payload.get("enabled") else links.unregister())
            except Exception as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400
        return jsonify(links.status())

    @app.route("/api/netwatch", methods=["GET", "POST"])
    def api_netwatch():
        """Settings > System Setup > Internet check (rbrowser/netwatch.py)."""
        watch = getattr(browser, "netwatch", None)
        if watch is None:
            return jsonify({"status": "error", "error": "Not available"}), 500
        if request.method == "POST":
            res = watch.update(request.get_json(silent=True) or {})
            return jsonify(res), (200 if res.get("status") == "success" else 400)
        return jsonify({"status": "success", **watch.settings(), **watch.status()})

    @app.route("/api/netwatch/test", methods=["POST"])
    def api_netwatch_test():
        """The Test button: are the servers in the box answering? (Not for
        guests: like every write, auth.guest_blocked.)"""
        from .netwatch import test_servers
        incoming = request.get_json(silent=True) or {}
        res = test_servers(str(incoming.get("method") or ""), incoming.get("servers"))
        return jsonify(res), (200 if res.get("status") == "success" else 400)

    @app.route("/api/console-settings", methods=["GET", "POST"])
    def api_console_settings():
        """Terminal log: which categories of line are shown (console_log.py).
        Applies at once."""
        from .console_log import console, PRESETS
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            categories = payload.get("categories")
            if categories is None and payload.get("terminal_log") in PRESETS:
                categories = PRESETS[payload["terminal_log"]]
            try:
                return jsonify(console.save(categories))
            except ValueError as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400
        return jsonify(console.describe())

    @app.route("/api/usage")
    def api_usage():
        """CPU and memory of this rBrowser's Python process (psutil, if it
        is installed): the badge in the status bar and Settings > About."""
        try:
            import psutil
        except ImportError:
            # Linux and Android (Termux) without psutil: the process's own
            # CPU time and /proc/self, readable there even where the
            # system-wide figures are not.
            usage = _usage_without_psutil()
            if usage is None:
                return jsonify({"status": "error", "error": "psutil is not installed (pip install psutil)"})
            return jsonify({"status": "success", **usage})
        global _USAGE_PROC
        if _USAGE_PROC is None:
            _USAGE_PROC = psutil.Process()
            _USAGE_PROC.cpu_percent(None)        # the first reading is always 0
        p = _USAGE_PROC
        with p.oneshot():
            mem = p.memory_info().rss
            cpu = p.cpu_percent(None) / (psutil.cpu_count() or 1)
            threads = p.num_threads()
        return jsonify({"status": "success", "pid": p.pid, "cpu": round(cpu, 1),
                        "rss_mb": round(mem / 1048576, 1), "threads": threads})

    @app.route("/api/ui-prefs", methods=["GET", "POST"])
    def api_ui_prefs():
        """The page's preferences (rbrowser_* keys the browser kept in
        localStorage: zoom defaults, notifications, image policy, sort...)
        in settings/ui_prefs.json, so every browser, port and phone of this
        rBrowser sees the same ones. POST
        merges {key: value}; a null value removes the key."""
        from .fileio import atomic_write_json
        with _UI_PREFS_LOCK:
            prefs = _read_ui_prefs()
            if request.method == "POST":
                payload = request.get_json(silent=True)
                if not isinstance(payload, dict):
                    return jsonify({"status": "error", "error": "Bad payload"}), 400
                for key, value in list(payload.items())[:64]:
                    key = str(key)
                    if not key.startswith("rbrowser_") or len(key) > 80:
                        continue
                    if value is None:
                        prefs.pop(key, None)
                    elif len(prefs) < 200 or key in prefs:
                        prefs[key] = str(value)[:4000]
                atomic_write_json(_UI_PREFS_PATH, prefs, indent=1)
        return jsonify({"status": "success", "prefs": prefs})

    @app.route("/api/sounds", methods=["GET", "POST"])
    def api_sounds():
        """Settings > System Setup > Sounds, kept in settings/sounds.json so every
        port and address of this rBrowser sees the same choice (localStorage
        is per origin: :5000 and :5099 did not share it)."""
        import json as _json
        import os as _os
        path = _os.path.join("settings", "sounds.json")
        if request.method == "POST":
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict):
                return jsonify({"status": "error", "error": "Bad payload"}), 400
            kinds = payload.get("kinds") if isinstance(payload.get("kinds"), dict) else {}
            try:
                volume = min(1.0, max(0.05, float(payload.get("volume", 0.5))))
            except (TypeError, ValueError):
                volume = 0.5
            data = {"on": bool(payload.get("on", True)), "volume": volume,
                    "kinds": {str(k)[:32]: bool(v) for k, v in list(kinds.items())[:32]}}
            _os.makedirs("settings", exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                _json.dump(data, fh, indent=2)
            _os.replace(tmp, path)
            return jsonify({"status": "success", "sounds": data})
        try:
            with open(path, encoding="utf-8") as fh:
                return jsonify({"status": "success", "sounds": _json.load(fh)})
        except (OSError, ValueError):
            return jsonify({"status": "success", "sounds": None})

    @app.route("/api/restart", methods=["POST"])
    def api_restart():
        """
        Restart rBrowser with the saved host and port. The page asked the
        user first; this only answers once and then the process goes away.
        """
        from .server_settings import schedule_restart
        settings = _server_settings()
        if settings is None:
            return jsonify({"status": "error", "error": "Server settings unavailable"}), 500
        if not settings.can_restart():
            return jsonify({"status": "error",
                            "error": "rBrowser was not started with rBrowser.py (Docker or "
                                     "waitress-serve): restart it from there."}), 409
        host, port = settings.saved["host"], settings.saved["port"]
        # The new process reads host/port from the file. With nothing ever
        # saved, "saved" is just what is running (possibly typed on the
        # command line), so write it down first or the restart would fall
        # back to the defaults.
        if not settings.has_file:
            settings.save(host, port)
        print(f"🔄 Restart requested from the page -> {host}:{port}")
        # The restart ends this process with os._exit: say goodbye to the
        # RRC hubs first, or they keep a dead session of ours for minutes.
        try:
            browser.rrc.close_all()
        except Exception:
            pass
        schedule_restart(host, port)
        return jsonify({"status": "success", "host": host, "port": port,
                        "instance": browser.start_time})

    @app.route("/api/shutdown", methods=["POST"])
    def api_shutdown():
        """Stop rBrowser (Settings > Shut down, asked first). Refused where
        whoever launched it would start it again anyway (Docker restarts
        the container): it is stopped from there."""
        from .server_settings import schedule_shutdown
        settings = _server_settings()
        if settings is None or not settings.can_restart():
            return jsonify({"status": "error",
                            "error": "rBrowser was not started with rBrowser.py (Docker or "
                                     "waitress-serve): stop it from there."}), 409
        print("⏻ Shutdown requested from the page")
        try:
            browser.rrc.close_all()
        except Exception:
            pass
        schedule_shutdown()
        return jsonify({"status": "success"})

    @app.route("/api/link-quality/<node_hash>")
    def api_link_quality(node_hash):
        """Is this link fast enough to pull images without asking first?"""
        return jsonify(browser.link_quality(node_hash))

    # The front-end script, lifted out of index.html so the browser caches it
    # instead of re-parsing 150+ KB of inline code on every load. Served with
    # a revalidating cache header: the page picks up changes on a reload, but
    # unchanged bytes come back as a 304 rather than a full transfer.
    @app.route("/script/rbrowser.js")
    def serve_rbrowser_js():
        script_path = os.path.join("script", "rbrowser.js")
        if not os.path.exists(script_path):
            print(f"❌ Front-end script not found at: {script_path}")
            return "console.error('rbrowser.js not found');", 404
        response = send_from_directory("script", "rbrowser.js",
                                       mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.route("/script/messenger.js")
    def serve_messenger_js():
        response = send_from_directory("script", "messenger.js", mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.route("/script/tooltips.js")
    def serve_tooltips_js():
        response = send_from_directory("script", "tooltips.js", mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.route("/script/purify.min.js")
    def serve_purify():
        script_path = os.path.join("script", "purify.min.js")
        if os.path.exists(script_path):
            print(f"✅ Serving DOMPurify from: {script_path}")
            return send_from_directory("script", "purify.min.js", mimetype="application/javascript")
        print(f"❌ DOMPurify not found at: {script_path}")
        return "console.error('DOMPurify file not found');", 404

    # html2canvas 1.4.1 (MIT), for the page screenshot. Kept here rather than
    # loaded from a CDN: rBrowser has to work on a mesh with no internet.
    # The page fetches it only when a screenshot is first taken.
    @app.route("/script/html2canvas.min.js")
    def serve_html2canvas():
        if os.path.exists(os.path.join("script", "html2canvas.min.js")):
            return send_from_directory("script", "html2canvas.min.js",
                                       mimetype="application/javascript")
        return "console.error('html2canvas not found');", 404

    @app.route("/script/micron-parser_original.js")
    def serve_micron_parser():
        script_path = os.path.join("script", "micron-parser_original.js")
        if os.path.exists(script_path):
            print(f"✅ Serving micron parser from: {script_path}")
            return send_from_directory("script", "micron-parser_original.js", mimetype="application/javascript")
        print(f"❌ Micron parser not found at: {script_path}")
        return "console.error('Micron parser file not found');", 404

    @app.route("/api/download/<node_hash>/start")
    def api_start_download(node_hash):
        """Start a download and return a download ID."""
        file_path = request.args.get("path", "/file/")
        if not file_path.startswith("/file/"):
            return jsonify({"error": "Invalid file path"}), 400
        
        # Generate unique download ID
        download_id = str(uuid.uuid4())
        download_progress[download_id] = {"progress": 0, "status": "starting"}
        token = CancelToken()
        download_cancels[download_id] = token

        def do_download():
            def progress_callback(progress):
                if token.cancelled:
                    return
                download_progress[download_id] = {
                    "progress": progress * 100,
                    "status": "downloading"
                }

            try:
                response = browser.fetch_file(node_hash, file_path, progress_callback,
                                              cancel_token=token)
            finally:
                download_cancels.pop(download_id, None)

            if token.cancelled:
                # Nobody is waiting for it: keep nothing.
                download_progress.pop(download_id, None)
                download_results.pop(download_id, None)
                return

            if response["status"] == "success":
                download_results[download_id] = {
                    "status": "complete",
                    "content": response["content"],
                    "filename": response.get("filename") or file_path.split("/")[-1] or "download"
                }
                download_progress[download_id] = {"progress": 100, "status": "complete"}
            else:
                download_results[download_id] = {
                    "status": "error",
                    "error": response.get("error", "Unknown error")
                }
                # Carry the reason through to the poller, so the page can say
                # what went wrong instead of a bare "Download failed!".
                download_progress[download_id] = {
                    "progress": 0,
                    "status": "error",
                    "error": response.get("error", "Unknown error"),
                }
        
        # Start download in background thread
        thread = threading.Thread(target=do_download)
        thread.daemon = True
        thread.start()
        
        return jsonify({"download_id": download_id, "status": "started"})

    @app.route("/api/download/cancel/<download_id>", methods=["POST"])
    def api_download_cancel(download_id):
        """
        Closing the download box. Stops a transfer still running and drops a
        finished file nobody will collect - before this the box only hid
        itself and the transfer carried on in the background.
        """
        token = download_cancels.pop(download_id, None)
        if token is not None:
            token.cancel()
        download_progress.pop(download_id, None)
        download_results.pop(download_id, None)
        return jsonify({"status": "cancelled", "was_running": token is not None})

    @app.route("/api/download/progress/<download_id>")
    def api_download_progress(download_id):
        """Get current download progress."""
        progress_data = download_progress.get(download_id, {"progress": 0, "status": "unknown"})
        return jsonify(progress_data)

    @app.route("/api/download/result/<download_id>")
    def api_download_result(download_id):
        """Get the downloaded file once complete."""
        result = download_results.get(download_id)
        
        if not result:
            return jsonify({"error": "Download not found"}), 404
        
        if result["status"] == "error":
            # Clean up here too. Without this, every failed download left its
            # entry in both dictionaries forever - the success path was the
            # only one that cleared them.
            download_progress.pop(download_id, None)
            download_results.pop(download_id, None)
            return jsonify({"error": result.get("error", "Download failed")}), 500

        file_data = result["content"]
        filename = result["filename"]

        # Kept for a few minutes rather than dropped on the first read. On a
        # phone the page hands this URL to the browser's own downloader, and
        # Android's can ask for it a second time; the old delete-on-serve
        # answered that second request with 404 and the save failed at 100%.
        if not result.get("expiry_set"):
            result["expiry_set"] = True

            def _expire():
                download_progress.pop(download_id, None)
                download_results.pop(download_id, None)

            timer = threading.Timer(300, _expire)
            timer.daemon = True
            timer.start()

        if not isinstance(file_data, bytes):
            if isinstance(file_data, str):
                file_data = file_data.encode("latin1")
            else:
                file_data = str(file_data).encode("latin1")

        if not file_data:
            # An empty answer used to be saved as a 0 byte file, which looks
            # like success until the file is opened.
            return jsonify({"error": "The node sent an empty file"}), 502

        print(f"✅ Serving file: {filename} ({len(file_data)} bytes)")

        file_obj = io.BytesIO(file_data)
        response = send_file(
            file_obj,
            mimetype=_media_mimetype(filename),
            as_attachment=True,
            download_name=filename
        )
        # The page saves the blob itself and so cannot read Content-Disposition
        # across the fetch; hand it the name the node reported in a header it
        # can read, otherwise the file is saved under the name guessed from the
        # URL even when the node said it was called something else.
        # Percent-encoded: a header value has to be latin-1, and a node can
        # name its file in Cyrillic or with an emoji. The page decodes it.
        response.headers["X-Download-Filename"] = quote(filename, safe="")
        response.headers["Access-Control-Expose-Headers"] = "X-Download-Filename"
        return response

    @app.route("/favicon.svg")
    def favicon():
        # The icon was in templates/ all along; this used to answer 204, so
        # the browser tab never had one.
        return send_from_directory("templates", "favicon.svg", mimetype="image/svg+xml")

    @app.route("/api/fingerprint/<node_hash>", methods=["POST"])
    def api_send_fingerprint(node_hash):
        print(f"API Request: Sending identity fingerprint to {node_hash[:16]}...")
        response = browser.send_fingerprint(node_hash)
        if response["status"] == "success":
            print("API Response: Identity fingerprint sent successfully")
        else:
            print(f"API Response: Identity fingerprint failed - {response.get('error', 'Unknown error')}")
        return jsonify(response)

    @app.route("/api/connection-status")
    def api_connection_status():
        try:
            status_data = browser.get_cached_status()
        except Exception as exc:
            print(f"Error in connection status: {exc}")
            return jsonify({"status": "connerror", "message": "Status check failed", "color": "red"})

        app_uptime = status_data["app_uptime"]
        has_nodes = status_data["has_nodes"]
        time_since_last_announce = status_data["time_since_last_announce"]
        connection_state = status_data["connection_state"]
        reticulum_ready = status_data["reticulum_ready"]

        # The web server now starts before Reticulum, so "not ready yet" is
        # the normal state for the first seconds. The states are checked
        # first: testing reticulum_ready first used to report every startup
        # as a failure.
        if connection_state == "failed":
            why = status_data.get("reticulum_error") or "unknown error"
            return jsonify({"status": "connerror",
                            "message": "Reticulum failed: " + html_escape(why),
                            "detail": why, "color": "red"})

        if connection_state == "initializing":
            return jsonify({"status": "waiting", "message": "Starting Reticulum...", "color": "yellow"})

        if connection_state == "connecting":
            return jsonify({"status": "waiting", "message": "Connecting to Reticulum...", "color": "yellow"})

        if not reticulum_ready:
            return jsonify({"status": "waiting", "message": "Reticulum not ready...", "color": "yellow"})

        # rbrowser/rnswatch.py: every interface to the network is down (no
        # coverage, no Wi-Fi) while Reticulum itself still answers.
        if status_data.get("rns_ifaces_total") and not status_data.get("rns_ifaces_online"):
            return jsonify({"status": "offline", "color": "red",
                            "message": "Reticulum interface disconnected, reconnecting..."})

        # rbrowser/netwatch.py: Reticulum still says connected while the
        # line is dead, so this comes before its states.
        if status_data.get("internet") == "down":
            return jsonify({"status": "offline", "message": "No internet connection, waiting for reconnect...",
                            "color": "red"})

        if connection_state == "connected":
            if app_uptime < 60:
                return jsonify(
                    {
                        "status": "waiting",
                        "message": "Connected! <span style='color: #FFC107;'>Waiting for announces...</span> ",
                        "color": "green",
                    }
                )
            if app_uptime < 120:
                return jsonify({"status": "waiting", "message": "Waiting for network activity...", "color": "yellow"})
            return jsonify(
                {"status": "waiting", "message": "Connected but no network activity", "color": "yellow"}
            )

        if connection_state == "active":
            if has_nodes:
                if time_since_last_announce and time_since_last_announce > 300:
                    return jsonify(
                        {"status": "waiting", "message": "No recent announces, waiting...", "color": "yellow"}
                    )
                return jsonify({"status": "online", "message": "Online. Reticulum Connected!", "color": "green"})
            return jsonify(
                {"status": "waiting", "message": "Connection active but no nodes found", "color": "yellow"}
            )

        return jsonify(
            {"status": "connerror", "message": f"Unknown connection state: {connection_state}", "color": "red"}
        )

    @app.route("/templates/go.png")
    def serve_go_icon():
        return _serve_template_asset("go.png")

    @app.route("/templates/star.png")
    def serve_star_icon():
        return _serve_template_asset("star.png")

    @app.route("/templates/ping.png")
    def serve_ping_icon():
        return _serve_template_asset("ping.png")

    @app.route("/templates/fingerprint.png")
    def serve_fingerprint_icon():
        return _serve_template_asset("fingerprint.png")
    
    # The bundled page font. Declared before the catch-all below because
    # that one lets mimetypes guess, and a stock Windows Python does not
    # know .ttf - the file came back as application/octet-stream, which
    # some browsers refuse to use as a font.
    @app.route('/templates/fonts/<path:filename>')
    def serve_font(filename):
        ext = os.path.splitext(filename)[1].lower()
        types = {".ttf": "font/ttf", ".otf": "font/otf",
                 ".woff": "font/woff", ".woff2": "font/woff2",
                 ".txt": "text/plain", ".json": "application/json"}
        if ext not in types:
            abort(404)
        response = send_from_directory(os.path.join("templates", "fonts"),
                                       filename, mimetype=types[ext])
        # Immutable: the file only changes when the font itself is replaced.
        response.headers["Cache-Control"] = "public, max-age=31536000"
        return response

    @app.route('/templates/<path:filename>')
    def serve_template_file(filename):
        """Serve static files from templates directory (icons, images, etc.)"""
        return send_from_directory('templates', filename)

    @app.route("/api/ping/<node_hash>", methods=["POST"])
    def api_ping_node(node_hash):
        print(f"API Request: Pinging node {node_hash[:16]}...")
        response = browser.ping_node(node_hash)
        if response["status"] == "success":
            print(f"API Response: Ping successful - RTT: {response.get('rtt', 0):.2f}s")
        else:
            print(f"API Response: Ping failed - {response.get('error', 'Unknown error')}")
        return jsonify(response)
    
    @app.route("/api/hidden-nodes", methods=["GET", "POST"])
    def api_hidden_nodes():
        """GET: the hidden nodes. POST {hash, hidden, name}: hide or restore."""
        if request.method == "POST":
            incoming = request.get_json(silent=True) or {}
            ok = browser.set_node_hidden(incoming.get("hash", ""),
                                         bool(incoming.get("hidden", True)),
                                         incoming.get("name", ""))
            return jsonify({"status": "success" if ok else "error",
                            "hidden": browser.hidden_nodes.listing()})
        return jsonify({"status": "success", "hidden": browser.hidden_nodes.listing()})

    @app.route("/api/path/<node_hash>", methods=["POST"])
    def api_request_path(node_hash):
        print(f"API Request: fresh path to {node_hash[:16]}...")
        response = browser.request_fresh_path(node_hash)
        if response["status"] == "success":
            print(f"API Response: path found in {response.get('elapsed', 0):.1f}s")
        else:
            print(f"API Response: no path - {response.get('error', 'Unknown error')}")
        return jsonify(response)

    # The LXMF messenger - see rbrowser/messenger.py.
    @app.route("/api/messenger", methods=["GET"])
    def messenger_status():
        return jsonify(browser.messenger.status())

    # ── RetiBBS client (rbrowser/retibbs.py) ──────────────────────────
    @app.route("/api/retibbs", methods=["GET"])
    def retibbs_status():
        return jsonify(browser.retibbs.status())

    @app.route("/api/retibbs/servers", methods=["GET"])
    def retibbs_servers():
        return jsonify({"status": "success", **browser.retibbs.servers()})

    @app.route("/api/retibbs/settings", methods=["POST"])
    def retibbs_settings():
        try:
            return jsonify(browser.retibbs.update_settings(request.get_json(silent=True) or {}))
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.route("/api/retibbs/connect/<address>", methods=["POST"])
    def retibbs_connect(address):
        return jsonify(browser.retibbs.connect(address))

    @app.route("/api/retibbs/disconnect/<address>", methods=["POST"])
    def retibbs_disconnect(address):
        return jsonify(browser.retibbs.disconnect(address))

    @app.route("/api/retibbs/close/<address>", methods=["POST"])
    def retibbs_close(address):
        return jsonify(browser.retibbs.close(address))

    @app.route("/api/retibbs/send/<address>", methods=["POST"])
    def retibbs_send(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.retibbs.send(address, incoming.get("text", "")))

    @app.route("/api/retibbs/output/<address>", methods=["GET"])
    def retibbs_output(address):
        return jsonify(browser.retibbs.output(address, request.args.get("since", 0)))

    @app.route("/api/retibbs/favorite/<address>", methods=["POST"])
    def retibbs_favorite(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.retibbs.set_favorite(address, bool(incoming.get("favorite", True))))

    @app.route("/api/retibbs/forget/<address>", methods=["POST"])
    def retibbs_forget(address):
        return jsonify(browser.retibbs.forget(address))

    # --- RRC chat (rbrowser/rrc.py) ---

    @app.route("/api/rrc", methods=["GET"])
    def rrc_status():
        return jsonify(browser.rrc.status())

    @app.route("/api/rrc/hubs", methods=["GET"])
    def rrc_hubs():
        return jsonify({"status": "success", **browser.rrc.hubs()})

    @app.route("/api/rrc/settings", methods=["POST"])
    def rrc_settings():
        try:
            return jsonify(browser.rrc.update_settings(request.get_json(silent=True) or {}))
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.route("/api/rrc/connect/<address>", methods=["POST"])
    def rrc_connect(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.connect(address, incoming.get("room")))

    @app.route("/api/rrc/disconnect/<address>", methods=["POST"])
    def rrc_disconnect(address):
        return jsonify(browser.rrc.disconnect(address))

    @app.route("/api/rrc/close/<address>", methods=["POST"])
    def rrc_close(address):
        return jsonify(browser.rrc.close(address))

    @app.route("/api/rrc/close-all", methods=["POST"])
    def rrc_close_all():
        """Every hub link closed properly, before stopping this process from
        outside (a kill skips the exit handlers). The hubs reconnect by
        themselves if the process stays up."""
        return jsonify({"status": "success", "closed": browser.rrc.close_all()})

    @app.route("/api/version")
    def version_info():
        """Settings > About: this version; with ?check=1 the one on GitHub too
        (?force=1 skips the 10 minute cache)."""
        from . import updates
        if request.args.get("check") == "1":
            out = updates.check(force=request.args.get("force") == "1")
        else:
            out = {"status": "success", "local": updates.local_version(),
                   "repo": updates.REPO_URL, "command": updates.UPDATE_COMMAND}
        return jsonify({**out, "self_update": _self_update_info()})

    def _self_update_info():
        """Can "Update now" run here, and restart afterwards?"""
        from . import selfupdate
        settings = _server_settings()
        return {**selfupdate.availability(),
                "can_restart": bool(settings is not None and settings.can_restart())}

    @app.route("/api/update/start", methods=["POST"])
    def api_update_start():
        """Settings > About > Update now: git pull in the rBrowser folder.
        The page asked first; it restarts rBrowser itself once this is done."""
        from . import selfupdate
        result = selfupdate.start()
        if result.get("status") == "success":
            print("⬇️ Update requested from the page: git pull")
        return jsonify(result), (200 if result.get("status") == "success" else 409)

    @app.route("/api/update/status")
    def api_update_status():
        from . import selfupdate
        return jsonify({"status": "success", **selfupdate.status()})

    @app.route("/api/rrc/identity/<address>", methods=["POST"])
    def rrc_hub_identity(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.set_hub_identity(address, incoming.get("identity", "")))

    @app.route("/api/rrc/hub-settings", methods=["GET"])
    def rrc_hub_settings():
        """Settings > RRC Client > Saved hubs: identity and nick of each hub."""
        return jsonify({"status": "success", "hubs": browser.rrc.hub_settings()})

    @app.route("/api/rrc/hub-nick/<address>", methods=["POST"])
    def rrc_hub_nick(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.set_hub_nick(address, incoming.get("nick", "")))

    @app.route("/api/rrc/hub-forget/<address>", methods=["POST"])
    def rrc_hub_forget(address):
        return jsonify(browser.rrc.forget_hub(address))

    @app.route("/api/rrc/identities", methods=["POST"])
    def rrc_identity_new():
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.create_identity(incoming.get("name", "")))

    @app.route("/api/rrc/identities/<identity_id>", methods=["DELETE"])
    def rrc_identity_delete(identity_id):
        return jsonify(browser.rrc.delete_identity(identity_id))

    @app.route("/api/rrc/input/<address>", methods=["POST"])
    def rrc_input(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.input(address, incoming.get("room"), incoming.get("text", ""),
                                         bool(incoming.get("split"))))

    @app.route("/api/rrc/join/<address>", methods=["POST"])
    def rrc_join(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.join(address, incoming.get("room")))

    @app.route("/api/rrc/part/<address>", methods=["POST"])
    def rrc_part(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.part(address, incoming.get("room")))

    @app.route("/api/rrc/list/<address>", methods=["POST"])
    def rrc_list(address):
        return jsonify(browser.rrc.list_rooms(address))

    @app.route("/api/rrc/read/<address>", methods=["POST"])
    def rrc_read(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.mark_read(address, incoming.get("room")))

    @app.route("/api/rrc/output/<address>", methods=["GET"])
    def rrc_output(address):
        return jsonify(browser.rrc.output(address, request.args.get("since", 0)))

    @app.route("/api/rrc/ignore", methods=["POST"])
    def rrc_ignore():
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.ignore(incoming.get("id"), bool(incoming.get("on", True)), incoming.get("nick", "")))

    @app.route("/api/rrc/peer/<address>/<ident>")
    def rrc_peer(address, ident):
        return jsonify(browser.rrc.peer_info(address, ident))

    @app.route("/api/rrc/favorite/<address>", methods=["POST"])
    def rrc_favorite(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.set_favorite(address, bool(incoming.get("favorite", True))))

    @app.route("/api/rrc/autoconnect/<address>", methods=["POST"])
    def rrc_autoconnect(address):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.rrc.set_autoconnect(address, bool(incoming.get("on", True))))

    @app.route("/api/rrc/forget/<address>", methods=["POST"])
    def rrc_forget(address):
        return jsonify(browser.rrc.forget(address))

    @app.route("/script/rrc.js")
    def serve_rrc_js():
        response = send_from_directory("script", "rrc.js", mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    # --- RMAP integration (rbrowser/rmap.py) ---

    @app.route("/api/rmap", methods=["GET"])
    def rmap_status():
        return jsonify(browser.rmap.status())

    @app.route("/api/rmap/nodes", methods=["GET"])
    def rmap_nodes():
        return jsonify(browser.rmap.listing())

    @app.route("/api/rmap/settings", methods=["POST"])
    def rmap_settings():
        try:
            return jsonify(browser.rmap.update_settings(request.get_json(silent=True) or {}))
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.route("/api/rmap/refresh", methods=["POST"])
    def rmap_refresh():
        return jsonify(browser.rmap.refresh())

    @app.route("/script/rmap.js")
    def serve_rmap_js():
        response = send_from_directory("script", "rmap.js", mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    # Leaflet 1.9.4 (BSD-2) + Leaflet.markercluster (MIT), the same copies
    # rmap.world uses, kept here: the page loads them when the RMAP view
    # first opens. Only these names are served.
    LEAFLET_FILES = {
        "leaflet.js": "application/javascript",
        "leaflet.css": "text/css",
        "leaflet.markercluster.js": "application/javascript",
        "MarkerCluster.css": "text/css",
        "MarkerCluster.Default.css": "text/css",
        # Country borders, Natural Earth 1:50m (public domain), simplified:
        # the offline map. The same file rmap.world uses.
        "countries.json": "application/json",
    }

    @app.route("/script/leaflet/<name>")
    def serve_leaflet(name):
        if name not in LEAFLET_FILES:
            abort(404)
        return send_from_directory(os.path.join("script", "leaflet"), name, mimetype=LEAFLET_FILES[name])

    @app.route("/script/retibbs.js")
    def serve_retibbs_js():
        response = send_from_directory("script", "retibbs.js", mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.route("/api/messenger/settings", methods=["POST"])
    def messenger_settings():
        try:
            return jsonify(browser.messenger.update_settings(request.get_json(silent=True) or {}))
        except ValueError as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.route("/api/messenger/announce", methods=["POST"])
    def messenger_announce():
        return jsonify(browser.messenger.announce_now())

    @app.route("/api/messenger/propagation-nodes", methods=["GET"])
    def messenger_propagation_nodes():
        """Propagation nodes heard on the network (nothing is sent)."""
        return jsonify({"status": "success", "nodes": browser.messenger.propagation_nodes(),
                        "propagation": browser.messenger.sync_status()})

    @app.route("/api/messenger/sync", methods=["POST"])
    def messenger_sync():
        """Collect the messages waiting on the propagation node."""
        return jsonify(browser.messenger.sync_now())

    @app.route("/api/messenger/sync/cancel", methods=["POST"])
    def messenger_sync_cancel():
        return jsonify(browser.messenger.cancel_sync())

    @app.route("/api/messenger/conversations", methods=["GET"])
    def messenger_conversations():
        return jsonify({"status": "success", "conversations": browser.messenger.conversations(),
                        "revision": browser.messenger.revision})

    @app.route("/api/messenger/messages/<peer>", methods=["GET"])
    def messenger_messages(peer):
        return jsonify({"status": "success", "peer": peer.lower(),
                        "name": browser.messenger.peer_name(peer.lower()),
                        "messages": browser.messenger.messages(peer)})

    @app.route("/api/messenger/send", methods=["POST"])
    def messenger_send():
        # JSON for text only; multipart (fields + "file" parts) with files.
        if request.files:
            from .messenger import MAX_ATTACH_BYTES
            form = request.form
            attachments = []
            total = 0
            for upload in request.files.getlist("file"):
                data = upload.read(MAX_ATTACH_BYTES + 1)
                total += len(data)
                if total > MAX_ATTACH_BYTES:
                    return jsonify({"status": "error",
                                    "error": f"Files too big: at most {MAX_ATTACH_BYTES // (1024 * 1024)} MB in one message"})
                attachments.append((upload.filename or "file", data))
            return jsonify(browser.messenger.send(form.get("peer"), form.get("content", ""),
                                                  form.get("title", ""),
                                                  propagated=form.get("propagated") == "1",
                                                  attachments=attachments, reply_to=form.get("reply_to")))
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.send(incoming.get("peer"), incoming.get("content"),
                                              incoming.get("title", ""),
                                              propagated=bool(incoming.get("propagated")),
                                              reply_to=incoming.get("reply_to")))

    @app.route("/api/messenger/react/<peer>", methods=["POST"])
    def messenger_react(peer):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.react(peer, incoming.get("id"), incoming.get("reaction", "")))

    @app.route("/api/messenger/nickname/<peer>", methods=["POST"])
    def messenger_nickname(peer):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.set_nickname(peer, incoming.get("nickname", "")))

    @app.route("/api/messenger/name", methods=["POST"])
    def messenger_display_name():
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.set_display_name(incoming.get("identity"), incoming.get("name", "")))

    @app.route("/api/messenger/cancel-incoming/<resource_id>", methods=["POST"])
    def messenger_cancel_incoming(resource_id):
        return jsonify(browser.messenger.cancel_incoming(resource_id))

    @app.route("/api/messenger/keep-ephemeral", methods=["POST"])
    def messenger_keep_ephemeral():
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.keep_ephemeral(incoming.get("name")))

    @app.route("/api/messenger/contact/<peer>", methods=["POST"])
    def messenger_add_contact(peer):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.add_contact(peer, incoming.get("nickname", "")))

    @app.route("/api/messenger/favorite/<peer>", methods=["POST"])
    def messenger_favorite(peer):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.set_favorite(peer, bool(incoming.get("favorite", True))))

    @app.route("/api/messenger/peers", methods=["GET"])
    def messenger_peers():
        """LXMF peers heard announcing (lxmf_peers.py), newest first."""
        m = browser.messenger
        own = m.destination.hash.hex() if m.destination is not None else None
        return jsonify(m.peers.listing(request.args.get("q", ""), own=own))

    @app.route("/api/messenger/search", methods=["GET"])
    def messenger_search():
        return jsonify({"status": "success", "hits": browser.messenger.search(request.args.get("q", ""))})

    @app.route("/api/messenger/cancel/<peer>/<local_id>", methods=["POST"])
    def messenger_cancel(peer, local_id):
        return jsonify(browser.messenger.cancel(peer, local_id))

    @app.route("/api/messenger/retry/<peer>/<local_id>", methods=["POST"])
    def messenger_retry(peer, local_id):
        return jsonify(browser.messenger.retry(peer, local_id))

    @app.route("/api/messenger/file/<peer>/<local_id>/<int:index>", methods=["GET"])
    def messenger_file(peer, local_id, index):
        """A file of a conversation. ?download=1 saves it, otherwise images
        and PDFs open in the browser and the rest is saved too."""
        data, meta = browser.messenger.file_data(peer, local_id, index)
        if data is None:
            return jsonify({"status": "error", "error": meta}), 404
        mime = meta.get("mime") or "application/octet-stream"
        inline = request.args.get("download") != "1" and (
            mime in ("image/webp", "image/jpeg", "image/png", "image/gif", "image/bmp", "application/pdf")
            or mime.startswith("audio/"))
        # conditional: Range requests, so the chat's player can seek.
        response = send_file(io.BytesIO(data), mimetype=mime if inline else "application/octet-stream",
                             as_attachment=not inline, download_name=meta.get("name") or "file",
                             conditional=True)
        # Someone else's file: never run as a page of ours.
        response.headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.route("/api/messenger/file/<peer>/<local_id>/<int:index>/delete", methods=["POST"])
    def messenger_file_delete(peer, local_id, index):
        return jsonify(browser.messenger.delete_file(peer, local_id, index))

    @app.route("/api/messenger/file/<peer>/<local_id>/<int:index>/show", methods=["POST"])
    def messenger_file_show(peer, local_id, index):
        """Opens a folder on the computer rBrowser runs on: only from that computer."""
        if request.remote_addr not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return jsonify({"status": "error", "error": "Only from the computer rBrowser runs on"}), 403
        return jsonify(browser.messenger.show_file(peer, local_id, index))

    @app.route("/api/messenger/ping/<peer>", methods=["POST"])
    def messenger_ping(peer):
        return jsonify(browser.messenger.ping(peer))

    @app.route("/api/messenger/block/<peer>", methods=["POST"])
    def messenger_block(peer):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.block(peer, bool(incoming.get("blocked", True))))

    @app.route("/api/messenger/color/<peer>", methods=["POST"])
    def messenger_color(peer):
        incoming = request.get_json(silent=True) or {}
        return jsonify(browser.messenger.set_color(peer, incoming.get("hue")))

    @app.route("/api/messenger/peer/<peer>", methods=["GET"])
    def messenger_peer(peer):
        return jsonify(browser.messenger.peer_info(peer))

    @app.route("/api/messenger/read/<peer>", methods=["POST"])
    def messenger_read(peer):
        browser.messenger.mark_read(peer)
        return jsonify({"status": "success"})

    @app.route("/api/messenger/delete/<peer>", methods=["POST"])
    def messenger_delete(peer):
        everywhere = bool((request.get_json(silent=True) or {}).get("all"))
        return jsonify({"status": "success", "deleted": browser.messenger.delete_conversation(peer, everywhere)})

    @app.route("/api/messenger/clear/<peer>", methods=["POST"])
    def messenger_clear(peer):
        return jsonify({"status": "success", "cleared": browser.messenger.clear_conversation(peer)})

    @app.route("/api/messenger/owners/<peer>")
    def messenger_owners(peer):
        """Which of our identities have a chat with peer (Delete asks)."""
        return jsonify({"status": "success", "owners": browser.messenger.conversation_owners(peer)})

    def hash_kind(dest: bytes) -> Dict[str, Any]:
        """The aspect of a destination: its announce's identity, hashed with
        each known application name until one gives the same address."""
        from .nomadnet import KNOWN_ASPECTS
        identity = rnsquiet.recall(dest)
        if identity is None:
            return {"status": "success", "known": False}
        aspects = {"nomadnetwork.node": "a NomadNet node", **KNOWN_ASPECTS}
        aspect = next((a for a in aspects
                       if RNS.Destination.hash_from_name_and_identity(a, identity) == dest), None)
        name = ""
        label = aspects.get(aspect, "an unknown Reticulum destination: it answers, but its application is not one rBrowser knows")
        if aspect == "nomadnetwork.node":
            name = (browser.nomadnet_nodes.get(RNS.prettyhexrep(dest)) or {}).get("name", "")
        elif aspect == "lxmf.delivery" and getattr(browser, "messenger", None):
            name = browser.messenger.peer_name(dest.hex())
        elif aspect == "rnstransport.discovery.interface":
            detail = discovered_interface(rnsquiet.recall_app_data(dest))
            if detail:
                name, label = detail
        return {"status": "success", "known": True, "aspect": aspect, "label": label, "name": name}

    def discovered_interface(app_data: Any):
        """(name, label) from an interface discovery announce (RNS
        Discovery.py: a flags byte, msgpack, then a stamp). None when it
        cannot be read - an encrypted one, say."""
        try:
            import RNS.vendor.umsgpack as msgpack
            from RNS import Discovery as D
            from LXMF import LXStamper
            if not app_data or len(app_data) < LXStamper.STAMP_SIZE + 2 or app_data[0] & 0b10:
                return None
            info = msgpack.unpackb(app_data[1:-LXStamper.STAMP_SIZE])
            kind = str(info.get(D.INTERFACE_TYPE, ""))
            what = {"RNodeInterface": "LoRa radio", "RNodeMultiInterface": "LoRa radio",
                    "KISSInterface": "packet radio (KISS)", "BackboneInterface": "Backbone (TCP)",
                    "TCPServerInterface": "TCP", "TCPClientInterface": "TCP", "I2PInterface": "I2P",
                    "WeaveInterface": "Weave"}.get(kind, kind or "interface")
            extra = []
            if info.get(D.FREQUENCY):
                extra.append(f"{int(info[D.FREQUENCY]) / 1e6:.3f} MHz")
            if info.get(D.REACHABLE_ON):
                extra.append(f"{info[D.REACHABLE_ON]}{':' + str(info[D.PORT]) if info.get(D.PORT) else ''}")
            name = str(info.get(D.NAME, "") or "")
            label = f"a discoverable {what} interface" + (f" ({', '.join(extra)})" if extra else "")
            return name, label
        except Exception:
            return None

    @app.route("/api/hash-kind/<address>", methods=["GET", "POST"])
    def api_hash_kind(address):
        """What an address written as plain text in a page is: worked out
        from the identity of its announce, if heard. Nothing is sent.
        POST ("Check address aspect type"): when not heard, one path request;
        the answer carries the announce, and so the identity."""
        text = address.strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", text):
            return jsonify({"status": "error", "error": "Not an address"}), 400
        dest = bytes.fromhex(text)
        result = hash_kind(dest)
        if request.method == "POST" and not result["known"]:
            started = time.time()
            RNS.Transport.request_path(dest)
            while time.time() - started < HASH_KIND_WAIT and rnsquiet.recall(dest) is None:
                time.sleep(0.5)
            result = hash_kind(dest)
            result["asked"] = True
            result["elapsed"] = round(time.time() - started, 1)
        return jsonify(result)

    @app.route("/api/path-check/<node_hash>", methods=["GET"])
    def api_path_check(node_hash):
        return jsonify(browser.check_path(node_hash))

    @app.route("/api/lxmf-check/<address>", methods=["POST"])
    def api_lxmf_check(address):
        print(f"API Request: is LXMF {address[:16]}... reachable")
        try:
            timeout = min(max(float(request.args.get("timeout", 0)), 0.0), 120.0) or None
        except ValueError:
            timeout = None
        response = browser.check_lxmf_reachable(address, timeout)
        print(f"API Response: {response.get('reachable', response.get('error'))}")
        return jsonify(response)

    # History - see rbrowser/history.py. Written only by page visits.
    @app.route('/api/history', methods=['GET'])
    def get_history():
        return jsonify({'status': 'success', **browser.history.snapshot()})

    @app.route('/api/history/settings', methods=['POST'])
    def save_history_settings():
        settings = browser.history.save_settings(request.get_json(silent=True) or {})
        return jsonify({'status': 'success', 'settings': settings})

    @app.route('/api/history/remove', methods=['POST'])
    def remove_history_entry():
        url = (request.get_json(silent=True) or {}).get('url', '')
        return jsonify({'status': 'success', 'removed': browser.history.remove(str(url))})

    @app.route('/api/history/clear', methods=['POST'])
    def clear_history():
        return jsonify({'status': 'success', 'removed': browser.history.clear()})

    @app.route('/api/favorites', methods=['GET'])
    def get_favorites():
        try:
            return jsonify({'status': 'success', 'favorites': browser.favorites.load(),
                            'revision': browser.favorites.revision})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)})

    @app.route('/api/favorites/settings', methods=['GET', 'POST'])
    def favorites_settings():
        if request.method == 'POST':
            settings = browser.favorites.save_settings(request.get_json(silent=True) or {})
        else:
            settings = dict(browser.favorites.settings)
        return jsonify({'status': 'success', 'settings': settings})

    @app.route('/api/favorites', methods=['POST'])
    def save_favorites():
        try:
            saved = browser.favorites.save(request.json.get('favorites', []))
            return jsonify({'status': 'success', 'message': 'Favorites saved',
                            'favorites': saved, 'revision': browser.favorites.revision})
        except Exception as e:
            return jsonify({'status': 'error', 'error': str(e)})

    # The name of a node from what is already known - node list and the
    # announces Reticulum remembers. Never touches the network: the add
    # favorite dialog calls it while you type.
    @app.route('/api/node-name/<node_hash>')
    def node_name(node_hash):
        return jsonify({'status': 'success', 'name': browser.known_node_name(node_hash)})

    @app.route('/<path:path>')
    def catch_all(path):
        """
        Catch-all route for hash-based URLs.
        Allows URLs like /hash or /hash/page/path.mu to load the main interface.
        The JavaScript will then parse the path and load the correct page.
        """
        # Check if path starts with a 32-character hex hash
        if re.match(r'^[a-fA-F0-9]{32}', path):
            # Serve the main index.html for hash-based URLs
            return render_index()

        # For other paths, return 404
        abort(404)

# ---------------------------------------------------------------------- #
# Helper utilities (kept module-private)                                 #
# ---------------------------------------------------------------------- #


# NomadNet converts every non-native image to WebP before serving it, so WebP
# is the type we will see most - and mimetypes.guess_type() does not know it on
# a stock Windows Python, which served every image as application/octet-stream
# and left the browser showing a broken image. Spell the types out.
_MEDIA_MIMETYPES = {
    ".webp": "image/webp",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".bmp":  "image/bmp",
    ".tiff": "image/tiff",
}


def _media_mimetype(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext in _MEDIA_MIMETYPES:
        return _MEDIA_MIMETYPES[ext]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _serve_template_asset(filename: str):
    try:
        return send_from_directory("templates", filename, mimetype="image/png")
    except Exception as exc:
        print(f"❌ Error serving {filename}: {exc}")
        return "", 404


