/**
 * How many times each AGE BAND has been passed over.
 *
 * The table prints up to six rows — six age bands, oldest first — and this
 * counter answers exactly ONE question about them: when the model chose a fold
 * START, how often did that start fall OUTSIDE this band?
 *
 * The bands are SLOTS, not content (the owner's definition, 2026-10-16):
 *
 *  - nothing here is keyed by a seq range. A band keeps its counter when the
 *    surface grows, when its representative row changes, and when a fold lands
 *    — the number is never reset because a key moved. "The band the fold starts
 *    in" is decided by the regions the LAST table build printed, which is the
 *    table the model was actually reading when it chose.
 *  - one CHOICE = one compress call. A sweep that folds seventy spans is ONE
 *    choice, and its start is the earliest seq it folds — that is the point the
 *    model committed to. Every band whose region does not contain that seq gets
 *    +1; the band it lands in does not.
 *  - a start that lands in NO band (older than the first band's region, newer
 *    than the last) counts for every band.
 *
 * So a climbing number reads "the model keeps choosing a start somewhere else",
 * and the band with the smallest number is the one folds keep starting in.
 * In-memory and session-scoped: a restart starts over.
 *
 * @module billion-context-dsh/band-skips
 */

/** One band's region on the surface: its first offerable span's start .. its last span's end. */
export interface BandRegion {
  readonly start: number
  readonly end: number
}

/** How many sessions are tracked at once (the engine has no disposal hook on this line). */
const SESSION_LIMIT = 50

/** The regions the LAST build printed, per session — how a later choice is attributed. */
const regions = new Map<string, readonly BandRegion[]>()

/** The counters, per session, aligned with {@link regions} (index 0 = band 1). */
const skips = new Map<string, number[]>()

/** Insert/refresh one session's entry, evicting the least recently written session. */
function touch<T>(map: Map<string, T>, sessionId: string, value: T): void {
  map.delete(sessionId)
  map.set(sessionId, value)
  while (map.size > SESSION_LIMIT) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
    skips.delete(oldest.value)
  }
}

/**
 * Record the regions of the build that is about to be shown to the model. Pure
 * bookkeeping: a build is not a choice, so nothing increments here.
 *
 * @param sessionId - the session the table was built for.
 * @param bands - one region per printed band, oldest first.
 */
export function noteBandRegions(sessionId: string, bands: readonly BandRegion[]): void {
  touch(regions, sessionId, bands.map((band) => ({ start: band.start, end: band.end })))
  if (!skips.has(sessionId)) touch(skips, sessionId, bands.map(() => 0))
  else touch(skips, sessionId, skips.get(sessionId)!)
}

/**
 * One model CHOICE: every band whose region does not contain `chosenSeq` is
 * counted as passed over. The band it lands in is left alone.
 *
 * @param sessionId - the session the fold belongs to.
 * @param chosenSeq - the earliest seq this compress call folds (a sweep is one choice).
 */
export function noteBandChoice(sessionId: string, chosenSeq: number): void {
  const bands = regions.get(sessionId)
  if (bands === undefined || bands.length === 0) return
  const counters = skips.get(sessionId) ?? bands.map(() => 0)
  const next = bands.map((band, index) => {
    const inside = band.start <= chosenSeq && chosenSeq <= band.end
    return (counters[index] ?? 0) + (inside ? 0 : 1)
  })
  touch(skips, sessionId, next)
}

/** The counters of the last build's bands, oldest first (empty before any build). */
export function lastBandSkipsOf(sessionId: string): readonly number[] {
  return skips.get(sessionId) ?? []
}

/** Drop one session's regions and counters. */
export function forgetBandSkips(sessionId: string): void {
  regions.delete(sessionId)
  skips.delete(sessionId)
}

/** The remembered band count for one session (tests and diagnostics). */
export function trackedBandsOf(sessionId: string): number {
  return regions.get(sessionId)?.length ?? 0
}
