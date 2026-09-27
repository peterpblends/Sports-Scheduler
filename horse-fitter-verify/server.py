#!/usr/bin/env python3
"""Horse Fitter Verify server. Python 3.8+, standard library only.

One file, three jobs:
  1. Serves the PWA (./app).
  2. Proxies the Tactilus mat under /mat/ so the browser talks to one origin
     (no CORS or mixed-content trouble with the mat's plain-HTTP API).
  3. Stores synced fit-check sessions in SQLite (/api/sessions) and, with
     --upstream, forwards them to another copy of this server (e.g. a cloud
     host) whenever that is reachable, and pulls back changes made elsewhere.

At the barn:   python3 server.py                       (open the printed address)
In the cloud:  python3 server.py --host 0.0.0.0 --port 8080 --no-mat --token SECRET   (behind HTTPS)
Barn → cloud:  python3 server.py --upstream https://fit.example.com --upstream-token SECRET
"""
import argparse
import hmac
import json
import mimetypes
import os
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT, "app")
MAX_BODY = 20 * 1024 * 1024
PAGE = 200

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


# ---------------------------------------------------------------- storage

class Store:
    """Sessions keyed by id, last-writer-wins on updatedAt.

    seq is a local, monotonically increasing change counter; clients pull with
    ?since=<seq> so device clock skew never hides a change.
    forwarded is 0 for changes that still need to go upstream.
    """

    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0, forwarded INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)""")
        self.db.execute("CREATE INDEX IF NOT EXISTS sessions_seq ON sessions(seq)")
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
        self.db.commit()

    def _next_seq(self):
        row = self.db.execute("SELECT COALESCE(MAX(seq), 0) FROM sessions").fetchone()
        return row[0] + 1

    def get(self, sid):
        with self.lock:
            row = self.db.execute("SELECT body FROM sessions WHERE id=?", (sid,)).fetchone()
        return json.loads(row[0]) if row else None

    def upsert(self, session, forwarded=0):
        """Returns (accepted, current). Not accepted means the stored copy is newer."""
        sid, updated = session["id"], int(session.get("updatedAt") or 0)
        with self.lock:
            row = self.db.execute("SELECT updated_at, body FROM sessions WHERE id=?", (sid,)).fetchone()
            if row and row[0] > updated:
                return False, json.loads(row[1])
            if row and row[0] == updated:
                return True, json.loads(row[1])  # already have this version
            self.db.execute(
                "INSERT OR REPLACE INTO sessions (id, updated_at, seq, deleted, forwarded, body) VALUES (?,?,?,?,?,?)",
                (sid, updated, self._next_seq(), 1 if session.get("deleted") else 0, forwarded, json.dumps(session, separators=(",", ":"))))
            self.db.commit()
            return True, session

    def since(self, seq, limit=PAGE):
        with self.lock:
            rows = self.db.execute("SELECT seq, body FROM sessions WHERE seq > ? ORDER BY seq LIMIT ?", (seq, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return [json.loads(b) for _, b in rows], (rows[-1][0] if rows else seq), more

    def unforwarded(self):
        with self.lock:
            rows = self.db.execute("SELECT updated_at, body FROM sessions WHERE forwarded=0 ORDER BY seq").fetchall()
        return [(u, json.loads(b)) for u, b in rows]

    def mark_forwarded(self, sid, updated):
        with self.lock:
            self.db.execute("UPDATE sessions SET forwarded=1 WHERE id=? AND updated_at=?", (sid, updated))
            self.db.commit()

    def meta(self, k, v=None):
        with self.lock:
            if v is None:
                row = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
                return row[0] if row else None
            self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?,?)", (k, str(v)))
            self.db.commit()

    def counts(self):
        with self.lock:
            total, pending = self.db.execute(
                "SELECT COALESCE(SUM(deleted=0), 0), COALESCE(SUM(forwarded=0), 0) FROM sessions").fetchone()
        return total, pending


def valid_session(s):
    if not isinstance(s, dict):
        return "body must be a JSON object"
    if not isinstance(s.get("id"), str) or not (0 < len(s["id"]) <= 100):
        return "id must be a string of 1–100 characters"
    if not isinstance(s.get("updatedAt"), (int, float)):
        return "updatedAt must be a number (ms since epoch)"
    return None


# ---------------------------------------------------------------- upstream

class Upstream(threading.Thread):
    """Store-and-forward to another server: push local changes, pull remote ones."""

    def __init__(self, store, url, token, interval):
        super().__init__(daemon=True)
        self.store, self.base = store, url.rstrip("/")
        if not self.base.endswith("/api"):
            self.base += "/api"
        self.token, self.interval = token, interval
        self.state = {"ok": None, "at": None, "error": None}
        self.wake = threading.Event()

    def call(self, path, body=None):
        headers = {"content-type": "application/json", "user-agent": "horse-fitter-verify/" + VERSION}
        if self.token:
            headers["authorization"] = "Bearer " + self.token
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method="POST" if data else "GET")
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")

    def once(self):
        pushed = pulled = 0
        for updated, s in self.store.unforwarded():
            res = self.call("/sessions", s)
            if res.get("status") == "stale" and res.get("session"):
                self.store.upsert(res["session"], forwarded=1)
                pulled += 1
            self.store.mark_forwarded(s["id"], updated)
            pushed += 1
        cursor = int(self.store.meta("upstream_cursor") or 0)
        for _ in range(100):
            res = self.call("/sessions?since=%d" % cursor)
            for s in res.get("sessions", []):
                if valid_session(s) is None:
                    ok, _ = self.store.upsert(s, forwarded=1)
                    pulled += 1 if ok else 0
            cursor = int(res.get("cursor", cursor))
            self.store.meta("upstream_cursor", cursor)
            if not res.get("more"):
                break
        return pushed, pulled

    def run(self):
        while True:
            try:
                pushed, pulled = self.once()
                self.state = {"ok": True, "at": int(time.time() * 1000), "error": None}
                if pushed or pulled:
                    log("upstream: pushed %d, pulled %d" % (pushed, pulled))
            except (urllib.error.URLError, OSError, ValueError) as e:
                if self.state.get("ok") is not False:
                    log("upstream not reachable (%s); will keep trying" % getattr(e, "reason", e))
                self.state = {"ok": False, "at": self.state.get("at"), "error": str(getattr(e, "reason", e))}
            self.wake.wait(self.interval)
            self.wake.clear()


# ---------------------------------------------------------------- http

def log(msg):
    sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))


class Handler(BaseHTTPRequestHandler):
    server_version = "HorseFitterVerify/" + VERSION
    protocol_version = "HTTP/1.1"
    cfg = None  # set in main()

    def log_message(self, fmt, *args):
        if self.cfg.verbose:
            log("%s %s" % (self.address_string(), fmt % args))

    # --- helpers
    def cors(self):
        origin = self.headers.get("Origin")
        allowed = self.cfg.cors
        if origin and ("*" in allowed or origin in allowed):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def json(self, code, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if not self.cfg.token:
            return True
        given = self.headers.get("Authorization", "").encode()
        return hmac.compare_digest(given, ("Bearer " + self.cfg.token).encode())

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("body too large")
        return self.rfile.read(n) if n else b""

    # --- routing
    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/mat/"):
            return self.proxy_mat()
        if path == "/api/health":
            total, pending = self.cfg.store.counts()
            up = self.cfg.upstream
            return self.json(200, {
                "ok": True, "app": "horse-fitter-verify", "version": VERSION, "time": int(time.time() * 1000),
                "matProxy": bool(self.cfg.mat), "sessions": total, "auth": bool(self.cfg.token),
                "upstream": up.base if up else None, "upstreamPending": pending if up else 0,
                "upstreamState": up.state if up else None,
            })
        if path == "/api/sessions":
            if not self.authorized():
                return self.json(401, {"error": "missing or wrong access token"})
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                since = int(q.get("since", ["0"])[0])
            except ValueError:
                return self.json(400, {"error": "since must be an integer"})
            sessions, cursor, more = self.cfg.store.since(since)
            return self.json(200, {"sessions": sessions, "cursor": cursor, "more": more})
        if path.startswith("/api/sessions/"):
            if not self.authorized():
                return self.json(401, {"error": "missing or wrong access token"})
            s = self.cfg.store.get(urllib.parse.unquote(path[len("/api/sessions/"):]))
            return self.json(200, s) if s else self.json(404, {"error": "not found"})
        if path.startswith("/api/"):
            return self.json(404, {"error": "not found"})
        return self.static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/mat/"):
            return self.proxy_mat()
        if path == "/api/sessions":
            if not self.authorized():
                return self.json(401, {"error": "missing or wrong access token"})
            try:
                s = json.loads(self.read_body() or b"null")
            except ValueError as e:
                return self.json(400, {"error": "invalid JSON: %s" % e})
            err = valid_session(s)
            if err:
                return self.json(400, {"error": err})
            accepted, current = self.cfg.store.upsert(s)
            if self.cfg.upstream and accepted:
                self.cfg.upstream.wake.set()
            if accepted:
                return self.json(200, {"status": "ok", "updatedAt": current.get("updatedAt")})
            return self.json(200, {"status": "stale", "session": current})
        return self.json(404, {"error": "not found"})

    def do_PUT(self):
        if urllib.parse.urlparse(self.path).path.startswith("/mat/"):
            return self.proxy_mat()
        return self.json(405, {"error": "method not allowed"})

    # --- static files
    def static(self, path):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(APP_DIR, rel))
        if not (full == APP_DIR or full.startswith(APP_DIR + os.sep)):
            return self.json(403, {"error": "forbidden"})
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self.json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith(("json", "javascript")) else ""))
        self.send_header("Content-Length", str(len(data)))
        # Revalidate every time; the service worker handles offline.
        self.send_header("Cache-Control", "no-cache")
        if full.endswith("sw.js"):
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # --- mat proxy (streams SSE through unbuffered)
    def proxy_mat(self):
        if not self.cfg.mat:
            return self.json(404, {"error": "mat proxy disabled on this server"})
        target = self.cfg.mat + self.path[len("/mat"):]
        body = self.read_body() if self.command in ("POST", "PUT") else None
        headers = {k: v for k, v in self.headers.items() if k.lower() in ("content-type", "accept", "last-event-id")}
        req = urllib.request.Request(target, data=body, headers=headers, method=self.command)
        try:
            up = urllib.request.urlopen(req, timeout=self.cfg.mat_timeout)
        except urllib.error.HTTPError as e:
            up = e
        except (urllib.error.URLError, OSError) as e:
            return self.json(502, {"error": "mat not reachable at %s (%s)" % (self.cfg.mat, getattr(e, "reason", e))})
        with up:
            ctype = up.headers.get("Content-Type", "application/octet-stream")
            streaming = "text/event-stream" in ctype
            self.send_response(up.status if hasattr(up, "status") else up.code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            if streaming:
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                try:
                    while True:
                        chunk = up.read1(65536) if hasattr(up, "read1") else up.read(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
                    pass
            else:
                data = up.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)


def lan_ip(towards):
    try:
        host = urllib.parse.urlparse(towards).hostname or "8.8.8.8"
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((host, 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main(argv=None):
    p = argparse.ArgumentParser(description="Horse Fitter Verify server")
    p.add_argument("--host", default=os.environ.get("HFV_HOST", "0.0.0.0"))
    p.add_argument("--port", type=int, default=int(os.environ.get("HFV_PORT", "8080")))
    p.add_argument("--db", default=os.environ.get("HFV_DB", os.path.join(ROOT, "data", "sessions.db")))
    p.add_argument("--mat", default=os.environ.get("HFV_MAT", "http://10.0.0.1"), help="mat base URL to proxy under /mat/")
    p.add_argument("--no-mat", action="store_true", help="disable the mat proxy (cloud deployments)")
    p.add_argument("--mat-timeout", type=float, default=30.0, help="seconds without data before the mat stream is dropped")
    p.add_argument("--token", default=os.environ.get("HFV_TOKEN", ""), help="require this bearer token for /api/sessions")
    p.add_argument("--cors", default=os.environ.get("HFV_CORS", "*"), help="comma-separated allowed origins for /api (* = any)")
    p.add_argument("--upstream", default=os.environ.get("HFV_UPSTREAM", ""), help="another server to forward sessions to")
    p.add_argument("--upstream-token", default=os.environ.get("HFV_UPSTREAM_TOKEN", ""))
    p.add_argument("--upstream-interval", type=float, default=30.0)
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)

    os.makedirs(os.path.dirname(os.path.abspath(a.db)), exist_ok=True)
    store = Store(a.db)
    up = None
    if a.upstream:
        up = Upstream(store, a.upstream, a.upstream_token, a.upstream_interval)
        up.start()

    class Cfg:
        pass
    cfg = Cfg()
    cfg.store, cfg.upstream, cfg.token, cfg.verbose = store, up, a.token, a.verbose
    cfg.mat = None if a.no_mat else a.mat.rstrip("/")
    cfg.mat_timeout = a.mat_timeout
    cfg.cors = {o.strip() for o in a.cors.split(",") if o.strip()}
    Handler.cfg = cfg

    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    httpd.daemon_threads = True
    ip = lan_ip(cfg.mat or "http://8.8.8.8")
    print("Horse Fitter Verify %s" % VERSION)
    print("  App:       http://%s:%d   (open this on phones/tablets on the same network)" % (ip, a.port))
    print("  Sessions:  %s" % os.path.abspath(a.db))
    print("  Mat proxy: %s" % (cfg.mat + " → /mat/" if cfg.mat else "off"))
    print("  Upstream:  %s" % (up.base if up else "none"))
    if a.token:
        print("  Access token required for sync.")
    print("Ctrl+C to stop.")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
