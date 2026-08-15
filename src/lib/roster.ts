import { prisma } from './prisma'
import { conflict } from './http'

/**
 * Roster invariants shared by more than one endpoint.
 *
 * These live here rather than in a route file because Next only permits HTTP
 * handler exports from `route.ts`.
 */

/**
 * A Person may be linked to a login only if that login is a member of this org,
 * and only once. The link is what resolves "their own team" and "their own
 * assignments", so it must not be forgeable or shared.
 */
export async function assertUserLinkable(
  orgId: string,
  userId: string,
  exceptPersonId?: string,
): Promise<void> {
  const membership = await prisma.membership.findFirst({
    where: { userId, orgId, deletedAt: null },
  })
  if (!membership) throw conflict('That user is not a member of this organization.')

  const taken = await prisma.person.findFirst({
    where: { userId, deletedAt: null, ...(exceptPersonId ? { id: { not: exceptPersonId } } : {}) },
  })
  if (taken) throw conflict('That user is already linked to another person record.')
}

/**
 * Jersey numbers are unique among a team's current members. Enforced here rather
 * than by a database constraint, since soft-deleted and past-dated memberships
 * must be allowed to hold the same number.
 */
export async function assertJerseyFree(
  teamId: string,
  jerseyNumber: string,
  exceptId?: string,
): Promise<void> {
  const clash = await prisma.teamMembership.findFirst({
    where: {
      teamId,
      jerseyNumber,
      deletedAt: null,
      activeTo: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  })
  if (clash) throw conflict(`Jersey number ${jerseyNumber} is already taken on this team.`)
}
