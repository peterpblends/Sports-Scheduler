import Link from 'next/link'
import type { Role } from '@prisma/client'
import { can, type Permission } from '@/lib/authz'
import { Card } from './ui'

/**
 * A short, role-specific "what do I do here" guide for the dashboard.
 *
 * Three things shape this:
 *
 * **Steps are gated on permission, not on page availability.** Several pages are
 * readable by roles that cannot act on them — `/setup` needs only `structure:read`,
 * so a coach can open it — and sending someone to a screen where every button
 * refuses them is worse than not mentioning it. Each step names the permission it
 * needs and disappears without it.
 *
 * **It opens itself only when it is needed.** `defaultOpen` is computed from the
 * caller's actual state: an organization with no venues yet, a referee who has not
 * set availability, a season with nothing published. Someone who has already done
 * the work gets a collapsed one-line summary instead of a lecture. That is why there
 * is no "don't show me again" — the condition *is* the dismissal, so nothing has to
 * be stored and nothing goes stale.
 *
 * **Native `<details>`, no JavaScript.** It works before hydration, costs nothing on
 * a phone, and cannot flash open-then-closed the way a localStorage-backed panel
 * does on every page load.
 */

export type QuickStartStep = {
  title: string
  /** One sentence. What it is for, or the thing people get wrong. */
  detail: string
  href?: string
  linkLabel?: string
  /** Rendered only if the role holds this. */
  needs?: Permission
}

export type QuickStartContext = {
  orgSlug: string
  publicSlug: string
  /** The active season, when there is one. Steps needing it are dropped otherwise. */
  seasonId: string | null
  /** A coach's first team, for a direct roster link. */
  teamId?: string | null
}

/**
 * Exported for tests: the steps are pure data, so which role gets which link is
 * assertable without rendering anything.
 */
