#!/usr/bin/env python3
"""Serve the repo and open the arm-in-cell viewer, reloading it on changes.

    python3 viewer/serve.py [port] [--no-open]
    python3 viewer/serve.py --stdio          (for the installed desktop app)

Serves the repository root (the viewer fetches ../cell_fr3 and
../applications) with
caching off. A watcher thread rescans the tracked files twice a second;
the page long-polls /__reload and reloads itself when anything changed.
"""
import http.server
import os
import re
import socketserver
import sys
import threading
import time
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chat import Chats  # noqa: E402
import appfiles  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_args = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(_args[0]) if _args else 8742
OPEN_BROWSER = "--no-open" not in sys.argv   # a restart need not open one more tab
STDIO = "--stdio" in sys.argv             # serve a parent process through pipes (the desktop app)

WATCH_EXT = {".html", ".js", ".ts", ".css", ".json", ".glb", ".stl", ".py"}
SKIP_DIRS = {".git", "node_modules", "out", "dist", "__pycache__", ".DS_Store", ".backups", "chats"}
SKIP_FILES = {".chat-sessions.json"}      # written while an agent works: not a reason to reload

CHATS = Chats(ROOT)

# what the user attaches in the chat lands in applications/<name>/materials/
MATERIALS = "materials"
MAX_UPLOAD = 50_000_000
MAX_IMPORT = 1_000_000_000      # a .microfactory file

# starts at the clock, not at 0: pages left open across a server restart
# see a newer generation and reload, instead of running their old code
_generation = int(time.time())
_own_writes = {}   # path -> mtime of a file this server just saved itself
_changed = threading.Condition()


