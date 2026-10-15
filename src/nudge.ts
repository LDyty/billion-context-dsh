/**
 * M4 — ACP nudge: the kernel's compression recommendation, rendered as an
 * injected user message with a seq-based compressible-range table (D1:
 * "seq is the ref" — DSH has no in-memory message rewrite hook, so the model
 * targets ranges by surface seq rather than by <acp> tags).
 * @module billion-context-dsh/nudge
 */

import {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
  defaultCountTokens,
  renderNudgeText,
  type CompressionCore,
  type CompressionState,
  type ContextBreakdown,
  type CoreMessage,
  type NudgeDecision,
} from 'acp-kernel'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AcpStateStore } from './state.ts'
import { allLogMessages, eventsToCoreMessages, isCheckpointNode, surfaceEventsOf } from './messages.ts'
import {
  buildCompressibleSeqRanges,
  findOpenTurn,
  bestBatchProposal,
  foldCostsOfRanges,
  summarySeqOfKernelBlock,
  surfaceSummary,
  type KernelRangeView,
  type MediaPriceOf,
  type SeqCompressibleRange,
} from './region.ts'
import { mediaPriceViaMeter } from './host-tokens.ts'
import { sessionEventsOf } from './session-events.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'
import { DEFAULT_RESOLVED, renderTemplate, type ResolvedPrompts } from './prompts.ts'

/**
 * B6 nudge 瘦身（2026-09-08 方案 §4 B6）：哲学段与压缩规则段**移出 nudge**——
 * 它们已经住在系统提示与工具描述里（各注一次），每拍复读=同一份文本反复计费
 * （本会话实测：nudge 正文 6.1 KB/次 × 3 = 18.4 KB）。nudge 只留「该压缩了 + 压缩哪些」。
 *
 * UPSTREAM: this is a labeled host-side workaround (AGENTS.md rule 11), not a
 * long-term design. The four texts below are imported from acp-kernel and are
 * removed from already-rendered nudge text, so the clean fix belongs upstream:
 * an acp-kernel option that renders the nudge without the guidance blocks.
 * Drop stripNudgeGuidance and use that option once it exists. Tracked in
 * docs/dsh-porting-verification.md.
 */
const GUIDANCE_BLOCKS = [COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES] as const

export function stripNudgeGuidance(text: string): string {
  let out = text
  for (const block of GUIDANCE_BLOCKS) out = out.split(block).join('')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** Kernel inputs the nudge path shares with the compress tool. */
export interface NudgeEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
  /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
  readonly prompts?: ResolvedPrompts
}

