/**
 * Schema migrations, applied in order and tracked with SQLite's `user_version`.
 * Never edit a migration that has shipped — append a new one.
 */

export const migrations: string[] = [
  // ---- 1: core ledger -----------------------------------------------------
  `
  CREATE TABLE setting (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE vehicle (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    vin                 TEXT UNIQUE,
    tesla_id            TEXT,
    display_name        TEXT NOT NULL,
    model               TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    last_odometer_miles REAL,
    last_sample_at      TEXT,
    last_state          TEXT,
    created_at          TEXT NOT NULL
  );

  -- Raw readings from the car. Kept so trips can always be rebuilt from source.
  CREATE TABLE sample (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id     INTEGER NOT NULL REFERENCES vehicle(id),
    at             TEXT NOT NULL,
    odometer_miles REAL,
    latitude       REAL,
    longitude      REAL,
    shift_state    TEXT,
    speed_mph      REAL,
    state          TEXT,
    charging_state TEXT,
    battery_level  INTEGER,
    cached         INTEGER NOT NULL DEFAULT 0,
    source         TEXT NOT NULL,
    UNIQUE(vehicle_id, at)
  );
  CREATE INDEX sample_vehicle_at ON sample(vehicle_id, at);

  -- A labeled location. "kind" decides how a coordinate is matched to it.
  CREATE TABLE place (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'address',
    label             TEXT NOT NULL DEFAULT 'business',
    purpose           TEXT,
    client            TEXT,
    address           TEXT,
    city              TEXT,
    region            TEXT,
    postal            TEXT,
    latitude          REAL,
    longitude         REAL,
    radius_meters     INTEGER NOT NULL DEFAULT 200,
    is_home           INTEGER NOT NULL DEFAULT 0,
    is_primary_office INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    visit_count       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
  );
  CREATE INDEX place_kind ON place(kind, deleted_at);

  CREATE TABLE trip (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id            INTEGER NOT NULL REFERENCES vehicle(id),
    started_at            TEXT NOT NULL,
    ended_at              TEXT NOT NULL,
    start_latitude        REAL,
    start_longitude       REAL,
    end_latitude          REAL,
    end_longitude         REAL,
    start_odometer_miles  REAL,
    end_odometer_miles    REAL,
    distance_miles        REAL NOT NULL,
    duration_seconds      INTEGER NOT NULL,
    start_place_id        INTEGER REFERENCES place(id),
    end_place_id          INTEGER REFERENCES place(id),
    start_description     TEXT,
    end_description       TEXT,
    classification        TEXT NOT NULL DEFAULT 'unclassified',
    classification_source TEXT NOT NULL DEFAULT 'none',
    classification_reason TEXT,
    confidence            REAL NOT NULL DEFAULT 0,
    purpose               TEXT,
    client                TEXT,
    notes                 TEXT,
    -- 'user' once the owner types a purpose, so automatic passes stop
    -- overwriting it; 'auto' while it is still derived from a label or rule.
    purpose_source        TEXT NOT NULL DEFAULT 'auto',
    locked                INTEGER NOT NULL DEFAULT 0,
    inferred              INTEGER NOT NULL DEFAULT 0,
    open                  INTEGER NOT NULL DEFAULT 0,
    distance_source       TEXT NOT NULL DEFAULT 'odometer',
    needs_review          INTEGER NOT NULL DEFAULT 1,
    signature             TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    deleted_at            TEXT,
    UNIQUE(vehicle_id, started_at)
  );
  CREATE INDEX trip_started ON trip(started_at);
  CREATE INDEX trip_review ON trip(needs_review, deleted_at);
  CREATE INDEX trip_signature ON trip(signature);

  -- Declarative classification rules. "conditions" is JSON; see domain/classify.ts.
  CREATE TABLE rule (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    priority       INTEGER NOT NULL DEFAULT 100,
    enabled        INTEGER NOT NULL DEFAULT 1,
    source         TEXT NOT NULL DEFAULT 'user',
    conditions     TEXT NOT NULL,
    classification TEXT NOT NULL,
    purpose        TEXT,
    client         TEXT,
    hits           INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
  );
  CREATE INDEX rule_order ON rule(enabled, priority, deleted_at);

  -- Every manual classification, kept as the training signal for suggestions.
  CREATE TABLE feedback (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id        INTEGER NOT NULL,
    signature      TEXT NOT NULL,
    classification TEXT NOT NULL,
    purpose        TEXT,
    client         TEXT,
    at             TEXT NOT NULL
  );
  CREATE INDEX feedback_signature ON feedback(signature);

  -- A pattern the app noticed and wants to confirm before automating it.
  CREATE TABLE suggestion (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    signature      TEXT NOT NULL UNIQUE,
    classification TEXT NOT NULL,
    purpose        TEXT,
    client         TEXT,
    observations   INTEGER NOT NULL DEFAULT 0,
    description    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  -- Tesla API spend, so the poller can stay inside the free monthly allowance.
  CREATE TABLE api_usage (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT NOT NULL,
    month    TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    credits  INTEGER NOT NULL DEFAULT 0,
    cached   INTEGER NOT NULL DEFAULT 0,
    ok       INTEGER NOT NULL DEFAULT 1,
    detail   TEXT
  );
  CREATE INDEX api_usage_month ON api_usage(month);

  CREATE TABLE token (
    provider      TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    TEXT,
    region        TEXT,
    scope         TEXT,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE geocode_cache (
    key          TEXT PRIMARY KEY,
    display      TEXT,
    house_number TEXT,
    road         TEXT,
    city         TEXT,
    region       TEXT,
    postal       TEXT,
    country      TEXT,
    fetched_at   TEXT NOT NULL
  );

  -- IRS standard mileage rates. Editable, because the IRS changes them
  -- (sometimes mid-year) and the CPA is the final authority.
  CREATE TABLE mileage_rate (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from TEXT NOT NULL UNIQUE,
    effective_to   TEXT NOT NULL,
    business_cents REAL NOT NULL,
    medical_cents  REAL NOT NULL,
    charity_cents  REAL NOT NULL,
    note           TEXT
  );

  CREATE TABLE share_link (
    token        TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );

  CREATE TABLE audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL,
    action    TEXT NOT NULL,
    entity    TEXT,
    entity_id TEXT,
    detail    TEXT
  );
  CREATE INDEX audit_at ON audit(at);
  `,
];
