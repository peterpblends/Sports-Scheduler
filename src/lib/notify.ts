import { prisma } from './prisma'
import { appUrl, mailer } from './mailer'
import { recordAudit, recordAuditMany, type AuditInput } from './audit'
import { formatInstantInZone } from './time'
import { can } from './authz'

/**
 * Transactional notifications.
 *
 * Three rules, and they are what keep this from becoming a source of bugs and spam:
 *
 *  1. **Never inside the mutation's transaction.** A mail send that fails or hangs must
 *     not roll back a published schedule, and a transaction must not be held open across
 *     a network call to an SMTP server. Callers dispatch *after* their write commits.
 *  2. **Recipients are derived from the data, then filtered by preference.** A missing
 *     preference row means the defaults, so nobody needs back-filling when a new kind is
 *     added.
 *  3. **One audit row per notification.** "Why didn't I get told?" has to be answerable,
 *     and a delivery that was suppressed by a preference is recorded as suppressed
 *     rather than not recorded at all.
 *
 * Failures are swallowed per-recipient and reported in the result. A publish is not
 * undone because one mailbox bounced.
 */

export type NotificationKind =
  | 'schedulePublished'
  | 'gameRescheduled'
  | 'assignmentChanged'
  | 'rosterChanged'
  | 'officiatingRequest'

/** Matches the column defaults on NotificationPreference. */
export const NOTIFICATION_DEFAULTS: Record<NotificationKind, boolean> = {
  schedulePublished: true,
  gameRescheduled: true,
  assignmentChanged: true,
  rosterChanged: false,
  officiatingRequest: true,
}

export const NOTIFICATION_LABELS: Record<NotificationKind, { title: string; detail: string }> = {
  schedulePublished: {
    title: 'A schedule is published',
    detail: 'When a new version goes live, so the fixtures you can see have changed.',
  },
  gameRescheduled: {
    title: 'One of my games moves',
    detail: 'When a game involving your team, or one you are officiating, changes time or field.',
  },
  assignmentChanged: {
    title: 'An officiating assignment changes',
    detail: 'When you are offered a game, moved off one, or a crew you are on changes.',
  },
  rosterChanged: {
    title: 'A roster I manage changes',
    detail: 'When somebody joins or leaves a team you are staff of. Off by default.',
  },
  officiatingRequest: {
    title: 'An officiating request needs an answer, or mine is answered',
    detail:
      'Assigners hear when a referee asks for a game; referees hear when their request is approved or turned down.',
  },
}

export type Recipient = {
  userId: string
  email: string
  name: string
}

export type NotifyResult = {
  sent: number
  suppressed: number
  failed: number
}

/**
 * Loads the preference for each recipient in one query and applies the default for
 * anyone with no row.
 */
async function allowed(
  orgId: string,
  kind: NotificationKind,
  recipients: Recipient[],
): Promise<{ allow: Recipient[]; suppress: Recipient[] }> {
  if (recipients.length === 0) return { allow: [], suppress: [] }

  const prefs = await prisma.notificationPreference.findMany({
    where: { orgId, userId: { in: recipients.map((recipient) => recipient.userId) } },
  })
  const byUser = new Map(prefs.map((pref) => [pref.userId, pref]))

  const allow: Recipient[] = []
  const suppress: Recipient[] = []
  for (const recipient of recipients) {
    const pref = byUser.get(recipient.userId)
    const on = pref ? pref[kind] : NOTIFICATION_DEFAULTS[kind]
    if (on) allow.push(recipient)
    else suppress.push(recipient)
  }
  return { allow, suppress }
}

/**
 * Sends one message per allowed recipient and records the outcome for every one,
 * including those a preference suppressed.
 */
