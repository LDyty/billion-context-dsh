/**
 * M3 — the four model tools: compress / decompress / search_context /
 * acp_status, registered through `ctx.tools` (defineTool).
 *
 * compress is the heart of ACP: the model writes the summary and the tool
 * lands it as a durable surface replacement (no second LLM summarization
 * call). decompress recovers shadowed content read-only from the log (DSH
 * keeps the originals — V5). search_context scores blocks rebuilt from the
 * log. acp_status reports the block ledger and pressure.
 * @module billion-context-dsh/tools
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type CompressionCore, type SearchDoc } from 'acp-kernel';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AcpStateStore } from './state.ts';
import { type KernelConfigInput } from './config.ts';
import { type AcpWindow } from './window.ts';
import { type ResolvedPrompts } from './prompts.ts';
import type { SettingsCommandSurface } from './settings.ts';
import type { PresetName } from './presets.ts';
export interface ToolEnvironment extends KernelConfigInput {
    readonly kernel: CompressionCore;
    readonly store: AcpStateStore;
    /** Display-only: the named preset that produced the nudge thresholds above, if any (`/acp-prune status` names it). Never read by the kernel path. */
    readonly preset?: PresetName;
    /** Resolve the effective context window for an agent (optional: status falls back to modelContextLimit). */
    readonly windowFor?: (agent: Agent) => Promise<AcpWindow>;
    /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
    readonly prompts?: ResolvedPrompts;
    /**
     * Call ids of compress invocations that created a durable block. The engine
     * listens for the matching `tool/result` and hides the call/result pair from
     * the surface, preventing the compaction summary from sitting between them
     * (strict providers reject that sequence with HTTP 400).
     */
    readonly compressCallIdsToHide?: Set<string>;
    /**
     * How a plain (message-ref) range that crosses a LIVE block's checkpoint
     * carrier is handled. `split` (default) folds the runs around the carrier(s)
     * and reports what stayed visible; `reject` restores the pre-2026-10-13 hard
     * refusal, which handed the call back with the block-id recipe instead.
     * Block-ref boundaries (`bN..bM`) never reach this policy — distilling is
     * what they are for.
     */
    readonly carrierSpans?: 'split' | 'reject';
    /**
     * Read/write access to the runtime settings layer for `/acp-prune config`.
     * Absent surfaces (never expected — the engine always builds one) would
     * degrade the command to advice text.
     */
    readonly settingsCommand?: SettingsCommandSurface;
    /** Cache-miss ÷ cache-hit price ratio (AcpConfig.cacheMissPriceRatio): a billing fact the panel shows. */
    readonly cacheMissPriceRatio?: number;
}
/**
 * Resolve the effective context window for a tool or command run: probe the
 * agent's real window via `windowFor` when provided, otherwise fall back to
 * the environment's `modelContextLimit`. Shared by the compress and
 * acp_status tool handlers and the `/acp-prune` command so the resolution logic
 * lives in exactly one place (issue #63 — the tools used the 128K fallback
 * for pressure decisions even when auto-detection had found a larger window).
 */
