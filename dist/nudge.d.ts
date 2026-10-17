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
import { type RangeTablePrompts, type ResolvedPrompts } from './prompts.ts';
export declare function stripNudgeGuidance(text: string): string;
/** Kernel inputs the nudge path shares with the compress tool. */
export interface NudgeEnvironment extends KernelConfigInput {
    readonly kernel: CompressionCore;
    readonly store: AcpStateStore;
    /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
    readonly prompts?: ResolvedPrompts;
    /** Cache-miss ÷ cache-hit price ratio (see AcpConfig.cacheMissPriceRatio). */
    readonly cacheMissPriceRatio?: number;
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
/** Age regions the offerable list is cut into — the six 年龄区域. */
export declare const RANGE_TABLE_AGE_REGIONS = 6;
/**
 * Rows printed PER age region (owner ruling, 2026-10-16; caliber changed to the
 * billing payback on 2026-10-17): that region's three CHEAPEST-to-fold intervals
 * (lowest billing payback), printed oldest-first. One row per age region gave the
 * model a single choice per age, and the only way to see anything finer was to
 * leave the table; three rows make the table the place the choice is made,
 * without changing what the age regions are or how a fold start is attributed.
 * Ranking by payback rather than size matters: inside one age region a smaller,
 * later-starting interval can re-send far less of the prefix than the largest one.
 */
export declare const RANGE_TABLE_ROWS_PER_AGE_REGION = 3;
/** Rows the nudge range table prints, at most. */
export declare const RANGE_TABLE_LIMIT: number;
/**
 * Billing payback (in requests, see {@link billingPaybackRequests}) at which a
 * row is flagged ⚠. Below this the fold earns its one-time rewrite back quickly;
 * above it the fold only pays off in a session that keeps going that long.
 * 50 requests ≈ a long-but-normal stretch of one working session (the live
 * session ran ~300 requests/day) — a knob, not a law; raise it if folds should
 * be encouraged, lower it to be stricter.
 */
export declare const RANGE_TABLE_COST_WARN_PAYBACK_REQUESTS = 50;
/**
 * The OLD token-caliber threshold (`invalidated ÷ reclaimed`, ≥6 = ⚠). The ⚠ the
 * model sees now uses the billing payback above; this constant survives only
 * because the legacy batch-proposal search and its invariants still take it as
 * their objective (src/region.ts bestBatchProposal, tests/range-*).
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
 * Cut the offerable list into age regions (the rows are picked by
 * {@link rangeTableRowsOfGroups}: up to three per region, largest first).
 *
 * Policy (2026-10-16), replacing plain size-first. Size-first had one blind
 * spot: on a big surface the shortlist is filled from whatever region happens to
 * hold the largest spans, so the older scattered content is never offered —
 * measured on the live surface, the oldest age region held 26 offerable spans (median
 * 1.3K tokens) and not one of them could ever reach a six-row size-first table.
 *
 * The age regions are equal WEIGHT, not equal count: splitting the offerable list into
 * six equal-count groups gives the oldest group three times the spans of the
 * newest (26 vs 7 live) and lets it monopolise rows. Walking the surface in
 * order and closing an age region once it holds `total ÷ age regions` tokens gives every row
 * the same share of the reclaimable context, so a row IS an age region: row 1 is
 * the oldest sixth of the reclaimable content, row 6 the newest. Each age region
 * offers its largest span as the base — the row the model reads — and carries
 * its own sweep (see {@link bestSweepProposal}), which is what makes an old
 * age region actionable at all.
 *
 * Rows come back in age region order (oldest → newest), which is also surface order,
 * so the table reads as the timeline it is.
 *
 * @param all - every offerable range, in surface position order.
 * @param ageRegions - how many age regions to cut (defaults to the six 年龄区域).
 * @returns one group of ranges per age region, oldest first.
 */
export declare function partitionOfferableIntoAgeRegions<T extends {
    start: number;
    end: number;
    tokens: number;
}>(all: readonly T[], ageRegions?: number): T[][];
/**
 * One printed row: the range it offers, the age region it belongs to, and its
 * size rank inside that region.
 */
export interface RangeTableRow<T> {
    readonly range: T;
    /** 1-based age region; every row of one region carries the same number. */
    readonly ageRegion: number;
    /**
     * Why this interval is on the table (owner ruling, 2026-10-17): each age region
     * offers its CHEAPEST fold, its LARGEST interval and its OLDEST one. A single
     * interval can hold several roles at once.
     */
    readonly picks: readonly RangeTablePick[];
}
/** The three roles a printed row can hold inside its age region. */
export type RangeTablePick = 'cheapest' | 'largest' | 'oldest';
/** A row picked by a plain top-N ranking (see {@link rangeTableRowsOfGroups}). */
export interface RangeTableRankedRow<T> {
    readonly range: T;
    readonly ageRegion: number;
    /** 1-based rank inside the age region by the caller's key (1 = best). */
    readonly rank: number;
}
/**
 * The rows the table prints under the three-role rule (owner ruling, 2026-10-17):
 * per age region its cheapest fold (lowest billing payback), its largest interval
 * and its oldest one, deduplicated and printed oldest-first. Fewer than three rows
 * means two roles landed on the same interval — the table says so instead of
 * padding the slot with a worse candidate.
 *
 * @param groups - the age regions, oldest first.
 * @param costOf - billing payback of one interval (lower is cheaper).
 * @returns one row per printed interval, oldest first, each with its roles.
 */
export declare function rangeTablePicksOfGroups<T extends {
    start: number;
    end: number;
    tokens: number;
}>(groups: readonly (readonly T[])[], costOf: (range: T) => number): RangeTableRow<T>[];
/**
 * The pressure pair the range table's context line prints — the same measurement
 * the nudge decision uses (see `rememberPressure` in buildNudge):
 * `tokens` is what the next request carries, `limit` the sustainable input budget
 * it is measured against. Absent in paths that have no window (panel rebuilds and
 * tests): the line is then simply not printed.
 */
export interface RangeTableContext {
    /** Provider-anchored context tokens (system + tools + surface). */
    readonly tokens: number;
    /** Sustainable input budget: window minus the route's output reservation. */
    readonly limit: number;
    /** Cache-miss ÷ cache-hit price ratio, printed as a fact (SETTING_DEFAULTS.cacheMissPriceRatio). */
    readonly missHitRatio: number;
}
/**
 * Above this many complement spans the list stops being a cheap map: one line
 * per age region keeps the first..last span, the count and how many were
 * elided. 120 spans ≈ 400 tokens (three digits tokenise small).
 */
export declare const RANGE_TABLE_OTHERS_CAP = 120;
/**
 * The complement of the printed rows (owner ruling, 2026-10-17): every
 * offerable interval a sweep from the table's OLDEST row would fold but the
 * rows themselves did not print. Seq ranges only — the sweep line already
 * carries the batch totals and composition, and per-span stats would cost more
 * than the list. Printed once per table, grouped by age region.
 */
export declare function renderSweepComplement<T extends {
    start: number;
    end: number;
}>(groups: readonly (readonly T[])[], sweepEntries: readonly T[], recommended: ReadonlySet<T>, prompts?: RangeTablePrompts): string[];
/**
 * Top-N by a caller-supplied key: the generic ranking helper the selection
 * invariants use (production prints three ROLES per region instead — see
 * {@link rangeTablePicksOfGroups}). Within a region the rows are printed in
 * surface order (oldest first), so the table stays the timeline it is.
 *
 * @param groups - the age regions, oldest first (see {@link partitionOfferableIntoAgeRegions}).
 * @param perRegion - rows per age region (defaults to {@link RANGE_TABLE_ROWS_PER_AGE_REGION}).
 * @param rankKey - lower is better; defaults to size (the largest intervals), which
 *   is what the pure-geometry callers and the range-selection invariants pin.
 * @returns one row per printed interval, oldest first.
 */
export declare function rangeTableRowsOfGroups<T extends {
    start: number;
    end: number;
    tokens: number;
}>(groups: readonly (readonly T[])[], perRegion?: number, rankKey?: (range: T) => number): RangeTableRankedRow<T>[];
/**
 * The same rows, straight from the offerable list.
 *
 * @param all - every offerable range, in any order.
 * @param ageRegions - how many age regions to cut (defaults to the six).
 * @param perRegion - rows per age region.
 * @returns one row per printed interval, oldest first.
 */
export declare function selectRangeTableRows<T extends {
    start: number;
    end: number;
    tokens: number;
}>(all: readonly T[], ageRegions?: number, perRegion?: number, rankKey?: (range: T) => number): RangeTableRankedRow<T>[];
/** Just the offered ranges, in the order the table prints them (tests, scratch tools). */
export declare function selectRangeTableRanges<T extends {
    start: number;
    end: number;
    tokens: number;
}>(all: readonly T[], ageRegions?: number, perRegion?: number, rankKey?: (range: T) => number): T[];
/**
 * Render the compressible-range table as seq refs for the model.
 *
 * The spans are the kernel's own (`compressibleRanges`, translated to surface
 * seqs) with the host guards applied on top — see buildCompressibleSeqRanges.
 * This function used to self-compute them from the surface as a labeled
 * `UPSTREAM:` workaround for kernel ref-map drift; that drift is fixed upstream
 * (acp-kernel #207) and the workaround is gone (rule 11).
 */
export declare function rangeTable(session: import('@deepseek-ai/dsh-session').Session, kernelView: KernelRangeView, prompts?: ResolvedPrompts, mediaPriceOf?: MediaPriceOf, context?: RangeTableContext): string;
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
export declare function buildNudgeText(nudge: NudgeDecision, emergency: boolean, session: import('@deepseek-ai/dsh-session').Session, kernelView: KernelRangeView, prompts?: ResolvedPrompts, mediaPriceOf?: MediaPriceOf, context?: RangeTableContext): string;
