/**
 * M5 — durable region transaction and the log-rebuilt block ledger.
 *
 * Modeled on `dsh-compaction-basic/src/region.ts` (which is package-internal
 * and not exported by the seam): validate the surface range and tool-call/result
 * pairing, take the durable `compaction/start` lock, record `compaction/summary`
 * as the shadow price, land the `user/message` surface replacement carrying the
 * summary under `compactCheckpointSource`, and release the lock with
 * `compaction/end`. The original events stay in the append-only log, so
 * decompress/search/status can rebuild everything from the log.
 * @module billion-context-dsh/region
 */
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session';
import { CompactionId } from '@deepseek-ai/dsh-compaction';
import { type ContentBlock } from '@deepseek-ai/dsh-llm';
import { type AcpBlockLedgerPayload } from './block-ledger.ts';
/** One durable ACP block as rebuilt from the session log. */
export interface AcpBlockLedgerEntry {
    /** The compaction transaction id (stable block identity). */
    readonly blockId: string;
    readonly summary: string;
    /** The block's short label (kernel `CompressionBlock.topic`), when the compress request carried one. */
    readonly topic?: string;
    readonly shadowedSeqs: readonly number[];
    readonly shadowedTokenCount: number;
    readonly start: number;
    readonly end: number;
    /** Compression tier: 1 (message range), 2 (distills tier-1 blocks), 3 (distills tier-2 blocks). Legacy blocks default to 1. */
    readonly tier: 1 | 2 | 3;
    /** Compaction ids of the blocks this block distilled (parents). Empty for tier-1 blocks. */
    readonly parentBlockIds: readonly string[];
    /** The acp-kernel block id (`bN`) created for this transaction — absent for legacy blocks (synthesised by order). */
    readonly kernelBlockId?: string;
    /** The surface seq of this block's checkpoint summary node (derived from the log; null when the node is gone). */
    readonly summarySeq?: number;
    /** The kernel block's raw direct/effective message ids at creation (recorded since the tier feature; absent for legacy). */
    readonly directMessageIds?: readonly string[];
    readonly effectiveMessageIds?: readonly string[];
    /** B3: acceptance readings that were already green before compression (absent when the compress call carried none). */
    readonly verifiedReadings?: readonly string[];
    /** The thinking that produced this fold (absent when the call's assistant message carried none). */
    readonly reasoning?: string;
    /** Unix epoch ms of the compaction/summary event. */
    readonly createdAt: number;
}
/** The open turn number, or null when the log ends between turns. */
export declare function findOpenTurn(events: readonly SessionEvent[]): number | null;
/**
 * Reject a second concurrent compaction for the same session.
 *
 * Compaction is synchronous and a session is single-writer, so a
 * `compaction/start` with NO matching `compaction/end` in the durable log can
 * only be a stale leftover from a prior run that died mid-write (a hard kill,
 * not a caught throw — every caught throw is paired with a compensating
 * `compaction/end` in runCompactionTransaction). Such a leftover must NOT
 * permanently block every later compress call: this treats it as stale,
 * surfaces it once, and lets a new compaction proceed. The old "already
 * active" throw only fired when a genuine concurrent compaction existed,
 * which the synchronous single-writer premise makes impossible.
 */
export declare function assertNoActiveCompaction(events: readonly SessionEvent[]): void;
/**
 * A requested range whose EVERY live message was already shadowed by one or
 * more blocks. The compress tool catches this and reports the range as already
 * compressed (with the covering block ids) instead of folding block summary
 * nodes as plain messages or erroring out. Distillation stays an explicit act:
 * target a LIVE checkpoint seq directly to distill (tier 2/3).
 */
export declare class AlreadyCompressedRangeError extends Error {
    readonly start: number;
    readonly end: number;
    readonly coveringBlockIds: readonly string[];
    constructor(start: number, end: number, coveringBlockIds: readonly string[]);
}
export interface ResolvedSurfaceRange {
    readonly start: number;
    readonly end: number;
    /**
     * True when the requested edges were not on the current surface and were
     * remapped to the still-live content of the requested span (an earlier
     * compression shadowed them). Callers surface this so the model sees what
     * was actually compressed instead of silently shadowing a different span.
     */
    readonly recovered?: boolean;
}
/**
 * Validate one inclusive surface span and adjust its edges to a
 * tool-pairing-balanced range whose boundaries anchor (bare-`${seq}` ref,
 * multi-call sub-id, or empty-result fallback — see anchorsRangeEdge,
 * issue #155). Reversed ranges throw. An edge that sits inside a
 * tool-call/result pair is first nudged inward to the nearest clean cut; if
 * that collapses the range (e.g. the model asked for a SINGLE tool result,
 * which can never be balanced alone), the range EXPANDS outward to the
 * enclosing clean pair instead — a lone tool message is almost always a
 * "consumed output" the model genuinely wants to compress. The returned range
 * is what a caller should actually shadow.
 *
 * Missing edges are NOT an immediate error: the seqs were probably shadowed by
 * an earlier compression (stale nudge table / old compress result). The span
 * is rebuilt from its still-live remainder via recoverStaleRange — a fully
 * shadowed span throws AlreadyCompressedRangeError, a genuinely unknown edge
 * throws the not-in-surface guidance error. The returned range is what a
 * caller should actually shadow.
 */
