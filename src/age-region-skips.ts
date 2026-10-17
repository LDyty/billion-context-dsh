/**
 * How many times each 年龄区域 (age region) has been passed over.
 *
 * The table prints up to three rows per age region, oldest first — the region
 * COUNT is configurable (engine `ageRegions`, default 6) — and this counter
 * answers exactly ONE question about them: when the model chose a fold START,
 * how often did that start fall OUTSIDE this age region?
 *
 * The age regions are SLOTS, not content (the owner's definition, 2026-10-16):
 *
 *  - nothing here is keyed by a seq range. An age region keeps its counter when the
 *    surface grows, when its representative row changes, and when a fold lands
 *    — the number is never reset because a key moved. "The age region the fold
 *    starts in" is decided by the spans the LAST table build printed, which is the
 *    table the model was actually reading when it chose.
 *  - one CHOICE = one compress call. A sweep that folds seventy spans is ONE
 *    choice, and its start is the earliest seq it folds — that is the point the
 *    model committed to. Every age region whose span does not contain that seq gets
 *    +1; the age region it lands in does not.
 *  - a start that lands in NO age region (older than the first age region's span,
 *    newer than the last) counts for every age region.
 *  - SWEEP RETRACTION (owner rule, 2026-10-16): when one call folds a
 *    CONTIGUOUS RUN of more than one span — a sweep, i.e. the run of
 *    compressible ranges the table offers from one start, with nothing
 *    compressible left unfolded in between — every age region those OTHER spans
 *    reach into gets −1: the call did not pass that age region over, it folded
 *    through it. Every such age region was +1'd a line earlier, so the sweep
 *    leaves its count where it was (floored at 0). A single-span call never
 *    retracts (it cannot cover an age region it did not start in), and neither
 *    does a batch of unrelated scattered segments — those really did pass the
 *    age regions between them over. "Contiguous" is judged against the
 *    offerable spans of the LAST build, which is the table the model read.
 *
 * So a climbing number reads "the model keeps choosing a start somewhere else",
 * and the age region with the smallest number is the one folds keep starting in.
 *
 * PERSISTENCE (sidecar, 2026-10-16): the counters live in
 * `<DSH_HOME>/dsh-acp-age-region-skips.json` — one small file, not the session log —
 * so a restart no longer wipes a day's worth of choices ("skipped 40×" survives
 * the operator opening and closing dsh all day). Only the per-age-region
 * counters are stored; the spans are re-recorded by the next build anyway. A
 * missing or unreadable file degrades to zeros, never throws, and the file is
 * pruned to the most recently updated sessions so it cannot grow without bound.
 *
 * The file was called `dsh-acp-band-skips.json` before the 2026-10-16 wording
 * ruling ("1–6 are 年龄区域, and the identifier is ageRegion"). The old name is
 * still READ once as a fallback and then written forward under the new name, so
 * renaming the concept does not silently reset a day of counters.
 *
 * @module billion-context-dsh/age-region-skips
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * One seq span (inclusive), used for the two things that share the shape: the
 * stretch an age region covers on the surface, and one compressible range the
 * model folds.
 */
export interface SeqSpan {
  readonly start: number
  readonly end: number
}

/** Does a folded span reach into this age region's span? (Spans overlap; one span can cross several.) */
function reaches(ageRegion: SeqSpan, span: SeqSpan): boolean {
  return span.start <= ageRegion.end && span.end >= ageRegion.start
}

/**
 * Is there an offerable range sitting unfolded BETWEEN any two of these spans?
 * This is what separates a sweep (one contiguous run of the table's offers) from
 * a batch of unrelated segments: only the sweep may retract a count.
 */
function somethingOfferableBetween(offerable: readonly SeqSpan[], folded: readonly SeqSpan[]): boolean {
  const ordered = [...folded].sort((left, right) => left.start - right.start)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!
    if (offerable.some((span) => span.start > previous.end && span.end < current.start)) return true
  }
  return false
}

/** How many sessions are tracked at once (the engine has no disposal hook on this line). */
const SESSION_LIMIT = 50

/** Sidecar file name inside the DSH home, and how many sessions it keeps. */
const SIDECAR_FILE = 'dsh-acp-age-region-skips.json'
/** The pre-rename name (2026-10-16): read once so the rename cannot zero a day. */
const LEGACY_SIDECAR_FILE = 'dsh-acp-band-skips.json'
const SIDECAR_VERSION = 1
const SIDECAR_SESSIONS = 50

interface SidecarSession {
  skips: number[]
  updatedAt: number
}

interface Sidecar {
  version: number
  sessions: Record<string, SidecarSession>
}

/**
 * Where the sidecar lives: `DSH_HOME` when the launcher set it (it always does
 * in this setup), else `<home>/.dsh` — the same directory the harness keeps its
 * sessions in. `undefined` when neither can be resolved (a stripped environment
 * degrades to in-memory counting).
 */