export async function notify(input: {
  orgId: string
  kind: NotificationKind
  recipients: Recipient[]
  subject: string
  /** Called per recipient so a message can address them by name. */
  body: (recipient: Recipient) => string
  entityType: string
  entityId: string
  actorLabel?: string
  meta?: Record<string, unknown>
}): Promise<NotifyResult> {
  const { allow, suppress } = await allowed(input.orgId, input.kind, input.recipients)
  const transport = mailer()
  const events: AuditInput[] = []
  let sent = 0
  let failed = 0

  for (const recipient of allow) {
    try {
      await transport.send({
        to: recipient.email,
        subject: input.subject,
        text: input.body(recipient),
      })
      sent += 1
      events.push({
        orgId: input.orgId,
        actorLabel: input.actorLabel ?? 'system',
        entityType: input.entityType,
        entityId: input.entityId,
        action: 'notification.sent',
        meta: { kind: input.kind, to: recipient.email, subject: input.subject, ...input.meta },
      })
    } catch (error) {
      // One bad mailbox must not stop the rest, and must not undo the write that
      // triggered this.
      failed += 1
      events.push({
        orgId: input.orgId,
        actorLabel: input.actorLabel ?? 'system',
        entityType: input.entityType,
        entityId: input.entityId,
        action: 'notification.failed',
        meta: {
          kind: input.kind,
          to: recipient.email,
          error: error instanceof Error ? error.message : String(error),
          ...input.meta,
        },
      })
    }
  }

  for (const recipient of suppress) {
    events.push({
      orgId: input.orgId,
      actorLabel: input.actorLabel ?? 'system',
      entityType: input.entityType,
      entityId: input.entityId,
      action: 'notification.suppressed',
      meta: { kind: input.kind, to: recipient.email, reason: 'preference', ...input.meta },
    })
  }

  await recordAuditMany(events)
  return { sent, suppressed: suppress.length, failed }
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

/** Every member of the org with a login, which is who a publish concerns. */
export async function orgRecipients(orgId: string): Promise<Recipient[]> {
  const memberships = await prisma.membership.findMany({
    where: { orgId, deletedAt: null, user: { deletedAt: null } },
    include: { user: { select: { id: true, email: true, name: true } } },
  })
  return dedupe(
    memberships.map((membership) => ({
      userId: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
    })),
  )
}

/**
 * Members who can act on an officiating request.
 *
 * Derived from the permission matrix rather than a hard-coded role list, so adding
 * `official:request:review` to a role automatically starts telling them. That is
 * the same single-source-of-truth rule the endpoints follow.
 */
export async function requestReviewerRecipients(orgId: string): Promise<Recipient[]> {
  const memberships = await prisma.membership.findMany({
    where: { orgId, deletedAt: null, user: { deletedAt: null } },
    include: { user: { select: { id: true, email: true, name: true } } },
  })
  return dedupe(
    memberships
      .filter((membership) => can(membership.role, 'official:request:review'))
      .map((membership) => ({
        userId: membership.user.id,
        email: membership.user.email,
        name: membership.user.name,
      })),
  )
}

/**
 * Everyone a specific game concerns: staff of either team, and the officiating crew.
 *
 * Players are excluded deliberately — a youth roster is mostly minors without logins,
 * and a Person is only reachable at all if it is linked to a user account.
 */
export async function gameRecipients(gameId: string): Promise<Recipient[]> {
  const game = await prisma.game.findFirst({
    where: { id: gameId, deletedAt: null },
    select: { homeTeamId: true, awayTeamId: true },
  })
  if (!game) return []

  const [staff, officials] = await Promise.all([
    prisma.teamMembership.findMany({
      where: {
        deletedAt: null,
        activeTo: null,
        teamId: { in: [game.homeTeamId, game.awayTeamId] },
        role: { in: ['coach', 'assistant', 'manager'] },
        person: { deletedAt: null, user: { deletedAt: null } },
      },
      include: { person: { include: { user: { select: { id: true, email: true, name: true } } } } },
    }),
    prisma.gameOfficial.findMany({
      where: {
        gameId,
        deletedAt: null,
        status: { not: 'declined' },
        referee: { deletedAt: null, person: { deletedAt: null, user: { deletedAt: null } } },
      },
      include: {
        referee: {
          include: { person: { include: { user: { select: { id: true, email: true, name: true } } } } },
        },
      },
    }),
  ])

  return dedupe([
    ...staff.flatMap((membership) =>
      membership.person.user
        ? [
            {
              userId: membership.person.user.id,
              email: membership.person.user.email,
              name: membership.person.user.name,
            },
          ]
        : [],
    ),
    ...officials.flatMap((assignment) =>
      assignment.referee.person.user
        ? [
            {
              userId: assignment.referee.person.user.id,
              email: assignment.referee.person.user.email,
              name: assignment.referee.person.user.name,
            },
          ]
        : [],
    ),
  ])
}

/** The one official an assignment concerns, if they have a login. */
export async function refereeRecipient(refereeId: string): Promise<Recipient[]> {
  const referee = await prisma.referee.findFirst({
    where: { id: refereeId, deletedAt: null },
    include: { person: { include: { user: { select: { id: true, email: true, name: true } } } } },
  })
  if (!referee?.person.user) return []
  return [
    {
      userId: referee.person.user.id,
      email: referee.person.user.email,
      name: referee.person.user.name,
    },
  ]
}

function dedupe(recipients: Recipient[]): Recipient[] {
  const seen = new Map<string, Recipient>()
  for (const recipient of recipients) if (!seen.has(recipient.userId)) seen.set(recipient.userId, recipient)
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Footer line pointing at the page that actually owns these settings. */
function settingsFooter(orgSlug: string): string {
  return `Change which of these emails you get: ${appUrl(`/app/${orgSlug}/subscriptions`)}`
}

export async function notifySchedulePublished(input: {
  orgId: string
  seasonId: string
  versionNumber: number
  actorLabel: string
}): Promise<NotifyResult> {
  const [org, season] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: input.orgId }, select: { name: true, slug: true } }),
    prisma.season.findUniqueOrThrow({
      where: { id: input.seasonId },
      select: { name: true, league: { select: { name: true } } },
    }),
  ])

  const link = appUrl(`/app/${org.slug}/schedule?seasonId=${input.seasonId}`)
  const publicLink = appUrl(`/s/${org.slug}?seasonId=${input.seasonId}`)
  const label = `${season.league.name} · ${season.name}`
  const settingsLine = settingsFooter(org.slug)

  return notify({
    orgId: input.orgId,
    kind: 'schedulePublished',
    recipients: await orgRecipients(input.orgId),
    entityType: 'Season',
    entityId: input.seasonId,
    actorLabel: input.actorLabel,
    meta: { versionNumber: input.versionNumber },
    subject: `${org.name}: ${label} schedule published (v${input.versionNumber})`,
    body: (recipient) =>
      [
        `Hello ${recipient.name},`,
        '',
        `Version ${input.versionNumber} of the ${label} schedule is now published. It is what everyone outside the office sees from now on.`,
        '',
        `Your view: ${link}`,
        `Public link: ${publicLink}`,
        '',
        settingsLine,
      ].join('\n'),
  })
}

