"""Local preview server.

Unlike the deploy (which copies everything into `_site/`), this serves
files *live* from their source locations — edit `site/app.js` or drop a
new JSON into `results/`, refresh the browser, done.

  /                    → site/index.html
  /style.css           → site/style.css          (any site/* file)
  /results/<file>.json → results/<file>.json     (any results/* file)
  /results/index.json  → regenerated on each request from results/*.json

Usage:
    uv run serve             # port 8000, opens browser
    uv run serve --port 4000 --no-browser
"""

from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SITE = ROOT / "site"
RESULTS = ROOT / "results"


def build_index_bytes() -> bytes:
    """Return the current index as JSON bytes (regenerated on every call so
    it always reflects what's on disk).

    Reloads `scripts.site.build_index` on every request so edits to that
    module take effect without restarting the dev server. The first import
    is the only one that triggers Python's module cache; without reload
    we'd serve stale `build_index` logic for the lifetime of the dev
    server process, which has bitten us several times when adding new
    index fields.
    """
    import importlib

    from . import build_index as _build_index_module
    importlib.reload(_build_index_module)
    return (json.dumps(_build_index_module.build_index(RESULTS), indent=2) + "\n").encode("utf-8")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        # Default document root is site/; /results/* is routed manually below.
        super().__init__(*a, directory=str(SITE), **kw)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path

        if path == "/results/index.json":
            body = build_index_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if path.startswith("/results/"):
            rel = path[len("/results/"):].lstrip("/")
            target = (RESULTS / rel).resolve()
            try:
                target.relative_to(RESULTS.resolve())
            except ValueError:
                self.send_error(403)
                return
            if not target.is_file():
                self.send_error(404)
                return
            data = target.read_bytes()
            ct = "application/json" if target.suffix == ".json" else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        # Everything else: serve from site/.
        return super().do_GET()

    def end_headers(self):
        # Belt-and-suspenders: keep the browser from caching stale site assets
        # during iteration.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # Quieter than the default one-line-per-request log: skip 2xx and
        # 3xx, let everything else (4xx, 5xx, errors) fall through.
        try:
            if 200 <= int(code) < 400:
                return
        except (TypeError, ValueError):
            pass
        super().log_request(code, size)


class _Server(socketserver.ThreadingTCPServer):
    # Class attributes are evaluated during __init__'s server_bind(), so
    # setting allow_reuse_address on the instance after __init__ is too late.
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    url = f"http://localhost:{args.port}"
    try:
        httpd = _Server(("", args.port), Handler)
    except OSError as e:
        import errno
        if e.errno == errno.EADDRINUSE:
            sys.stderr.write(
                f"error: port {args.port} is already in use.\n"
                f"  Find the process:  lsof -ti :{args.port}\n"
                f"  Stop it:           lsof -ti :{args.port} | xargs kill\n"
                f"  Or pick another:   uv run serve --port <N>\n"
            )
            sys.exit(1)
        raise

    with httpd:
        print(f"Serving site/ + results/ live at {url}")
        print("  Edit site/* or drop new JSON into results/ — just refresh the browser.")
        print("  (Ctrl-C to stop)")
        if not args.no_browser:
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
