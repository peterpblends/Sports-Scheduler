import { timingSafeEqual } from "node:crypto";

export function cors(req, res) {
  const allowed = (process.env.HFV_CORS || "*").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

export function send(res, code, obj) {
  res.setHeader("Cache-Control", "no-store");
  res.status(code).json(obj);
}

// HFV_TOKEN is required on Vercel: a public deployment must not accept anonymous writes.
export function authorized(req) {
  const token = process.env.HFV_TOKEN || "";
  if (!token) return false;
  const a = Buffer.from(req.headers.authorization || ""), b = Buffer.from("Bearer " + token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authError(res) {
  return send(res, 401, { error: process.env.HFV_TOKEN ? "missing or wrong access token" : "HFV_TOKEN is not set on this deployment, so sync is disabled" });
}
