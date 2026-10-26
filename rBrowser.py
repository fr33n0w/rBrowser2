#!/usr/bin/env python3
"""
rBrowser entrypoint.

This module keeps the runtime bootstrap logic lean by delegating the majority
of the work to the `rbrowser` package. It exists primarily to provide a CLI
interface and to remain compatible with the historical `python rBrowser.py`
usage.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
from typing import Tuple

# Settings, cache, favorites and identity keys are all kept next to this
# file. They are opened by relative paths, so work from this folder:
# started from anywhere else, rBrowser read and wrote a second set of files
# there - including a brand new Default identity. argv[0] is made absolute
# first, so a restart still finds this script.
sys.argv[0] = os.path.abspath(sys.argv[0])
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# A nomadnetwork://, rrc:// or rbrowser:// link clicked somewhere (rbrowser/links.py):
# hand it to the rBrowser that is running, or start one, and stop here. Done
# before anything below, which sets up a whole rBrowser - and before the
# console setup, which from pythonw would flash a window on every click.
if "--open" in sys.argv[1:]:
    _open = argparse.ArgumentParser()
    _open.add_argument("--open", nargs="?", default="")
    _open.add_argument("--port", type=int, default=None)
    _open_args, _ = _open.parse_known_args()
    from rbrowser.links import open_link
    sys.exit(open_link(_open_args.open or "", _open_args.port))

from flask import Flask

from rbrowser import (console_log, favorites, hidden_nodes, identities, links, mdns, messenger, nomadnet,
                      pagecache, propagation, remote, retibbs, rmap, routes, rrc, server_settings, visits,
                      web_browser)
from rbrowser.server_settings import ServerSettings, wait_for_previous_instance
from rbrowser.routes import register_routes
from rbrowser.web_browser import NomadNetWebBrowser

# The terminal log setting (full / status only) applies to everything the
# rbrowser package prints. This file's own startup lines are always shown.
console_log.install(favorites, hidden_nodes, identities, links, mdns, messenger, nomadnet, pagecache,
                    propagation, remote, retibbs, rmap, routes, rrc, server_settings, visits, web_browser)


# Ensure UTF-8 output for Windows console.
#
# chcp alone is not enough: Python decides sys.stdout's encoding when the
# interpreter starts, so changing the console code page afterwards leaves
# the encoder on cp1252 and the first emoji in a log line raises
# UnicodeEncodeError in the middle of a request. reconfigure() changes the
# encoder itself, and errors="replace" means a character the terminal
# cannot show costs a question mark rather than a traceback.
if sys.platform == "win32":
    try:
        os.system("chcp 65001 >nul")
    except Exception:
        pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

# A restart from the settings page starts this process before the old one has
# exited. Wait for it here: after the console is UTF-8 (the wait prints an
# emoji, and on cp1252 that alone killed the new process), and before
# create_app() below brings up Reticulum, because two processes starting the
# shared instance at once is exactly what must not happen. Importing the
# rbrowser package above starts nothing; only NomadNetWebBrowser() does.
wait_for_previous_instance()


def create_app() -> Tuple[Flask, NomadNetWebBrowser]:
    """Factory used by both the CLI entrypoint and potential WSGI imports."""
    app = Flask(__name__)
    # Access password (rbrowser/auth.py): the session key is kept in
    # settings/auth.json, so a restart does not log the browsers out.
    from rbrowser.auth import Auth
    auth = Auth()
    app.secret_key = auth.secret
    app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Strict",
                      PERMANENT_SESSION_LIFETIME=86400 * 30)

    # Without this, Jinja compiles templates/index.html once and caches it
    # for the life of the process: TEMPLATES_AUTO_RELOAD defaults to None,
    # which falls back to app.debug, which is False here. Editing the page
    # then has no visible effect at all until rBrowser.py is restarted -
    # which looks exactly like the edit not having been made. The cost is one
    # stat() of the file per page load, and the page is loaded once.
    app.config["TEMPLATES_AUTO_RELOAD"] = True

    browser = NomadNetWebBrowser()
    browser.server_settings = ServerSettings()
    browser.auth = auth
    # Remote access (rbrowser/remote.py): requests through a tunnel or a
    # proxy get back the address of who sent them, never "this computer".
    app.wsgi_app = remote.ProxyFix(app.wsgi_app)
    browser.remote = remote.Remote(auth)
    register_routes(app, browser)
    return app, browser


app, browser = create_app()

# Imported by a WSGI server instead of run as a script (the Docker image runs
# "waitress-serve rBrowser:app"): that server owns the startup order, so
# Reticulum comes up here, at import, in the main thread, as it always has.
if __name__ != "__main__":
    # The tunnel/DDNS too: the server's port is not known from here, the
    # image uses 5000 (RBROWSER_PORT if another one is set).
    try:
        browser.remote.start("0.0.0.0", int(os.environ.get("RBROWSER_PORT") or 5000))
    except Exception as exc:
        print(f"⚠️ Remote access not started: {exc}")
    if browser.init_reticulum():
        browser.start_monitoring()


def start_server(flask_app: Flask, host: str = "0.0.0.0", port: int = 5000) -> None:
    """Start the HTTP server, preferring Waitress when available."""
    try:
        from waitress import serve

        print("🚀 Local Web Interface starting with Waitress server...")
        # Many requests wait on the network (a page fetch, a path, a ping,
        # an LXMF info) for up to a minute, mostly asleep. With 8 threads a
        # few of them filled the server and everything else queued
        # ("Task queue depth", the UI froze): more threads cost little.
        serve(flask_app, host=host, port=port, threads=24)
    except ImportError:
        logging.getLogger("werkzeug").setLevel(logging.ERROR)
        print("⚠️  Waitress not found, falling back to Flask dev server...")
        print("🚀 Local Web Interface starting...")
        flask_app.run(host=host, port=port, debug=False, threaded=True)


def main() -> int:
    """CLI entrypoint with sanity checks before serving traffic."""
    parser = argparse.ArgumentParser(description="rBrowser - Standalone NomadNet Browser")
    # No argparse defaults: an option left out means "use what was saved in
    # the settings page", and only an option actually typed overrides it.
    parser.add_argument("--host", type=str, default=None,
                        help="Host to bind the web server to (default: saved setting, else 0.0.0.0)")
    parser.add_argument("--port", type=int, default=None,
                        help="Port to run the web server on (default: saved setting, else 5000)")
    parser.add_argument("--log", choices=console_log.MODES, default=None,
                        help="Terminal log for this run: 'full' (everything) or 'status' "
                             "(connection, identity and errors). Default: the choice in Settings")
    parser.add_argument("--open", metavar="LINK", default=None,
                        help="Open a nomadnetwork://, rrc:// or rbrowser:// link in the running rBrowser "
                             "(started if needed). Used by the system when links are registered")
    parser.add_argument("--register-links", action="store_true",
                        help="Make nomadnetwork://, rrc:// and rbrowser:// links open in rBrowser, then exit")
    parser.add_argument("--unregister-links", action="store_true",
                        help="Stop opening those links in rBrowser, then exit")
    args = parser.parse_args()
    if args.register_links or args.unregister_links:
        from rbrowser import links
        try:
            state = links.register() if args.register_links else links.unregister()
        except Exception as exc:
            print(f"❌ {exc}")
            return 1
        print(f"   {state['schemes']}")
        return 0
    if args.log:
        console_log.console.override = args.log
    # Links on by default (Settings > System > Links turns them off).
    links.auto_register()
    listen = browser.server_settings.resolve(args.host, args.port)
    args.host, args.port = listen["host"], listen["port"]

    try:
        template_path = os.path.join("templates", "index.html")
        if os.path.exists(template_path):
            print(f"✅ Found HTML template: {template_path}")
        else:
            print(f"❌ HTML template not found: {template_path}")
            print("   Please verify templates/ directory and index.html file")
            return 1

        micron_path = os.path.join("script", "micron-parser_original.js")
        if os.path.exists(micron_path):
            print(f"✅ Found Micron parser: {micron_path}")
        else:
            print(f"⚠️ Micron parser not found: {micron_path}")
            print("   Fallback parser will be used")

        dom_path = os.path.join("script", "purify.min.js")
        if os.path.exists(dom_path):
            print(f"✅ Found DOMPurify: {dom_path}")
        else:
            print(f"⚠️ DOMPurify not found: {dom_path}")

        if not getattr(browser, "identity", None):
            print("❌ Browser initialization failed - No identity could be loaded or created")
            return 1

        # Web server first, Reticulum second. The other way round, a
        # Reticulum that was slow or failed kept the page from ever opening,
        # and the process could exit with nothing on screen to say why. Now
        # the page is up at once and its status bar shows "Connecting to
        # Reticulum..." and then the result, failure included.
        #
        # The server gets the thread, not Reticulum: RNS.Reticulum() installs
        # signal handlers, which Python only allows in the main thread.
        host_display = "localhost" if args.host == "0.0.0.0" else args.host
        print(f"🌐 Starting local web server on http://{host_display}:{args.port}")
        server = threading.Thread(target=start_server, args=(app, args.host, args.port),
                                  name="rbrowser-web", daemon=True)
        server.start()
        print(f"🔍 Open your browser to http://{host_display}:{args.port}")
        browser.server_settings.start_local_name()
        browser.remote.start(args.host, args.port)
        # Where links clicked in other programs find this rBrowser.
        from rbrowser.links import record_running
        record_running(args.host, args.port)
        print("=========== Press Ctrl+C to stop and exit ============\n")

        if browser.init_reticulum():
            browser.start_monitoring()
        else:
            print("⚠️ Running without Reticulum: fix the problem above and restart rBrowser.")

        # Stay alive for as long as the web server does. If it stops (the
        # port was taken, say) there is nothing left to serve.
        while server.is_alive():
            server.join(0.5)
            browser.run_main_thread_tasks()
        print("❌ The web server stopped - see the message above (is the port already in use?)")
        return 1

    except KeyboardInterrupt:
        print("\n👋 NomadNet Browser shutting down...")
        try:
            browser.remote.shutdown()   # cloudflared goes with us
        except Exception:
            pass
        try:
            browser.rrc.close_all()     # the hubs drop our sessions at once
        except Exception:
            pass
        browser.running = False
        if hasattr(browser, "connection_state"):
            browser.connection_state = "shutdown"
        print("✅ Shutdown complete")
        return 0

    except Exception as exc:
        print(f"\n❌ Startup failed: {exc}")
        print(f"   Error type: {type(exc).__name__}")

        if hasattr(browser, "connection_state"):
            browser.connection_state = "failed"

        if hasattr(browser, "reticulum"):
            print(f"   Reticulum object exists: {browser.reticulum is not None}")
        else:
            print("   No reticulum attribute found on browser object")

        if hasattr(browser, "identity"):
            print(f"   Identity exists: {browser.identity is not None}")
        else:
            print("   No identity attribute found on browser object")

        return 1


if __name__ == "__main__":
    sys.exit(main())
