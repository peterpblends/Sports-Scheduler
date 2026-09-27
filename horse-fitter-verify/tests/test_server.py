"""Server tests: static files, sync API, auth, mat proxy (including SSE), upstream
store-and-forward. Each server runs as a real subprocess on a free port."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def req(url, body=None, method=None, token=None, raw=False):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=headers, method=method or ("POST" if data else "GET"))
    with urllib.request.urlopen(r, timeout=10) as res:
        out = res.read()
        return (res, out) if raw else json.loads(out)


def wait_until(fn, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(0.1)
    raise AssertionError("condition not met in time")


class FakeMat(BaseHTTPRequestHandler):
    """Mimics the Tactilus WiFi module: PUT /api/frequency, SSE on /api/sse."""
    protocol_version = "HTTP/1.1"
    frequency = None

    def log_message(self, *a):
        pass

    def do_PUT(self):
        n = int(self.headers.get("Content-Length") or 0)
        FakeMat.frequency = self.rfile.read(n).decode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        if self.path != "/api/sse":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for i in range(3):
            frame = {"readings": [[[i, 1], [2, 3]]], "timestamp": 1000 + i}
            self.wfile.write(("event: newframe\ndata: %s\n\n" % json.dumps(frame)).encode())
            self.wfile.flush()
            time.sleep(0.05)


class Server:
    def __init__(self, *args):
        self.port = free_port()
        self.dir = tempfile.mkdtemp()
        self.url = "http://127.0.0.1:%d" % self.port
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server.py"), "--host", "127.0.0.1", "--port", str(self.port),
             "--db", os.path.join(self.dir, "s.db"), *args],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_until(lambda: req(self.url + "/api/health")["ok"])

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mat = ThreadingHTTPServer(("127.0.0.1", 0), FakeMat)
        threading.Thread(target=cls.mat.serve_forever, daemon=True).start()
        cls.mat_url = "http://127.0.0.1:%d" % cls.mat.server_address[1]
        cls.s = Server("--mat", cls.mat_url)

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()
        cls.mat.shutdown()

    def test_health(self):
        h = req(self.s.url + "/api/health")
        self.assertEqual(h["app"], "horse-fitter-verify")
        self.assertTrue(h["matProxy"])

    def test_static_and_traversal(self):
        res, body = req(self.s.url + "/", raw=True)
        self.assertIn(b"Horse Fitter Verify", body)
        res, _ = req(self.s.url + "/manifest.webmanifest", raw=True)
        self.assertEqual(res.headers["Content-Type"].split(";")[0], "application/manifest+json")
        res, _ = req(self.s.url + "/js/app.js", raw=True)
        self.assertTrue(res.headers["Content-Type"].startswith("text/javascript"))
        with self.assertRaises(urllib.error.HTTPError) as e:
            req(self.s.url + "/../server.py")
        self.assertIn(e.exception.code, (403, 404))
        with self.assertRaises(urllib.error.HTTPError) as e:
            req(self.s.url + "/%2e%2e/server.py")
        self.assertIn(e.exception.code, (403, 404))

    def test_sync_roundtrip_and_last_writer_wins(self):
        base = self.s.url + "/api/sessions"
        cursor = req(base + "?since=0")["cursor"]
        self.assertEqual(req(base, {"id": "a1", "updatedAt": 100, "horse": "Bramble"})["status"], "ok")
        self.assertEqual(req(base, {"id": "a1", "updatedAt": 200, "horse": "Bramble II"})["status"], "ok")
        stale = req(base, {"id": "a1", "updatedAt": 150, "horse": "old"})
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["session"]["horse"], "Bramble II")
        page = req(base + "?since=%d" % cursor)
        self.assertEqual([s["horse"] for s in page["sessions"] if s["id"] == "a1"], ["Bramble II"])
        self.assertEqual(req(base + "?since=%d" % page["cursor"])["sessions"], [])
        self.assertEqual(req(base + "/a1")["updatedAt"], 200)

    def test_rejects_bad_sessions(self):
        for bad in ({"updatedAt": 1}, {"id": "x"}, {"id": "", "updatedAt": 1}, [1, 2]):
            with self.assertRaises(urllib.error.HTTPError) as e:
                req(self.s.url + "/api/sessions", bad)
            self.assertEqual(e.exception.code, 400)

    def test_mat_proxy_put_and_sse(self):
        res, body = req(self.s.url + "/mat/api/frequency", method="PUT", raw=True,
                        body="10800")  # JSON-encoded string; the fake mat only records it
        self.assertEqual(body, b"ok")
        self.assertIn("10800", FakeMat.frequency)
        res, body = req(self.s.url + "/mat/api/sse", raw=True)
        self.assertEqual(res.headers["Content-Type"], "text/event-stream")
        events = [json.loads(l[6:]) for l in body.decode().splitlines() if l.startswith("data: ")]
        self.assertEqual([e["timestamp"] for e in events], [1000, 1001, 1002])


class AuthTests(unittest.TestCase):
    def test_token_required(self):
        s = Server("--no-mat", "--token", "sekret")
        try:
            with self.assertRaises(urllib.error.HTTPError) as e:
                req(s.url + "/api/sessions?since=0")
            self.assertEqual(e.exception.code, 401)
            with self.assertRaises(urllib.error.HTTPError):
                req(s.url + "/api/sessions?since=0", token="wrong")
            self.assertEqual(req(s.url + "/api/sessions?since=0", token="sekret")["sessions"], [])
            self.assertFalse(req(s.url + "/api/health")["matProxy"])
            with self.assertRaises(urllib.error.HTTPError) as e:
                req(s.url + "/mat/api/sse")
            self.assertEqual(e.exception.code, 404)
        finally:
            s.stop()


class UpstreamTests(unittest.TestCase):
    def test_barn_forwards_to_cloud_and_pulls_back(self):
        cloud = Server("--no-mat", "--token", "t0k")
        barn = Server("--no-mat", "--upstream", cloud.url, "--upstream-token", "t0k", "--upstream-interval", "0.3")
        try:
            # A phone syncs to the barn server; the barn forwards it to the cloud.
            req(barn.url + "/api/sessions", {"id": "s1", "updatedAt": 10, "horse": "Pepper"})
            wait_until(lambda: req(cloud.url + "/api/sessions/s1", token="t0k")["horse"] == "Pepper")
            # An office edit on the cloud flows back to the barn.
            req(cloud.url + "/api/sessions", {"id": "s1", "updatedAt": 20, "horse": "Pepper", "notes": "office"}, token="t0k")
            wait_until(lambda: req(barn.url + "/api/sessions/s1").get("notes") == "office")
            # Deletions travel as tombstones.
            req(barn.url + "/api/sessions", {"id": "s1", "updatedAt": 30, "deleted": True})
            wait_until(lambda: req(cloud.url + "/api/sessions/s1", token="t0k").get("deleted") is True)
            wait_until(lambda: req(barn.url + "/api/health")["upstreamPending"] == 0)
        finally:
            barn.stop()
            cloud.stop()

    def test_barn_queues_while_cloud_is_down(self):
        port = free_port()
        barn = Server("--no-mat", "--upstream", "http://127.0.0.1:%d" % port, "--upstream-interval", "0.3")
        try:
            req(barn.url + "/api/sessions", {"id": "q1", "updatedAt": 1})
            time.sleep(0.8)
            h = req(barn.url + "/api/health")
            self.assertEqual(h["upstreamPending"], 1)
            self.assertFalse(h["upstreamState"]["ok"])
        finally:
            barn.stop()


if __name__ == "__main__":
    unittest.main()
