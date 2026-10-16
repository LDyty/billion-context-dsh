/**
 * How many times the range table has OFFERED a piece of the surface.
 *
 * Why this signal and not a timestamp: wall-clock age measures the operator's
 * idle gaps as much as the work (a session resumed the next day holds content
 * written minutes ago), so "this span is 33 hours old" says nothing about whether
 * it is consumed. "This span has been put in front of the model 141 times and
 * never folded" does — it is a fact about the model's own decisions, and it
 * survives any break in the operator's schedule.
 *
 * The unit of counting is the START of a printed row, matched by COVERAGE rather
 * than by equality: a row's edges drift by a message or two between builds as the
 * surface grows, and an exact `start..end` key would reset the count every time
 * that happens. So a build adds one to every printed start, and the count a row
 * prints is "how many builds (including this one) put a row in front of the model
 * that covered this start".
 *
 * A fold that lands clears the builds whose rows it replaced: the content those
 * offers described is gone, so they must not keep counting toward whatever
 * survives around them.
 *
 * In-memory and session-scoped: a restart starts counting again. The number is a
 * recency-of-refusal signal, not durable accounting (the block ledger is that).
 *
 * @module billion-context-dsh/offer-count
 */

/** One build's printed rows, as `{ start, end }` spans. */
type OfferedBuild = readonly { readonly start: number; readonly end: number }[]

/** How many builds are remembered per session (a bounded rolling window). */
const HISTORY_LIMIT = 200

/**
 * How many sessions are tracked at once. The engine has no session-disposal hook
 * on this line, so the map is kept small the same way its own caches are: the
 * least recently written session falls out.
 */
const SESSION_LIMIT = 50

const histories = new Map<string, OfferedBuild[]>()

/** The counts the LAST build produced, per session — the read face for acp_status. */
const lastCounts = new Map<string, Map<number, number>>()

/** Insert/refresh one session's history, evicting the least recently written session. */
function putHistory(sessionId: string, history: OfferedBuild[]): void {
  histories.delete(sessionId)
  histories.set(sessionId, history)
  while (histories.size > SESSION_LIMIT) {
    const oldest = histories.keys().next()
    if (oldest.done === true) break
    histories.delete(oldest.value)
  }
}

/**
 * Record one build's printed rows.
 *
 * @param sessionId - the session the table was built for.
 * @param rows - the rows that were actually printed (the offered shortlist).
 * @returns per printed start, how many builds have covered it, THIS ONE INCLUDED.
 */
export function noteOfferedRows(
  sessionId: string,
  rows: readonly { readonly start: number; readonly end: number }[],
): Map<number, number> {
  const history = histories.get(sessionId) ?? []
  const counts = new Map<number, number>()
  for (const row of rows) {
    let previous = 0
    for (const build of history) {
      if (build.some((span) => span.start <= row.start && row.start <= span.end)) previous += 1
    }
    counts.set(row.start, previous + 1)
  }
  history.push(rows.map((row) => ({ start: row.start, end: row.end })))
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
  putHistory(sessionId, history)
  lastCounts.delete(sessionId)
  lastCounts.set(sessionId, counts)
  return counts
}

/**
 * The counts the last build produced, keyed by the row's start seq.
 *
 * The nudge table prints these inline; `acp_status` is the other place a model
 * reads compressible ranges, so it needs the same numbers or the signal is
 * invisible to anyone who consults status instead of the nudge.
 */
export function lastOfferedCountsOf(sessionId: string): ReadonlyMap<number, number> {
  return lastCounts.get(sessionId) ?? new Map()
}

/**
 * A durable fold landed: forget every remembered offer whose span it replaced.
 *
 * `shadowed` is a contiguous surface slice (the transaction's own `shadowedSeqs`),
 * so an interval test is exact here.
 *
 * @param sessionId - the session the fold belongs to.
 * @param shadowed - the seqs the fold shadowed.
 */
export function noteFoldLanded(sessionId: string, shadowed: readonly number[]): void {
  const history = histories.get(sessionId)
  if (history === undefined || shadowed.length === 0) return
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const seq of shadowed) {
    if (seq < low) low = seq
    if (seq > high) high = seq
  }
  const kept = history
    .map((build) => build.filter((span) => span.end < low || span.start > high))
    .filter((build) => build.length > 0)
  putHistory(sessionId, kept)
}

/** Drop one session's history (session disposal). */
export function forgetOffers(sessionId: string): void {
  histories.delete(sessionId)
  lastCounts.delete(sessionId)
}

/** The remembered build count for one session (tests and diagnostics). */
export function offeredBuildsOf(sessionId: string): number {
  return histories.get(sessionId)?.length ?? 0
}