export declare function resolveSurfaceRange(session: Session, start: number, end: number): ResolvedSurfaceRange;
/** The surface seqs shadowed by the inclusive positional span. */
export declare function shadowedSeqsOf(session: Session, start: number, end: number): number[];
/**
 * True iff `declared` equals the CURRENT surface slice between `start` and
 * `end` positionally — both edges on the surface, in order, element-wise equal.
 * This mirrors exactly the invariant the released readers enforce at load time
 * on every `compaction/summary` / `compaction/prune` event (`shadowedSeqs` must
 * name an exact current surface span); writing an event that violates it makes
 * the whole session log unloadable forever (issue #201). Unlike
 * {@link shadowedSeqsOf} (which silently degrades for read-only probes), this
 * is the strict gate for WRITES.
 */
export declare function isExactSurfaceSpan(session: Session, start: number, end: number, declared: readonly number[]): boolean;
export interface CompactionTransactionInput {
    readonly start: number;
    readonly end: number;
    readonly shadowedSeqs: readonly number[];
    readonly summary: ContentBlock[];
    readonly shadowedTokenCount: number;
    readonly provider: string;
    readonly model: string;
    /** Short block label (kernel `CompressionBlock.topic`) — persisted so a restarted engine rehydrates it. */
    readonly topic?: string;
    /** Compression tier of this block (default 1). */
    readonly tier?: 1 | 2 | 3;
    /** The acp-kernel block id (`bN`) created by the kernel for this transaction. */
    readonly kernelBlockId?: string;
    /** Compaction ids of the blocks distilled into this one. */
    readonly parentBlockIds?: readonly string[];
    /** The kernel block's direct/effective message ids (raw CoreMessage ids) — recorded for faithful rehydration. */
    readonly directMessageIds?: readonly string[];
    readonly effectiveMessageIds?: readonly string[];
    /** B3：压缩前已绿的验收读数（结构化，压缩后仍可读）。 */
    readonly verifiedReadings?: readonly string[];
    /**
     * 模型挑这一段时的真实思考（那条 assistant/message 的 reasoning 块，由
     * `reasoningForToolCall` 抽取）——随块落盘，事后可查。
     */
    readonly reasoning?: string;
}
type CompactionSummaryData = SessionEventMap['compaction/summary'];
/**
 * Read a `compaction/summary` event's data. The six ACP tier/lineage fields are
 * no longer top-level members (issue #141): post-fix writers carry them in the
 * admitted optional `rawOutput` member (decode via {@link decodeAcpBlockLedger}),
 * while logs written by pre-fix engines still carry them as top-level members —
 * so the returned type also intersects with {@link AcpBlockLedgerPayload}, letting
 * readers fall back to the legacy shape. Never `any`.
 */
export declare function readCompactionSummary(event: SessionEvent): CompactionSummaryData & AcpBlockLedgerPayload;
/**
 * B3: read the structured verified readings a compress call recorded for this
 * block (acceptance checks that were already green before the range was
 * shadowed — e.g. "t0-fastpath 8/8"). Post-fix writers carry them inside the
 * admitted `rawOutput` member (AcpBlockLedgerPayload); legacy writers put them
 * top-level. Absent in either shape → empty array; never throws.
 */
export declare function verifiedReadingsOf(event: SessionEvent): string[];
/**
 * 这个块落地时，模型挑选它的那条 assistant/message 里的真实思考
 * （reasoning 块，压缩时由 {@link reasoningForToolCall} 抽取并随块落盘）。
 * 读不出来时返回 undefined——老块本来就是没有这一项，永远不会抛错。
 */
export declare function reasoningOf(event: SessionEvent): string | undefined;
/**
 * B1：给摘要块数组的第一个文本块加标源前缀（幂等——已带前缀不重复加）。
 * 只动文本块，工具/图片块原样保留。
 */