export function ageRegionSkipsPath(): string | undefined {
  try {
    const env = typeof process === 'undefined' ? undefined : process.env
    const home = env?.DSH_HOME !== undefined && env.DSH_HOME.length > 0
      ? env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    return home.length > 0 ? path.join(home, SIDECAR_FILE) : undefined
  } catch {
    return undefined
  }
}

/** Loaded sidecars, keyed by absolute file path (a test can point DSH_HOME elsewhere). */
const sidecars = new Map<string, Sidecar>()

function sidecarPath(): string | undefined {
  return ageRegionSkipsPath()
}

/** The pre-rename sidecar next to the current one, for the one-way fallback read. */
function legacySidecarPath(): string | undefined {
  const file = sidecarPath()
  return file === undefined ? undefined : path.join(path.dirname(file), LEGACY_SIDECAR_FILE)
}

/** Parse one sidecar file's bytes; anything unreadable or malformed degrades to `undefined`. */
function parseSidecar(raw: string): Sidecar | undefined {
  try {
    const value = JSON.parse(raw) as { version?: unknown; sessions?: unknown }
    if (value.version !== SIDECAR_VERSION || typeof value.sessions !== 'object' || value.sessions === null) return undefined
    const sessions: Record<string, SidecarSession> = {}
    for (const [id, entry] of Object.entries(value.sessions as Record<string, unknown>)) {
      const skips = (entry as { skips?: unknown })?.skips
      if (!Array.isArray(skips)) continue
      const cleaned = skips
        .map((count) => (typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0))
      sessions[id] = { skips: cleaned, updatedAt: Number((entry as { updatedAt?: unknown })?.updatedAt) || 0 }
    }
    return { version: SIDECAR_VERSION, sessions }
  } catch {
    return undefined
  }
}

/** Read (once per path) the sidecar; an unreadable or malformed file degrades to empty. */
function sidecar(): Sidecar | undefined {
  const file = sidecarPath()
  if (file === undefined) return undefined
  const cached = sidecars.get(file)
  if (cached !== undefined) return cached
  let parsed: Sidecar = { version: SIDECAR_VERSION, sessions: {} }
  try {
    const current = parseSidecar(fs.readFileSync(file, 'utf8'))
    if (current !== undefined) parsed = current
  } catch {
    // Missing file, no permission, truncated JSON: count in memory instead.
  }
  // One-way rename migration: only when the CURRENT file carries nothing, read
  // the pre-rename name and write it forward immediately, so the next restart
  // (and every other reader) sees the new file.
  if (Object.keys(parsed.sessions).length === 0) {
    const legacy = legacySidecarPath()
    if (legacy !== undefined) {
      try {
        const inherited = parseSidecar(fs.readFileSync(legacy, 'utf8'))
        if (inherited !== undefined && Object.keys(inherited.sessions).length > 0) {
          parsed = inherited
          sidecars.set(file, parsed)
          persistSidecar()
          return parsed
        }
      } catch {
        // No old file (the normal case after a while): nothing to inherit.
      }
    }
  }
  sidecars.set(file, parsed)
  return parsed
}

/** Write the sidecar back (tmp + rename), pruned to the newest {@link SIDECAR_SESSIONS}. */
function persistSidecar(): void {
  const file = sidecarPath()
  const store = file === undefined ? undefined : sidecars.get(file)
  if (file === undefined || store === undefined) return
  try {
    const entries = Object.entries(store.sessions)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, SIDECAR_SESSIONS)
    store.sessions = Object.fromEntries(entries)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // A sidecar that cannot be written is not worth failing a compress over.
  }
}

/** The persisted counters for one session, or undefined when the sidecar has none. */
function persistedSkips(sessionId: string): number[] | undefined {
  return sidecar()?.sessions[sessionId]?.skips
}

/** The regions the LAST build printed, per session — how a later choice is attributed. */
const regions = new Map<string, readonly SeqSpan[]>()

/**
 * The offerable spans of the LAST build, per session — what "contiguous" is
 * judged against (see {@link somethingOfferableBetween}). Recorded next to the
 * age regions by the same build, so both describe the table the model read.
 */
const offerable = new Map<string, readonly SeqSpan[]>()

/** The counters, per session, aligned with {@link regions} (index 0 = age region 1). */
const skips = new Map<string, number[]>()

/** Insert/refresh one session's entry, evicting the least recently written session. */
function touch<T>(map: Map<string, T>, sessionId: string, value: T): void {
  map.delete(sessionId)
  map.set(sessionId, value)
  while (map.size > SESSION_LIMIT) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
    regions.delete(oldest.value)
    offerable.delete(oldest.value)
    skips.delete(oldest.value)
  }
}

