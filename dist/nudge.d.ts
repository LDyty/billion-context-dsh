/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */
import { type CompressionCore, type CompressionState, type ContextBreakdown, type CoreMessage, type NudgeDecision } from 'acp-kernel';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { AcpStateStore } from './state.ts';
import { type KernelRangeView, type MediaPriceOf } from './region.ts';
import { type KernelConfigInput } from './config.ts';
import { type ResolvedPrompts } from './prompts.ts';
export declare function stripNudgeGuidance(text: string): string;
/** Kernel inputs the nudge path shares with the compress tool. */
export interface NudgeEnvironment extends KernelConfigInput {
    readonly kernel: CompressionCore;
    readonly store: AcpStateStore;
    /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
    readonly prompts?: ResolvedPrompts;
}
export interface NudgeOutcome {
    readonly message: UserMessage;
    readonly emergency: boolean;
}
/**
 * Resolve the best available token count for ACP pressure decisions.
 *
 * Priority chain:
 * 1. `sessionProjections.contextPressure.projectedTokens` — matches the UI's
 *    context-occupancy display (includes fixed overhead: system prompt, tool
 *    definitions, AGENTS.md, etc.). Provider-anchored; reacts to compaction.
 * 2. `tokenMeter.measure(session).surfaceTokens` — heuristic surface-only
 *    estimate (pure conversation messages, no fixed overhead). Falls back
 *    when sessionProjections is unavailable or has no provider anchor yet.
 * 3. `defaultCountTokens` character heuristic — last resort for tests and
 *    minimal hosts that lack the token-meter service.
 */
export declare function resolveTokenCount(agent: Agent, coreMessages: CoreMessage[]): number;
/**
 * Whether the kernel's recommendation has a LEGAL target on this surface.
 *
 * A tier-2/3 recommendation targets existing blocks (their checkpoint seqs), so
 * it is always actionable. A plain T1 recommendation needs at least one offered
 * compressible span: with the surface fragmented by injected control rows (or
 * with the remaining spans below the kernel's merge floor) the offer table comes
 * back empty, and then "Context limit reached — compress now" asks for an action
 * with no legal target at all. Live-measured 2026-10-14 (session-a41fb964): 906
 * surface nodes, 241 barrier rows (goal 186 / time-context 20 / team-message 17 /
 * agent-instructions 10), ~2K tokens offerable — every nudge in that window was
 * unactionable, and the model degraded while trying to comply.
 */
export declare function hasActionableTarget(session: import('@deepseek-ai/dsh-session').Session, nudge: NudgeDecision, state: CompressionState): boolean;
/**
 * Lazy per-seq media price. The FIRST lookup triggers one meter measurement, so
 * the range walk only asks about seqs that really carry an attachment — a
 * media-free session never pays for the measurement (issue #117, issue #110).
 * Exported for the context-overflow recovery path, which ranks ranges with the
 * same vocabulary as the nudge table.
 */
export declare function meterMediaPriceResolver(agent: Agent, session: import('@deepseek-ai/dsh-session').Session): MediaPriceOf;
/** Rows the nudge range table prints. */
export declare const RANGE_TABLE_LIMIT = 6;
/**
 * Break-even request count at which a row is flagged as expensive to fold.
 * Above this the one-time prefix rewrite costs more requests than the reclaim
 * pays back quickly, so the model is told rather than left to guess.
 */
export declare const RANGE_TABLE_COST_WARN_BREAK_EVEN = 6;
/** How many older / newer neighbours a normal base row may absorb into its batch. */
export declare const RANGE_TABLE_BATCH_MAX_OLD = 3;
export declare const RANGE_TABLE_BATCH_MAX_NEW = 3;
/**
 * A flagged row's rewrite is fixed by where it starts, so only NEWER neighbours
 * can divide that rewrite over more reclaimed tokens — extending it backwards
 * would deepen the very cost the flag warns about.
 */
export declare const RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE = 6;
/** Only print a batch when it beats its base row's break-even by this fraction. */
export declare const RANGE_TABLE_BATCH_MIN_IMPROVEMENT = 0.25;
/**
 * Pick the rows the nudge range table prints: **one per age band**.
 *
 * Policy (2026-10-16), replacing plain size-first. Size-first had one blind
 * spot: on a big surface the shortlist is filled from whatever region happens to
 * hold the largest spans, so the older scattered content is never offered —
 * measured on the live surface, the oldest band held 26 offerable spans (median
 * 1.3K tokens) and not one of them could ever reach a six-row size-first table.
 *
 * The bands are equal WEIGHT, not equal count: splitting the offerable list into
 * six equal-count groups gives the oldest group three times the spans of the
 * newest (26 vs 7 live) and lets it monopolise rows. Walking the surface in
 * order and closing a band once it holds `total ÷ bands` tokens gives every row
 * the same share of the reclaimable context, so a row IS an age band: row 1 is
 * the oldest sixth of the reclaimable content, row 6 the newest. Each band
 * offers its largest span as the base — the row the model reads — and carries
 * its own sweep (see {@link bestSweepProposal}), which is what makes an old
 * band actionable at all.
 *
 * Rows come back in band order (oldest → newest), which is also surface order,
 * so the table reads as the timeline it is.
 *
 * @param all - every offerable range, in surface position order.
 * @param bands - how many bands to cut (defaults to the row cap).
 * @returns one base range per band, oldest first.
 */
export declare function partitionOfferableIntoBands<T extends {
    start: number;
    end: number;
    tokens: number;
}>(all: readonly T[], bands?: number): T[][];
/**
 * The rows the table prints: **one per age band**, each the LARGEST span of its
 * band (the row the model reads, and the one every neighbour in the sweep is
 * priced against). See {@link partitionOfferableIntoBands} for the geometry.
 *
 * @param all - every offerable range, in any order.
 * @param bands - how many bands to cut (defaults to the row cap).
 * @returns one base range per band, oldest first.
 */