export declare function prefixSummaryBlocks(blocks: readonly ContentBlock[]): ContentBlock[];
/**
 * Checkpoint source for the durable summary node, normalized for V4 writers.
 *
 * The copy of @deepseek-ai/dsh-compaction this engine resolves to may predate
 * the host persisting the session: the plugin's peer range floors at the
 * 0.1.5 line, whose compactCheckpointSource() still emits the retired V3
 * wrapper shape { kind: 'plugin', plugin: 'compact' }. A DSH ≥0.1.7 v4
 * persistence writer rejects that shape in producer-kind admission ("format
 * v4 message requires a producer-owned source kind") and the WHOLE write batch
 * wedges in memory — every later event piles behind the poison row until
 * restart (issue #181; #165 fixed our own writers but not this host-supplied
 * one). Normalize exactly that legacy shape when the session is persisted at
 * format v4 — header.version decides which writer encodes the row, not which
 * package resolved — and pass everything else through verbatim: older hosts
 * still speak the wrapper, and newer dsh-compaction copies already emit the
 * producer kind.
 *
 * Removal gate: delete once the peer floor moves past the last
 * wrapper-emitting dsh-compaction line (or upstream retires the shape there).
 *
 * Reachability is line-dependent, and so is its coverage: each dsh-compaction
 * line derives its `CompactionCheckpointSource` type from its OWN marker
 * constant, so the wrapper variant is present in the 0.1.5-line types (whose
 * `compactCheckpointSource()` really does emit it) and absent from the 0.2.0-line
 * ones (marker `{ kind: 'compact-checkpoint' }`). On the 0.2.0 baseline the
 * rewrite below is therefore unreachable — and untypeable if written as a plain
 * `source.kind === 'plugin'` comparison (TS2367 against a literal kind) — which is
 * why the two identifying fields are read through a structural view and the
 * normalized object is rebuilt from the fields both lines share.
 */
export declare function checkpointSourceFor(session: Pick<Session, 'header'>, compactionId: CompactionId): Readonly<{
    kind: 'compact-checkpoint';
    compactionId: CompactionId;
    sourceCommandId?: import("@deepseek-ai/dsh-commands").CommandId | undefined;
}>;
/**
 * Run one durable compression transaction. Throws on invalid state; on success
 * the four events are in the log and the surface has one summary node.
 */
export declare function runCompactionTransaction(session: Session, input: CompactionTransactionInput): {
    compactionId: string;
    seqs: number[];
};
/** Rebuild the block ledger from the durable log (no kernel state needed). */
export declare function rebuildBlockLedger(events: readonly SessionEvent[]): AcpBlockLedgerEntry[];
/** One self-computed compressible span of the current surface. */
export interface SeqCompressibleRange {
    readonly start: number;
    readonly end: number;
    readonly count: number;
    readonly tokens: number;
    /**
     * Share of the span's CHARACTERS held by tool machinery (tool-result content
     * plus tool-call arguments), 0-100. Character-based since 2026-10-16 so the
     * three composition shares partition exactly 100% — the kernel-parity
     * ROW-count `toolPct` it replaced could not be read together with a
     * character-based reasoning share.
     */
    readonly toolPct: number;
    /**
     * Share of the span's CHARACTERS held by assistant reasoning
     * (`{type:'reasoning', text}` in the log, `{type:'thinking', thinking}` on the
     * wire), 0-100. Live audit of the long-running daily session: assistant rows
     * held 61.6% of the visible characters, of which reasoning was 61.3% (37.8% of
     * the whole surface) and the visible PROSE only 3.1%; over the whole session
     * reasoning was 65.1% of all assistant content against 4.4% prose. Reasoning
     * is the densest reclaimable mass in a reasoning-model session, and because a
     * fold's invalidation cost depends only on where the span STARTS (never on
     * what it holds), a reasoning-dense span pays back far faster than a tool span
     * beginning at the same place. Reported, never instructed: no copy tells the
     * model to prefer it.
     */
    readonly reasoningPct: number;
    /** Share of the span's characters that are neither tool machinery nor reasoning (user turns, prose, injected rows), 0-100. Derived so `toolPct + reasoningPct + textPct === 100`. */
    readonly textPct: number;
    /**
     * Share of the span's MESSAGES that are tool messages (tool-call or
     * tool-result), 0-100 — the kernel's own `toolPct` caliber, kept BESIDE the
     * character partition instead of replacing it: the two answer different
     * questions ("what kind of rows are these" vs "where is the mass"), and the
     * count figure is printed with the message count for exactly that reason.
     */
    readonly toolRowPct: number;
    /**
     * The row-count caliber as a MIX: `3 tool · 2 assistant · 1 user` (empty
     * classes omitted; `other` covers injected rows and checkpoints). Printed
     * right after the message count — the one place a per-row figure belongs.
     */
    readonly rowMix: string;
    /** Image blocks reachable inside the span (directly or through a tool result). */
    readonly images: number;
    /** File blocks reachable inside the span. */
    readonly files: number;
}
/**
 * Per-seq provider-anchored price for non-text blocks (see `mediaPriceViaMeter`
 * in host-tokens.ts). A callback, not a map, so a media-free session never pays
 * for a meter measurement: the range walk only asks about seqs it already knows
 * carry an image/file block.
 */
