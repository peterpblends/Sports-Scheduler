import Link from 'next/link'
import { YardLockup } from '@/components/logo'
import { ThemeToggle } from '@/components/theme-toggle'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" className="inline-flex items-center">
          <YardLockup size={22} />
        </Link>
        <ThemeToggle />
      </div>
      {children}
    </main>
  )
}
