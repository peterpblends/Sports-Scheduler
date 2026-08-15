/**
 * Schedule snapshots and the diff between two of them.
 *
 * A snapshot is the frozen content of a version. It denormalizes every name it
 * displays — teams, venues, fields, officials — because a version has to render the
 * same way in a year's time even if a team is renamed or a venue is retired. Storing
 * only ids would let old versions silently change meaning, which defeats the point
 * of an immutable snapshot.
 *
 * `diffSnapshots` is a pure function, so the diff logic is testable without a
 * database and identical whether it runs on the server or in a report.
 */

export const SNAPSHOT_VERSION = 1

export type OfficialSnapshot = {
  refereeId: string
  refereeName: string
  position: string
  status: string
}

export type GameSnapshot = {
  /** The live row's id at the moment of capture. Used to match across versions. */
  gameId: string
  divisionId: string
  divisionName: string
  homeTeamId: string
  homeTeamName: string
  awayTeamId: string
  awayTeamName: string
  fieldId: string | null
  fieldName: string | null
  venueId: string | null
  venueName: string | null
  /** The venue's zone, so the snapshot renders in local time without a lookup. */
  timezone: string | null
  /** ISO 8601 UTC. */
  startTime: string
  durationMinutes: number
  status: string
  homeScore: number | null
  awayScore: number | null
  roundNumber: number | null
  notes: string | null
  officials: OfficialSnapshot[]
}