export type MediaPriceOf = (seq: number) => number;
/** Whether a surface message event is a tool message (tool-call or tool-result) — kernel `isToolMessage` parity. */
/** Whether one surface event counts as tool traffic (the table's `[tool X%]`). */
export declare function isToolEvent(event: SessionEvent): boolean;
/**
 * Durable model-free prune: append `compaction/prune` as the shadow price,
 * then replace the given surface seqs with a user message. dsh-session 0.1.5+
 * allows only user/message (and system/message) replacements to cite source
 * events — assistant/message FORBIDS `sourceEventSeqs` because it embeds its
 * own provider stream — so there is no invisible replacement node anymore:
 * every hidden span becomes a user message. Callers with meaningful text pass
 * it (compress call/result hiding keeps the tool outcome visible to the
 * model); callers without get the fixed prune note. The originals remain in
 * the append-only log. Exported for the issue #201 regression tests — not part
 * of the public API (index.ts re-exports only).
 */
export declare const PRUNE_NOTE = "(removed by context management)";
export declare function hideSurfaceSeqs(session: Session, seqs: readonly number[], text?: string, priceEvent?: (event: SessionEvent) => number): void;
/**
 * Hide one successful `compress` tool's call/result pair after its tool/result
 * has been logged. The durable compaction summary is inserted BEFORE the
 * current tool result (the compress tool runs mid-turn), so leaving the pair on
 * the surface would produce `assistant(tool_calls) → user(summary) →
 * tool(result)` — rejected by strict providers. Replacing both nodes with a
 * plain user message (the result text) removes the pair from the derived
 * surface without touching the compaction block.
 */
export declare function hideCompressToolPair(session: Session, callId: string, resultSeq?: number): boolean;
/**
 * Surface-level orphan cleanup: hide tool/result nodes with no matching call,
 * assistant tool-call nodes whose calls all lack results, and "broken pairs"
 * whose result is NOT adjacent to the call node on the surface (a
 * non-tool/result node — typically the compaction summary a buggy older
 * version inserted between a compress call and its result — sits between
 * them). A single orphan result corrupts the whole tool-pairing balance cache
 * (every range resolve throws), orphan calls fragment large ranges into tiny
 * uncompressed fragments, and a broken pair cannot serialize for strict
 * providers — the mechanisms behind issue #18's "only ~28 tokens visible".
 * Uses the same durable prune protocol as `hideSurfaceSeqs`, so the removed
 * nodes stay recoverable from the append-only log.
 */
export declare function stripOrphanedSurfaceToolMessages(session: Session, inFlightCallIds?: ReadonlySet<string>): number;
/**
 * All tool-call ids currently visible on the surface with no matching
 * tool/result yet — the in-flight calls of the current step. Sibling tools
 * called in the same assistant message as `compress` are in-flight too, so
 * `handleCompress` must protect the whole set (not just its own call id) or
 * the sibling call would be pruned as an orphan and its result would land
 * orphaned (HTTP 400 until the next cleanup).
 */
export declare function openToolCallIds(session: Session): Set<string>;
/**
 * Schedule `hideCompressToolPair` on the microtask queue. `session.append`
 * is NOT reentrant: running it synchronously inside a `session/event`
 * listener (while the outer append is still publishing) throws "session
 * append cannot reenter while another append is being published" on live,
 * store-attached sessions, and the dispatcher silently swallows the error —
 * so a synchronous hide is a silent no-op in production. A microtask drains
 * after the current append fully publishes and before the agent loop resumes,
 * so the pair is hidden before the next request is built.
 */
export declare function deferCompressPairHide(session: Session, callId: string, resultSeq: number, onError?: (error: unknown) => void): void;
/**
 * Newest AGENTS.md instruction row per scope (source file). The host
 * re-injects a file's instructions when its CURRENT copy is absent from the
 * surface (deepseek-harness packages/context/agent-instructions presence
 * gate, index.ts:137/:163 — presence+identity, not payload diff), so
 * compressing the newest row of a scope makes that file come straight back,
 * while compressing a STALE copy of the same file is silent. Live-audited
 * shape (session-f25e4fad): EVERY injection row — baseline and worktree —
 * carries `source.changes[].scope` = `"<dir>\u0000<file>"` (root
 * `.\u0000AGENTS.md`, worktree `worktrees/<name>\u0000AGENTS.md`), which is
 * stable across config tweaks unlike `baselineIdentity`. Tail-scan the log,
 * group by scope, keep the last seq of each group. O(events), mirrors
 * indexWatermarkOf. Rows without `changes[]` (legacy shapes) are SKIPPED
 * entirely: identity is what the host's presence gate needs in order to
 * re-inject a file, so a scope-less row can never come back and must not be
 * guarded (the earlier shape gave each its own group, which made every legacy
 * row a permanent hard-reject — issue #71 review S3).
 */
export declare function newestInstructionSeqsOf(session: Session): Set<number>;
/**
 * Newest skill-catalog row (issue #185). ONE group: every catalog row is the
 * full current list, so each new one supersedes all earlier ones (unlike
 * agent-instructions, which group per file scope). The guard matters because
 * the host does NOT re-inject a folded catalog — dsh-tool-skill's resend gate
 * is the catalog DIGEST, and shadowing the visible row changes nothing about
 * it, so the model loses skill discovery until the catalog actually changes.
 * Tail-scan the log like newestInstructionSeqsOf; null when the session never
 * carried a catalog.
 */
