import { cors, send } from "./_lib/http.js";
import { count } from "./_lib/store.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  let sessions = null, storage = "ok";
  try { sessions = await count(); } catch (e) { storage = e.message; }
  send(res, 200, {
    ok: true, app: "horse-fitter-verify", version: "1.0.0", time: Date.now(), host: "vercel",
    matProxy: false, auth: true, tokenConfigured: !!process.env.HFV_TOKEN, storage, sessions,
    upstream: null, upstreamPending: 0, upstreamState: null,
  });
}