export declare function resolveEffectiveWindow(env: ToolEnvironment, agent: Agent): Promise<AcpWindow>;
export declare const compressParameters: {
    readonly arguments: {
        readonly type: 'json';
        readonly description: 'Tolerated wrapped-arguments form (model-generated); unwrapped in handleCompress. Prefer passing content directly.';
    };
    readonly topic: {
        readonly type: 'string';
        readonly description: 'Fallback topic for entries without their own.';
    };
    readonly content: {
        readonly oneOf: readonly [{
            readonly type: 'array';
            readonly description: 'One or more ranges to compress, each with startSeq/endSeq boundaries (surface seqs) and a dense summary. Required — pass it directly, not wrapped in an arguments key.';
            readonly items: {
                readonly type: 'object';
                readonly properties: {
                    readonly startSeq: {
                        readonly oneOf: readonly [{
                            readonly type: 'integer';
                            readonly description: 'First surface seq of the range.';
                        }, {
                            readonly type: 'string';
                            readonly description: 'Seq as text; a trailing #callId fragment is ignored. A drilldown mN ref ("m00306") or a kernel block id ("b1", as acp_status lists) is also accepted — a block id resolves to that block\'s checkpoint seq, which makes the fold a tier 2/3 distillation.';
                        }];
                    };
                    readonly endSeq: {
                        readonly oneOf: readonly [{
                            readonly type: 'integer';
                            readonly description: 'Inclusive last surface seq of the range.';
                        }, {
                            readonly type: 'string';
                            readonly description: 'Seq as text; a trailing #callId fragment is ignored. Also accepts a drilldown mN ref or a kernel block id ("b3") — for a multi-block condense name the LAST block id (tier 3). Or the literal "sweep": fold the whole forward sweep that starts at startSeq in ONE call, every span sharing your summary (see the table\'s sweep lines).';
                        }];
                    };
                    readonly summary: {
                        readonly type: 'string';
                        readonly description: 'Complete technical summary replacing the range; keep paths, decisions, values verbatim. How short it may be is judged PER ENTRY by the SIZE of the span you are folding: a span over ~500 tokens owes at least 50 characters, and so does any block-ref distillation whatever its size, while a span under ~500 tokens may be a single honest sentence. A span with NO durable value (pure noise, duplicated tool output, retries, output already superseded by a later result) gets exactly that short honest summary — say what it was and that nothing was kept (e.g. "retry logs — nothing kept; decompress for the raw output") — rather than an invented one. Never pad a junk span into a fake summary, and never leave the entry out: the entry is what frees the tokens.';
                    };
                    readonly topic: {
                        readonly type: 'string';
                        readonly description: 'Short label (3-5 words) for this range.';
                    };
                    readonly verifiedReadings: {
                        readonly type: 'array';
                        readonly items: {
                            readonly type: 'string';
                        };
                        readonly description: 'Optional: acceptance readings that are already green before this compression (e.g. "t0-fastpath 8/8", "closedloop 414/414"). Stored structurally on the compaction/summary event and recovered by verifiedReadingsOf, so later steps need not re-run the checks.';
                    };
                };
                readonly additionalProperties: false;
            };
        }, {
            readonly type: 'string';
            readonly description: 'Tolerated wrapped form: the SAME content array serialized as JSON text (what a model channel sometimes emits). It is parsed back before validation — prefer passing the array directly.';
        }];
    };
};
/**
 * How small a folded span has to be before its summary may go UNDER the kernel
 * floor (owner rule, 2026-10-16). A few hundred tokens of junk have nothing to
 * be substantive about, and padding them into 50+ characters is filler the
 * model then has to read back.
 */
export declare const SHORT_SPAN_SUMMARY_TOKENS = 500;
/**
 * The summary floor is the HOST's rule, and it is per ENTRY — not per call and
 * not per marker (the 2026-10-16 owner ruling replaced the `(discarded)` /
 * whole-call-waiver shape):
 *
 *  - a fold of a small span may carry a genuinely short summary;
 *  - a fold of a large span still owes a real one, whatever else the call folds
 *    (mixing junk with real content must not force filler on the junk, and must
 *    not let the real content off either);
 *  - a block-ref fold (tier 2/3 distillation) ALWAYS owes the floor: its input
 *    is already a summary, so it is the one place where a stub would break the
 *    tier chain that carries information upward.
 *
 * The kernel reads `minSummaryLength` per call, so `handleCompress` hands it 0
 * and applies this policy itself, refusing an entry with the kernel's own
 * message shape when it is too short.
 *
 * @param session - the session being folded.
 * @param range - the accepted range, with its surface edges and refs.
 * @param floor - the configured floor (`config.compress.minSummaryLength`).
 * @returns `undefined` when the entry may fold, otherwise the refusal note.
 */