export declare function newestSkillCatalogSeqOf(session: Session): number | null;
/**
 * Surface seqs NO caller may compress: the CURRENT (newest) injected
 * agent-instructions row of every scope (restricted to rows still visible on
 * the surface — one definition of "current" — `newestInstructionSeqsOf`) PLUS
 * the newest visible REAL user turn (`isRealUserTurn` reverse scan over
 * `session.surface.nodes`, issue #196): a wide or miscalculated model span
 * must never shadow the active question, while OLDER user turns stay
 * compressible once superseded by a newer one. `buildCompressibleSeqRanges`
 * never OFFERS them, and both compress entry points (`handleCompress` in
 * src/tools.ts, `/acp-prune compress` in src/commands.ts) probe the RESOLVED
 * span against this set and HARD-REJECT a covering range before the kernel
 * applies it, so nothing durable lands and no phantom block can exist. This
 * supersedes the earlier F7 draft (warn only): folding a current copy reclaims
 * nothing — the host re-injects it — and folding the active user turn loses the
 * conversation intent, so neither has a legitimate outcome to warn about.
 * Deliberately NARROW (issue #71 review F4): for instruction rows, only CURRENT
 * ones — the audited loop driver; for skill catalogs (issue #185) it is the ONE
 * visible copy, because unlike AGENTS.md the host does NOT re-send a folded
 * catalog (resend is keyed on the digest, which a fold cannot change), so
 * folding it loses skill discovery until the catalog actually changes.
 * Engine-authored metadata rows (nudge echo, compress-pair stub) stay foldable
 * like main, and STALE copies (older AGENTS.md scopes, superseded catalog rows)
 * stay compressible — removing them while the newest copy stays visible is the
 * real cleanup.
 */
/** One row of the surface-kind histogram behind `/acp-prune status`'s context map. */
export interface SurfaceKindCount {
    /** Display label: the source kind, or `plugin:<name>` for plugin rows. */
    readonly label: string;
    readonly count: number;
    /** True when the range table treats this row as a barrier (never offered, splits spans). */
    readonly barrier: boolean;
}
/**
 * Count the live surface's nodes by source kind, marking the barriers.
 *
 * This is the diagnostic half of the 2026-10-14 fragmentation case: the table
 * came back with six entries (three the same span, one ~0 tokens) on a 906-node
 * surface because 241 injected control rows (goal 186 / time-context 20 /
 * team-message 17 / agent-instructions 10) split it into 3-4 node runs. One line
 * now shows that instead of an afternoon of log forensics.
 */
export declare function surfaceKindCounts(session: Session): SurfaceKindCount[];
/**
 * Surface seqs of SUPERSEDED host rows — the ones the range table may fold even
 * though `classifySurfaceEvent` calls their kind a barrier.
 *
 * Two families, both "only the newest copy carries live state":
 *
 *  - **state echoes** ({@link STALE_FOLDABLE_HOST_KINDS}: goal / tool-goal /
 *    time-context / team-message / agent-message), newest per KIND. Live case:
 *    2026-10-14, 241 such rows chopped a 906-node surface into 3-4 node runs.
 *  - **superseded instruction rows and skill catalogs**, newest per SCOPE. The
 *    host re-injects the newest AGENTS.md copy the moment the surface loses it
 *    (`visibleBaselineSource` walks the surface newest-first and compares the
 *    baseline identity), and the skill catalog's resend gate is the digest — so
 *    the NEWEST copy of each scope must stay, while every older copy is history
 *    the host will never look at again. Live case 2026-10-16: one session's
 *    surface still carried 11 superseded copies of the same cjdb AGENTS.md,
 *    ~30K host-vocabulary tokens (≈11% of a 283K surface) that the table could
 *    never offer while every AGENTS.md row was a blanket barrier.
 *
 * Only rows the classifier would otherwise call a barrier need the override;
 * anything already foldable is left untouched.
 */
export declare function staleFoldableHostRowSeqs(session: Session): Set<number>;
export declare function guardedSurfaceSeqsOf(session: Session): Set<number>;
/**
 * The kernel's own view of what can be compressed, as the engine hands it to
 * the range table: the geometry (`nudge.compressibleRanges`) plus the ref map
 * that turns a kernel ref back into a surface seq (`state.messageRefs`).
 *
 * Structural shapes only, so the engine passes the kernel's own objects
 * straight through and tests can hand-build a view.
 */
