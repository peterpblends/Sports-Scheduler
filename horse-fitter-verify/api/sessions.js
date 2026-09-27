// GET  /api/sessions?since=N   changes after server change counter N
// POST /api/sessions           upsert one session (last writer wins)
// GET  /api/sessions/<id>      one session (rewritten to ?id=<id> in vercel.json)
import { cors, send, authorized, authError } from "./_lib/http.js";
import { upsert, since, get, validSession } from "./_lib/store.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!authorized(req)) return authError(res);
  try {
    if (req.method === "GET") {
      if (req.query.id) {
        const s = await get(String(req.query.id));
        return s ? send(res, 200, s) : send(res, 404, { error: "not found" });
      }
      const n = Number(req.query.since ?? 0);
      if (!Number.isInteger(n)) return send(res, 400, { error: "since must be an integer" });
      return send(res, 200, await since(n));
    }
    if (req.method === "POST") {
      let s = req.body;
      if (typeof s === "string") { try { s = JSON.parse(s); } catch (e) { return send(res, 400, { error: "invalid JSON" }); } }
      const err = validSession(s);
      if (err) return send(res, 400, { error: err });
      const { accepted, current } = await upsert(s);
      return send(res, 200, accepted ? { status: "ok", updatedAt: current.updatedAt } : { status: "stale", session: current });
    }
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return send(res, 405, { error: "method not allowed" });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
}