export interface NudgeOutcome {
  readonly message: UserMessage
  readonly emergency: boolean
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
export function resolveTokenCount(agent: Agent, coreMessages: CoreMessage[]): number {
  // 1. Prefer sessionProjections.contextPressure.projectedTokens (matches UI).
  const projections = agent.ctx?.get?.('sessionProjections') as
    | { snapshot?: (session: unknown) => { values?: { contextPressure?: { projectedTokens?: number } } } }
    | undefined
  const projected = projections?.snapshot?.(agent.session)?.values?.contextPressure?.projectedTokens
  if (typeof projected === 'number' && projected > 0) return projected

  // 2. Fallback to tokenMeter surfaceTokens (heuristic, no fixed overhead).
  const meter = agent.ctx?.get?.('tokenMeter') as
    | { measure?: (session: unknown) => { surfaceTokens?: number } }
    | undefined
  const surface = meter?.measure?.(agent.session)?.surfaceTokens
  if (typeof surface === 'number' && surface > 0) return surface

  // 3. Last resort: character heuristic.
  return coreMessages.reduce((sum, message) => sum + defaultCountTokens(message.text ?? ''), 0)
}

/**
 * The kernel's decision and live state in the shape the range table needs.
 *
 * The kernel owns the compressible geometry (`nudge.compressibleRanges`); the
 * ref map turns a kernel ref back into a surface seq. Both objects come from
 * the SAME turn — the map must be the one `processTurn` just returned, never a
 * rehydrated store state, or the refs point at ids this surface does not have.
 */
function kernelRangeViewOf(nudge: NudgeDecision, state: CompressionState): KernelRangeView {
  return { ranges: nudge.compressibleRanges ?? [], refs: state.messageRefs }
}

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
export function hasActionableTarget(
  session: import('@deepseek-ai/dsh-session').Session,
  nudge: NudgeDecision,
  state: CompressionState,
): boolean {
  if (nudge.tier !== null && nudge.tier !== undefined) return true
  return buildCompressibleSeqRanges(session, kernelRangeViewOf(nudge, state)).length > 0
}

/**
 * Range-row suffix naming the image/file blocks a span carries, so the model
 * does not read "~0 tokens" as "nothing to reclaim" for a picture-heavy span
 * (issue #117). Counts, not prices: the price sits in the token column.
 */
function mediaSuffixOf(range: SeqCompressibleRange): string {
  if (range.images === 0 && range.files === 0) return ''
  const parts: string[] = []
  if (range.images > 0) parts.push(`+${range.images} image${range.images === 1 ? '' : 's'}`)
  if (range.files > 0) parts.push(`+${range.files} file${range.files === 1 ? '' : 's'}`)
  // ` | ` is the separator the same row already uses for the tool/text share
  // column (`[tool X% | text Y%]`) and the one AGENTS.md rule 19 documents; a
  // comma inside the bracket reads as prose.
  return ` [${parts.join(' | ')}]`
}

/**
 * Lazy per-seq media price. The FIRST lookup triggers one meter measurement, so
 * the range walk only asks about seqs that really carry an attachment — a
 * media-free session never pays for the measurement (issue #117, issue #110).
 * Exported for the context-overflow recovery path, which ranks ranges with the
 * same vocabulary as the nudge table.
 */
export function meterMediaPriceResolver(
  agent: Agent,
  session: import('@deepseek-ai/dsh-session').Session,
): MediaPriceOf {
  let prices: ReadonlyMap<number, number> | null = null
  return (seq: number) => {
    if (prices === null) prices = mediaPriceViaMeter(session, agent.ctx)
    return prices.get(seq) ?? 0
  }
}

/** Rows the nudge range table prints. */
export const RANGE_TABLE_LIMIT = 6

/**
 * Break-even request count at which a row is flagged as expensive to fold.
 * Above this the one-time prefix rewrite costs more requests than the reclaim
 * pays back quickly, so the model is told rather than left to guess.
 */
export const RANGE_TABLE_COST_WARN_BREAK_EVEN = 6

/** Marker appended to a row whose fold pays back slower than the warning line. */
const RANGE_TABLE_COST_WARN_FLAG = ' — ⚠ expensive: this span starts early, so most of the context is re-sent'

/** How many older / newer neighbours a normal base row may absorb into its batch. */
export const RANGE_TABLE_BATCH_MAX_OLD = 3
export const RANGE_TABLE_BATCH_MAX_NEW = 3

/**
 * A flagged row's rewrite is fixed by where it starts, so only NEWER neighbours
 * can divide that rewrite over more reclaimed tokens — extending it backwards
 * would deepen the very cost the flag warns about.
 */
export const RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE = 6

/** Only print a batch when it beats its base row's break-even by this fraction. */
export const RANGE_TABLE_BATCH_MIN_IMPROVEMENT = 0.25

/**
 * A batch is only recommended when folding it pays back within this many
 * requests. This is the policy knob, not a formatting one: a proposal is an
 * instruction to go compress, so it is only issued where the arithmetic really
 * is cheap. Recommended batches start later than a lone base row, so their
 * payback falls to roughly `base ÷ (1 + pulled-in tokens)`.
 *
 * Live-calibrated 2026-10-15 against the model's own behaviour on this
 * session's tables: every batch it composed itself landed at 1.9-1.93 requests,
 * while the best batch reachable from a ⚠ row stayed at 5.0-5.6 — and it took
 * ⚠ rows 0 times out of 6 in the three most recent compressions. Recommending
 * the 5.6-request escape hatch therefore bought nothing; recommending the
 * 3-request-and-under batches on the rows it actually picks does.
 */
export const RANGE_TABLE_BATCH_RECOMMEND_BREAK_EVEN = 3

/**
 * Hard cap on how many batch proposals one table may carry. The count is
 * otherwise dynamic: a table prints a proposal for every printed row whose best
 * batch clears {@link RANGE_TABLE_BATCH_RECOMMEND_BREAK_EVEN} (and beats the row
 * itself by {@link RANGE_TABLE_BATCH_MIN_IMPROVEMENT}), so a cheap table may
 * carry three and an expensive one none. The cap exists because the nudge body
 * is re-sent with every request: unbounded, a table whose rows all have
 * neighbours prints one proposal per row (measured 123 of 123 rows on a
 * randomized matrix), roughly doubling the text for no extra guidance.
 */
export const RANGE_TABLE_BATCH_MAX_PROPOSALS = 3

/** Compact token count for a cost row: one decimal above 10K, whole numbers below. */
function compactTokens(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(1)}K` : String(Math.round(tokens))
}

/**
 * One batch entry, carrying the two facts the model needs to write its summary:
 * how big the segment is and what it is mostly made of. The table prints only six
 * rows, but a batch reaches into the whole offerable list, so without this the
 * model would be asked to summarise seqs it never saw a size or flavour for.
 */
function batchEntryLabel(entry: SeqCompressibleRange): string {
  const kind = entry.toolPct >= 100 ? 'tool' : entry.toolPct <= 0 ? 'text' : `tool ${entry.toolPct}%`
  return `${entry.start}..${entry.end}(~${compactTokens(entry.tokens)} ${kind})`
}

/**
 * Pick the rows the nudge range table prints: **largest first, oldest among
 * equals**.
 *
 * Ordering policy (2026-10-15). It replaces the earlier "oldest among the
 * large" compromise, which sorted the largest eight spans back into position
 * order — putting the OLDEST span of the offerable set in row 1 on 36/36 live
 * compressions of one measured day. Folding a span invalidates every cached
 * token after its start, so an old first row is the most expensive default the
 * table can hand the model: predicting the invalidation of each strategy's
 * first row over that day's real offerable tables gives 47.8% for
 * oldest-of-the-largest against 8.5% for size-first. Size-first also matches
 * the upstream table (PR #217), so the two implementations stay identical.
 */
export function selectRangeTableRanges<T extends { start: number; end: number; tokens: number }>(
  all: readonly T[],
): T[] {
  return [...all]
    .sort((a, b) => b.tokens - a.tokens || a.start - b.start)
    .slice(0, RANGE_TABLE_LIMIT)
}

/**
 * Render the compressible-range table as seq refs for the model.
 *
 * The spans are the kernel's own (`compressibleRanges`, translated to surface
 * seqs) with the host guards applied on top — see buildCompressibleSeqRanges.
 * This function used to self-compute them from the surface as a labeled
 * `UPSTREAM:` workaround for kernel ref-map drift; that drift is fixed upstream
 * (acp-kernel #207) and the workaround is gone (rule 11).
 */
export function rangeTable(
  session: import('@deepseek-ai/dsh-session').Session,
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
  mediaPriceOf?: MediaPriceOf,
): string {
  const ranges = buildCompressibleSeqRanges(
    session,
    kernelView,
    mediaPriceOf === undefined ? {} : { mediaPriceOf },
  )
  const shown = selectRangeTableRanges(ranges)
  // 零范围:整块省略(保留现状的提前返回与 nudge 尾部 '\n')。
  if (shown.length === 0) return ''
  // Each row carries its own fold cost: reclaiming a span makes every node at
  // and after its start re-send uncached once, so the model needs that number to
  // weigh a cheap-but-tiny span against an expensive-but-satisfying one. The
  // cost is informational only — ordering stays size-first, because ranking by
  // cost would systematically promote the newest large spans (the ones the task
  // is most likely still using).
  const costs = foldCostsOfRanges(session, ranges, mediaPriceOf)
  // Costs cover every offerable range, so a base row can reach its neighbours
  // even when they did not fit the printed six.
  const baseRows = shown.map((range) => {
    const at = ranges.indexOf(range)
    const cost = costs[at] ?? { invalidatedTokens: 0, breakEvenRequests: Number.POSITIVE_INFINITY }
    return { range, at, cost, expensive: cost.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN }
  })
  // Proposals are DYNAMIC (2026-10-15, second revision): a row carries one when
  // its best batch folds within RANGE_TABLE_BATCH_RECOMMEND_BREAK_EVEN requests,
  // scanned in PRINTED order (largest first) so the rows the model is actually
  // weighing are the ones that get the hint. The earlier policy claimed two
  // slots worst-cost-first, which handed both to the ⚠ rows (payback 14.8 /
  // 20.4) — the exact rows the model declined in every measured call — while the
  // batch it composed itself (payback 1.9) never appeared in the table at all.
  // An entry set that two base rows converge on is still printed once.
  const claimed = new Set<string>()
  // Keyed by the offered range's POSITION in the offerable list, not by its
  // start seq: two nested rows can share a start (`36622..36662` inside
  // `36622..36659` on the live surface, 2026-10-15), and a start-keyed map then
  // printed the SAME proposal under both rows — one of the table's few slots
  // spent on a duplicate. Keying by position prints it exactly once, under the
  // row that claimed it.
  const proposalOfAt = new Map<number, string>()
  for (const row of baseRows) {
    if (row.at < 0) continue
    if (proposalOfAt.size >= RANGE_TABLE_BATCH_MAX_PROPOSALS) break
    const proposal = bestBatchProposal(ranges, costs, row.at, {
      maxOld: row.expensive ? 0 : RANGE_TABLE_BATCH_MAX_OLD,
      maxNew: row.expensive ? RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE : RANGE_TABLE_BATCH_MAX_NEW,
      minImprovement: RANGE_TABLE_BATCH_MIN_IMPROVEMENT,
    })
    if (proposal === undefined) continue
    // Cheap only: a proposal asks the model to go compress, so it is issued
    // where the arithmetic really pays — see the constant.
    if (proposal.breakEvenRequests > RANGE_TABLE_BATCH_RECOMMEND_BREAK_EVEN) continue
    const entries = proposal.entries.map(batchEntryLabel).join(', ')
    if (claimed.has(entries)) continue
    claimed.add(entries)
    proposalOfAt.set(row.at, renderTemplate(prompts.rangeTable.batch, {
      entries,
      count: proposal.entries.length,
      reclaimed: compactTokens(proposal.reclaimedTokens),
      invalidated: `${compactTokens(proposal.invalidatedTokens)} tok`,
      breakEven: Number.isFinite(proposal.breakEvenRequests) ? proposal.breakEvenRequests.toFixed(1) : '∞',
    }))
  }
  const lines = baseRows.flatMap(({ range, at, cost, expensive }) => {
    const rows = [
      renderTemplate(prompts.rangeTable.line, {
        start: range.start,
        end: range.end,
        count: range.count,
        tokens: range.tokens,
        toolPct: range.toolPct,
        textPct: 100 - range.toolPct,
        media: mediaSuffixOf(range),
      }),
      renderTemplate(prompts.rangeTable.cost, {
        reclaimed: compactTokens(range.tokens),
        invalidated: `${compactTokens(cost.invalidatedTokens)} tok`,
        breakEven: Number.isFinite(cost.breakEvenRequests) ? cost.breakEvenRequests.toFixed(1) : '∞',
        flag: expensive ? RANGE_TABLE_COST_WARN_FLAG : '',
      }),
    ]
    const batch = proposalOfAt.get(at)
    if (batch !== undefined) rows.push(batch)
    return rows
  })
  return [
    // 前导空串元素产生 nudge 中范围表前的唯一空行(§4:parts 层不再加分隔)。
    '',
    renderTemplate(prompts.rangeTable.header, { surface: surfaceSummary(session) }),
    renderTemplate(prompts.rangeTable.title, { count: shown.length }),
    ...lines,
    // Name what the cap hid: with a fragmented surface the table used to show a
    // handful while dozens more sat unlisted, and the model had no way to know
    // (2026-10-14: 128 offerable ranges, six rows printed).
    ...(ranges.length > shown.length
      ? [`  (${ranges.length - shown.length} more range(s) not shown — acp_status with scope:"uncompressed", view:"ranges" lists them)`]
      : []),
    prompts.rangeTable.footer,
  ].join('\n')
}

/**
 * The token count driving pressure decisions. Prefer `resolveTokenCount` which
 * uses `sessionProjections.contextPressure.projectedTokens` (matches the UI's
 * context-occupancy display, including fixed overhead). Falls back to
 * `tokenMeter.measure(session).surfaceTokens`, then `defaultCountTokens`
 * character heuristic for tests and minimal hosts.
 */
function measuredTokenCount(agent: Agent, coreMessages: CoreMessage[]): number {
  return resolveTokenCount(agent, coreMessages)
}

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
export function computeSurfaceBreakdown(
  state: CompressionState,
  messages: readonly CoreMessage[],
  total: number,
  growth: number,
): ContextBreakdown {
  let system = 0
  let tool = 0
  let code = 0
  let text = 0
  for (const message of messages) {
    const tokens = defaultCountTokens(message.text ?? '')
    if (message.contentType === 'tool-call' || message.contentType === 'tool-result') {
      tool += tokens
    } else if (message.role === 'system') {
      system += tokens
    } else if ((message.text ?? '').includes('```')) {
      code += tokens
    } else {
      text += tokens
    }
  }
  let summaries = 0
  for (const block of state.blocks) {
    if (block.active) summaries += defaultCountTokens(block.summary)
  }
  return { system, tool, summaries, code, text, total, growth }
}

