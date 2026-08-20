/** Small helpers over node:http. No framework, nothing to install. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Query = URLSearchParams;

export type Ctx = {
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  path: string;
  query: Query;
  cookies: Record<string, string>;
  /** Set once the request is authenticated. */
  viewer: 'owner' | 'share' | 'anonymous';
  shareToken: string | null;
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(request);
  const type = request.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const params = new URLSearchParams();
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) params.set(key, String(value));
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key !== '') out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Is this request arriving over HTTPS, directly or through a proxy? */
export function isSecureRequest(request: IncomingMessage): boolean {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === 'https') return true;
  const socket = request.socket as { encrypted?: boolean };
  return socket.encrypted === true;
}

export function setCookie(
  response: ServerResponse,
  name: string,
  value: string,
  options: {
    maxAgeSeconds?: number;
    httpOnly?: boolean;
    sameSite?: 'Lax' | 'Strict';
    secure?: boolean;
  } = {},
): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure === true) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  const existing = response.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)];
  list.push(parts.join('; '));
  response.setHeader('set-cookie', list);
}

/**
 * Security headers applied to every HTML response.
 *
 * The pages carry no inline scripts — everything is delegated from /app.js — so
 * script-src can stay at 'self'. Styles are the one exception: the printable
 * report is a standalone document that has to keep working when saved to disk,
 * so its stylesheet is inline.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
};

export function html(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  response.end(body);
}

export function text(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

export function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body, null, 2));
}

export function download(
  response: ServerResponse,
  body: string,
  filename: string,
  contentType: string,
): void {
  response.writeHead(200, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function redirect(response: ServerResponse, location: string, flash?: string): void {
  const target = flash === undefined ? location : appendFlash(location, flash);
  response.writeHead(303, { location: target, 'cache-control': 'no-store' });
  response.end();
}

function appendFlash(location: string, flash: string): string {
  const separator = location.includes('?') ? '&' : '?';
  return `${location}${separator}flash=${encodeURIComponent(flash)}`;
}

export function notFound(response: ServerResponse): void {
  html(response, '<h1>Not found</h1><p><a href="/">Back to the ledger</a></p>', 404);
}

/** Read an integer query parameter with bounds. */
export function intParam(query: Query, name: string, fallback: number, min = 0, max = 1e9): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