def _scan():
    state = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if os.path.splitext(f)[1] in WATCH_EXT and f not in SKIP_FILES:
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
            # a file the page itself asked us to save (the step order) is
            # already on screen: no reload for that
            moved = {p for p in set(now) | set(last) if now.get(p) != last.get(p)}
            last = now
            if all(p in now and _own_writes.get(p) == now[p] for p in moved):
                continue
            with _changed:
                _generation += 1
                _changed.notify_all()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/__reload"):
            return self._reload_poll()
        if self.path.startswith("/__applications/export"):
            return self._export()
        if self.path.startswith("/__applications"):
            return self._applications()
        if self.path.startswith("/__steps"):
            return self._steps()
        if self.path.startswith("/__chat/agent"):
            if not self._same_origin():
                return self._json({"error": "forbidden"}, 403)
            return self._json(CHATS.agent())
        if self.path.startswith("/__chat/events"):
            if not self._same_origin():
                return self._json({"error": "forbidden"}, 403)
            q = dict(p.split("=", 1) for p in self.path.partition("?")[2].split("&") if "=" in p)
            try:
                chat = CHATS.get(q.get("app", ""))
                if chat is None:
                    return self._json({"error": "no such application"}, 404)
                r = chat.poll(int(q.get("epoch", -1)), int(q.get("since", 0)))
                return self._json({**r, "available": CHATS.available()})
            except ValueError:
                return self._json({"error": "bad request"}, 400)
        super().do_GET()

    # The chat runs an agent that edits files on this machine, so its
    # endpoints answer only to THIS page: a request must come from our own
    # origin and carry a header that no other website can send without
    # asking permission first (which this server never grants).
    def _same_origin(self):
        ours = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        origin = self.headers.get("Origin")
        return (self.headers.get("Host") in ours
                and self.headers.get("X-Microfactory") == "chat"
                and (origin is None or origin.split("://", 1)[-1] in ours))

    def _json(self, obj, code=200):
        import json
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        import json
        if not self.path.startswith(("/__chat/", "/__loop/save", "/__applications/new", "/__applications/import")):
            return self._json({"error": "not found"}, 404)
        if not self._same_origin():
            return self._json({"error": "forbidden"}, 403)
        if self.path.startswith("/__chat/upload"):
            return self._upload()
        if self.path.startswith("/__applications/import"):
            return self._import()
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}") if n < 200_000 else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            return self._json({"error": "bad request"}, 400)
        if self.path.startswith("/__applications/new"):
            return self._new_application(data)
        if self.path.startswith("/__loop/save"):
            return self._save_loop(data)
        action = self.path[len("/__chat/"):]
        chat = CHATS.get(str(data.get("app", "")))
        if chat is None:
            return self._json({"error": "no such application"}, 404)
        if action == "send":
            # attachments: only files that really are in an application's materials/
            files = []
            for p in data.get("files") or []:
                full = os.path.realpath(os.path.join(ROOT, str(p)))
                parts = os.path.relpath(full, ROOT).split(os.sep)
                if (len(parts) == 4 and parts[0] == "applications" and parts[2] == MATERIALS
                        and os.path.isfile(full)):
                    files.append("/".join(parts))
            err = chat.send(str(data.get("text", "")), str(data.get("context", ""))[:400], files[:20])
            return self._json({"error": err} if err else {"ok": True}, 409 if err else 200)
        if action == "stop":
            chat.stop()
            return self._json({"ok": True})
        if action == "new":
            chat.new()
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    def _applications(self):
        import json
        apps = []
        adir = os.path.join(ROOT, "applications")
        for name in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
            try:
                with open(os.path.join(adir, name, "application.json")) as f:
                    a = json.load(f)
                apps.append({"id": name, "name": a.get("name", name), "robot": a.get("robot")})
            except (OSError, ValueError):
                pass
        return self._json(apps)

    def _app_dir(self, app):
        # an application's folder, or None for anything that is not one
        d = os.path.join(ROOT, "applications", app)
        ok = isinstance(app, str) and app and app == os.path.basename(app) and app not in (".", "..")
        return d if ok and os.path.isfile(os.path.join(d, "application.json")) else None

    def _upload(self):
        # a file attached in the chat: /__chat/upload?app=<name>&name=<file name>,
        # the file itself as the body. Saved in the application's materials/
        # folder under a safe name, never over an existing file.
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        d = self._app_dir(q.get("app", [""])[0])
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if not d or n < 0:
            return self._json({"error": "bad request"}, 400)
        if n > MAX_UPLOAD:
            return self._json({"error": f"file too large (limit {MAX_UPLOAD // 1_000_000} MB)"}, 413)
        # keep letters, digits, dot, dash, underscore; no folders, no hidden files
        raw = os.path.basename(q.get("name", ["file"])[0].replace("\\", "/"))
        stem, ext = os.path.splitext(re.sub(r"[^\w.-]+", "-", raw).strip(".-") or "file")
        stem, ext = (stem or "file")[:80], ext[:12]
        folder = os.path.join(d, MATERIALS)
        try:
            os.makedirs(folder, exist_ok=True)
            path, k = os.path.join(folder, stem + ext), 1
            while os.path.exists(path):
                k += 1
                path = os.path.join(folder, f"{stem}-{k}{ext}")
            left = n
            with open(path, "xb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                os.remove(path)
                return self._json({"error": "upload cut short"}, 400)
            _own_writes[path] = os.stat(path).st_mtime_ns     # no page reload for it
        except OSError as e:
            return self._json({"error": str(e)}, 500)
        return self._json({"ok": True, "path": os.path.relpath(path, ROOT), "name": os.path.basename(path)})

    def _export(self):
        # the open application as one file: /__applications/export?app=<name>
        import tempfile
        from urllib.parse import parse_qs, urlparse
        if not self._same_origin():
            return self._json({"error": "forbidden"}, 403)
        app = parse_qs(urlparse(self.path).query).get("app", [""])[0]
        d = self._app_dir(app)
        if not d:
            return self._json({"error": "no such application"}, 404)
        with tempfile.TemporaryFile() as tmp:
            try:
                appfiles.export_application(d, tmp)
            except OSError as e:
                return self._json({"error": str(e)}, 500)
            size = tmp.tell()
            tmp.seek(0)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            # the file's name says when it was saved, to the second
            name = appfiles.export_name(app)
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("X-Microfactory-File", name)
            self.end_headers()
            while True:
                chunk = tmp.read(1 << 20)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _import(self):
        # a .microfactory file as the body: /__applications/import?name=<file name>&existing=ask|replace|copy
        import tempfile
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        existing = q.get("existing", ["ask"])[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n <= 0 or existing not in ("ask", "replace", "copy"):
            return self._json({"error": "bad request"}, 400)
        if n > MAX_IMPORT:
            return self._json({"error": f"file too large (limit {MAX_IMPORT // 1_000_000} MB)"}, 413)
        name = os.path.basename(q.get("name", [""])[0].replace("\\", "/"))
        with tempfile.TemporaryFile() as tmp:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    return self._json({"error": "upload cut short"}, 400)
                tmp.write(chunk)
                left -= len(chunk)
            tmp.seek(0)
            try:
                res = appfiles.import_application(
                    os.path.join(ROOT, "applications"), tmp, name, existing,
                    backup_root=os.path.join(ROOT, ".backups", "applications"))
            except appfiles.ImportError_ as e:
                return self._json({"error": str(e)}, 400)
            except OSError as e:
                return self._json({"error": str(e)}, 500)
        return self._json({"ok": True, **res})

    def _new_application(self, data):
        # a new, empty application (viewer/appfiles.py), set up on the same
        # robot as the application `like`
        name = " ".join(str(data.get("name", "")).split())[:60]
        app_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        if not app_id:
            return self._json({"error": "give the application a name (letters or digits)"}, 400)
        d = os.path.join(ROOT, "applications", app_id)
        if os.path.exists(d):
            return self._json({"error": f"applications/{app_id} already exists"}, 409)
        like = self._app_dir(data.get("like"))
        if not like:
            return self._json({"error": "bad request"}, 400)
        try:
            appfiles.new_application(d, name, like)
        except (OSError, ValueError) as e:
            return self._json({"error": str(e)}, 500)
        return self._json({"ok": True, "id": app_id})

    def _save_loop(self, data):
        # the page dragged a step: write the loop's new order into the manifest
        d = self._app_dir(data.get("app"))
        steps = data.get("steps")
        if not d or not isinstance(steps, list) or len(steps) > 200:
            return self._json({"error": "bad request"}, 400)
        for st in steps:
            if not (isinstance(st, str) and re.fullmatch(r"[\w-]+", st)
                    and os.path.isfile(os.path.join(d, "steps", st + ".ts"))):
                return self._json({"error": f"no such step: {st}"}, 400)
        try:
            path = appfiles.write_loop_steps(d, steps)
            if path:
                _own_writes[path] = os.stat(path).st_mtime_ns     # no page reload for it
        except (OSError, ValueError) as e:
            return self._json({"error": str(e)}, 500)
        return self._json({"ok": True})

    def _steps(self):
        # the steps of one application: /__steps?app=<name>
        import json
        from urllib.parse import parse_qs, urlparse
        app = parse_qs(urlparse(self.path).query).get("app", [""])[0]
        steps = []
        tdir = os.path.join(ROOT, "applications", app, "steps")
        if app and app == os.path.basename(app) and app not in (".", "..") and os.path.isdir(tdir):
            # a step is one file, steps/<id>.ts, that says what it is called
            # and which gripper it uses:  export const name = '...';
            for fn in sorted(os.listdir(tdir)):
                if not fn.endswith(".ts"):
                    continue
                try:
                    with open(os.path.join(tdir, fn), encoding="utf-8") as f:
                        src = f.read()
                except OSError:
                    continue
                step = {"id": fn[:-3]}
                for key in ("name", "tool"):
                    m = re.search(r"^export const %s\s*=\s*(['\"])(.*?)\1" % key, src, re.M)
                    if m:
                        step[key] = m.group(2)
                steps.append(step)
        return self._json(steps)

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


def _stdio(httpd):
    """Serve the same server to a parent process over stdin/stdout.

    The installed desktop app (an artifact page, viewer/desktop.js) cannot
    open a network connection to this machine, but it can run this program
    and talk to it through its pipes. So every request the page makes
    arrives here as one JSON line and is answered with one JSON line:

      -> {"id": 7, "method": "GET", "path": "/__steps?app=x", "headers": {...}, "body": "<base64>"}
      <- {"id": 7, "status": 200, "headers": {...}, "body": "<base64>"}

    Each is passed to the HTTP server above on its own thread, so long
    polls do not hold the others up. The first line written is
    {"ready": true}; the program ends when stdin closes.
    """
    import base64
    import http.client
    import json
    out_lock = threading.Lock()

    def reply(obj):
        with out_lock:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()

    def handle(req):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=120)
            headers = {k: v for k, v in (req.get("headers") or {}).items()
                       if k.lower() not in ("host", "origin", "content-length", "connection")}
            body = base64.b64decode(req.get("body") or "")
            conn.request(req.get("method", "GET"), req["path"], body=body or None, headers=headers)
            r = conn.getresponse()
            data = r.read()
            reply({"id": req["id"], "status": r.status, "headers": dict(r.getheaders()),
                   "body": base64.b64encode(data).decode()})
            conn.close()
        except Exception as e:                      # the page gets an answer whatever happens
            reply({"id": req.get("id"), "status": 502, "headers": {"Content-Type": "application/json"},
                   "body": base64.b64encode(json.dumps({"error": f"bridge: {e}"}).encode()).decode()})

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    reply({"ready": True, "root": ROOT})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        threading.Thread(target=handle, args=(req,), daemon=True).start()


if __name__ == "__main__":
    threading.Thread(target=_watch, daemon=True).start()
    if STDIO:
        # for the installed desktop app: any free port, nothing printed but the protocol
        with Server(("127.0.0.1", 0), Handler) as httpd:
            PORT = httpd.server_address[1]
            _stdio(httpd)
        sys.exit(0)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/viewer/"
        print(f"viewer: {url}  (live reload on, ctrl-c to stop)")
        if OPEN_BROWSER:
            threading.Timer(0.3, webbrowser.open, (url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
