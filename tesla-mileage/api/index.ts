/**
 * Vercel entry point.
 *
 * Vercel hands each request to a function rather than to a server that keeps
 * listening, so this hands it straight to the same router the local server uses.
 * The app is built once per instance and reused while that instance is warm.
 *
 * Worth being clear about what this can and cannot be. A serverless instance has
 * no permanent disk — /tmp belongs to one instance and goes away with it — and no
 * process that stays alive to read the car every ninety seconds. So a deployment
 * here is a working preview: every screen, every export, real behaviour, demo
 * data, and a banner saying nothing is kept. It says so rather than quietly
 * losing a tax record.
 *
 * The ledger of record wants a host that stays on. See the Dockerfile and the
 * systemd unit in deploy/, or just run it on your own machine.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, type App } from '../src/app.ts';
import { createRequestListener } from '../src/web/server.ts';

let listener: ((request: IncomingMessage, response: ServerResponse) => void) | null = null;
let application: App | null = null;

function handler(request: IncomingMessage, response: ServerResponse): void {
  if (listener === null) {
    application = createApp();
    // No long-lived instance means no poller; a cron trigger drives it instead.
    application.poller.stop();
    listener = createRequestListener(application);
  }
  listener(request, response);
}

export default handler;
