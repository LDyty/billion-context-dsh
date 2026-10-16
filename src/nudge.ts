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
  addRangeMass,
  buildCompressibleSeqRanges,
  compositionOf,
  EMPTY_RANGE_MASS,
  findOpenTurn,
  sweepFromBaseRange,
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
import { rememberBreakdown, rememberPressure, rememberRangeTable } from './inspect.ts'
import { lastAgeRegionSkipsOf, noteAgeRegions, noteOfferableSpans } from './age-region-skips.ts'
import type { AcpInspectSweep } from './inspect-types.ts'
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
  /** Cache-miss ÷ cache-hit price ratio (see AcpConfig.cacheMissPriceRatio). */
  readonly cacheMissPriceRatio?: number
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

/** Age regions the offerable list is cut into — the six 年龄区域. */
export const RANGE_TABLE_AGE_REGIONS = 6

/**
 * Rows printed PER age region (owner ruling, 2026-10-16): that region's three
 * largest intervals, oldest-first. One row per age region gave the model a
 * single choice per age, and the only way to see anything finer was to leave
 * the table; three rows make the table the place the choice is made, without
 * changing what the age regions are or how a fold start is attributed to one.
 */
export const RANGE_TABLE_ROWS_PER_AGE_REGION = 3

/** Rows the nudge range table prints, at most. */
export const RANGE_TABLE_LIMIT = RANGE_TABLE_AGE_REGIONS * RANGE_TABLE_ROWS_PER_AGE_REGION

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
 * The row suffix naming how many times THIS AGE REGION was passed over: the model has
 * chosen a fold start outside it `count` times (src/age-region-skips.ts). Printed on
 * every row, 0 included — a stable field needs no legend, and 0 is information
 * ("every choice so far landed in this age region").
 */
function skippedLabel(count: number): string {
  return ` · skipped ${String(count)}×`
}