export declare function selectRangeTableRanges<T extends {
    start: number;
    end: number;
    tokens: number;
}>(all: readonly T[], bands?: number): T[];
/**
 * Render the compressible-range table as seq refs for the model.
 *
 * The spans are the kernel's own (`compressibleRanges`, translated to surface
 * seqs) with the host guards applied on top — see buildCompressibleSeqRanges.
 * This function used to self-compute them from the surface as a labeled
 * `UPSTREAM:` workaround for kernel ref-map drift; that drift is fixed upstream
 * (acp-kernel #207) and the workaround is gone (rule 11).
 */
export declare function rangeTable(session: import('@deepseek-ai/dsh-session').Session, kernelView: KernelRangeView, prompts?: ResolvedPrompts, mediaPriceOf?: MediaPriceOf): string;
/**
 * Compute a SURFACE-ONLY context breakdown for display, aligned with
 * `acp_status` (kernel `buildStatusReport`/`renderOverview`).
 *
 * The kernel's own `computeContextBreakdown` (which the nudge text renders)
 * walks the message array it is fed — and `buildNudge` feeds it the FULL log
 * (`allLogMessages`, needed so T2/T3 distillation can anchor every block). So
 * a session with compressed blocks reports HISTORICAL totals there: every
 * original tool/text message already absorbed into a block is counted again,
 * e.g. `85.2K tool` for ~8.5K of live tool context. `acp_status` instead feeds
 * `buildStatusReport` the VISIBLE surface + active-block summaries, so its
 * breakdown reads the true current context. This function reproduces that
 * visible-surface reality for the nudge line so the two tools agree.
 *
 * Classification replicates kernel `computeContextBreakdown` (tool-call/
 * tool-result → tool, `system` role → system, `` code `` fence in text →
 * code, else text) EXCEPT summaries: kernel detects summaries by a
 * `[Compressed conversation section]` text prefix, which never matches a DSH
 * checkpoint node (our summary is the plain summary + `compactCheckpointSource`
 * source marker). We instead count active-block summaries directly from kernel
 * state (same source `buildStatusReport` uses), and the caller must exclude
 * checkpoint summary nodes from `messages` (they are not in any block's
 * `effectiveMessageIds` and would double-count — mirror of `/acp-prune` status's
 * `isCheckpointNode` exclusion).
 */
export declare function computeSurfaceBreakdown(state: CompressionState, messages: readonly CoreMessage[], total: number, growth: number): ContextBreakdown;
/**
 * Max emergency nudge injections within a single user turn. Bounds the
 * positive-feedback loop where an unrelieved ≥emergency-threshold pressure
 * re-injects a durable emergency nudge on every pre-step forever (issue #108).
 * Mirrors billion-context-pi commit 414acd1 (cap emergency nudge injections per
 * user turn). Normal-pressure nudges remain limited to one per turn regardless.
 */
export declare const EMERGENCY_NUDGE_MAX_PER_TURN = 3;
/**
 * Decide and build one nudge message for the agent's next pre-step. Returns
 * null when the kernel recommends no nudge or the per-turn budget is spent:
 * normal-pressure nudges fire at most once per user turn, and emergency nudges
 * are capped at {@link EMERGENCY_NUDGE_MAX_PER_TURN} per user turn so an
 * unrelieved ≥threshold pressure cannot re-inject a durable nudge on every
 * pre-step forever (issue #108). Also advances the in-memory kernel state (ref
 * assignment) so the compress tool can resolve seq → mNNNNN refs.
 *
 * `onEmergencyCapHit` (optional) fires when the kernel still wants an
 * emergency nudge but the per-turn budget is spent — the host uses it to log
 * why the model stops receiving nudges (issue #108 review).
 *
 * `onNothingToCompress` (optional) fires when the kernel wants a nudge but the
 * offered range table is EMPTY (no reclaimable span above the host guards and
 * the kernel's merge floor) — the injection is skipped instead of asking the
 * model for an action with no legal target (2026-10-14 fragmentation case).
 */
export declare function buildNudge(agent: Agent, env: NudgeEnvironment, lastNudgeTurn: Map<string, number>, emergencyNudges: Map<string, {
    turn: number;
    count: number;
}>, onEmergencyCapHit?: () => void, onNothingToCompress?: (kind: 'normal' | 'emergency') => void): NudgeOutcome | null;
/**
 * Render the nudge message text. DEFAULT (no `config.prompts.nudge` override)
 * calls the kernel's own `renderNudgeText` — EFFICIENCY_NOTE/EMERGENCY_HEADER,
 * context breakdown, HOW_TO_COMPRESS_RULES, tier rules, and the batch tip all
 * come from acp-kernel verbatim (the kernel-alignment principle). Only the
 * ref-ID-oriented segments are replaced with our seq-based equivalents,
 * because DSH has no `<acp>` ref tags — see docs/dsh-porting-verification.md:
 * - `rangesStr` (mNNNNN refs) → the surface-seq range table;
 * - the emergency JSON example (startId/endId) → a seq example;
 * - the tier trigger block (block ids bN) → our tier line with surface seqs.
 * When a host overrides any `prompts.nudge` slot, the template path is used so
 * `config.prompts` keeps full control (custom copy wins over kernel defaults).
 */
export declare function buildNudgeText(nudge: NudgeDecision, emergency: boolean, session: import('@deepseek-ai/dsh-session').Session, kernelView: KernelRangeView, prompts?: ResolvedPrompts, mediaPriceOf?: MediaPriceOf): string;