export type ScheduleSnapshot = {
  snapshotVersion: number
  seasonId: string
  takenAt: string
  games: GameSnapshot[]
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Identity of a *fixture* rather than a row: this pairing, in this division, in this
 * round.
 *
 * Needed because a regeneration replaces every `Game` row, so ids do not survive it.
 * Without a fixture-level identity every regeneration would read as "72 games removed,
 * 72 added" instead of "these eight moved" — which is the diff an admin actually wants.
 */
function fixtureKey(game: GameSnapshot): string {
  return [game.divisionId, game.homeTeamId, game.awayTeamId, game.roundNumber ?? '-'].join('|')
}

/** Same pairing, ignoring which side is nominally home and which round it fell in. */
function pairingKey(game: GameSnapshot): string {
  const [a, b] = [game.homeTeamId, game.awayTeamId].sort()
  return `${game.divisionId}|${a}|${b}`
}

export type MovedGame = {
  before: GameSnapshot
  after: GameSnapshot
  /** How the two were matched, which tells the reader how much to trust the pairing. */
  matchedBy: 'game_id' | 'fixture' | 'pairing'
  timeChanged: boolean
  fieldChanged: boolean
  statusChanged: boolean
  scoreChanged: boolean
  /** Minutes the kickoff shifted. Negative means earlier. */
  minutesMoved: number
}

export type OfficialsChange = {
  game: GameSnapshot
  added: OfficialSnapshot[]
  removed: OfficialSnapshot[]
  /** Same official and position, different acceptance status. */
  statusChanged: Array<{ before: OfficialSnapshot; after: OfficialSnapshot }>
}

export type SnapshotDiff = {
  added: GameSnapshot[]
  removed: GameSnapshot[]
  moved: MovedGame[]
  officialsChanged: OfficialsChange[]
  /** Matched games with nothing changed at all. */
  unchanged: number
  counts: {
    before: number
    after: number
    added: number
    removed: number
    moved: number
    officialsChanged: number
    unchanged: number
  }
}

function officialKey(official: OfficialSnapshot): string {
  return `${official.refereeId}|${official.position}`
}

function diffOfficials(
  before: GameSnapshot,
  after: GameSnapshot,
): Omit<OfficialsChange, 'game'> | null {
  const beforeByKey = new Map(before.officials.map((o) => [officialKey(o), o]))
  const afterByKey = new Map(after.officials.map((o) => [officialKey(o), o]))

  const added = after.officials.filter((o) => !beforeByKey.has(officialKey(o)))
  const removed = before.officials.filter((o) => !afterByKey.has(officialKey(o)))
  const statusChanged: OfficialsChange['statusChanged'] = []

  for (const [key, beforeOfficial] of beforeByKey) {
    const afterOfficial = afterByKey.get(key)
    if (afterOfficial && afterOfficial.status !== beforeOfficial.status) {
      statusChanged.push({ before: beforeOfficial, after: afterOfficial })
    }
  }

  if (added.length === 0 && removed.length === 0 && statusChanged.length === 0) return null
  return { added, removed, statusChanged }
}

/**
 * Compares two snapshots.
 *
 * Matching runs in three passes, most reliable first: same row id, then same fixture
 * (division + teams + round), then same pairing regardless of round. Each game is
 * consumed by the first pass that claims it, so nothing is double-counted. Whatever is
 * left over on each side is genuinely added or removed.
 */
export function diffSnapshots(before: ScheduleSnapshot, after: ScheduleSnapshot): SnapshotDiff {
  const unmatchedBefore = new Map(before.games.map((game) => [game.gameId, game]))
  const unmatchedAfter = new Map(after.games.map((game) => [game.gameId, game]))
  const pairs: Array<{ before: GameSnapshot; after: GameSnapshot; matchedBy: MovedGame['matchedBy'] }> = []

  // Pass 1 — the same persisted row survived, so this is definitively the same game.
  for (const [id, beforeGame] of [...unmatchedBefore]) {
    const afterGame = unmatchedAfter.get(id)
    if (afterGame) {
      pairs.push({ before: beforeGame, after: afterGame, matchedBy: 'game_id' })
      unmatchedBefore.delete(id)
      unmatchedAfter.delete(id)
    }
  }

  // Pass 2 — same fixture in the same round, after a regeneration replaced the rows.
  const matchOn = (key: (game: GameSnapshot) => string, matchedBy: MovedGame['matchedBy']) => {
    const index = new Map<string, GameSnapshot[]>()
    for (const game of unmatchedAfter.values()) {
      const k = key(game)
      index.set(k, [...(index.get(k) ?? []), game])
    }
    // Sorted so which of two identical candidates gets claimed is deterministic.
    for (const list of index.values()) list.sort((a, b) => a.gameId.localeCompare(b.gameId))

    for (const beforeGame of [...unmatchedBefore.values()].sort((a, b) =>
      a.gameId.localeCompare(b.gameId),
    )) {
      const candidates = index.get(key(beforeGame))
      const afterGame = candidates?.shift()
      if (!afterGame) continue
      pairs.push({ before: beforeGame, after: afterGame, matchedBy })
      unmatchedBefore.delete(beforeGame.gameId)
      unmatchedAfter.delete(afterGame.gameId)
    }
  }

  matchOn(fixtureKey, 'fixture')
  // Pass 3 — same two teams, different round. A reshuffle rather than a new fixture.
  matchOn(pairingKey, 'pairing')

  const moved: MovedGame[] = []
  const officialsChanged: OfficialsChange[] = []
  let unchanged = 0

  for (const pair of pairs) {
    const timeChanged = pair.before.startTime !== pair.after.startTime
    const fieldChanged = pair.before.fieldId !== pair.after.fieldId
    const statusChanged = pair.before.status !== pair.after.status
    const scoreChanged =
      pair.before.homeScore !== pair.after.homeScore ||
      pair.before.awayScore !== pair.after.awayScore

    const officials = diffOfficials(pair.before, pair.after)
    if (officials) officialsChanged.push({ game: pair.after, ...officials })

    if (timeChanged || fieldChanged || statusChanged || scoreChanged) {
      moved.push({
        before: pair.before,
        after: pair.after,
        matchedBy: pair.matchedBy,
        timeChanged,
        fieldChanged,
        statusChanged,
        scoreChanged,
        minutesMoved: Math.round(
          (new Date(pair.after.startTime).getTime() - new Date(pair.before.startTime).getTime()) /
            60_000,
        ),
      })
    } else if (!officials) {
      unchanged += 1
    }
  }

  const sortGames = (games: GameSnapshot[]) =>
    [...games].sort(
      (a, b) => a.startTime.localeCompare(b.startTime) || a.gameId.localeCompare(b.gameId),
    )

  const added = sortGames([...unmatchedAfter.values()])
  const removed = sortGames([...unmatchedBefore.values()])

  moved.sort(
    (a, b) =>
      a.after.startTime.localeCompare(b.after.startTime) ||
      a.after.gameId.localeCompare(b.after.gameId),
  )
  officialsChanged.sort(
    (a, b) =>
      a.game.startTime.localeCompare(b.game.startTime) || a.game.gameId.localeCompare(b.game.gameId),
  )

  return {
    added,
    removed,
    moved,
    officialsChanged,
    unchanged,
    counts: {
      before: before.games.length,
      after: after.games.length,
      added: added.length,
      removed: removed.length,
      moved: moved.length,
      officialsChanged: officialsChanged.length,
      unchanged,
    },
  }
}

/** True when two snapshots hold the same schedule, ignoring row ids and capture time. */
export function snapshotsMatch(a: ScheduleSnapshot, b: ScheduleSnapshot): boolean {
  const diff = diffSnapshots(a, b)
  return (
    diff.counts.added === 0 &&
    diff.counts.removed === 0 &&
    diff.counts.moved === 0 &&
    diff.counts.officialsChanged === 0
  )
}

/** Parses a snapshot out of a Json column, rejecting anything malformed. */
export function parseSnapshot(value: unknown): ScheduleSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as ScheduleSnapshot).games)
  ) {
    throw new Error('Stored snapshot is not a schedule snapshot.')
  }
  return value as ScheduleSnapshot
}