export declare function summaryFloorRefusal(session: Session, range: {
    start: number;
    end: number;
    startSeq: number;
    endSeq: number;
    summary: string;
}, floor: number): string | undefined;
/** Exported so the ref-width contract test can pin it without a 100K-message fixture. */
export declare function mnRefIndex(value: string): number | null;
/**
 * Pure gate helpers for the compress tool's CURRENT-instruction-row rejection.
 *
 * Decision history (issue #71 review): the first draft only WARNED when a
 * manual compress range swallowed a current injected row (F7), because the
 * compression is safe and self-healing. The owner reversed that during PR1
 * review: compressing a CURRENT row has NO legitimate outcome — the host
 * re-injects the newest AGENTS.md copy unconditionally the moment it leaves
 * the surface (presence gate, deepseek-harness
 * packages/context/agent-instructions/src/index.ts:137/:163), so the tokens
 * come straight back and the call is pure waste — and a hard reject keeps the
 * manual path consistent with the system-side GC's iron rule (PR2: never
 * clear a group's newest row). STALE copies stay compressible: removing them
 * while the newest stays visible is the actual cleanup and triggers no
 * re-injection. Skill-catalog rows joined the guard set for a DIFFERENT
 * reason (issue #185): they are not self-healing at all — the host resends
 * the catalog only when its digest changes, so a folded catalog stays gone
 * until the catalog actually changes. The range table
 * (buildCompressibleSeqRanges) never offers these rows, so the gate only fires
 * on hand-built ranges.
 *
 * `guardedRowsInSpan` is the overlap probe. It takes the POSITIONAL span the
 * transaction will actually shadow (`shadowedSeqsOf`), never a numeric
 * `start <= seq <= end` interval: the surface is locally non-monotonic after
 * earlier replacements (a checkpoint seq spliced ahead of older residual
 * nodes), so a tier-2 distill of two checkpoints can carry a CURRENT
 * instruction row numerically inside its edges while the sliced span excludes
 * it — the interval probe rejected exactly the call the nudge hands the model
 * (issue #71 review B1). Probing the slice also keeps guard and effect in
 * agreement: `shadowedSeqsOf` is what the transaction prices and
 * `assertProvenance` verifies.
 * `protectedRowRejectionNote` renders the rejection the model sees: it names
 * the offending seqs AND the compressible slices left in the span, so the model
 * can re-cut (or split into two calls) instead of retrying the same call.
 * `guardedSurfaceSeqsOf` supplies the protected set.
 */
export declare function guardedRowsInSpan(guarded: ReadonlySet<number>, shadowed: readonly number[]): number[];
/**
 * Advisory note for a plain range that would fold a LIVE block's checkpoint
 * carrier (see `liveCheckpointCarriersInSpan`). Names the block ids the model
 * can use instead — a block-ref boundary is the call that legitimately folds
 * carriers (tier 2/3 distillation).
 */
export declare function liveCarrierRejectionNote(start: number, end: number, carriers: readonly {
    seq: number;
    kernelBlockId: string;
}[]): string;
export declare function protectedRowRejectionNote(start: number, end: number, hits: readonly number[], shadowed: readonly number[], session?: Session): string;
/**
 * Kernel ref for one RESOLVED range edge's surface node (issue #155).
 * Resolved edges are tool-pairing-balanced and anchorable, but NO LONGER
 * guaranteed to carry a bare-`${seq}` ref: a multi-tool-call assistant
 * projects to `${seq}#${callId}` sub-ids, and an empty tool result projects
 * to nothing. Three tiers, in order:
 *
 *  1. the bare-seq id (user turns, single-call assistants, text-bearing results);
 *  2. the node's sub-ids in projection (= content) order — FIRST for a start
 *     edge (the kernel must consume the whole node from its first sub-message),
 *     LAST for an end edge (unreachable in practice: a node with open calls
 *     makes every cut after it unbalanced, so it can never be a resolved end
 *     edge);
 *  3. the nearest message-bearing LIVE node between this edge and the opposite
 *     edge (inclusive), walked along the SURFACE — never raw-id space, where
 *     shadowed nodes keep their refs and would anchor onto already-compressed
 *     messages. Walking inward only also guarantees the returned ref names a
 *     message the transaction actually shadows; a span whose interior carries
 *     no message at all (two adjacent empty results) yields undefined and the
 *     caller raises the existing "no assigned ref" error.
 */
export declare function edgeRefForSeq(session: Session, byRaw: Readonly<Record<string, string>>, seq: number, role: 'start' | 'end', oppositeSeq: number): string | undefined;
/**
 * Build the unified SearchDoc[] from the log: one block doc per ledger entry
 * (ref = compactionId, so `decompress({ blockId })` closes the loop) plus one
 * message doc per shadowed ORIGINAL (expanded through distilled parents; each
 * seq is claimed by the earliest/innermost block that covered it, mirroring
 * pi's owner map — decompress on that block recovers the original).
 * Cached per log snapshot (see searchDocsCache). Exported for the issue #133
 * regression tests (not part of the public API — index.ts re-exports only).
 */
export declare function buildSearchDocs(session: Session): SearchDoc[];
/** Build the four ACP model tools bound to one engine. */
export declare function makeTools(env: ToolEnvironment): ToolDefinition[];
