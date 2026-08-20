/**
 * SQLite access built on Node's built-in `node:sqlite` — no native module to
 * compile, no database server to pay for. The whole ledger is one file the
 * owner can copy, back up, or hand to their accountant.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './schema.ts';
import { nowIso } from '../lib/time.ts';
import { log } from '../lib/log.ts';

/** Values node:sqlite can bind directly. */
export type Bindable = string | number | null | bigint | Uint8Array;
export type Param = Bindable | boolean | undefined;
export type Row = Record<string, unknown>;

function normalize(param: Param): Bindable {
  if (param === undefined) return null;
  if (typeof param === 'boolean') return param ? 1 : 0;
  if (typeof param === 'number' && !Number.isFinite(param)) return null;
  return param;
}

export class Database {
  readonly handle: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.handle = new DatabaseSync(path);
    this.handle.exec('PRAGMA journal_mode = WAL');
    this.handle.exec('PRAGMA foreign_keys = ON');
    this.handle.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const current = Number(
      (this.handle.prepare('PRAGMA user_version').get() as { user_version?: number })
        ?.user_version ?? 0,
    );
    for (let version = current; version < migrations.length; version += 1) {
      const sql = migrations[version];
      if (sql === undefined) continue;
      log.info(`applying database migration ${version + 1}`);
      this.handle.exec('BEGIN');
      try {
        this.handle.exec(sql);
        this.handle.exec(`PRAGMA user_version = ${version + 1}`);
        this.handle.exec('COMMIT');
      } catch (error) {
        this.handle.exec('ROLLBACK');
        throw error;
      }
    }
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.handle.prepare(sql).all(...params.map(normalize)) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.handle.prepare(sql).get(...params.map(normalize)) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const result = this.handle.prepare(sql).run(...params.map(normalize));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /** Single scalar value from the first column of the first row. */
  value<T = number>(sql: string, ...params: Param[]): T | undefined {
    const row = this.get<Row>(sql, ...params);
    if (row === undefined) return undefined;
    const first = Object.values(row)[0];
    return first as T;
  }

  transaction<T>(work: () => T): T {
    this.handle.exec('BEGIN');
    try {
      const result = work();
      this.handle.exec('COMMIT');
      return result;
    } catch (error) {
      this.handle.exec('ROLLBACK');
      throw error;
    }
  }

  // -- settings -------------------------------------------------------------

  setting(key: string): string | undefined {
    return this.value<string>('SELECT value FROM setting WHERE key = ?', key);
  }

  settingOr(key: string, fallback: string): string {
    return this.setting(key) ?? fallback;
  }

  settingNumber(key: string, fallback: number): number {
    const raw = this.setting(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  settingBool(key: string, fallback: boolean): boolean {
    const raw = this.setting(key);
    if (raw === undefined) return fallback;
    return raw === '1' || raw === 'true';
  }

  putSetting(key: string, value: string): void {
    this.run(
      `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      nowIso(),
    );
  }

  allSettings(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.all<{ key: string; value: string }>('SELECT key, value FROM setting')) {
      out[row.key] = row.value;
    }
    return out;
  }

  audit(actor: string, action: string, entity?: string, entityId?: string | number, detail?: string): void {
    this.run(
      'INSERT INTO audit (at, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
      nowIso(),
      actor,
      action,
      entity ?? null,
      entityId === undefined ? null : String(entityId),
      detail ?? null,
    );
  }

  close(): void {
    this.handle.close();
  }
}

let singleton: Database | undefined;

export function openDatabase(path: string): Database {
  return new Database(path);
}

export function db(): Database {
  if (singleton === undefined) throw new Error('database not initialized');
  return singleton;
}

export function setDatabase(instance: Database): void {
  singleton = instance;
}
