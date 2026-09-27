// Runs the Vercel functions against a real Redis through a tiny Upstash-style
// REST shim. Skipped when redis-server isn't installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import http from "node:http";

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;
let redisProc, shim, port;

// Minimal RESP client: one command at a time.
function respClient(p) {
  const sock = net.connect(p, "127.0.0.1");
  let buf = Buffer.alloc(0), waiting = [];
  sock.on("data", d => { buf = Buffer.concat([buf, d]); drain(); });
  function parse(i) {
    const nl = buf.indexOf("\r\n", i); if (nl < 0) return null;
    const t = String.fromCharCode(buf[i]), line = buf.toString("utf8", i + 1, nl), next = nl + 2;
    if (t === "+") return [line, next];
    if (t === "-") return [new Error(line), next];
    if (t === ":") return [Number(line), next];
    if (t === "$") { const n = +line; if (n < 0) return [null, next]; if (buf.length < next + n + 2) return null; return [buf.toString("utf8", next, next + n), next + n + 2]; }
    if (t === "*") { const n = +line; if (n < 0) return [null, next]; const out = []; let j = next;
      for (let k = 0; k < n; k++) { const r = parse(j); if (!r) return null; out.push(r[0]); j = r[1]; } return [out, j]; }
    throw new Error("bad RESP");
  }
  function drain() { while (waiting.length) { const r = parse(0); if (!r) return; buf = buf.subarray(r[1]); waiting.shift()(r[0]); } }
  return {
    cmd: args => new Promise(res => { waiting.push(res); sock.write(`*${args.length}\r\n` + args.map(a => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("")); }),
    close: () => sock.destroy(),
  };
}

let client;
before(async () => {
  if (!hasRedis) return;
  const rport = 16379 + Math.floor(Math.random() * 1000);
  redisProc = spawn("redis-server", ["--port", String(rport), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await new Promise((ok, no) => { const s = net.connect(rport, "127.0.0.1", () => { s.destroy(); ok(); }); s.on("error", no); }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  client = respClient(rport);
  shim = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d)); req.on("end", async () => {
      if (req.headers.authorization !== "Bearer redis-token") { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      const r = await client.cmd(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r instanceof Error ? { error: r.message } : { result: r }));
    });
  });
  await new Promise(r => shim.listen(0, "127.0.0.1", r));
  port = shim.address().port;
  process.env.KV_REST_API_URL = `http://127.0.0.1:${port}`;
  process.env.KV_REST_API_TOKEN = "redis-token";
  process.env.HFV_TOKEN = "sync-token";
});
after(() => { client?.close(); shim?.close(); redisProc?.kill(); });

// Vercel-style req/res doubles.
async function call(handler, { method = "GET", query = {}, body, token = "sync-token", origin } = {}) {
  const headers = {}; if (token) headers.authorization = "Bearer " + token; if (origin) headers.origin = origin;
  const out = { code: 0, headers: {}, body: null };
  const res = {
    setHeader: (k, v) => (out.headers[k.toLowerCase()] = v),
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return this; },
    end() { return this; },
  };
  await handler({ method, query, body, headers }, res);
  return out;
}

test("vercel: health, auth, sync round trip, last writer wins", { skip: !hasRedis && "redis-server not installed" }, async () => {
  const { default: health } = await import("../api/health.js");
  const { default: sessions } = await import("../api/sessions.js");

  const h = await call(health);
  assert.equal(h.body.app, "horse-fitter-verify");
  assert.equal(h.body.matProxy, false);
  assert.equal(h.body.storage, "ok");

  assert.equal((await call(sessions, { token: null })).code, 401);
  assert.equal((await call(sessions, { token: "wrong" })).code, 401);

  const c0 = (await call(sessions, { query: { since: "0" } })).body.cursor;
  assert.equal((await call(sessions, { method: "POST", body: { id: "v1", updatedAt: 100, horse: "Juno" } })).body.status, "ok");
  assert.equal((await call(sessions, { method: "POST", body: JSON.stringify({ id: "v1", updatedAt: 200, horse: "Juno II" }) })).body.status, "ok");
  const stale = (await call(sessions, { method: "POST", body: { id: "v1", updatedAt: 150, horse: "old" } })).body;
  assert.equal(stale.status, "stale"); assert.equal(stale.session.horse, "Juno II");
  assert.equal((await call(sessions, { method: "POST", body: { id: "v1", updatedAt: 200, horse: "dup" } })).body.status, "ok");

  const page = (await call(sessions, { query: { since: String(c0) } })).body;
  assert.deepEqual(page.sessions.map(s => s.horse), ["Juno II"]);
  assert.deepEqual((await call(sessions, { query: { since: String(page.cursor) } })).body.sessions, []);
  assert.equal((await call(sessions, { query: { id: "v1" } })).body.horse, "Juno II");
  assert.equal((await call(sessions, { query: { id: "nope" } })).code, 404);

  for (const bad of [{ updatedAt: 1 }, { id: "x" }, [1], "not json"]) assert.equal((await call(sessions, { method: "POST", body: bad })).code, 400);
  assert.equal((await call(sessions, { method: "DELETE" })).code, 405);

  const pre = await call(sessions, { method: "OPTIONS", origin: "https://example.org" });
  assert.equal(pre.code, 204); assert.equal(pre.headers["access-control-allow-origin"], "https://example.org");

  // Paging: 205 new changes come back in two pages.
  const c1 = (await call(sessions, { query: { since: "0" } })).body;
  let cur = page.cursor;
  for (let i = 0; i < 205; i++) await call(sessions, { method: "POST", body: { id: "p" + i, updatedAt: 1 } });
  const p1 = (await call(sessions, { query: { since: String(cur) } })).body;
  assert.equal(p1.sessions.length, 200); assert.equal(p1.more, true);
  const p2 = (await call(sessions, { query: { since: String(p1.cursor) } })).body;
  assert.equal(p2.sessions.length, 5); assert.equal(p2.more, false);
  assert.ok(c1);
});

test("vercel: sync refuses everything when HFV_TOKEN is unset", { skip: !hasRedis && "redis-server not installed" }, async () => {
  const { default: sessions } = await import("../api/sessions.js");
  const saved = process.env.HFV_TOKEN; delete process.env.HFV_TOKEN;
  try {
    const r = await call(sessions, { token: "" });
    assert.equal(r.code, 401); assert.match(r.body.error, /HFV_TOKEN is not set/);
  } finally { process.env.HFV_TOKEN = saved; }
});