export function quickStartStepsFor(role: Role, ctx: QuickStartContext): QuickStartStep[] {
  const app = `/app/${ctx.orgSlug}`

  // --- referee
  if (can(role, 'official:read:own') && !can(role, 'schedule:edit')) {
    return [
      {
        title: 'Tell us when you can referee',
        detail:
          'Set your weekly windows and any dates you are away. The scheduler treats these as hard rules, so nothing will be offered to you outside them — this is the step that makes everything else work.',
        href: `${app}/officiating`,
        linkLabel: 'Set my availability',
      },
      {
        title: 'Answer the games offered to you',
        detail:
          'Accept or decline each one. Until you answer, nobody knows whether the game is covered.',
        href: `${app}/officiating`,
        linkLabel: 'My games',
      },
      {
        title: 'Pick up a spare game',
        detail:
          'Games short of an official are listed with a button to ask for one. If you cannot take a game, the reason is shown instead — usually a clash or your daily limit.',
        href: `${app}/officiating`,
        linkLabel: 'Games needing an official',
      },
      {
        title: 'Put your games in your calendar',
        detail:
          'A subscription link that stays up to date on its own, so a moved kickoff moves in your phone too.',
        href: `${app}/subscriptions`,
        linkLabel: 'Subscribe',
      },
    ]
  }

  // --- coach
  if (can(role, 'roster:write:own') && !can(role, 'schedule:edit')) {
    return [
      {
        title: 'Check your next game',
        detail:
          'Kickoff, venue and field are at the top of this page, shown in the venue’s local time — not yours, so a travel game reads correctly.',
      },
      {
        title: 'Keep your roster current',
        detail:
          'Add and remove players on your own team. You can paste a spreadsheet in rather than typing names one at a time.',
        href: ctx.teamId ? `${app}/teams/${ctx.teamId}` : undefined,
        linkLabel: 'My team',
      },
      {
        title: 'Subscribe to your fixtures',
        detail:
          'A live calendar feed for your team. It updates itself when a game moves, so it never goes stale the way a copied list does.',
        href: `${app}/subscriptions`,
        linkLabel: 'Subscribe',
      },
      {
        title: 'Everything else is read-only',
        detail:
          'You can see the full schedule and other teams, but only an organizer can move a game. Ask them if something needs changing.',
        href: `${app}/schedule`,
        linkLabel: 'Full schedule',
      },
    ]
  }

  // --- viewer
  if (!can(role, 'schedule:edit')) {
    return [
      {
        title: 'Find a game',
        detail:
          'The schedule can be filtered by team, division, venue or date, and every time is shown in the local time of the venue it is played at.',
        href: `${app}/schedule`,
        linkLabel: 'Open the schedule',
      },
      {
        title: 'Follow it in your calendar',
        detail:
          'Subscribe once and moved games update themselves. Better than a printout that is wrong by Saturday.',
        href: `${app}/subscriptions`,
        linkLabel: 'Subscribe',
      },
      {
        title: 'Share it with a parent',
        detail:
          'A public page that needs no login and shows only what has been published — no officials, no contact details.',
        href: `/s/${ctx.publicSlug}`,
        linkLabel: 'Public page',
      },
    ]
  }

  // --- organizer: owner, admin, scheduler
  const steps: QuickStartStep[] = [
    // Two spellings of the same first step, because a scheduler holds `venue:write`
    // but not `structure:write`. Dropping it for them would leave the person who
    // actually runs generation never told where field availability lives — and a
    // field with no declared availability is the single most common reason a
    // generation comes back with everything unplaced.
    ...(can(role, 'structure:write')
      ? [
          {
            title: 'Set up the basics',
            detail:
              'Leagues, teams, venues, and — the one people miss — when each field is actually available. The scheduler cannot place a game into a slot you have not told it about.',
            href: `${app}/setup`,
            linkLabel: 'Setup checklist',
          },
        ]
      : [
          {
            title: 'Check when the fields are free',
            detail:
              'Every field needs its available hours declared before a game can be placed in them. If a generation comes back with nothing placed, this is almost always why.',
            href: `${app}/venues`,
            linkLabel: 'Venues and field availability',
            needs: 'venue:write' as Permission,
          },
        ]),
    {
      title: 'Invite the people who need in',
      detail:
        'A scheduler can build and publish schedules but cannot change members. A coach only ever edits their own roster. A referee only sees their own games.',
      href: `${app}/members`,
      linkLabel: 'Members',
      needs: 'member:invite',
    },
    {
      title: 'Generate a draft schedule',
      detail:
        'Preview first — it costs nothing and shows what it could not place. The same settings always produce the same schedule, so you can re-run it safely.',
      href: ctx.seasonId ? `${app}/seasons/${ctx.seasonId}/generate` : undefined,
      linkLabel: 'Generate',
      needs: 'schedule:generate',
    },
    {
      title: 'Fix anything by dragging it',
      detail:
        'Drop a game on a new slot. If that breaks a hard rule — double-booked field, a team playing twice, a referee who is not available — you are told which, and can override with a reason that is recorded.',
      href: `${app}/schedule`,
      linkLabel: 'Schedule',
      needs: 'schedule:edit',
    },
    {
      title: 'Publish it, or nobody sees it',
      detail:
        'This is the step that catches people out. Coaches, referees and viewers see the published version only — your draft stays private until you publish, and each publish is a version you can roll back to.',
      href: ctx.seasonId ? `${app}/seasons/${ctx.seasonId}/versions` : undefined,
      linkLabel: 'Versions',
      needs: 'schedule:publish',
    },
    {
      title: 'Staff the games',
      detail:
        'The assignment board lists every game short of a crew, worst first, and any referee who has volunteered. Approving a volunteer is the quickest way to fill a gap.',
      href: `${app}/schedule/officials`,
      linkLabel: 'Assignment board',
      needs: 'official:assign',
    },
  ]

  return steps.filter((step) => !step.needs || can(role, step.needs))
}

/** Plain-language name for the guide's heading. */
const ROLE_LABEL: Record<Role, string> = {
  owner: 'an owner',
  admin: 'an admin',
  scheduler: 'a scheduler',
  coach: 'a coach',
  referee: 'a referee',
  viewer: 'a viewer',
}

export function QuickStart({
  role,
  defaultOpen = false,
  ...ctx
}: QuickStartContext & { role: Role; defaultOpen?: boolean }) {
  const steps = quickStartStepsFor(role, ctx)
  if (steps.length === 0) return null

  return (
    <Card className="mb-6">
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <span>
            <span className="text-base font-semibold">Quick start</span>
            <span className="ml-2 text-sm text-ink-500 dark:text-ink-300">
              {steps.length} steps for {ROLE_LABEL[role]}
            </span>
          </span>
          {/* Rotates with the disclosure. `group-open` needs no JavaScript. */}
          <span
            aria-hidden="true"
            className="text-ink-400 transition-transform group-open:rotate-90"
          >
            ▶
          </span>
        </summary>

        <ol className="mt-4 space-y-4">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-turf-500/15 text-xs font-semibold tabular-nums text-turf-700 dark:text-turf-500"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium">{step.title}</div>
                <p className="mt-0.5 text-sm text-ink-600 dark:text-ink-300">{step.detail}</p>
                {step.href && (
                  <Link
                    href={step.href}
                    className="mt-1 inline-block text-sm font-medium text-turf-600 hover:underline"
                  >
                    {step.linkLabel ?? 'Open'} →
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </details>
    </Card>
  )
}
