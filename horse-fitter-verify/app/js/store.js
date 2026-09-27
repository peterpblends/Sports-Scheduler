// Local, offline-first storage in IndexedDB. Everything the app does lands here
// first; sync.js copies it to a server whenever one is reachable.
//
// Stores:
//   sessions  fit-check sessions (summaries, verdicts), keyPath "id"
//   frames    raw frames per phase, key "<sessionId>/<phaseKey>" (never synced)
//   meta      key/value: settings, device id, sync cursors

const DB_NAME = "horse-fitter-verify", DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const q = indexedDB.open(DB_NAME, DB_VERSION);
    q.onupgradeneeded = () => {
      const db = q.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("frames")) db.createObjectStore("frames");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => { dbp = null; reject(q.error); };
    q.onblocked = () => reject(new Error("Database is open in another tab with an older version. Close other tabs and reload."));
  });
  return dbp;
}

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then(v => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction aborted"));
  });
}

// ---------- sessions ----------

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2));

export const getSession = id => tx("sessions", "readonly", s => req(s.get(id)));

export async function listSessions({ includeDeleted = false } = {}) {
  const all = await tx("sessions", "readonly", s => req(s.getAll()));
  return all.filter(x => includeDeleted || !x.deleted).sort((a, b) => b.createdAt - a.createdAt);
}

// Save a local edit: bumps updatedAt and marks the session for upload.
export async function saveSession(session) {
  session.updatedAt = Math.max(Date.now(), (session.updatedAt || 0) + 1);
  session._dirty = true;
  delete session._syncError;
  await tx("sessions", "readwrite", s => req(s.put(session)));
  return session;
}

// Write a session exactly as given (used by sync to apply server copies).
export const putSessionRaw = session => tx("sessions", "readwrite", s => req(s.put(session)));

// Deletes are tombstones so the deletion syncs to other devices too.
export async function deleteSession(id) {
  const s = await getSession(id);
  if (!s) return;
  await deleteFrames(id);
  await saveSession({ id, createdAt: s.createdAt, deleted: true, updatedAt: s.updatedAt });
}

// ---------- raw frames (local only) ----------
// Stored as one Float32Array per frame to keep a 30 s capture around 3 MB.

export async function putFrames(sessionId, phaseKey, { rows, cols, frames, times, withers, mirror }) {
  const packed = frames.map(g => { const a = new Float32Array(rows * cols); let i = 0; for (const row of g) for (const v of row) a[i++] = v; return a; });
  await tx("frames", "readwrite", s => req(s.put({ rows, cols, times, withers, mirror, frames: packed }, `${sessionId}/${phaseKey}`)));
}

export async function getFrames(sessionId, phaseKey) {
  const rec = await tx("frames", "readonly", s => req(s.get(`${sessionId}/${phaseKey}`)));
  if (!rec) return null;
  const { rows, cols } = rec;
  const frames = rec.frames.map(a => Array.from({ length: rows }, (_, r) => Array.from(a.subarray(r * cols, (r + 1) * cols))));
  return { ...rec, frames };
}

export async function deleteFrames(sessionId, phaseKey) {
  await tx("frames", "readwrite", async s => {
    if (phaseKey) return req(s.delete(`${sessionId}/${phaseKey}`));
    const keys = await req(s.getAllKeys());
    await Promise.all(keys.filter(k => k.startsWith(sessionId + "/")).map(k => req(s.delete(k))));
  });
}

// ---------- meta ----------

export const getMeta = key => tx("meta", "readonly", s => req(s.get(key)));
export const setMeta = (key, value) => tx("meta", "readwrite", s => req(s.put(value, key)));

export async function deviceId() {
  let id = await getMeta("deviceId");
  if (!id) { id = newId(); await setMeta("deviceId", id); }
  return id;
}
