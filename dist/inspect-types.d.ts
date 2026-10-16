/**
 * The wire shape the ACP inspector panel reads (`/api/billion-context/inspect`).
 *
 * Types only — the browser half imports this module, the host half fills it, and
 * nothing here may pull in a runtime dependency (the client bundle's purity gate
 * would fail the build).
 *
 * Every number is what the ENGINE already computed and showed: the range rows and
 * their fold costs are the nudge table's own numbers, the sweeps are the proposals
 * it printed, the blocks are the durable ledger, and each block's `why` is the
 * model's own reasoning captured at fold time (src/messages.ts
 * `reasoningForToolCall`). The panel therefore never disagrees with what the model
 * saw, which is the only property that makes it worth looking at.
 */
/** How one surface node reads on the map: what it is and whether it can be folded. */
export type AcpInspectNodeKind = 'tool' | 'text' | 'checkpoint' | 'instruction' | 'protected' | 'metadata';
/** One node of the live surface, in prompt order. */
export interface AcpInspectNode {
    readonly seq: number;
    /** Host-vocabulary price (the same ruler as the ledger and the table). */
    readonly tokens: number;
    readonly kind: AcpInspectNodeKind;
    /** Why this node is a barrier, when it is one (empty for foldable content). */
    readonly barrier?: string;
}
/** One printed range row (one per age band) with its fold cost. */
export interface AcpInspectRow {
    /** 1-based band index; band 1 is the oldest sixth of the reclaimable content. */
    readonly band: number;
    readonly start: number;
    readonly end: number;
    readonly messages: number;
    readonly tokens: number;
    /** Share of the row's CHARACTERS held by tool machinery (results + call arguments). */
    readonly toolPct: number;
    /**
     * Share of the row's CHARACTERS held by assistant reasoning (`thinking`).
     */
    readonly reasoningPct: number;
    /** Share of the row's characters that are neither tool nor reasoning; the three partition 100%. */
    readonly textPct: number;
    /** Tokens the next request re-sends uncached once because of this fold. */
    readonly invalidated: number;
    /** `invalidated ÷ tokens` — requests needed to pay the rewrite back. */
    readonly breakEven: number;
    readonly expensive: boolean;
    /**
     * How many builds have offered a row covering this start, this one included
     * (src/offer-count.ts). The nudge prints it from 3 up; the panel shows it too,
     * because "the model keeps skipping this" is exactly what a human watching the
     * table needs to know.
     */
    readonly offered: number;
}
/** The sweep printed under one row: everything that can ride along in one call. */
export interface AcpInspectSweep {
    /** The start seq of the row this sweep is attached to. */
    readonly rowStart: number;
    readonly entries: number;
    readonly messages: number;
    readonly reclaims: number;
    readonly invalidates: number;
    readonly breakEven: number;
    /** The entries themselves, in surface order — what a copy-paste call needs. */
    readonly spans: readonly {
        readonly start: number;
        readonly end: number;
    }[];
}
/** One durable compressed block. */
export interface AcpInspectBlock {
    readonly id: string;
    /** Short id as the tool result prints it. */
    readonly shortId: string;
    readonly start: number;
    readonly end: number;
    readonly messages: number;
    readonly tokens: number;
    readonly tier: number;
    readonly createdAt: number;
    readonly summary: string;
    /** The model's own thinking while it chose this fold, when it is on record. */
    readonly why?: string;
}
/** The knobs the engine actually reads, so the panel shows live values. */
export interface AcpInspectSettings {
    readonly modelContextLimit: number;
    readonly nudgeMinContextLimitPct: number;
    readonly nudgeMaxContextLimitPct: number;
    readonly nudgeEmergencyThresholdPct: number;
    readonly preset?: string;
}
/** The whole payload one panel read returns. */
export interface AcpInspectSnapshot {
    readonly sessionId: string;
    /** When the engine last built the range table this snapshot describes. */
    readonly capturedAt: number;
    readonly surface: {
        readonly nodes: number;
        readonly firstSeq: number;
        readonly lastSeq: number;
    };
    readonly usage: {
        /** Provider-anchored pressure (the nudge's own gauge). */
        readonly tokens: number;
        readonly window: number;
        /**
         * Where the denominator came from, so the panel can say it out loud:
         * `engine` = the budget the engine compresses against (explicit setting, or
         * the sustainable input budget the last nudge used), `projection` = the raw
         * route capacity the host disclosed, `default` = the built-in fallback (the
         * least trustworthy case — a session the engine has never measured).
         */
        readonly windowSource: 'engine' | 'projection' | 'default';
        readonly pct: number;
        readonly breakdown: {
            readonly tool: number;
            readonly text: number;
            readonly code: number;
            readonly summaries: number;
            readonly system: number;
        };
    };
    readonly map: readonly AcpInspectNode[];
    readonly rows: readonly AcpInspectRow[];
    readonly sweeps: readonly AcpInspectSweep[];
    readonly blocks: readonly AcpInspectBlock[];
    readonly settings: AcpInspectSettings;
}
/** `{ ok: true, value }` / `{ ok: false, error }` — the route envelope. */
export type AcpInspectReply = {
    readonly ok: true;
    readonly value: AcpInspectSnapshot | null;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
};
