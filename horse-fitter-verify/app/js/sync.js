// Sync: push locally changed sessions, then pull what other devices changed.
//
// Protocol (served by server.py, same code on a barn laptop or a cloud host):
//   POST /api/sessions            body: session → { status: "ok" } | { status: "stale", session }
//   GET  /api/sessions?since=N    → { sessions: [...], cursor: M, more: bool }
// Conflicts resolve last-writer-wins on updatedAt. Fields starting with "_" are
// local bookkeeping and never leave the device.

import * as store from "./store.js";

// Pure: should a copy from the server replace what this device holds?
export function takeRemote(local, remote) {
  if (!local) return true;
  if ((remote.updatedAt || 0) > (local.updatedAt || 0)) return true;
  return false;
}

export function forUpload(session) {
  const out = {};
  for (const k of Object.keys(session)) if (!k.startsWith("_")) out[k] = session[k];
  return out;
}

export function apiBase(syncUrl) {
  const u = (syncUrl || "").trim().replace(/\/+$/, "");
  return u ? (u.endsWith("/api") ? u : u + "/api") : new URL("api", location.href).href.replace(/\/$/, "");
}

export function createSync({ getConfig, onChange = () => {}, onStatus = () => {} }) {
  let running = null, timer = null, last = { state: "idle" };
  const status = s => { last = { ...last, ...s }; onStatus(last); };

  async function call(base, path, opts = {}) {
    const { syncToken } = getConfig();
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(base + path, {
        ...opts, signal: ctl.signal, cache: "no-store",
        headers: { "content-type": "application/json", ...(syncToken ? { authorization: "Bearer " + syncToken } : {}), ...(opts.headers || {}) },
      });
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error(syncToken ? "The sync server refused the access token. Check it in Settings → Sync."
          : "This sync server needs an access token. Enter it in Settings → Sync."), { auth: true });
      }
      if (!r.ok) throw new Error(`Sync server answered ${r.status}`);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  async function run() {
    const cfg = getConfig();
    if (!cfg.syncEnabled) { status({ state: "off", pending: await pendingCount() }); return; }
    const base = apiBase(cfg.syncUrl);
    if (location.protocol === "https:" && base.startsWith("http:")) {
      status({ state: "error", message: "An HTTPS page can't sync to an http:// server. Use an https:// sync address." });
      return;
    }
    status({ state: "syncing" });
    let pushed = 0, pulled = 0;
    try {
      // Push.
      const all = await store.listSessions({ includeDeleted: true });
      for (const s of all.filter(x => x._dirty)) {
        const sentAt = s.updatedAt;
        let res;
        try { res = await call(base, "/sessions", { method: "POST", body: JSON.stringify(forUpload(s)) }); }
        catch (e) {
          if (e.auth || e.name === "AbortError" || e instanceof TypeError) throw e; // server unreachable or auth: stop
          const cur = await store.getSession(s.id);
          if (cur) { cur._syncError = e.message; await store.putSessionRaw(cur); }
          continue;
        }
        const cur = await store.getSession(s.id);
        if (res.status === "stale" && res.session) {
          await store.putSessionRaw({ ...res.session, _dirty: false, _syncedAt: Date.now() });
          pulled++;
        } else if (cur && cur.updatedAt === sentAt) {
          cur._dirty = false; cur._syncedAt = Date.now(); delete cur._syncError;
          await store.putSessionRaw(cur);
        }
        pushed++;
      }
      // Pull.
      const cursorKey = "cursor:" + base;
      let cursor = (await store.getMeta(cursorKey)) || 0, more = true, guard = 0;
      while (more && guard++ < 50) {
        const res = await call(base, "/sessions?since=" + encodeURIComponent(cursor));
        for (const remote of res.sessions || []) {
          const local = await store.getSession(remote.id);
          if (takeRemote(local, remote)) {
            await store.putSessionRaw({ ...remote, _dirty: false, _syncedAt: Date.now() });
            if (remote.deleted) await store.deleteFrames(remote.id);
            pulled++;
          }
        }
        cursor = res.cursor ?? cursor; more = !!res.more;
      }
      await store.setMeta(cursorKey, cursor);
      await store.setMeta("lastSync", Date.now());
      status({ state: "ok", at: Date.now(), pending: await pendingCount(), message: "" });
      if (pushed || pulled) onChange({ pushed, pulled });
    } catch (e) {
      const offline = !navigator.onLine || e.name === "AbortError" || e instanceof TypeError;
      status({ state: offline ? "offline" : "error", pending: await pendingCount(), message: offline ? "Sync server not reachable. Changes are saved on this device." : e.message });
    }
  }

  // Coalesce overlapping requests: one run at a time, one queued behind it.
  let queued = false;
  function sync() {
    if (running) { queued = true; return running; }
    running = run().finally(() => { running = null; if (queued) { queued = false; sync(); } });
    return running;
  }

  function start() {
    addEventListener("online", () => sync());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);
    sync();
  }

  return { sync, start, get status() { return last; } };
}

export async function pendingCount() {
  const all = await store.listSessions({ includeDeleted: true });
  return all.filter(s => s._dirty).length;
}