/**
 * Record the regions of the build that is about to be shown to the model. Pure
 * bookkeeping: a build is not a choice, so nothing increments here.
 *
 * @param sessionId - the session the table was built for.
 * @param ageRegions - one span per printed age region, oldest first.
 */
export function noteAgeRegions(sessionId: string, ageRegions: readonly SeqSpan[]): void {
  touch(regions, sessionId, ageRegions.map((ageRegion) => ({ start: ageRegion.start, end: ageRegion.end })))
  // A changed age-region COUNT invalidates the slot identities: "region 3 of 6"
  // and "region 3 of 9" are different slices of the surface, so carrying the
  // counters across would silently re-label old choices. Reset instead — the
  // config change is a deliberate operator action, not drift.
  const current = skips.get(sessionId)
  if (current !== undefined) {
    touch(skips, sessionId, ageRegions.map((_, index) => (current.length === ageRegions.length ? current[index]! : 0)))
    return
  }
  // First sight of this session in this process: seed from the sidecar (a
  // restart must not wipe the day's choices). Same count rule as above: a
  // sidecar written under a different region count starts from zeros.
  const persisted = persistedSkips(sessionId)
  touch(skips, sessionId, ageRegions.map((_, index) => (persisted?.length === ageRegions.length ? persisted[index]! : 0)))
}

/**
 * Record every compressible range the build offered, in table order. Pure
 * bookkeeping, like {@link noteAgeRegions}: it exists only so a later choice can
 * tell a sweep (one contiguous run of offers) from a batch of unrelated
 * segments, without re-deriving the table at compress time.
 *
 * @param sessionId - the session the table was built for.
 * @param spans - every offerable span of that build, oldest first.
 */
export function noteOfferableSpans(sessionId: string, spans: readonly SeqSpan[]): void {
  touch(offerable, sessionId, spans.map((span) => ({ start: span.start, end: span.end })))
}

/**
 * One model CHOICE: every age region whose span does not contain the fold's start
 * is counted as passed over; when the call folded a CONTIGUOUS RUN of more than
 * one span (a sweep), the age regions those other spans reach into get that count
 * taken back.
 *
 * @param sessionId - the session the fold belongs to.
 * @param folded - every seq span this compress call folds, in call order. The
 *   START of the choice is the earliest `start` among them (a sweep is ONE
 *   choice); the rest are what a sweep retracts with.
 */
export function noteAgeRegionChoice(sessionId: string, folded: readonly SeqSpan[]): void {
  const ageRegions = regions.get(sessionId)
  if (ageRegions === undefined || ageRegions.length === 0) return
  if (folded.length === 0) return
  const first = folded.reduce((best, span) => (span.start < best.start ? span : best))
  const chosenSeq = first.start
  // Sweep mode = one contiguous run of offers (owner rule, 2026-10-16): the call
  // committed to a start AND kept folding straight through the table with
  // nothing compressible left unfolded between its spans. A batch of unrelated
  // scattered segments is NOT a sweep — those really did pass the age regions
  // between them over — and a hand-written pair with no table on record cannot be
  // called contiguous, so it does not retract either.
  const spans = offerable.get(sessionId) ?? []
  const sweep = folded.length > 1
    && spans.length > 0
    && !somethingOfferableBetween(spans, folded)
  const swept = sweep ? folded.filter((span) => span !== first) : []
  const counters = skips.get(sessionId) ?? ageRegions.map(() => 0)
  const next = ageRegions.map((ageRegion, index) => {
    const inside = ageRegion.start <= chosenSeq && chosenSeq <= ageRegion.end
    if (inside) return counters[index] ?? 0
    const count = (counters[index] ?? 0) + 1
    return swept.some((span) => reaches(ageRegion, span)) ? Math.max(0, count - 1) : count
  })
  touch(skips, sessionId, next)
  const store = sidecar()
  if (store !== undefined) {
    store.sessions[sessionId] = { skips: next, updatedAt: Date.now() }
    persistSidecar()
  }
}

/** The counters of the last build's age regions, oldest first (empty before any build). */
export function lastAgeRegionSkipsOf(sessionId: string): readonly number[] {
  return skips.get(sessionId) ?? []
}

/** Drop one session's regions, offerable order and counters. */
export function forgetAgeRegionSkips(sessionId: string): void {
  regions.delete(sessionId)
  offerable.delete(sessionId)
  skips.delete(sessionId)
  const store = sidecar()
  if (store !== undefined && store.sessions[sessionId] !== undefined) {
    delete store.sessions[sessionId]
    persistSidecar()
  }
}

/** The remembered age region count for one session (tests and diagnostics). */
export function trackedAgeRegionsOf(sessionId: string): number {
  return regions.get(sessionId)?.length ?? 0
}
