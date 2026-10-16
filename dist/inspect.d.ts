/**
 * The host half of the ACP inspector panel.
 *
 * The panel (src/client/index.tsx, served by the route registered in
 * src/index.ts) shows the SAME numbers the model was shown: the engine already
 * builds the range table on every pre-step, so this module simply remembers what
 * it built (`rememberRangeTable`, called from `rangeTable`) and hands it back to
 * the browser with the live surface map, the durable block ledger, and the
 * settings the engine actually reads.
 *
 * Why a snapshot instead of a recompute: recomputing the table in the route
 * would mean running the kernel again (mutating the engine's per-session state
 * out of band) and could disagree with the nudge the model saw. Remembering the
 * last build is free, cannot disturb the engine, and is by construction the
 * truth about the last time the model was asked to compress something. The
 * `capturedAt` stamp is the age of that build — a panel that looks stale is
 * genuinely showing the last time anything was offered.
 *
 * @module billion-context-dsh/inspect
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { AcpInspectBlock, AcpInspectRow, AcpInspectSettings, AcpInspectSnapshot, AcpInspectSweep } from './inspect-types.ts';
/** What the engine remembers about its last range-table build for one session. */
export interface AcpInspectCache {
    /** When `rangeTable` last ran for this session. */
    capturedAt: number;
    /** Pressure gauge (the nudge's own number for the same surface). */
    pressure?: number;
    /** The sustainable input budget the engine compresses against. */
    window?: number;
    /** Where `window` came from (see the snapshot's `usage.windowSource`). */
    windowSource?: 'engine' | 'projection' | 'default';
    breakdown?: {
        tool: number;
        text: number;
        code: number;
        summaries: number;
        system: number;
    };
    rows: AcpInspectRow[];
    sweeps: AcpInspectSweep[];
}
/** Remember the rows/sweeps one range-table build produced. */
export declare function rememberRangeTable(sessionId: string, rows: readonly AcpInspectRow[], sweeps: readonly AcpInspectSweep[]): void;
/** Remember the pressure gauge (cheap: every pre-step knows it). */
export declare function rememberPressure(sessionId: string, pressure: number, window: number | undefined, windowSource?: 'engine' | 'projection' | 'default'): void;
/** Remember the surface breakdown (only computed when a nudge actually fires). */
export declare function rememberBreakdown(sessionId: string, breakdown: AcpInspectCache['breakdown']): void;
export declare function inspectCacheOf(sessionId: string): AcpInspectCache | undefined;
/**
 * Mark one session's remembered table as stale.
 *
 * Called when a compression lands (the surface just moved, so EVERY remembered
 * row may name seqs that are gone) and when the session is disposed. The rows
 * are kept — the panel keeps showing the last offer, greyed and marked — but the
 * age is zeroed so the next panel read (or pre-step) rebuilds instead of serving
 * a table whose spans no longer exist.
 */
export declare function invalidateInspectTable(sessionId: string): void;
/** Drop one session's cache (forget on session disposal). */
export declare function forgetInspectCache(sessionId: string): void;
/** The structural slice of the host `sessions` service the route needs. */
export interface InspectSessionsFace {
    get?(sessionId: string): unknown;
}
/** What the route needs from its host: the context, the live settings, the preset name. */
export interface InspectRouteHost {
    readonly ctx: {
        get(name: string): unknown;
    };
    /**
     * Make sure a table snapshot exists for this session (the engine builds one on
     * demand when the remembered one is missing or old). Optional: a host that
     * cannot build one simply serves whatever it remembers.
     */
    readonly ensureFresh?: (sessionId: string, session: Session) => Promise<void>;
    readonly settings: {
        readonly modelContextLimit?: number;
        readonly nudgeMinContextLimitPct?: number;
        readonly nudgeMaxContextLimitPct: number;
        readonly nudgeEmergencyThresholdPct: number;
        readonly cacheMissPriceRatio: number;
    };
    readonly preset?: string;
    /** Kernel fallback for an absent `nudgeMinContextLimitPct` (the floor it reads). */
    readonly kernelNudgeMinContextLimitPct: number;
    /** Fallback denominator when the settings name no explicit limit. */
    readonly defaultContextWindow: number;
}
/**
 * One inspector read: resolve the session, then build the snapshot.
 *
 * Extracted from the engine so the route is testable without binding a whole
 * plugin fiber, and so the engine method stays a two-line delegate. Read-only:
 * nothing here runs the kernel or writes to the session.
 *
 * @param host - context, live settings, preset, and the two fallbacks.
 * @param request - the POST request carrying `{ sessionId }`.
 * @returns the route response (2xx with a snapshot, or a typed failure).
 */
export declare function handleInspectRequest(host: InspectRouteHost, request: Request): Promise<Response>;
/**
 * Build the panel payload: the remembered table, the live surface map, the
 * durable ledger, and the live settings.
 *
 * @param input - session, its cache, the ledger rows, the settings readout.
 * @returns the wire snapshot (never throws for a session-shaped input).
 */
export declare function buildInspectSnapshot(input: {
    sessionId: string;
    session: Session;
    cache: AcpInspectCache | undefined;
    blocks: readonly AcpInspectBlock[];
    settings: AcpInspectSettings;
}): AcpInspectSnapshot;
/**
 * The panel's colour legend, decided exactly like the engine decides folding:
 * a guarded row is `protected`, a foldable-but-injected row is `instruction`
 * (the superseded copies the table may now fold), a checkpoint is
 * `checkpoint`, tool traffic is `tool`, everything else is `text`.
 */
/**
 * The durable block ledger in panel shape, with each block's captured thinking.
 *
 * `reasoningOf` reads the model's own words out of the block's ledger payload
 * (the reasoning blocks of the assistant message that issued the fold); a block
 * folded before that capture existed simply has no `why`.
 *
 * @param session - the session whose ledger to read.
 * @returns one panel block per durable compaction, oldest first.
 */
export declare function inspectBlocksOf(session: Session): AcpInspectBlock[];
