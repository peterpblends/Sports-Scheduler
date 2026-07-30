/**
 * Demo data for local development.
 *
 * Phase 1 seeds identity only: one soccer organization with a user at every
 * role, plus a pending invitation. Later phases extend this script with leagues,
 * divisions, teams, venues, officials and a generated schedule.
 *
 * Idempotent — safe to re-run. Every password is `demo-password-123`.
 */
import { PrismaClient, type Role } from '@prisma/client'
import { hash } from '@node-rs/argon2'
import { createHash, randomBytes } from 'node:crypto'

const prisma = new PrismaClient()

const PASSWORD = 'demo-password-123'

const PEOPLE: { email: string; name: string; role: Role }[] = [
  { email: 'owner@riverside.example', name: 'Marta Ibarra', role: 'owner' },
  { email: 'admin@riverside.example', name: 'Desmond Clay', role: 'admin' },
  { email: 'scheduler@riverside.example', name: 'Priya Raman', role: 'scheduler' },
  { email: 'coach@riverside.example', name: 'Tom Vasquez', role: 'coach' },
  { email: 'referee@riverside.example', name: 'Wei Chen', role: 'referee' },
  { email: 'viewer@riverside.example', name: 'Jules Petit', role: 'viewer' },
]

async function main() {
  const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 })

  const org = await prisma.organization.upsert({
    where: { slug: 'riverside-youth-soccer' },
    update: {},
    create: {
      name: 'Riverside Youth Soccer',
      slug: 'riverside-youth-soccer',
      timezone: 'America/Los_Angeles',
      settings: { sport: 'soccer' },
    },
  })

  for (const person of PEOPLE) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { name: person.name },
      create: { email: person.email, name: person.name, passwordHash },
    })

    await prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      update: { role: person.role, deletedAt: null },
      create: { userId: user.id, orgId: org.id, role: person.role },
    })

    await prisma.auditEvent.create({
      data: {
        orgId: org.id,
        actorId: user.id,
        actorLabel: 'seed script',
        entityType: 'Membership',
        entityId: user.id,
        action: 'member.role_set',
        diff: { role: { before: null, after: person.role } },
        meta: { source: 'seed' },
      },
    })
  }

  // A pending invitation so the members page has something to show. The raw
  // token is printed below; only its hash is stored.
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: PEOPLE[0]!.email } })
  const inviteToken = randomBytes(32).toString('base64url')
  await prisma.invitation.deleteMany({ where: { orgId: org.id, email: 'newcoach@riverside.example' } })
  await prisma.invitation.create({
    data: {
      orgId: org.id,
      email: 'newcoach@riverside.example',
      role: 'coach',
      tokenHash: createHash('sha256').update(inviteToken).digest('hex'),
      createdById: owner.id,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  })

  console.log(`\nSeeded "${org.name}" (/app/${org.slug})\n`)
  console.log('  Sign in with any of these — password: ' + PASSWORD)
  for (const p of PEOPLE) console.log(`    ${p.role.padEnd(10)} ${p.email}`)
  console.log(`\n  Pending invite accept link:`)
  console.log(`    ${process.env.APP_URL ?? 'http://localhost:3000'}/accept-invite?token=${inviteToken}\n`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