/**
 * Max emergency nudge injections within a single user turn. Bounds the
 * positive-feedback loop where an unrelieved ≥emergency-threshold pressure
 * re-injects a durable emergency nudge on every pre-step forever (issue #108).
 * Mirrors billion-context-pi commit 414acd1 (cap emergency nudge injections per
 * user turn). Normal-pressure nudges remain limited to one per turn regardless.
 */
export const EMERGENCY_NUDGE_MAX_PER_TURN = 3

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
export function buildNudge(
  agent: Agent,
  env: NudgeEnvironment,
  lastNudgeTurn: Map<string, number>,
  emergencyNudges: Map<string, { turn: number; count: number }>,
  onEmergencyCapHit?: () => void,
  onNothingToCompress?: (kind: 'normal' | 'emergency') => void,
): NudgeOutcome | null {
  const session = agent.session
  const state = env.store.stateFor(session)
  // Full log for the kernel (so block anchors survive — see handleCompress);
  // the measured token count stays a SURFACE measurement.
  const coreMessages = allLogMessages(session)
  const surfaceEvents = surfaceEventsOf(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEvents)
  const tokenCount = measuredTokenCount(agent, surfaceMessages)
  const config = kernelConfigFor(env)
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)

  const nudge = turn.nudge
  if (nudge === undefined || !nudge.shouldInject) return null
  // Media-bearing spans are invisible to every text estimator, so their price
  // comes from the host meter. Lazily: a media-free session never pays for a
  // measurement (meterMediaPriceResolver only measures on first lookup).
  const mediaPriceOf = meterMediaPriceResolver(agent, session)
  // The kernel computed `contextBreakdown` from the FULL log (allLogMessages),
  // so after any compression it reports HISTORICAL totals (a huge `tool` that
  // is really the compressed-away originals). Override it with the visible
  // surface + active-block summaries so the nudge line matches acp_status
  // (which renders from `buildStatusReport` over the surface). Checkpoint
  // summary nodes are excluded (they are not in any block's effectiveMessageIds
  // and would double-count) — the same exclusion `/acp-prune` status applies. The
  // breakdown is display-only and never drives injection, so this override is
  // safe for the decision path.
  const statusMessages = eventsToCoreMessages(
    surfaceEvents.filter((event) => isCheckpointNode(event) === false),
  )
  nudge.contextBreakdown = computeSurfaceBreakdown(turn.state, statusMessages, tokenCount, nudge.contextBreakdown?.growth ?? 0)
  const emergency = nudge.breakdown?.emergencyOverride === 1

  // Never demand a compression the surface cannot offer. The kernel decides
  // WHEN to nudge from pressure/growth, but only the HOST knows whether any
  // legal target exists: with the surface fragmented by injected control rows
  // the offered table can come back empty (or priced at ~0 tokens), and the
  // emergency copy — "Context limit reached — compress now" — then asks for an
  // action with no legal target at all. The model retries, its turn degenerates,
  // and the nudge re-injects (bounded per turn, so it also wastes the budget).
  // Live-measured 2026-10-14 (session-a41fb964): 906 surface nodes, 241 barrier
  // rows (goal 186 / time-context 20 / team-message 17 / agent-instructions 10),
  // only ~2K tokens offerable — every emergency nudge in that window was
  // unactionable. Suppress the injection instead, and let the caller log it.
  if (!hasActionableTarget(session, nudge, turn.state)) {
    onNothingToCompress?.(emergency ? 'emergency' : 'normal')
    return null
  }

  const turnNumber = findOpenTurn(sessionEventsOf(session)) ?? 0
  if (!emergency) {
    // Normal-pressure nudge: at most one per user turn (unchanged behavior).
    if (lastNudgeTurn.get(session.id) === turnNumber) return null
    lastNudgeTurn.set(session.id, turnNumber)
  } else {
    // Emergency nudge: bounded per user turn. Without this cap an unrelieved
    // ≥emergencyThreshold pressure re-injects a durable nudge on EVERY pre-step
    // (each appended as a user/message event), and the nudge's own tokens push
    // usage higher → a runaway feedback loop (issue #108; mirrors pi #223/#250
    // and commit 414acd1).
    const record = emergencyNudges.get(session.id)
    if (record !== undefined && record.turn === turnNumber) {
      if (record.count >= EMERGENCY_NUDGE_MAX_PER_TURN) {
        onEmergencyCapHit?.()
        return null
      }
      record.count += 1
    } else {
      emergencyNudges.set(session.id, { turn: turnNumber, count: 1 })
    }
  }

  const text = buildNudgeText(
    nudge,
    emergency,
    session,
    kernelRangeViewOf(nudge, turn.state),
    env.prompts,
    mediaPriceOf,
  )
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    // V4 producer kind (issue #163): DSH ≥0.1.7's V4 admission rejects the
    // legacy wrapper shape `{ kind: 'plugin', plugin: … }` outright (a wedged
    // batch fails the NEXT turn with "format v4 message requires a
    // producer-owned source kind"). `plugin:<name>` is exactly what the host's
    // own V3→V4 migration emits for unregistered plugins, and DSH 0.1.5
    // sessions accept it too (probe-verified), so no version gate is needed.
    source: { kind: 'plugin:acp-nudge' },
  })
  return { message, emergency }
}

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
export function buildNudgeText(
  nudge: NudgeDecision,
  emergency: boolean,
  session: import('@deepseek-ai/dsh-session').Session,
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts = DEFAULT_RESOLVED,
  mediaPriceOf?: MediaPriceOf,
): string {
  // A host override of any nudge slot → template rendering (config.prompts
  // keeps its v0.1.9 contract: custom copy wins). Only the pristine default
  // reference reaches the kernel path.
  if (prompts.nudge !== DEFAULT_RESOLVED.nudge) {
    return renderNudgeFromTemplates(nudge, emergency, session, kernelView, prompts, mediaPriceOf)
  }
  const rendered = renderNudgeText(nudge)
  return adaptKernelNudgeToSeq(rendered.text, nudge, session, kernelView, prompts, mediaPriceOf)
}