export interface KernelRangeView {
    /** Kernel `recommendedRanges`/`compressibleRanges` entries (oldest first). */
    readonly ranges: readonly {
        readonly startRef: string;
        readonly endRef: string;
    }[];
    /** Kernel ref map: `mNNNNN` → our message id (which IS the surface seq). */
    readonly refs: {
        readonly byRef: Readonly<Record<string, string>>;
    };
}
/**
 * Compressible spans in the DSH seq dialect, for the nudge range table.
 *
 * The GEOMETRY — which messages group into one compressible span — comes from
 * the kernel's own ranges (design decision 7: the kernel owns the algorithm).
 * The kernel splits a group when the next message is a user turn and the group
 * already holds 3+ messages, and after any protected or already-compressed
 * message, so a row reads as "roughly one stretch of work" rather than an
 * arbitrary slice. This function only does the two jobs the kernel cannot:
 *
 * 1. Translate refs into surface seqs — DSH has no `<acp>` ref tags; seq is our
 *    ref (design decision 2).
 * 2. Apply the host guards on top of the kernel's grouping: injected
 *    instruction rows split a span and the newest copy of every scope is never
 *    offered, checkpoints and the surface's system node are not compressible,
 *    and the recent tail plus the last REAL user turn stay protected (rule 16).
 *
 * History — why this used to compute the spans itself. A kernel range's edges
 * were derived by counting refs, and a surface replacement breaks that
 * arithmetic: the checkpoint node of a replace lands mid-array carrying a much
 * higher ref, so ref order and array order diverge and the spans came back
 * reversed (`end < start`) or lost large tool results entirely. The table was
 * therefore self-computed from the surface, labeled `UPSTREAM:` and tracked as
 * issue #38 (rule 11). The pinned kernel segments by ARRAY adjacency instead
 * (upstream #207) and the drift is gone — measured on a session whose
 * compressed span sits in the MIDDLE of the surface: every ref resolves to the
 * right seq, no span crosses the shadowed hole, and the compressed span is
 * excluded. Rules 3 and 11 are updated with it.
 */
export declare function buildCompressibleSeqRanges(session: Session, kernelView: KernelRangeView, opts?: {
    preserveRecent?: number;
    mediaPriceOf?: MediaPriceOf;
}): SeqCompressibleRange[];
/** One batch the table can offer as an alternative to folding a single row. */
export interface RangeBatchProposal {
    /** The batch's disjoint ranges, in surface order — each becomes its own block. */
    readonly entries: readonly SeqCompressibleRange[];
    /** Sum of the entries' tokens. */
    readonly reclaimedTokens: number;
    /** Tokens re-sent uncached once: everything at and after the batch's FIRST entry. */
    readonly invalidatedTokens: number;
    /** `invalidatedTokens ÷ reclaimedTokens`. */
    readonly breakEvenRequests: number;
}
/**
 * The single batch worth offering under one base row: the cheapest-to-fold
 * combination reachable by extending up to `maxOld` older and `maxNew` newer
 * rows, and only when it beats the base row's own break-even by `minImprovement`.
 *
 * A row that already folds cheaply needs no proposal — the base row is the
 * answer. A row flagged expensive is the one that benefits: its rewrite is fixed
 * by where it starts, so pulling in NEWER neighbours that the model has also
 * consumed divides the same rewrite over more reclaimed tokens.
 *
 * @param ranges - every offerable range, in surface position order.
 * @param costs - fold costs aligned with `ranges`.
 * @param baseIndex - position of the base range in `ranges`.
 * @param opts - extension limits and the improvement floor.
 * @returns the chosen batch, or `undefined` when no extension is worth printing.
 */
export declare function bestBatchProposal(ranges: readonly SeqCompressibleRange[], costs: readonly RangeFoldCost[], baseIndex: number, opts: {
    maxOld: number;
    maxNew: number;
    minImprovement: number;
}): RangeBatchProposal | undefined;
/**
 * The whole sweep from one base range: the base range PLUS every later offerable
 * span, uncapped and unconditional.
 *
 * Policy (2026-10-16, the owner's rule): the six printed rows are six STARTING
 * POINTS. A row's sweep begins at that row and runs FORWARD — the model picks how
 * far toward the newest content it wants to go — and nothing older than the row
 * is ever pulled in.
 *
 * Why forward-only needs no selection rule, no cap and no margin: a fold's
 * rewrite is pinned by the batch's EARLIEST entry (everything at and after that
 * point is re-sent once, no matter how many entries ride along). Extending
 * forward therefore never grows the rewrite, and every added newer span strictly
 * lowers the payback — reclaimed grows while the rewrite stands still. Extending
 * BACKWARD is the asymmetric case: it moves the rewrite, which is why the earlier
 * greedy form could print one batch under several neighbouring rows (and under
 * rows it did not start at). The forward sweep has neither problem: each row's
 * proposal is its own suffix of the offerable list.
 *
 * Overlaps still matter — the offerable list can hold NESTED spans (a kernel
 * range containing a later one after a replacement), so a span that overlaps an
 * entry already taken is skipped: whichever span the model folds first owns
 * those seqs.
 *
 * @param ranges - every offerable range, in surface position order.
 * @param costs - fold costs aligned with `ranges`.
 * @param baseIndex - position of the base range in `ranges`.
 * @returns the sweep, or undefined when `baseIndex` names no offerable range.
 */
