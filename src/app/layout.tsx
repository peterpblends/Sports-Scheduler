import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { THEME_STORAGE_KEY } from '@/components/theme-toggle'
import './globals.css'

export const metadata: Metadata = {
  title: 'THE YARD',
  description: 'League scheduling with versioned, auditable schedules.',
}

export const viewport: Viewport = {
  // Next does not inject this by default. Without it, mobile browsers render the
  // page at a fake desktop width and zoom out, which is the single biggest reason
  // a first visit from a phone looks broken before any component-level fix matters.
  width: 'device-width',
  initialScale: 1,
  // Matches the two `ink-50`/`ink-900` chalk/iron tones, so the browser's own chrome
  // (address bar, etc.) doesn't flash white while the page underneath is dark.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F5F1' },
    { media: '(prefers-color-scheme: dark)', color: '#171512' },
  ],
}

// Set before hydration, on the raw DOM, so there is no flash of the wrong theme
// between first paint and React taking over. `nonce` comes from the per-request CSP
// header `middleware.ts` sets — this is the one hand-authored inline script in the
// app, everything else Next generates itself and nonces automatically.
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',d)}catch(e){}})()`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
