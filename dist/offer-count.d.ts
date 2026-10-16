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
/**
 * Record one build's printed rows.
 *
 * @param sessionId - the session the table was built for.
 * @param rows - the rows that were actually printed (the offered shortlist).
 * @returns per printed start, how many builds have covered it, THIS ONE INCLUDED.
 */
export declare function noteOfferedRows(sessionId: string, rows: readonly {
    readonly start: number;
    readonly end: number;
}[]): Map<number, number>;
/**
 * A durable fold landed: forget every remembered offer whose span it replaced.
 *
 * `shadowed` is a contiguous surface slice (the transaction's own `shadowedSeqs`),
 * so an interval test is exact here.
 *
 * @param sessionId - the session the fold belongs to.
 * @param shadowed - the seqs the fold shadowed.
 */
export declare function noteFoldLanded(sessionId: string, shadowed: readonly number[]): void;
/** Drop one session's history (session disposal). */
export declare function forgetOffers(sessionId: string): void;
/** The remembered build count for one session (tests and diagnostics). */
export declare function offeredBuildsOf(sessionId: string): number;