export declare function sweepFromBaseRange(ranges: readonly SeqCompressibleRange[], costs: readonly RangeFoldCost[], baseIndex: number): RangeBatchProposal | undefined;
/** What folding one offered range costs the prompt cache. */
export interface RangeFoldCost {
    /**
     * Tokens the next request must re-send uncached because the fold moves every
     * node at and after the span's start. Depends only on where the span STARTS.
     */
    readonly invalidatedTokens: number;
    /** `invalidatedTokens ÷ the range's own tokens` — requests to pay the rewrite back. */
    readonly breakEvenRequests: number;
}
/**
 * Price what each offered range would invalidate if the model folded it.
 *
 * The provider caches a request prefix; folding a span replaces it in place, so
 * every token at and after the span's start is re-sent once as a fresh miss.
 * That cost is therefore a function of the span's START POSITION only — not of
 * its size — which is why an early span is expensive even when it is small.
 * Live-measured 2026-10-15 on one long session: the same shape of fold cost ~3K
 * cold tokens on a 76K-token surface and ~208K on a 267K-token surface, and the
 * day's three worst compressions were exactly the ones whose first row was the
 * oldest span offered.
 *
 * @param session - session whose surface order is the prompt order.
 * @param ranges - offered ranges, aligned with the returned array.
 * @param mediaPriceOf - routed media price lookup, when the host has one.
 * @returns one cost entry per range, in the same order.
 */
export declare function foldCostsOfRanges(session: Session, ranges: readonly SeqCompressibleRange[], mediaPriceOf?: MediaPriceOf): RangeFoldCost[];
/**
 * A compact human-readable description of the current surface for the model:
 * node count plus the first/last message seqs. Surface seqs are sparse (the
 * event log interleaves non-message events and expanded delta batches), so a
 * model that never saw the nudge range table — e.g. low-pressure sessions
 * where no nudge fires — cannot guess its own seq space. acp_status and the
 * nudge's range table both surface this so compress edges can be located
 * without blind probing.
 */
export declare function surfaceSummary(session: Session): string;
/** One block as seen by the tier machinery: durable id ↔ kernel ref (`bN`). */
export interface AcpBlockRegistryEntry {
    /** The durable compaction id. */
    readonly blockId: string;
    /** The acp-kernel block ref (`bN`); synthesised by log order for legacy blocks. */
    readonly kernelBlockId: string;
    readonly tier: 1 | 2 | 3;
    /** The surface seq of this block's checkpoint summary node (null when gone). */
    readonly summarySeq: number | null;
    /** True until a LATER block distills this one. Only active blocks are distillable. */
    readonly active: boolean;
    readonly parentBlockIds: readonly string[];
}
/**
 * Rebuild the compactionId ↔ kernel-block-ref registry from the durable log.
 * Legacy blocks (pre-tier, no recorded `kernelBlockId`) are synthesised as
 * `b1`, `b2`, … in log order; recorded ids are kept as-is. A block is active
 * until a later block lists it as a parent.
 */
export declare function blockRegistry(session: Session): AcpBlockRegistryEntry[];
/**
 * Checkpoint carriers of STILL-ACTIVE blocks inside a set of surface seqs.
 *
 * A plain message-ref range does not supersede a live block: the kernel keeps
 * such a carrier visible and reports the exclusion in its warning list
 * (upstream #335 — our projection marks carriers with
 * `CoreMessage.summaryOfBlockId`). But our durable transaction replaces the
 * whole span in ONE `surfaceOp`, so the carrier would leave the visible surface
 * anyway — the block's summary would vanish while the kernel still counts the
 * block as active, and the nudge's tier line would name a checkpoint seq that no
 * longer exists. The compress path therefore rejects such a span (see
 * `liveCarrierRejectionNote` in src/tools.ts).
 *
 * The offered range table never produces one — `compressibleSegmentsOf` flushes
 * on every checkpoint, exactly like the instruction-row barriers — so only a
 * hand-crafted call can reach this probe.
 */
export declare function liveCheckpointCarriersInSpan(session: Session, seqs: readonly number[]): {
    seq: number;
    kernelBlockId: string;
}[];
/**
 * Split a positional seq span at the given barrier seqs into contiguous runs.
 *
 * The compress path uses this to salvage a requested plain range that crosses a
 * live block's checkpoint carrier: the carrier itself must stay on the surface
 * (see `liveCheckpointCarriersInSpan`), while the content around it is still
 * foldable. Splitting — rather than rewriting the span into block ids — keeps
 * the model's own summary attached to the content it actually asked to fold
 * (`bN..bM` would distill the blocks instead, a different operation).
 *
 * Order is the SPAN's, not numeric order: the surface is locally unordered
 * after a replacement (a checkpoint node lands mid-array carrying a larger
 * seq), and the barrier seqs are positions in that same array, so the caller
 * must pass `shadowedSeqsOf`'s slice for both.
 */