export async function notifyGameRescheduled(input: {
  orgId: string
  gameId: string
  actorLabel: string
  before: { startTime: Date; timezone: string; where: string | null }
  after: { startTime: Date; timezone: string; where: string | null }
  overrideReason?: string | null
}): Promise<NotifyResult> {
  const [org, game] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: input.orgId }, select: { name: true, slug: true } }),
    prisma.game.findFirstOrThrow({
      where: { id: input.gameId },
      include: { homeTeam: true, awayTeam: true },
    }),
  ])

  const match = `${game.homeTeam.name} v ${game.awayTeam.name}`
  const link = appUrl(`/app/${org.slug}/games/${input.gameId}`)
  const settingsLine = settingsFooter(org.slug)

  return notify({
    orgId: input.orgId,
    kind: 'gameRescheduled',
    recipients: await gameRecipients(input.gameId),
    entityType: 'Game',
    entityId: input.gameId,
    actorLabel: input.actorLabel,
    meta: { overrideReason: input.overrideReason ?? null },
    subject: `${org.name}: ${match} has moved`,
    body: (recipient) =>
      [
        `Hello ${recipient.name},`,
        '',
        `${match} has been rescheduled.`,
        '',
        `Was: ${formatInstantInZone(input.before.startTime, input.before.timezone)}${input.before.where ? ` at ${input.before.where}` : ''}`,
        `Now: ${formatInstantInZone(input.after.startTime, input.after.timezone)}${input.after.where ? ` at ${input.after.where}` : ''}`,
        ...(input.overrideReason ? ['', `Note from the scheduler: ${input.overrideReason}`] : []),
        '',
        `Details: ${link}`,
        '',
        settingsLine,
      ].join('\n'),
  })
}