/**
 * Take the kernel-rendered nudge text and replace its ref-ID-oriented segments
 * with our surface-seq equivalents.
 *
 * The B6 slim step (`stripNudgeGuidance`) runs first: it removes the
 * philosophy, HOW_TO_COMPRESS_RULES and tier-2/3 rule blocks, because they
 * already live in the system prompt and the tool descriptions — repeating them
 * in every nudge only re-billed the same ~6 KB. What stays kernel-verbatim:
 * the frame, the context breakdown, the tier line and the batch tip.
 *
 * Only the ref-ID-oriented segments are replaced with our seq-based
 * equivalents, because DSH has no `<acp>` ref tags — see
 * docs/dsh-porting-verification.md:
 */
function adaptKernelNudgeToSeq(
  text: string,
  nudge: NudgeDecision,
  session: import('@deepseek-ai/dsh-session').Session,
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts,
  mediaPriceOf?: MediaPriceOf,
): string {
  // B6：先摘掉哲学/规则段（它们住在系统提示与工具描述里），再做 seq 适配
  let out = stripNudgeGuidance(text)
  // Tier nudges: replace the kernel trigger block (block ids bN) with our tier
  // line carrying surface seqs. The kernel's TIER2/3 rule blocks were already
  // removed by stripNudgeGuidance above — those rules live in the system prompt.
  if ((nudge.tier === 2 || nudge.tier === 3) && (nudge.tierTargetBlocks?.length ?? 0) > 0) {
    out = replaceTierTrigger(out, nudge, session, prompts)
  } else if (out.includes('"startId"')) {
    // Emergency nudges: replace the ref-ID JSON example with a seq example.
    out = replaceEmergencyExample(out)
  }
  // Replace the ref-ID range table (mNNNNN) with the surface-seq table.
  // A zero-range table leaves the kernel's own "[No specific ranges detected]"
  // notice intact — it is a better prompt than an empty table.
  const seqTable = rangeTable(session, kernelView, prompts, mediaPriceOf)
  if (seqTable !== '') out = replaceRangesStr(out, seqTable)
  out = insertContentFormNote(out)
  return out
}

