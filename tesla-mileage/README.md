# Mile Ledger

A mileage log for a Tesla, built to hand to an accountant.

It reads the car's own odometer, turns the readings into trips, works out which
ones were business, and produces a printable mileage log and spreadsheets you can
send to your CPA at any moment. It runs on your own machine, keeps everything in
one file, and costs nothing to operate.

```
node --version   # needs 22.18 or newer
node tesla-mileage/src/index.ts
# open http://127.0.0.1:8730
```

There is nothing to install. No `npm install`, no database server, no account,
no subscription — the app has **zero dependencies** and stores everything in a
single SQLite file.

---

## What it does

**Tracks miles from the car, not from a phone.** Distances come from the Tesla's
odometer. Two readings with a higher number in between mean the car drove that
far, so the ledger's totals always reconcile with the car itself. No GPS route
tracing, no phone app running in the background, no drift.

**Labels places, and learns from you.** Mark an address as business — a client
site, a warehouse, a job site — and every past and future trip touching it sorts
itself out. Label a whole city or state if that is how your work is organized. A
specific address always beats the city around it, so your house stays personal
even if the whole town is business.

**Knows commuting is different.** Mark your home and your regular office, and
driving between them is recorded as *commute* — tracked, visible, and excluded
from the deduction, which is how the IRS treats it. Driving from home to a client
is business, and it is treated that way.

**Gets more intuitive as you use it.** Every time you categorize a trip by hand,
that decision is remembered. Once the same route has been decided the same way a
couple of times, the app proposes handling it automatically — as a visible rule
you can edit or delete, never as a silent guess. When the pattern is really about
a place, it says so and offers to label the address instead, which is the better
fix because it generalizes.

**Explains itself.** Every trip carries a plain-English note about what decided
its category: "Ends at Acme Warehouse, labeled business", "Rule: Saturdays are
personal", "Classified by you". Those notes go into the export, so any number in
the report can be traced back.

**Exports properly.** A printable mileage log (open it, press print, save a PDF),
a per-trip CSV with the date, miles, both ends, purpose, client, odometer
readings and the reason for the category, and a monthly summary. Deductions are
calculated per trip at the IRS rate in force on that date — which matters in a
year like 2026, when the business rate changed on July 1.

**Gives your CPA a standing link.** Create a read-only link and send it. It
always shows the current ledger, so there is no emailing a new file every month.
It cannot change anything, and you can revoke it whenever you want.

---

## Is it really free?

The app is. Here is the honest accounting of everything around it.

| Thing | Cost |
|---|---|
| The app itself | Free. Zero dependencies, runs on your own machine. |
| Storage | One SQLite file. A year of driving is a few megabytes. |
| Street addresses | Free, via OpenStreetMap's Nominatim service. Can be switched off. |
| PDF reports | Free — your browser's own Print to PDF. |
| Hosting | Free if you run it on a machine you already have. |
| **Tesla's API** | **The one place real money can appear. See below.** |

### The Tesla API part

Tesla meters its Fleet API and includes a monthly allowance with each developer
account (about $10 of usage at the time of writing, which covers a personal car
comfortably). Going over it costs money. The app is built so that does not
happen:

- **It never wakes the car.** A wake is the single most expensive call there is.
  A sleeping Tesla still reports its odometer from Tesla's cache, and cached
  reads are not billed — so the app reads sleeping cars freely and lets them
  sleep.
- **It only reads often while the car is moving.** Parked: every few minutes.
  Asleep: every twenty. Driving: every ninety seconds. Those are all adjustable.
- **It holds itself to a monthly ceiling** you set (8,000 estimated credits by
  default, leaving headroom under the allowance). As the ceiling gets close, the
  reads space themselves out; at the ceiling they slow right down. Mileage keeps
  being recorded either way, because the odometer difference is still there when
  the app looks again — those trips are just marked *reconstructed*, which means
  the miles are the car's own but the route in between is not known.
- **Every screen shows the running estimate** so there are no surprises.

