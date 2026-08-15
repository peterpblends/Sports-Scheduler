import { describe, expect, it } from 'vitest'
import { can, ROLES } from '@/lib/authz'
import { quickStartStepsFor } from '@/components/quick-start'
import type { Role } from '@prisma/client'

/**
 * The dashboard quick-start guide.
 *
 * The content itself is prose and not worth asserting word by word. What *is* worth
 * asserting is the thing that would quietly go wrong: a step linking a role to a page
 * it cannot act on. Several pages are readable by roles that cannot use them —
 * `/setup` needs only `structure:read`, so a coach can open it and find every control
 * refused — so these tests check the guide never points anybody at one.
 */

const ctx = {
  orgSlug: 'riverside-youth-soccer',
  publicSlug: 'riverside-youth-soccer',
  seasonId: 'season-1',
  teamId: 'team-1',
}

/** Which permission each linked page actually requires to be *useful*, not just readable. */
const PAGE_REQUIREMENTS: Array<{ match: string; needs: Parameters<typeof can>[1] }> = [
  { match: '/setup', needs: 'structure:write' },
  { match: '/members', needs: 'member:read' },
  { match: '/generate', needs: 'schedule:generate' },
  { match: '/versions', needs: 'schedule:publish' },
  { match: '/schedule/officials', needs: 'official:assign' },
  { match: '/officiating', needs: 'official:read:own' },
]

describe('every role gets a usable guide', () => {
  for (const role of ROLES) {
    it(`${role} gets steps, and every step is actionable by them`, () => {
      const steps = quickStartStepsFor(role as Role, ctx)

      // Nobody lands on an empty guide.
      expect(steps.length).toBeGreaterThan(0)
      expect(steps.length).toBeLessThanOrEqual(6)

      for (const step of steps) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)

        if (!step.href) continue

        for (const rule of PAGE_REQUIREMENTS) {
          // `/schedule/officials` also contains `/schedule`, so match the most
          // specific rule only.
          if (!step.href.includes(rule.match)) continue
          if (rule.match === '/officiating' && step.href.includes('/schedule/officials')) continue
          expect(
            can(role as Role, rule.needs),
            `${role} is linked to ${step.href} but lacks ${rule.needs}`,
          ).toBe(true)
        }
      }
    })
  }
})

describe('the guide is shaped per role', () => {
  it('never sends a coach or viewer to setup, members or the assignment board', () => {
    for (const role of ['coach', 'viewer'] as Role[]) {
      const hrefs = quickStartStepsFor(role, ctx).map((step) => step.href ?? '')
      expect(hrefs.some((href) => href.includes('/setup'))).toBe(false)
      expect(hrefs.some((href) => href.includes('/members'))).toBe(false)
      expect(hrefs.some((href) => href.includes('/schedule/officials'))).toBe(false)
      expect(hrefs.some((href) => href.includes('/generate'))).toBe(false)
    }
  })

  it('leads a referee with availability, because everything else depends on it', () => {
    const steps = quickStartStepsFor('referee', ctx)
    expect(steps[0]!.title.toLowerCase()).toMatch(/availab|when you can/)
    expect(steps[0]!.href).toContain('/officiating')
  })

  it('tells an organizer to publish, the step most often missed', () => {
    const titles = quickStartStepsFor('admin', ctx).map((step) => step.title.toLowerCase())
    expect(titles.some((title) => title.includes('publish'))).toBe(true)
  })

  it('omits a scheduler’s member-management step, which they cannot do', () => {
    const steps = quickStartStepsFor('scheduler', ctx)
    expect(steps.some((step) => step.href?.includes('/members'))).toBe(false)
    // But they keep the parts of the organizer flow they can act on.
    expect(steps.some((step) => step.href?.includes('/generate'))).toBe(true)
    expect(steps.some((step) => step.href?.includes('/versions'))).toBe(true)
  })

  it('drops season-scoped links when there is no season yet', () => {
    const steps = quickStartStepsFor('owner', { ...ctx, seasonId: null })
    // The steps stay — the advice is still true — but nothing links to a URL built
    // from a season id that does not exist.
    expect(steps.some((step) => step.title.toLowerCase().includes('generate'))).toBe(true)
    expect(steps.every((step) => !step.href?.includes('/seasons/'))).toBe(true)
  })

  it('omits the coach roster link when they are on no team', () => {
    const steps = quickStartStepsFor('coach', { ...ctx, teamId: null })
    const roster = steps.find((step) => step.title.toLowerCase().includes('roster'))
    expect(roster).toBeDefined()
    expect(roster!.href).toBeUndefined()
  })
})

describe('a scheduler is still told where field availability lives', () => {
  it('gets a venues step in place of the setup checklist they cannot use', () => {
    const steps = quickStartStepsFor('scheduler', ctx)

    // They lack `structure:write`, so the setup checklist is not theirs...
    expect(steps.some((step) => step.href?.includes('/setup'))).toBe(false)
    // ...but they are the ones who run generation, and a field with no declared
    // availability is the usual reason it comes back empty. They must not lose it.
    const venues = steps.find((step) => step.href?.includes('/venues'))
    expect(venues, 'a scheduler needs the field-availability step').toBeDefined()
    expect(venues!.detail.toLowerCase()).toContain('available')
  })

  it('gives an owner the full checklist instead, not both', () => {
    const steps = quickStartStepsFor('owner', ctx)
    expect(steps.some((step) => step.href?.includes('/setup'))).toBe(true)
    expect(steps.some((step) => step.href?.includes('/venues'))).toBe(false)
  })
})
