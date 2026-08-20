# Mile Ledger

A mileage log for a Tesla, built to hand to an accountant.

It reads the car's own odometer, turns the readings into trips, works out which
ones were business, and produces a printable mileage log and spreadsheets you can
send to your CPA at any moment. It runs on your own machine, keeps everything in
one file, and costs nothing to operate.

```
node --version   # needs 22.18 or newer
node src/index.ts
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

**Reads well on a phone.** Not a desktop page shrunk down: a bottom bar with the
most-used screens and Dashboard in the middle, fields that bring up the right
keyboard, tap targets big enough to hit, and layouts checked at every width from
a small phone to a wide desktop — in portrait and landscape, with the iPhone home
indicator accounted for.

**Works without colour.** A black-and-white mode for anyone who prefers it, needs
it, or is printing. It is a real greyscale palette rather than a filter over the
page, and nothing depends on colour to be understood: every category carries a
glyph, a border style and its name, the chart uses texture and direct labels, and
all four light/dark × colour/greyscale combinations meet WCAG AA contrast.

**Exports properly.** A printable mileage log (open it, press print, save a PDF),
a per-trip CSV with the date, miles, both ends, purpose, client, odometer
readings and the reason for the category, and a monthly summary. Deductions are
calculated per trip at the IRS rate in force on that date — which matters in a
year like 2026, when the business rate changed on July 1.

**Gives your CPA a standing link.** Create a read-only link and send it. It
always shows the current ledger, so there is no emailing a new file every month.
It cannot change anything, and you can revoke it whenever you want.

---

## On a phone

The bottom bar carries the four things you do between one drive and the next,
with **Dashboard in the centre** and deliberately more prominent:

```
   Trips      Places    ( Dashboard )    Export      More
   the list   labels    today's state    for the CPA  everything else
```

Everything not on the bar — rules, the car connection, settings, importing,
appearance, signing out — lives on **More**, which is a real page rather than a
pop-out menu, so the back button works and you can bookmark it. On a tablet or
desktop the bar gives way to an ordinary row of tabs.

The bar respects the home indicator on modern iPhones, gets out of the way when
the keyboard opens, and shrinks in landscape where vertical space is scarce.

## Appearance

**Settings → Appearance**, or the same panel on **More**. Two independent
choices:

| Theme | Colour |
|---|---|
| Follow device · Light · Dark | Full colour · Black and white |

The choice is stored in your ledger, not the browser, so it survives a refresh, a
sign-out, a restart, and follows you to your phone. It is applied by the server
when the page is built, so there is no flash of the wrong theme, and it carries
through to the printable report — which is also the friendlier thing to send to a
printer.

Black and white is not a filter. It is a separate palette of strictly neutral
greys, and because colour carries no meaning in it, nothing in the app depends on
colour alone:

- every category shows a glyph and its name (● business, ○ personal, ◐ commute, ? undecided)
- category chips also differ by border style — solid, dashed, dotted, double
- the API budget meter goes striped, not just red
- the vehicle status dot changes shape, and the words beside it say the same thing
- the chart's second series is a hatch texture, with values printed on the bars
  and the same figures in a table underneath

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
node src/index.ts
```

Open <http://127.0.0.1:8730>. On the default settings the app listens only on
your own machine, so there is no login to get past.

To look around with a simulated car and six weeks of realistic history:

```bash
node src/index.ts --seed-demo
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

### Where to run it

Live reading only happens while the app is running, so a machine that is always
on records more detail. Nothing is lost when it is off: the next time the app
reads the car, the odometer has moved and those miles are recorded as a
reconstructed trip. A laptop that sleeps is a perfectly reasonable way to use
this — complete totals, less route detail.

| Where | Good for | Notes |
|---|---|---|
| **Your own machine** | getting going in a minute | `node src/index.ts`, nothing else to do |
| **Docker** | a spare box, a NAS, a Pi | `docker build -t mile-ledger . && docker run -p 8730:8730 -v mile-ledger-data:/data mile-ledger` |
| **systemd** | an always-free cloud VM | copy `deploy/mile-ledger.service`, adjust the paths, `systemctl enable --now` |
| **Vercel** | showing someone the app | preview only — see below |

Set a passcode and `MILE_LEDGER_SECRET` before exposing any of these past your
own machine.

### About Vercel

The app will deploy to Vercel and every screen works, but it can only ever be a
**preview** there, and the app says so on every page rather than letting you find
out later.

Two things a serverless platform cannot give this app:

- **A disk that persists.** Vercel functions get a `/tmp` that belongs to one
  instance and disappears with it. A SQLite ledger there loses trips on the next
  cold start — the worst possible failure for a tax record, because nothing looks
  broken.
- **A process that stays alive.** Reading the car every ninety seconds while it
  drives needs something always running. Serverless functions only exist while
  answering a request, and scheduled functions on the free plan run once a day.

So when the app detects a serverless host it starts in preview mode: loaded with
demo data, a banner on every page saying nothing is kept, and it refuses to store
a Tesla refresh token on a disk that is about to vanish. Useful for clicking
around on your phone or showing your accountant the report format — not for your
mileage.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpeterpblends%2Fmile-ledger)

Set the project's Node version to 22.x — the app uses Node's built-in SQLite,
which does not exist in Node 20. If you ever do attach real persistent storage,
`MILE_LEDGER_DURABLE_STORAGE=1` turns preview mode off.

Making Vercel the real home would mean moving the database to a hosted service
and converting the whole data layer to async, which would cost the two properties
this app was built for: no running costs, and one file you own.

If you expose it beyond your own machine, **set a passcode first** (Settings →
Access, or More → Access). The app refuses non-local connections until you do.

What that gets you: the passcode is stored as a scrypt hash, the session is a
signed cookie marked `Secure` behind HTTPS, repeated wrong guesses are throttled,
writes are rejected if they did not come from the app's own pages, and every page
is served under a Content-Security-Policy that forbids inline scripts. Set
`MILE_LEDGER_SECRET` as well and your Tesla refresh token is encrypted at rest
rather than sitting in the database in the clear.

The accountant's share link is deliberately narrow: read-only, revocable, and it
keeps working while the rest of the ledger stays locked. The JSON backup contains
your trips and settings but never the session secret, the passcode hash, or any
stored credential.

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
npm test          # 114 tests, no dependencies needed
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
    summary.ts      totals from trip rows (the exports need the rows anyway)
    aggregate.ts    the same totals from indexed SQL, for pages that only
                    show numbers — held against summary.ts by tests
  web/        server-rendered UI, no framework, no bundle
    ui.ts           the four palettes, the shell, form field helpers
    chart.ts        inline-SVG chart that survives losing all colour
    guard.ts        rate limiting and same-origin checks
    auth.ts         passcode, sessions, share tokens
  db/         schema and typed queries over node:sqlite
api/          the serverless entry point, for a preview deployment
deploy/       systemd unit for an always-on host
```

Money is handled in integer cents end to end, so a total never depends on the
order things were added in. Both summary implementations round per trip and sum
whole cents, and a test asserts they agree — including across a mid-year IRS rate
change.

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