Verify Tesla's current prices at
[developer.tesla.com](https://developer.tesla.com) — they set them, not this app,
and the numbers here are an estimate the app uses to pace itself.

**You can also skip the Tesla API entirely.** Paste a refresh token from any
Tesla token tool and the app uses the older owner interface, which is not metered
(and not officially supported, so Tesla could change it). Or import a CSV from
TeslaMate, Tessie or TeslaFi and run with no live connection at all. Or turn on
the built-in demo car and look around before deciding anything.

---

## Getting started

### 1. Run it

```bash
node tesla-mileage/src/index.ts
```

Open <http://127.0.0.1:8730>. On the default settings the app listens only on
your own machine, so there is no login to get past.

To look around with a simulated car and six weeks of realistic history:

```bash
node tesla-mileage/src/index.ts --seed-demo
```

### 2. Connect the car

Open **Settings → Change how the car is read**, and pick one:

| Option | What it needs | Notes |
|---|---|---|
| Official Fleet API | A free Tesla developer app and a domain you control | Supported by Tesla; metered, and the app stays inside the included allowance |
| Paste a refresh token | A token from any Tesla token tool | Nothing else. Not officially supported by Tesla |
| Demo car | Nothing | Simulated, for looking around |
| Files only | A CSV export | No live connection at all |

The Fleet API route needs a domain because Tesla verifies one before it will
talk to an application: you host a public key at
`https://your-domain/.well-known/appspecific/com.tesla.3p.public-key.pem` and
register it. The Connect page walks through it. If that is more trouble than it
is worth, the paste-a-token option gets you running in a minute.

### 3. Label two places

Go to **Places** and add:

- **Home** — label it personal, tick "This is home".
- **One place you drive to for work** — label it business, and give it a default
  purpose like "Client delivery" if you like.

That is enough for the app to start sorting trips on its own. Add more as you
go, or let the review queue prompt you.

### 4. Check the review queue

Anything the app cannot work out lands on the **Today** screen with Business /
Personal / Commute buttons. One tap each. After a few of those, the app starts
proposing patterns.

### 5. Send it to your CPA

**Export** → *Open printable report* for a PDF, the CSVs for a spreadsheet, or
create a standing link they can open any time.

---

## Configuration

Every setting has a working default. Copy `.env.example` to `.env` to change any
of them, or use the Settings page, which stores changes in the database instead.

The settings worth knowing about:

- `MILE_LEDGER_HOST` — `127.0.0.1` by default, meaning only this machine. Set a
  passcode before changing it.
- `MILE_LEDGER_TZ` — your time zone, e.g. `America/Chicago`. This decides which
  calendar day, month and tax year a trip falls in, so it is worth getting right.
- `MILE_LEDGER_DB` — where the ledger file lives. Back up this one file and you
  have backed up everything.
- `MILE_LEDGER_CREDIT_BUDGET` — the monthly Tesla API ceiling.
- `MILE_LEDGER_GEOCODE` — set to `0` to keep every coordinate on this machine and
  never look up an address.

### Running it always-on

Live reading only happens while the app is running, so a machine that is always
on records more detail. But nothing is lost when it is off: the next time the app
reads the car, the odometer has moved and those miles are recorded as a
reconstructed trip. Running it on a laptop that sleeps is a perfectly reasonable
way to use this — you get complete mileage totals and less route detail.

A few free ways to keep it running: a Raspberry Pi or an old machine at home, a
free-tier always-on VM from a cloud provider, or a `launchd`/`systemd` service on
a desktop that stays awake.

If you expose it beyond your own machine, **set a passcode first** (Settings →
Access). The app refuses non-local connections until you do.

---

## Your data

Everything lives in one SQLite file on your machine. Nothing is sent anywhere,
with two exceptions you control:

- Tesla, to read your own car.
- OpenStreetMap, to turn coordinates into street names — only the coordinate is
  sent, and only once per location, because results are cached forever. Turn it
  off with `MILE_LEDGER_GEOCODE=0`.

Raw readings are kept for 400 days by default and then pruned. Trips, categories
and your decisions are kept forever.

---

## For developers

```bash
npm test          # 85 tests, no dependencies needed
npm run typecheck # needs `npm install` for TypeScript itself
```

The code runs as TypeScript directly on Node — there is no build step. Layout:

```
src/
  domain/     the real logic, all pure and unit tested
    stitch.ts       readings -> trips (odometer-based, gap-safe)
    places.ts       coordinate -> labeled place
    classify.ts     trip -> category, with a reason
    learning.ts     corrections -> proposed rules
    rates.ts        IRS standard mileage rates
    pipeline.ts     ties the above to the database
  tesla/      connectors: Fleet API, owner API, CSV import, demo car
    poller.ts       adaptive cadence and the credit governor
  export/     summary math, CSVs, the printable report
  web/        server-rendered UI, no framework, no bundle
  db/         schema and typed queries over node:sqlite
```

The pieces that decide money are pure functions with tests: `stitch.ts`
(distance), `classify.ts` (category), `rates.ts` and `export/summary.ts`
(deduction).

---

## This is not tax advice

The app records what your car did and applies the standard mileage rates as
published. Whether a particular trip is deductible is a question for your
accountant, and the report says as much on its face. Check the rates against
[irs.gov](https://www.irs.gov/tax-professionals/standard-mileage-rates) — they
are editable in Settings for exactly that reason.