export async function notifyAssignmentChanged(input: {
  orgId: string
  gameId: string
  refereeId: string
  change: 'assigned' | 'unassigned'
  position: string
  actorLabel: string
}): Promise<NotifyResult> {
  const [org, game] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: input.orgId }, select: { name: true, slug: true } }),
    prisma.game.findFirstOrThrow({
      where: { id: input.gameId },
      include: {
        homeTeam: true,
        awayTeam: true,
        field: { include: { venue: { select: { name: true, timezone: true } } } },
      },
    }),
  ])

  const match = `${game.homeTeam.name} v ${game.awayTeam.name}`
  const timezone = game.field?.venue.timezone ?? 'UTC'
  const when = formatInstantInZone(game.startTime, timezone)
  const where = game.field ? `${game.field.venue.name} — ${game.field.name}` : 'venue to be confirmed'
  const link = appUrl(`/app/${org.slug}/games/${input.gameId}`)
  const settingsLine = settingsFooter(org.slug)

  return notify({
    orgId: input.orgId,
    kind: 'assignmentChanged',
    recipients: await refereeRecipient(input.refereeId),
    entityType: 'GameOfficial',
    entityId: input.gameId,
    actorLabel: input.actorLabel,
    meta: { gameId: input.gameId, refereeId: input.refereeId, change: input.change },
    subject:
      input.change === 'assigned'
        ? `${org.name}: you are assigned to ${match}`
        : `${org.name}: you are no longer on ${match}`,
    body: (recipient) =>
      input.change === 'assigned'
        ? [
            `Hello ${recipient.name},`,
            '',
            `You have been assigned as ${input.position} for ${match}.`,
            '',
            `When: ${when}`,
            `Where: ${where}`,
            '',
            `Accept or decline: ${link}`,
            '',
            settingsLine,
          ].join('\n')
        : [
            `Hello ${recipient.name},`,
            '',
            `You have been taken off ${match} (${when}). Nothing further is needed from you.`,
            '',
            `Details: ${link}`,
          ].join('\n'),
  })
}

/**
 * A referee has asked for a game. Tells whoever can answer.
 *
 * The requester is excluded even if they somehow hold the reviewing permission —
 * the same rule as everywhere else here: nobody is emailed about their own action.
 */
export async function notifyOfficiatingRequested(input: {
  orgId: string
  gameId: string
  requestId: string
  refereeName: string
  position: string
  note?: string | null
  actorUserId: string
  actorLabel: string
}): Promise<NotifyResult> {
  const [org, game] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: input.orgId },
      select: { name: true, slug: true },
    }),
    prisma.game.findFirstOrThrow({
      where: { id: input.gameId },
      include: {
        homeTeam: true,
        awayTeam: true,
        field: { include: { venue: { select: { name: true, timezone: true } } } },
      },
    }),
  ])

  const match = `${game.homeTeam.name} v ${game.awayTeam.name}`
  const timezone = game.field?.venue.timezone ?? 'UTC'
  const when = formatInstantInZone(game.startTime, timezone)
  const where = game.field ? `${game.field.venue.name} — ${game.field.name}` : 'venue to be confirmed'
  const link = appUrl(`/app/${org.slug}/schedule/officials`)

  const reviewers = (await requestReviewerRecipients(input.orgId)).filter(
    (recipient) => recipient.userId !== input.actorUserId,
  )

  if (reviewers.length === 0) {
    await recordNoRecipients({
      orgId: input.orgId,
      kind: 'officiatingRequest',
      entityType: 'OfficiatingRequest',
      entityId: input.requestId,
      actorLabel: input.actorLabel,
    })
    return { sent: 0, suppressed: 0, failed: 0 }
  }

  return notify({
    orgId: input.orgId,
    kind: 'officiatingRequest',
    recipients: reviewers,
    entityType: 'OfficiatingRequest',
    entityId: input.requestId,
    actorLabel: input.actorLabel,
    meta: { gameId: input.gameId, requestId: input.requestId, position: input.position },
    subject: `${org.name}: ${input.refereeName} asked to officiate ${match}`,
    body: (recipient) =>
      [
        `Hello ${recipient.name},`,
        '',
        `${input.refereeName} has asked to take ${input.position} for ${match}.`,
        '',
        `When: ${when}`,
        `Where: ${where}`,
        ...(input.note ? ['', `They said: ${input.note}`] : []),
        '',
        `Approve or turn it down: ${link}`,
        '',
        settingsFooter(org.slug),
      ].join('\n'),
  })
}