/**
 * The kernel's batch tip (0.0.101) advertises TWO content forms — the array
 * form and a plain string ("most robust through lossy gateways"). This tool's
 * schema takes the array form only: our ref dialect is surface seqs, and
 * `content` must be `[{ startSeq, endSeq, summary }]`. Rather than rewrite the
 * kernel's copy (rule 9: the kernel owns the prompt), the engine states the
 * difference in ONE line, placed BEFORE the tip so the tip stays the last
 * thing the model reads. Without it a model that follows the tip gets a schema
 * rejection it has to re-learn from mid-batch.
 */
const CONTENT_FORM_NOTE =
  'Note: this tool takes the array form only — compress({ content: [{ startSeq, endSeq, summary }] }) with the surface seqs above; a plain-string content is rejected.'

/** Insert the array-form note right before the kernel's closing tip (no tip → text unchanged). */
function insertContentFormNote(text: string): string {
  const tipAt = text.lastIndexOf('\n\n\u{1F4A1} ')
  if (tipAt === -1) return text
  return text.slice(0, tipAt) + '\n\n' + CONTENT_FORM_NOTE + text.slice(tipAt)
}

/** Replace the kernel rangesStr segment (`Compressible ranges (N, oldest first):…`) with our seq table. */
function replaceRangesStr(text: string, seqTable: string): string {
  const match = text.match(/\n\n(?:Compressible ranges \(|\[No specific ranges detected)/)
  if (!match) return text
  const start = match.index!
  const rest = text.slice(start + 2)
  const next = rest.match(/\n\n/)
  const end = next !== null ? start + 2 + next.index! : text.length
  const before = text.slice(0, start)
  const after = text.slice(end)
  // seqTable starts with '\n' (the range table's leading blank line), so
  // `before` + '\n' + seqTable yields one blank line before the table.
  return before + '\n' + seqTable + after
}

/** Replace the kernel tier trigger segment (`[TIER n …TRIGGER]…Example: compress(…)`) with our tier line. */
function replaceTierTrigger(
  text: string,
  nudge: NudgeDecision,
  session: import('@deepseek-ai/dsh-session').Session,
  prompts: ResolvedPrompts,
): string {
  const start = text.search(/\n\n(?:\[TIER \d|\[EMERGENCY — TIER \d)/)
  if (start === -1) return text
  const rest = text.slice(start + 2)
  const next = rest.match(/\n\nHOW TO COMPRESS/)
  const end = next !== null ? start + 2 + next.index! : text.length
  const targets = nudge.tierTargetBlocks!
  const summarySeqs = targets
    .map((block) => summarySeqOfKernelBlock(session, block.blockId))
    .filter((seq): seq is number => seq != null)
    .sort((a, b) => a - b)
  const pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3
  const tokens = typeof pending === 'number' ? pending : 0
  const tierValue = nudge.tier === null ? 2 : nudge.tier
  const tierLine = renderTemplate(prompts.nudge.tier, {
    tier: tierValue,
    count: targets.length,
    prevTier: tierValue - 1,
    tokens,
    seqs: summarySeqs.join(', '),
    firstSeq: summarySeqs[0] ?? 'n/a',
    lastSeq: summarySeqs[summarySeqs.length - 1] ?? 'n/a',
  })
  return text.slice(0, start) + '\n\n' + tierLine + text.slice(end)
}

/** Replace the kernel emergency JSON example (startId/endId) with a seq example. */
function replaceEmergencyExample(text: string): string {
  const start = text.search(/\n\n\{ "topic":/)
  if (start === -1) return text
  const rest = text.slice(start + 2)
  const next = rest.match(/\n\nCompressible ranges |\n\n\[No specific/)
  const end = next !== null ? start + 2 + next.index! : text.length
  return text.slice(0, start)
    + '\n\ncompress({ content: [{ startSeq, endSeq, summary }] }) — use the seqs from the range table above.'
    + text.slice(end)
}

/**
 * Template rendering path (used only when a host overrides a `prompts.nudge`
 * slot). Kept byte-compatible with the pre-refactor assembly: frame → breakdown
 * → growth → guidance → tier(+rules)/range table → tip.
 */
function renderNudgeFromTemplates(
  nudge: NudgeDecision,
  emergency: boolean,
  session: import('@deepseek-ai/dsh-session').Session,
  kernelView: KernelRangeView,
  prompts: ResolvedPrompts,
  mediaPriceOf?: MediaPriceOf,
): string {
  // Cap the reported percentage at 100: a broken measurement (e.g. response
  // pressure folded in) must never surface as an absurd "230%" to the model.
  const pct = Math.round(Math.min(nudge.contextUsage, 1) * 100)
  const frame = renderTemplate(
    emergency ? prompts.nudge.emergency : prompts.nudge.normal,
    { pct, philosophy: COMPRESS_PHILOSOPHY },
  )
  const parts: string[] = [frame]

  // Context breakdown (kernel style, from NudgeDecision.contextBreakdown).
  if (nudge.contextBreakdown) {
    const bd = nudge.contextBreakdown
    const breakdown = renderTemplate(prompts.nudge.breakdown, {
      system: Math.round(bd.system / 1000),
      tool: Math.round(bd.tool / 1000),
      summaries: Math.round(bd.summaries / 1000),
      code: Math.round(bd.code / 1000),
      text: Math.round(bd.text / 1000),
    })
    if (breakdown !== '') parts.push('', breakdown)
    if (bd.growth > 0) {
      const growth = renderTemplate(prompts.nudge.growth, { growth: Math.round(bd.growth / 1000) })
      if (growth !== '') parts.push(growth)
    }
  }

  // HOW_TO_COMPRESS_RULES as guidance (kernel puts it in every nudge).
  if (prompts.nudge.guidance !== '') parts.push('', prompts.nudge.guidance)

  // Tier line (distillation / condensation suggestion) + tier-specific rules.
  if ((nudge.tier === 2 || nudge.tier === 3) && (nudge.tierTargetBlocks?.length ?? 0) > 0) {
    const targets = nudge.tierTargetBlocks!
    const summarySeqs = targets
      .map((block) => summarySeqOfKernelBlock(session, block.blockId))
      .filter((seq): seq is number => seq != null)
      .sort((a, b) => a - b)
    const pending = nudge.tier === 2 ? nudge.breakdown?.pendingT2 : nudge.breakdown?.pendingT3
    const tokens = typeof pending === 'number' ? pending : 0
    const tierLine = renderTemplate(prompts.nudge.tier, {
      tier: nudge.tier,
      count: targets.length,
      prevTier: nudge.tier - 1,
      tokens,
      seqs: summarySeqs.join(', '),
      firstSeq: summarySeqs[0] ?? 'n/a',
      lastSeq: summarySeqs[summarySeqs.length - 1] ?? 'n/a',
    })
    if (tierLine !== '') parts.push(tierLine)
    // Tier-specific rules from kernel (TIER2_DISTILL_RULES / TIER3_CONDENSE_RULES).
    const tierRules = nudge.tier === 2 ? TIER2_DISTILL_RULES : TIER3_CONDENSE_RULES
    parts.push('', tierRules)
  } else {
    // Range table for non-tier nudges (DSH-specific: seq-based, not ref-ID-based).
    parts.push(rangeTable(session, kernelView, prompts, mediaPriceOf))
  }

  // Batch-compress tip (from kernel's nudge-text.ts style). The array-form
  // note rides with it on this path too — a host that overrides only the tip
  // must not lose the tool-contract line (same hole B6 closed for guidance).
  if (prompts.nudge.tip !== '') parts.push('', CONTENT_FORM_NOTE, '', prompts.nudge.tip)

  // B6：模板路径同样摘掉哲学/规则段——否则宿主只要覆盖任一 nudge 槽位（如只改 tip），
  // 整份 6 KB 指引就会重新贴回来（独立复核 2026-09-08 发现的软缺口）。
  return stripNudgeGuidance(parts.join('\n'))
}
