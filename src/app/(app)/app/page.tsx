import { redirect } from 'next/navigation'
import { requireActor } from '@/lib/auth-server'

/** Entry point after signing in: land in an org, or go create one. */
export default async function AppIndex() {
  const actor = await requireActor('/app')
  if (actor.memberships.length === 0) redirect('/new-org')
  redirect(`/app/${actor.memberships[0]!.orgSlug}`)
}
