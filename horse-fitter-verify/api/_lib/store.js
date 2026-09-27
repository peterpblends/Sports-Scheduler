// Sync storage for the Vercel deployment: Upstash Redis over its REST API (no
// dependencies). Same protocol and semantics as server.py's SQLite store:
// last-writer-wins on updatedAt, and a server-side change counter (seq) that
// clients pull from, so device clock skew never hides a change.
//
// Keys: hfv:body (hash id → JSON), hfv:upd (hash id → updatedAt),
//       hfv:seq (sorted set id by seq), hfv:counter (last seq).

const PAGE = 200;

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw Object.assign(new Error("No Redis database is connected to this Vercel project (KV_REST_API_URL / KV_REST_API_TOKEN missing)."), { status: 503 });
  return { url: url.replace(/\/+$/, ""), token };
}

export async function redis(...cmd) {
  const { url, token } = creds();
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Redis: " + (j.error || r.status));
  return j.result;
}

// Atomic compare-and-set, so the counter and the index always move together.
const UPSERT = `
local cur = redis.call('HGET', KEYS[2], ARGV[1])
if cur then
  local c, u = tonumber(cur), tonumber(ARGV[2])
  if c > u then return {'stale', redis.call('HGET', KEYS[1], ARGV[1])} end
  if c == u then return {'same'} end
end
local seq = redis.call('INCR', KEYS[4])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[3], seq, ARGV[1])
return {'ok'}`;
const KEYS = ["hfv:body", "hfv:upd", "hfv:seq", "hfv:counter"];

export async function upsert(session) {
  const [status, body] = await redis("EVAL", UPSERT, KEYS.length, ...KEYS, session.id, String(Math.trunc(session.updatedAt)), JSON.stringify(session));
  return status === "stale" ? { accepted: false, current: JSON.parse(body) } : { accepted: true, current: session };
}

export async function since(seq) {
  const flat = await redis("ZRANGEBYSCORE", "hfv:seq", `(${seq}`, "+inf", "WITHSCORES", "LIMIT", 0, PAGE + 1);
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) rows.push([flat[i], Number(flat[i + 1])]);
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  if (!page.length) return { sessions: [], cursor: seq, more: false };
  const bodies = await redis("HMGET", "hfv:body", ...page.map(r => r[0]));
  return { sessions: bodies.filter(Boolean).map(b => JSON.parse(b)), cursor: page[page.length - 1][1], more };
}

export async function get(id) {
  const b = await redis("HGET", "hfv:body", id);
  return b ? JSON.parse(b) : null;
}

export const count = () => redis("HLEN", "hfv:body");

export function validSession(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "body must be a JSON object";
  if (typeof s.id !== "string" || !s.id.length || s.id.length > 100) return "id must be a string of 1–100 characters";
  if (typeof s.updatedAt !== "number" || !isFinite(s.updatedAt)) return "updatedAt must be a number (ms since epoch)";
  return null;
}
