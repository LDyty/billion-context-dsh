/**
 * How many times each 年龄区域 (age region) has been passed over.
 *
 * The table prints up to six rows — six age regions, oldest first — and this
 * counter answers exactly ONE question about them: when the model chose a fold
 * START, how often did that start fall OUTSIDE this age region?
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
/**
 * One seq span (inclusive), used for the two things that share the shape: the
 * stretch an age region covers on the surface, and one compressible range the
 * model folds.
 */
export interface SeqSpan {
    readonly start: number;
    readonly end: number;
}
/**
 * Where the sidecar lives: `DSH_HOME` when the launcher set it (it always does
 * in this setup), else `<home>/.dsh` — the same directory the harness keeps its
 * sessions in. `undefined` when neither can be resolved (a stripped environment
 * degrades to in-memory counting).
 */
export declare function ageRegionSkipsPath(): string | undefined;
/**
 * Record the regions of the build that is about to be shown to the model. Pure
 * bookkeeping: a build is not a choice, so nothing increments here.
 *
 * @param sessionId - the session the table was built for.
 * @param ageRegions - one span per printed age region, oldest first.
 */
export declare function noteAgeRegions(sessionId: string, ageRegions: readonly SeqSpan[]): void;
/**
 * Record every compressible range the build offered, in table order. Pure
 * bookkeeping, like {@link noteAgeRegions}: it exists only so a later choice can
 * tell a sweep (one contiguous run of offers) from a batch of unrelated
 * segments, without re-deriving the table at compress time.
 *
 * @param sessionId - the session the table was built for.
 * @param spans - every offerable span of that build, oldest first.
 */
export declare function noteOfferableSpans(sessionId: string, spans: readonly SeqSpan[]): void;
/**
 * The offerable spans of the LAST build, in table order (empty before any build).
 *
 * This is the geometry the printed sweep lines and their cost numbers describe:
 * `endSeq: "table-sweep"` expands against THIS list, so the call folds exactly
 * what the table advertised instead of whatever exists at call time.
 */
export declare function offerableSpansOf(sessionId: string): readonly SeqSpan[];
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
export declare function noteAgeRegionChoice(sessionId: string, folded: readonly SeqSpan[]): void;
/** The counters of the last build's age regions, oldest first (empty before any build). */
export declare function lastAgeRegionSkipsOf(sessionId: string): readonly number[];
/** Drop one session's regions, offerable order and counters. */
export declare function forgetAgeRegionSkips(sessionId: string): void;
/** The remembered age region count for one session (tests and diagnostics). */
export declare function trackedAgeRegionsOf(sessionId: string): number;
