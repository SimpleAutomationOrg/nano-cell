#!/usr/bin/env python3
"""Serve the repo and open the arm-in-cell viewer, reloading it on changes.

    python3 viewer/serve.py [port]

Serves the repository root (the viewer fetches ../arm and ../cell) with
caching off. A watcher thread rescans the tracked files twice a second;
the page long-polls /__reload and reloads itself when anything changed.
"""
import http.server
import os
import socketserver
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8742

WATCH_EXT = {".html", ".js", ".css", ".json", ".glb", ".stl", ".py"}
SKIP_DIRS = {".git", "node_modules", "out", "dist", "__pycache__", ".DS_Store"}

_generation = 0
_changed = threading.Condition()


def _scan():
    state = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if os.path.splitext(f)[1] in WATCH_EXT:
                p = os.path.join(dirpath, f)
                try:
                    state[p] = os.stat(p).st_mtime_ns
                except OSError:
                    pass
    return state


def _watch():
    global _generation
    last = _scan()
    while True:
        time.sleep(0.5)
        now = _scan()
        if now != last:
            last = now
            with _changed:
                _generation += 1
                _changed.notify_all()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/__reload"):
            return self._reload_poll()
        super().do_GET()

    def _reload_poll(self):
        # long-poll: answer when the generation moves past the client's,
        # or after 25 s so the connection never goes stale
        try:
            seen = int(self.path.split("gen=")[1])
        except (IndexError, ValueError):
            seen = -1
        with _changed:
            if _generation <= seen:
                _changed.wait(timeout=25)
            gen = _generation
        body = str(gen).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    threading.Thread(target=_watch, daemon=True).start()
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/viewer/"
        print(f"viewer: {url}  (live reload on, ctrl-c to stop)")
        threading.Timer(0.3, webbrowser.open, (url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