export declare function splitSpanAtSeqs(seqs: readonly number[], barriers: readonly number[]): number[][];
/**
 * The kernel block ref (`bN`) for a surface seq, when that seq is the
 * checkpoint summary node of a block — the edge the model must use to
 * distill (T2/T3). Active blocks distill; a stale (already-distilled) node
 * still maps to its `bN` so the kernel reports "already compressed" instead
 * of silently folding the summary as a plain message. Returns null for
 * anything else (plain messages, non-checkpoint nodes).
 */
export declare function blockRefForSummarySeq(session: Session, seq: number): string | null;
/** The durable compaction ids distilled by the given kernel block refs (`bN`). */
export declare function compactionIdsOfKernelBlocks(session: Session, kernelBlockIds: readonly string[]): string[];
/**
 * Resolve a kernel block ref (`bN`) — as shown by the model tool `acp_status`
 * (kernel `buildStatusReport` renders `block.blockId`) — to the durable
 * compaction id the decompress/search tools accept. Returns null when `bN` is
 * not an exact registry key (unknown ref). Only matches the canonical `bN`
 * form (`/^b\d+$/`); anything else is not a kernel ref and returns null so the
 * caller falls back to its compaction-id prefix match.
 */
export declare function blockIdOfKernelRef(session: Session, kernelRef: string): string | null;
/** The checkpoint summary seq of an ACTIVE kernel block (`bN`), or null. */
export declare function summarySeqOfKernelBlock(session: Session, kernelBlockId: string): number | null;
/**
 * The shadowed seqs of a block, recursing into distilled parent blocks: a
 * tier-2 block shadows its parent's checkpoint node, so recovering its
 * originals requires expanding that node into the parent block's own shadowed
 * seqs. Cycle-safe (a block can never be its own ancestor).
 */
export declare function expandShadowedSeqs(session: Session, blockId: string): number[];
/**
 * Default decompress page size (#112): a block shadowing hundreds of
 * messages used to be returned whole in ONE tool result — big enough to
 * flood the context window or get silently trimmed by the host's
 * tool-result pruner before the model ever saw the tail. One page per call
 * keeps every recovery usable; `offset` walks the rest.
 *
 * A page is bounded by BOTH this message count and a rendered-character
 * budget ({@link DEFAULT_DECOMPRESS_PAGE_CHARS}). Count alone was not enough:
 * the host's `dsh-compaction-tool-result-pruner` (docs/dsh-porting-analysis.md)
 * trims by CHARACTERS (thresholdChars 8192), so a wide page of long messages
 * still crossed that line and had its middle dropped. The char bound keeps an
 * ordinary page under the pruner threshold so it comes back intact; the
 * message count doubles as a hard ceiling so a pathological `limit` can't
 * re-open the whole-block flooding half of #112.
 */
export declare const DEFAULT_DECOMPRESS_PAGE = 100;
/**
 * Rendered-character budget per decompress page (#112). Kept below the host's
 * tool-result pruner threshold (8192, docs/dsh-porting-analysis.md) with
 * headroom for the block header, the `[seq N]` prefixes, and the continue hint,
 * so a normal page survives intact instead of middle-trimmed. Deliberately NOT
 * tied to acp-kernel's `config.truncate.threshold`: that knob truncates a single
 * oversized tool output during compression, whereas the host pruner trims our
 * whole decompress result — different mechanisms, different thresholds.
 */
export declare const DEFAULT_DECOMPRESS_PAGE_CHARS = 7000;
export interface DecompressPage {
    /** Requested offset floored to >= 0; reported as-is when it lands past the end. */
    offset: number;
    /** Limit actually applied (clamped to [1, DEFAULT_DECOMPRESS_PAGE]). */
    limit: number;
    /** Total shadowed messages in the block (tier-expanded). */
    total: number;
    /** This page's shadowed seqs, in expansion order. */
    seqs: number[];
    /** True when no further page follows this one. */
    exhausted: boolean;
}
/**
 * Slice a block's expanded shadowed-seq list into one page. A page holds at most
 * `limit` messages AND at most `charBudget` rendered characters, where
 * `renderLen(seq)` reports each message's on-the-wire length (0 when it carries
 * no text). Seqs whose original carries no text still occupy a slot, so `offset`
 * stays a stable continuation index across calls while the log is frozen.
 * Out-of-range / negative / non-finite values clamp instead of failing (optional
 * convenience params, not semantic boundaries); non-numeric input falls back to
 * the default rather than leaking NaN into the result. The first message of the
 * page is always included even if it alone exceeds the budget, so a walk always
 * makes progress past a single giant message.
 */
export declare function sliceDecompressPage(expanded: number[], offset: number, limit: number, charBudget: number, renderLen: (seq: number) => number): DecompressPage;
export {};
