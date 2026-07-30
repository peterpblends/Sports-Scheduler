import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <Link href="/" className="mb-8 text-sm font-medium uppercase tracking-widest text-turf-600">
        Sports Scheduler
      </Link>
      {children}
    </main>
  )
}