/** Compact token count for a cost row: one decimal above 10K, whole numbers below. */
function compactTokens(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(1)}K` : String(Math.round(tokens))
}

/** The window side of the context line: whole thousands below a million, two decimals above. */
function windowTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  return tokens >= 1_000 ? `${String(Math.round(tokens / 1000))}K` : String(tokens)
}

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
export function partitionOfferableIntoAgeRegions<T extends { start: number; end: number; tokens: number }>(
  all: readonly T[],
  ageRegions: number = RANGE_TABLE_AGE_REGIONS,
): T[][] {
  const ordered = [...all].sort((a, b) => a.start - b.start)
  if (ordered.length === 0) return []
  const count = Math.max(1, Math.min(ageRegions, ordered.length))
  const total = ordered.reduce((sum, range) => sum + Math.max(0, range.tokens), 0)
  const target = total / count
  const groups: T[][] = []
  let bucket: T[] = []
  let running = 0
  const close = (): void => {
    if (bucket.length === 0) return
    groups.push(bucket)
    bucket = []
    running = 0
  }
  for (const [index, range] of ordered.entries()) {
    bucket.push(range)
    running += Math.max(0, range.tokens)
    if (groups.length >= count - 1) continue
    // Close when the age region is full, or when the spans left are exactly the age regions
    // left — otherwise one heavy span swallows the whole tail into the last age region
    // and the table collapses to fewer rows than asked for (measured on a
    // fixture with one 40K span ahead of five slivers: 6 age regions → 4 rows).
    const spansLeft = ordered.length - index - 1
    const ageRegionsLeft = count - groups.length
    if (running >= target || spansLeft <= ageRegionsLeft - 1) close()
  }
  close()
  return groups
}

/**
 * One printed row: the range it offers, the age region it belongs to, and its
 * size rank inside that region.
 */
export interface RangeTableRow<T> {
  readonly range: T
  /** 1-based age region; every row of one region carries the same number. */
  readonly ageRegion: number
  /** 1-based rank by size inside the age region (1 = that region's largest). */
  readonly rank: number
}

/**
 * The pressure pair the range table's context line prints — the same measurement
 * the nudge decision uses (see `rememberPressure` in buildNudge):
 * `tokens` is what the next request carries, `limit` the sustainable input budget
 * it is measured against. Absent in paths that have no window (panel rebuilds and
 * tests): the line is then simply not printed.
 */
export interface RangeTableContext {
  /** Provider-anchored context tokens (system + tools + surface). */
  readonly tokens: number
  /** Sustainable input budget: window minus the route's output reservation. */
  readonly limit: number
  /** Cache-miss ÷ cache-hit price ratio, printed as a fact (SETTING_DEFAULTS.cacheMissPriceRatio). */
  readonly missHitRatio: number
}

/**
 * The rows the table prints: the LARGEST {@link RANGE_TABLE_ROWS_PER_AGE_REGION}
 * intervals of every age region. Within a region the rows are printed in surface
 * order (oldest first), so the whole table stays the timeline it is; the rank is
 * still decided by size, because the largest interval of a region is the one the
 * region's sweep is priced from.
 *
 * @param groups - the age regions, oldest first (see {@link partitionOfferableIntoAgeRegions}).
 * @param perRegion - rows per age region (defaults to {@link RANGE_TABLE_ROWS_PER_AGE_REGION}).
 * @returns one row per printed interval, oldest first.
 */
export function rangeTableRowsOfGroups<T extends { start: number; end: number; tokens: number }>(
  groups: readonly (readonly T[])[],
  perRegion: number = RANGE_TABLE_ROWS_PER_AGE_REGION,
): RangeTableRow<T>[] {
  const rows: RangeTableRow<T>[] = []
  const take = Math.max(1, perRegion)
  for (const [index, group] of groups.entries()) {
    const ranked = [...group]
      .sort((left, right) => right.tokens - left.tokens || left.start - right.start)
      .slice(0, take)
    const rankOf = new Map(ranked.map((range, position) => [range, position + 1]))
    for (const range of ranked.sort((left, right) => left.start - right.start)) {
      rows.push({ range, ageRegion: index + 1, rank: rankOf.get(range) ?? 1 })
    }
  }
  return rows
}

/**
 * The same rows, straight from the offerable list.
 *
 * @param all - every offerable range, in any order.
 * @param ageRegions - how many age regions to cut (defaults to the six).
 * @param perRegion - rows per age region.
 * @returns one row per printed interval, oldest first.
 */
export function selectRangeTableRows<T extends { start: number; end: number; tokens: number }>(
  all: readonly T[],
  ageRegions: number = RANGE_TABLE_AGE_REGIONS,
  perRegion: number = RANGE_TABLE_ROWS_PER_AGE_REGION,
): RangeTableRow<T>[] {
  return rangeTableRowsOfGroups(partitionOfferableIntoAgeRegions(all, ageRegions), perRegion)
}

/** Just the offered ranges, in the order the table prints them (tests, scratch tools). */
export function selectRangeTableRanges<T extends { start: number; end: number; tokens: number }>(
  all: readonly T[],
  ageRegions: number = RANGE_TABLE_AGE_REGIONS,
  perRegion: number = RANGE_TABLE_ROWS_PER_AGE_REGION,
): T[] {
  return selectRangeTableRows(all, ageRegions, perRegion).map((row) => row.range)
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
  context?: RangeTableContext,
): string {
  const ranges = buildCompressibleSeqRanges(
    session,
    kernelView,
    mediaPriceOf === undefined ? {} : { mediaPriceOf },
  )
  // The age regions are cut ONCE: their spans are what a later fold start is
  // attributed against (src/age-region-skips.ts), and the printed rows are the
  // largest intervals inside them. Panel rebuilds record the same regions as a
  // nudge does — a build is never a choice, so there is nothing to skip counting.
  const ageRegionGroups = partitionOfferableIntoAgeRegions(ranges)
  const rangeRows = rangeTableRowsOfGroups(ageRegionGroups)
  // 零范围:整块省略(保留现状的提前返回与 nudge 尾部 '\n')。
  if (rangeRows.length === 0) return ''
  // Each row carries its own fold cost: reclaiming a span makes every node at
  // and after its start re-send uncached once, so the model needs that number to
  // weigh a cheap-but-tiny span against an expensive-but-satisfying one.
  const costs = foldCostsOfRanges(session, ranges, mediaPriceOf)
  // Publish this build's age region regions, then read the per-age region pass-over counts
  // (src/age-region-skips.ts): an age region's number moves only when a fold CHOOSES a start
  // outside it, never because the table was rebuilt or its span drifted.
  noteAgeRegions(String(session.id), ageRegionGroups.map((group) => ({
    start: group[0]!.start,
    end: group[group.length - 1]!.end,
  })))
  // …and every offerable span of this same build, which is what lets a later
  // choice tell a sweep (one contiguous run) from a batch of scattered segments.
  noteOfferableSpans(String(session.id), ranges.map((range) => ({ start: range.start, end: range.end })))
  const ageRegionSkips = lastAgeRegionSkipsOf(String(session.id))
  // Costs cover every offerable range, so a row's sweep can reach spans that did
  // not fit the printed rows.
  const baseRows = rangeRows.map(({ range, ageRegion, rank }) => {
    const at = ranges.indexOf(range)
    const cost = costs[at] ?? { invalidatedTokens: 0, breakEvenRequests: Number.POSITIVE_INFINITY }
    return { range, at, ageRegion, rank, cost, expensive: cost.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN }
  })
  // EVERY row carries its own sweep, and every sweep is printed in full
  // (2026-10-16): the six rows are six STARTING POINTS and each one runs forward
  // uncapped to the newest offerable span, so the model is choosing the SCOPE of
  // its fold. Two rows cannot share a proposal — row N's sweep is the suffix of
  // row N+1's from a different start — which is exactly the choice the repeated
  // lines express.
  // Keyed by the row's position in the offerable list (two nested rows can share
  // a start seq, and a start-keyed map printed one proposal under both rows).
  const proposalOfAt = new Map<number, string>()
  // The same proposals, structured, for the inspector panel (src/inspect.ts).
  const sweeps: AcpInspectSweep[] = []
  for (const row of baseRows) {
    if (row.at < 0) continue
    if (proposalOfAt.size >= RANGE_TABLE_LIMIT) break
    const proposal = sweepFromBaseRange(ranges, costs, row.at)
    if (proposal === undefined) continue
    const messages = proposal.entries.reduce((sum, entry) => sum + entry.count, 0)
    // The sweep's OWN composition, summed from raw mass (percentages cannot be
    // added) — the entries themselves are NOT printed: a sweep can hold seventy
    // spans and the labels are long, so the line carries the totals and points
    // at acp_status for the list. The model has to call acp_status anyway before
    // compressing (the snapshot line says the table's seqs go stale).
    const composition = compositionOf(
      proposal.entries.reduce((sum, entry) => addRangeMass(sum, entry.mass), EMPTY_RANGE_MASS),
    )
    sweeps.push({
      rowStart: row.range.start,
      entries: proposal.entries.length,
      messages,
      reclaims: proposal.reclaimedTokens,
      invalidates: proposal.invalidatedTokens,
      breakEven: proposal.breakEvenRequests,
      rowMix: composition.rowMix,
      rowCounts: {
        tool: proposal.entries.reduce((sum, entry) => sum + entry.mass.toolRows, 0),
        assistant: proposal.entries.reduce((sum, entry) => sum + entry.mass.assistantRows, 0),
        user: proposal.entries.reduce((sum, entry) => sum + entry.mass.userRows, 0),
        other: proposal.entries.reduce((sum, entry) => sum + entry.mass.otherRows, 0),
      },
      toolPct: composition.toolPct,
      reasoningPct: composition.reasoningPct,
      textPct: composition.textPct,
      spans: proposal.entries.map((entry) => ({ start: entry.start, end: entry.end })),
    })
    proposalOfAt.set(row.at, renderTemplate(prompts.rangeTable.batch, {
      count: proposal.entries.length,
      coverage: `${messages} messages / ${proposal.entries.length} summaries to write`,
      reclaimed: compactTokens(proposal.reclaimedTokens),
      invalidated: `${compactTokens(proposal.invalidatedTokens)} tok`,
      breakEven: Number.isFinite(proposal.breakEvenRequests) ? proposal.breakEvenRequests.toFixed(1) : '∞',
      rowMix: composition.rowMix,
      toolPct: composition.toolPct,
      reasoningPct: composition.reasoningPct,
      textPct: composition.textPct,
    }))
  }
  let previousAgeRegion = 0
  const lines = baseRows.flatMap(({ range, at, cost, expensive, ageRegion }) => {
    const rows: string[] = []
    // The age-region layer, printed once per region: its name and number, and the
    // pass-over count that belongs to the REGION (not to any one interval), with
    // the region's intervals nested one level under it.
    if (ageRegion !== previousAgeRegion) {
      previousAgeRegion = ageRegion
      rows.push(renderTemplate(prompts.rangeTable.region, {
        region: ageRegion,
        age: ageRegion === 1 ? ' (oldest)' : ageRegion === RANGE_TABLE_AGE_REGIONS ? ' (newest)' : '',
        skipped: ageRegionSkips[ageRegion - 1] ?? 0,
      }))
    }
    rows.push(
      renderTemplate(prompts.rangeTable.line, {
        start: range.start,
        end: range.end,
        count: range.count,
        tokens: range.tokens,
        toolPct: range.toolPct,
        reasoningPct: range.reasoningPct,
        textPct: range.textPct,
        toolRowPct: range.toolRowPct,
        rowMix: range.rowMix,
        media: mediaSuffixOf(range),
        // Kept in the placeholder set for custom templates; the default prints the
        // count on the region layer instead (it is the region's number, not a row's).
        skipped: skippedLabel(ageRegionSkips[ageRegion - 1] ?? 0),
      }),
      renderTemplate(prompts.rangeTable.cost, {
        reclaimed: compactTokens(range.tokens),
        invalidated: `${compactTokens(cost.invalidatedTokens)} tok`,
        breakEven: Number.isFinite(cost.breakEvenRequests) ? cost.breakEvenRequests.toFixed(1) : '∞',
        flag: expensive ? RANGE_TABLE_COST_WARN_FLAG : '',
      }),
    )
    const batch = proposalOfAt.get(at)
    if (batch !== undefined) rows.push(batch)
    return rows
  })
  // Hand the structured build to the inspector panel. Same numbers, remembered
  // once per build — the panel never recomputes (see src/inspect.ts).
  rememberRangeTable(
    String(session.id),
    baseRows.map((row) => ({
      ageRegion: row.ageRegion,
      rankInAgeRegion: row.rank,
      start: row.range.start,
      end: row.range.end,
      messages: row.range.count,
      tokens: row.range.tokens,
      toolPct: row.range.toolPct,
      reasoningPct: row.range.reasoningPct,
      textPct: row.range.textPct,
      toolRowPct: row.range.toolRowPct,
      rowMix: row.range.rowMix,
      rowCounts: {
        tool: row.range.mass.toolRows,
        assistant: row.range.mass.assistantRows,
        user: row.range.mass.userRows,
        other: row.range.mass.otherRows,
      },
      invalidated: row.cost.invalidatedTokens,
      breakEven: row.cost.breakEvenRequests,
      expensive: row.expensive,
      skipped: ageRegionSkips[row.ageRegion - 1] ?? 0,
    })),
    sweeps,
  )
  return [
    // 前导空串元素产生 nudge 中范围表前的唯一空行(§4:parts 层不再加分隔)。
    '',
    renderTemplate(prompts.rangeTable.header, { surface: surfaceSummary(session) }),
    // The pressure pair, right under the surface line: how full the context is
    // (the same measurement the nudge decision just made) and the prefix size the
    // next request carries — the number every fold's rewrite is priced against.
    ...(context === undefined || context.limit <= 0
      ? []
      : [renderTemplate(prompts.rangeTable.context, {
        used: compactTokens(context.tokens),
        window: windowTokens(context.limit),
        pct: Math.round((context.tokens / context.limit) * 100),
        ratio: context.missHitRatio,
      })]),
    renderTemplate(prompts.rangeTable.title, { count: rangeRows.length }),
    ...lines,
    // Name what the cap hid: with a fragmented surface the table used to show a
    // handful while dozens more sat unlisted, and the model had no way to know
    // (2026-10-14: 128 offerable ranges, six rows printed).
    ...(ranges.length > rangeRows.length
      ? [`  (${ranges.length - rangeRows.length} more range(s) not shown — acp_status with scope:"uncompressed", view:"ranges" lists them)`]
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
  // The panel's pressure gauge is the SAME measurement the nudge decides on, so
  // the two can never disagree; it is remembered before the should-inject gate
  // because every step knows it (unlike the breakdown below).
  // `env.modelContextLimit` is already the SUSTAINABLE input budget here (the
  // pre-step passes `windowFor(agent).limit`, raw window minus the output cap),
  // which is exactly what the panel should divide by.
  rememberPressure(String(session.id), tokenCount, env.modelContextLimit, 'engine')
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
  rememberBreakdown(String(session.id), {
    tool: nudge.contextBreakdown.tool,
    text: nudge.contextBreakdown.text,
    code: nudge.contextBreakdown.code,
    summaries: nudge.contextBreakdown.summaries,
    system: nudge.contextBreakdown.system,
  })
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
    // The pressure pair the same step just measured (see rememberPressure above):
    // the model gets the number the decision used, not a second opinion.
    {
      tokens: tokenCount,
      limit: env.modelContextLimit,
      // 50 mirrors SETTING_DEFAULTS.cacheMissPriceRatio — a hand-built env (tests)
      // may omit it, production always resolves the setting.
      missHitRatio: env.cacheMissPriceRatio ?? 50,
    },
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
  context?: RangeTableContext,
): string {
  // A host override of any nudge slot → template rendering (config.prompts
  // keeps its v0.1.9 contract: custom copy wins). Only the pristine default
  // reference reaches the kernel path.
  if (prompts.nudge !== DEFAULT_RESOLVED.nudge) {
    return renderNudgeFromTemplates(nudge, emergency, session, kernelView, prompts, mediaPriceOf, context)
  }
  const rendered = renderNudgeText(nudge)
  return adaptKernelNudgeToSeq(rendered.text, nudge, session, kernelView, prompts, mediaPriceOf, context)
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
  context?: RangeTableContext,
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
  const seqTable = rangeTable(session, kernelView, prompts, mediaPriceOf, context)
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
  context?: RangeTableContext,
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
    parts.push(rangeTable(session, kernelView, prompts, mediaPriceOf, context))
  }

  // Batch-compress tip (from kernel's nudge-text.ts style). The array-form
  // note rides with it on this path too — a host that overrides only the tip
  // must not lose the tool-contract line (same hole B6 closed for guidance).
  if (prompts.nudge.tip !== '') parts.push('', CONTENT_FORM_NOTE, '', prompts.nudge.tip)

  // B6：模板路径同样摘掉哲学/规则段——否则宿主只要覆盖任一 nudge 槽位（如只改 tip），
  // 整份 6 KB 指引就会重新贴回来（独立复核 2026-09-08 发现的软缺口）。
  return stripNudgeGuidance(parts.join('\n'))
}
