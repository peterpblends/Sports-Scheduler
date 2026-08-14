import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Sports Scheduler',
  description: 'League scheduling with versioned, auditable schedules.',
}

// Next does not inject this by default. Without it, mobile browsers render the
// page at a fake desktop width and zoom out, which is the single biggest reason
// a first visit from a phone looks broken before any component-level fix matters.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
