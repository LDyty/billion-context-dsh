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
 *
 * PERSISTENCE (sidecar, 2026-10-16): the counters live in
 * `<DSH_HOME>/dsh-acp-band-skips.json` — one small file, not the session log —
 * so a restart no longer wipes a day's worth of choices ("skipped 40×" survives
 * the operator opening and closing dsh all day). Only the per-band counters are
 * stored; the regions are re-recorded by the next build anyway. A missing or
 * unreadable file degrades to zeros, never throws, and the file is pruned to the
 * most recently updated sessions so it cannot grow without bound.
 *
 * @module billion-context-dsh/band-skips
 */
/** One band's region on the surface: its first offerable span's start .. its last span's end. */
export interface BandRegion {
    readonly start: number;
    readonly end: number;
}
/**
 * Where the sidecar lives: `DSH_HOME` when the launcher set it (it always does
 * in this setup), else `<home>/.dsh` — the same directory the harness keeps its
 * sessions in. `undefined` when neither can be resolved (a stripped environment
 * degrades to in-memory counting).
 */
export declare function bandSkipsPath(): string | undefined;
/**
 * Record the regions of the build that is about to be shown to the model. Pure
 * bookkeeping: a build is not a choice, so nothing increments here.
 *
 * @param sessionId - the session the table was built for.
 * @param bands - one region per printed band, oldest first.
 */
export declare function noteBandRegions(sessionId: string, bands: readonly BandRegion[]): void;
/**
 * One model CHOICE: every band whose region does not contain `chosenSeq` is
 * counted as passed over. The band it lands in is left alone.
 *
 * @param sessionId - the session the fold belongs to.
 * @param chosenSeq - the earliest seq this compress call folds (a sweep is one choice).
 */
export declare function noteBandChoice(sessionId: string, chosenSeq: number): void;
/** The counters of the last build's bands, oldest first (empty before any build). */
export declare function lastBandSkipsOf(sessionId: string): readonly number[];
/** Drop one session's regions and counters. */
export declare function forgetBandSkips(sessionId: string): void;
/** The remembered band count for one session (tests and diagnostics). */
export declare function trackedBandsOf(sessionId: string): number;