/** An assigner has answered a request. Tells the referee who asked. */
export async function notifyOfficiatingDecided(input: {
  orgId: string
  gameId: string
  requestId: string
  refereeId: string
  decision: 'approved' | 'rejected'
  position: string
  decisionNote?: string | null
  actorLabel: string
}): Promise<NotifyResult> {
  const [org, game] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: input.orgId },
      select: { name: true, slug: true },
    }),
    prisma.game.findFirstOrThrow({
      where: { id: input.gameId },
      include: {
        homeTeam: true,
        awayTeam: true,
        field: { include: { venue: { select: { name: true, timezone: true } } } },
      },
    }),
  ])

  const match = `${game.homeTeam.name} v ${game.awayTeam.name}`
  const timezone = game.field?.venue.timezone ?? 'UTC'
  const when = formatInstantInZone(game.startTime, timezone)
  const where = game.field ? `${game.field.venue.name} — ${game.field.name}` : 'venue to be confirmed'
  const link = appUrl(`/app/${org.slug}/officiating`)

  return notify({
    orgId: input.orgId,
    kind: 'officiatingRequest',
    recipients: await refereeRecipient(input.refereeId),
    entityType: 'OfficiatingRequest',
    entityId: input.requestId,
    actorLabel: input.actorLabel,
    meta: { gameId: input.gameId, requestId: input.requestId, decision: input.decision },
    subject:
      input.decision === 'approved'
        ? `${org.name}: you have ${match}`
        : `${org.name}: ${match} went to someone else`,
    body: (recipient) =>
      input.decision === 'approved'
        ? [
            `Hello ${recipient.name},`,
            '',
            `Your request to officiate ${match} was approved. You are down as ${input.position}.`,
            '',
            `When: ${when}`,
            `Where: ${where}`,
            ...(input.decisionNote ? ['', input.decisionNote] : []),
            '',
            // An approved request already puts them on the crew, so there is
            // nothing further to accept — saying so avoids a pointless trip.
            `Nothing else is needed from you. Your assignments: ${link}`,
            '',
            settingsFooter(org.slug),
          ].join('\n')
        : [
            `Hello ${recipient.name},`,
            '',
            `Your request to officiate ${match} (${when}) was not taken up.`,
            ...(input.decisionNote ? ['', `Reason given: ${input.decisionNote}`] : []),
            '',
            `Other games needing an official: ${link}`,
            '',
            settingsFooter(org.slug),
          ].join('\n'),
  })
}

/**
 * Records that a dispatch was skipped and why.
 *
 * Used where a notification is conditional on something other than a preference — a
 * game with nobody attached, say. Without this, "no email was sent" and "no email was
 * attempted" look identical in the trail.
 */
export async function recordNoRecipients(input: {
  orgId: string
  kind: NotificationKind
  entityType: string
  entityId: string
  actorLabel: string
}): Promise<void> {
  await recordAudit({
    orgId: input.orgId,
    actorLabel: input.actorLabel,
    entityType: input.entityType,
    entityId: input.entityId,
    action: 'notification.skipped',
    meta: { kind: input.kind, reason: 'no recipients with a login' },
  })
}

/**
 * Somebody joined or left a team.
 *
 * Goes to that team's staff, minus whoever made the change — telling someone about
 * their own edit is noise, and it is the single most common way a notification system
 * loses people's trust. Off by default, because a busy club secretary adding thirty
 * players does not need thirty emails about it.
 */
export async function notifyRosterChanged(input: {
  orgId: string
  teamId: string
  actorUserId: string
  actorLabel: string
  summary: string
}): Promise<NotifyResult> {
  const [org, team] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: input.orgId }, select: { name: true, slug: true } }),
    prisma.team.findFirstOrThrow({ where: { id: input.teamId }, select: { name: true } }),
  ])

  const staff = await prisma.teamMembership.findMany({
    where: {
      teamId: input.teamId,
      deletedAt: null,
      activeTo: null,
      role: { in: ['coach', 'assistant', 'manager'] },
      person: { deletedAt: null, user: { deletedAt: null } },
    },
    include: { person: { include: { user: { select: { id: true, email: true, name: true } } } } },
  })

  const recipients = dedupe(
    staff.flatMap((membership) =>
      membership.person.user && membership.person.user.id !== input.actorUserId
        ? [
            {
              userId: membership.person.user.id,
              email: membership.person.user.email,
              name: membership.person.user.name,
            },
          ]
        : [],
    ),
  )

  const link = appUrl(`/app/${org.slug}/teams/${input.teamId}`)
  const settingsLine = settingsFooter(org.slug)

  return notify({
    orgId: input.orgId,
    kind: 'rosterChanged',
    recipients,
    entityType: 'Team',
    entityId: input.teamId,
    actorLabel: input.actorLabel,
    meta: { teamId: input.teamId, summary: input.summary },
    subject: `${org.name}: ${team.name} roster changed`,
    body: (recipient) =>
      [
        `Hello ${recipient.name},`,
        '',
        `The ${team.name} roster has changed: ${input.summary}.`,
        '',
        `Roster: ${link}`,
        '',
        settingsLine,
      ].join('\n'),
  })
}
