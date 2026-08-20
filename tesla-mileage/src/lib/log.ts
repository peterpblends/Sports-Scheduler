/** Tiny leveled logger. Writes to stdout/stderr; no transport, no dependency. */
import { config } from '../config.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as LogLevel) in LEVELS ? (config.logLevel as LogLevel) : 'info'];

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (detail === undefined) {
    stream.write(`${line}\n`);
    return;
  }
  const rendered =
    detail instanceof Error
      ? `${detail.name}: ${detail.message}`
      : typeof detail === 'string'
        ? detail
        : safeJson(detail);
  stream.write(`${line} ${rendered}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => emit('debug', message, detail),
  info: (message: string, detail?: unknown) => emit('info', message, detail),
  warn: (message: string, detail?: unknown) => emit('warn', message, detail),
  error: (message: string, detail?: unknown) => emit('error', message, detail),
};
