# Horse Fitter Verify

Pressure-mat PWA that verifies saddle and rider fit. It streams a Tactilus mat over the mat's own WiFi, captures each phase of a fit check (saddle only, rider at halt, walk, trot, canter), scores it against fit thresholds, and produces a report. It works with no internet at all, and syncs sessions whenever a sync server is reachable.

## What it checks

Every capture is analysed in saddle coordinates (withers at the top, horse's left on the left):

| Check | What it looks at |
|---|---|
| Left / right balance | Share of load on each side |
| Bridging / rocking | Middle-third share vs front and back |
| Front (tree points) | Front-third share: tree too narrow, pinching |
| Back (cantle) | Back-third share: tree too wide, tipping back |
| Spine clearance | Load inside the central spine channel |
| Pressure hotspots | Cells well above the mean loaded pressure |
| Rider lateral shift | Change in balance vs the saddle-only phase |
| Rider stability, rocking in motion | Sway of the centre of pressure |

Each check comes out as OK, Caution or Fail, with a note on what usually causes the problem. **The thresholds are starting points, not clinically validated limits.** Tune them in Settings to your mat and your own standards. The report supports a fitter's judgement; it doesn't replace it.

## Running it

Everything is in `server.py`, which uses only the Python 3.8+ standard library. There is no build step.

### At the barn (no internet needed)

1. Join the mat's WiFi with a laptop, Raspberry Pi or similar.
2. `python3 server.py`. It prints an address such as `http://10.0.0.42:8080`.
3. Open that address on phones and tablets joined to the mat's WiFi. On **Live**, tap **Connect**.

The server proxies the mat under `/mat/`, so the browser only talks to one origin. That avoids CORS problems with the mat's API. Untick "Connect through this server" to talk to `http://10.0.0.1` directly.

Tap **Demo** to try everything without the mat. The scenarios cover a good fit, bridging, rocking, too narrow, too wide, a narrow channel, uneven panels, and a rider sitting to one side.

### Sync

Sessions are saved on the device (IndexedDB) the moment they're captured. The device pushes changes and pulls changes from other devices whenever the sync server is reachable: on start, on reconnect, when the app comes to the foreground, and every minute. The sync pill in the header shows the state (Synced / *n* to sync / Offline).

- **Default:** devices sync to the barn server they loaded the app from. That works on the mat's WiFi with no internet.
- **To the cloud:** run a second copy of `server.py` on a host with HTTPS:
  ```
  python3 server.py --no-mat --token SECRET          # or: docker build -t hfv . && docker run -p 8080:8080 -e HFV_TOKEN=SECRET -v hfv:/data hfv
  ```
  Then start the barn server with an upstream:
  ```
  python3 server.py --upstream https://fit.example.com --upstream-token SECRET
  ```
  The barn server queues sessions and forwards them whenever it has internet. It also pulls down changes made elsewhere, such as edits in the office.
- A device can also sync straight to the cloud. Put the address and token in Settings → Sync.

Conflicts resolve last-writer-wins per session. Deletions sync as tombstones. Raw frames stay on the capturing device; the summaries, mean/peak maps and verdicts are what sync. **Export session** includes the raw frames.

### Offline app / install

Over HTTPS or `localhost`, a service worker caches the app, so it opens with no connection and can be installed to the home screen. Over plain HTTP from the barn server, the browser won't run a service worker. The app still loads over the local network without internet, and all data is stored locally either way.

Why plain HTTP at the barn: the mat's API is plain HTTP, and an HTTPS page isn't allowed to call it (mixed content). Use HTTP at the barn and HTTPS for the cloud copy.

## First connection to a real mat

- The status line shows the grid size (rows × cols) and frame rate. Please note them.
- Check **Settings → Mat orientation** so the front of the saddle is at the top of the live map and left is left.
- If the values are raw counts rather than pressure, leave the units label blank. Verdicts are mostly ratio-based, so they still work. The hotspot limit is relative by default for the same reason.

## Development

```
npm test               # JS unit tests (node --test) + server tests (unittest)
python3 server.py -v   # serve with request logging
```

| Path | Purpose |
|---|---|
| `app/index.html`, `app/css/app.css` | UI shell |
| `app/js/app.js` | UI controller: live view, capture, reports, settings |
| `app/js/analysis.js` | Pure fit analysis and verdicts |
| `app/js/demo.js` | Saddle simulator |
| `app/js/mat.js` | Mat SSE client and demo source |
| `app/js/store.js` | IndexedDB storage |
| `app/js/sync.js` | Push/pull sync client |
| `app/sw.js` | Offline app shell, background sync |
| `server.py` | Static server, mat proxy, sync API (SQLite), upstream forwarding |
| `scripts/make-icons.mjs` | Regenerates PNG icons from the SVG |

Sync API: `POST /api/sessions` (upsert, returns `{status:"ok"}` or `{status:"stale", session}`), `GET /api/sessions?since=<cursor>` (changes after a server-side change counter), `GET /api/health`.

It also imports recordings exported by the earlier Tactilus Mat app (Sessions → Import).
