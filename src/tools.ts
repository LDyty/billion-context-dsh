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

import { defineTool, ToolArgsError, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildStatusReport, defaultCountTokens, searchBlocks, type CompressionCore, type MessageRole, type SearchDoc } from 'acp-kernel'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AcpStateStore } from './state.ts'
import { kernelConfigFor, type KernelConfigInput } from './config.ts'
import { resolveTokenCount } from './nudge.ts'
import { lastAgeRegionSkipsOf, noteAgeRegionChoice } from './age-region-skips.ts'
import { inspectCacheOf } from './inspect.ts'
import { routeFor, type AcpWindow } from './window.ts'
import {
  AlreadyCompressedRangeError,
  blockIdOfKernelRef,
  blockRefForSummarySeq,
  blockRegistry,
  compactionIdsOfKernelBlocks,
  expandShadowedSeqs,
  guardedSurfaceSeqsOf,
  isExactSurfaceSpan,
  rebuildBlockLedger,
  resolveSurfaceRange,
  runCompactionTransaction,
  liveCheckpointCarriersInSpan,
  splitSpanAtSeqs,
  shadowedSeqsOf,
  stripOrphanedSurfaceToolMessages,
  summarySeqOfKernelBlock,
  openToolCallIds,
  sliceDecompressPage,
  surfaceSummary,
  sharedSummaryGroupOf,
  resolvedSummariesOf,
  buildCompressibleSeqRanges,
  foldCostsOfRanges,
  sweepFromBaseRange,
  DEFAULT_DECOMPRESS_PAGE,
  DEFAULT_DECOMPRESS_PAGE_CHARS,
  type KernelRangeView,
  type MediaPriceOf,
  type ResolvedSurfaceRange,
} from './region.ts'
import { allLogMessages, attachmentsOfEvent, buildToolCallIndex, eventsToCoreMessages, extractEventText, isAgentInstructionsRow, isCheckpointNode, isRealUserTurn, isSkillCatalogRow, reasoningForToolCall, surfaceEventsOf, toolCallsOf } from './messages.ts'
import { hostPriceEvent, shadowedTokensViaMeter } from './host-tokens.ts'
import { eventAtOf, sessionEventsOf } from './session-events.ts'
import { DEFAULT_RESOLVED, type ResolvedPrompts } from './prompts.ts'
import type { SettingsCommandSurface } from './settings.ts'
import type { PresetName } from './presets.ts'

export interface ToolEnvironment extends KernelConfigInput {
  readonly kernel: CompressionCore
  readonly store: AcpStateStore
  /** Display-only: the named preset that produced the nudge thresholds above, if any (`/acp-prune status` names it). Never read by the kernel path. */
  readonly preset?: PresetName
  /** Resolve the effective context window for an agent (optional: status falls back to modelContextLimit). */
  readonly windowFor?: (agent: Agent) => Promise<AcpWindow>
  /** Resolved prompt templates (optional: falls back to DEFAULT_RESOLVED). */
  readonly prompts?: ResolvedPrompts
  /**
   * Call ids of compress invocations that created a durable block. The engine
   * listens for the matching `tool/result` and hides the call/result pair from
   * the surface, preventing the compaction summary from sitting between them
   * (strict providers reject that sequence with HTTP 400).
   */
  readonly compressCallIdsToHide?: Set<string>
  /**
   * How a plain (message-ref) range that crosses a LIVE block's checkpoint
   * carrier is handled. `split` (default) folds the runs around the carrier(s)
   * and reports what stayed visible; `reject` restores the pre-2026-10-13 hard
   * refusal, which handed the call back with the block-id recipe instead.
   * Block-ref boundaries (`bN..bM`) never reach this policy — distilling is
   * what they are for.
   */
  readonly carrierSpans?: 'split' | 'reject'
  /**
   * Read/write access to the runtime settings layer for `/acp-prune config`.
   * Absent surfaces (never expected — the engine always builds one) would
   * degrade the command to advice text.
   */
  readonly settingsCommand?: SettingsCommandSurface
  /** Cache-miss ÷ cache-hit price ratio (AcpConfig.cacheMissPriceRatio): a billing fact the panel shows. */
  readonly cacheMissPriceRatio?: number
}

interface TextOutput {
  text: string
}

function textOutput(): {
  schema: { type: 'object'; properties: { text: { type: 'string' } }; additionalProperties: boolean }
  render: (args: unknown, value: TextOutput) => import('@deepseek-ai/dsh-llm').ContentBlock[]
} {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) {
    throw new Error('billion-context-dsh: tool requires an agent execution context')
  }
  return exec.agent
}

/**
 * Resolve the effective context window for a tool or command run: probe the
 * agent's real window via `windowFor` when provided, otherwise fall back to
 * the environment's `modelContextLimit`. Shared by the compress and
 * acp_status tool handlers and the `/acp-prune` command so the resolution logic
 * lives in exactly one place (issue #63 — the tools used the 128K fallback
 * for pressure decisions even when auto-detection had found a larger window).
 */
export async function resolveEffectiveWindow(env: ToolEnvironment, agent: Agent): Promise<AcpWindow> {
  return env.windowFor === undefined
    ? { limit: env.modelContextLimit, source: 'explicit' as const }
    : await env.windowFor(agent)
}

export const compressParameters = {
  // Tolerated wrapped-arguments form: some models emit
  // `{ "arguments": "{\"content\": [...]}" }` (double-nested) or
  // `{ "arguments": { "content": [...] } }` instead of the unwrapped
  // `{ "content": [...] }`. The old DSH validator surfaced this as
  // `invalid arguments: "arguments" must be an object` and the model retried
  // forever. `arguments` is accepted as an optional JSON node so the wrapped
  // shape passes schema validation; `handleCompress` unwraps it and falls back
  // to a clear runtime error when neither form carries content. `content` is
  // intentionally NOT `required: true` — a required property would reject the
  // wrapped shape before `handleCompress` can see it. The tool description
  // still tells the model content is mandatory.
  //
  // The items fields need a precise MISSING-FIELD message (a call that omits
  // `summary` used to fail late inside the kernel with "Summary is empty", which
  // sent live sessions into a retry loop; the fix is
  // `missing required property "content[0].summary"`). That message now comes
  // from `validateContentItems` — which runs on BOTH forms after the envelope
  // peel — and NOT from `required: true` on the declaration: `content` has to
  // stay a `oneOf` of array-or-JSON-text (below), the enforced JSON Schema
  // subset has no `type: [array, string]`, and a `required` inside the array
  // branch therefore answers a broken array with the generic
  // `must match exactly one oneOf branch (matched 0)` — losing the field name
  // exactly when the model needs it.
  arguments: { type: 'json', description: 'Tolerated wrapped-arguments form (model-generated); unwrapped in handleCompress. Prefer passing content directly.' },
  topic: { type: 'string' as const, description: 'Fallback topic for entries without their own.' },
  content: {
    // The canonical array, plus the SAME array serialized as JSON text. The host
    // validates arguments against this declaration BEFORE the handler runs, and
    // deepseek-flash emitted the stringified form live (2026-10-16:
    // `{"content": "[{\"startSeq\": 38721, \"endSeq\": 38763, \"summary\": …}]"}`)
    // — the gate answered `invalid arguments: "content" must be an array` and the
    // fold was lost. `handleCompress` parses the string back (unwrapCompressArgs),
    // so declaring it here makes the tolerance reachable; the array form stays
    // first and the description keeps telling the model to use it.
    oneOf: [
      {
        type: 'array' as const,
        description: 'One or more ranges to compress, each with startSeq/endSeq boundaries (surface seqs) and a dense summary. Required — pass it directly, not wrapped in an arguments key.',
        items: {
          type: 'object' as const,
          properties: {
        startSeq: {
          oneOf: [
            { type: 'integer' as const, description: 'First surface seq of the range.' },
            { type: 'string' as const, description: 'Seq as text; a trailing #callId fragment is ignored. A drilldown mN ref ("m00306") or a kernel block id ("b1", as acp_status lists) is also accepted — a block id resolves to that block\'s checkpoint seq, which makes the fold a tier 2/3 distillation.' },
          ],
        },
        endSeq: {
          oneOf: [
            { type: 'integer' as const, description: 'Inclusive last surface seq of the range.' },
            { type: 'string' as const, description: 'Seq as text; a trailing #callId fragment is ignored. Also accepts a drilldown mN ref or a kernel block id ("b3") — for a multi-block condense name the LAST block id (tier 3). Or the literal "sweep": fold the whole forward sweep that starts at startSeq in ONE call, every span sharing your summary (see the table\'s sweep lines).' },
          ],
        },
        summary: {
          type: 'string' as const,
          description: 'Complete technical summary replacing the range; keep paths, decisions, values verbatim. How short it may be is judged PER ENTRY by the SIZE of the span you are folding: a span over ~500 tokens owes at least 50 characters, and so does any block-ref distillation whatever its size, while a span under ~500 tokens may be a single honest sentence. A span with NO durable value (pure noise, duplicated tool output, retries, output already superseded by a later result) gets exactly that short honest summary — say what it was and that nothing was kept (e.g. "retry logs — nothing kept; decompress for the raw output") — rather than an invented one. Never pad a junk span into a fake summary, and never leave the entry out: the entry is what frees the tokens.',
        },
        topic: { type: 'string' as const, description: 'Short label (3-5 words) for this range.' },
        // B3 (2026-09-08 governance plan): the handler and region.ts have
        // accepted verifiedReadings since the plan landed, but the declared
        // parameter schema did not list it — `additionalProperties: false`
        // then rejected every live call that carried it
        // (`invalid arguments: "content[0].verifiedReadings" is not a declared
        // property`), so the structured-loss-stopping field was unreachable
        // from the model's tool interface. Declared here; additionalProperties
        // stays false so unknown fields are still rejected.
        verifiedReadings: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Optional: acceptance readings that are already green before this compression (e.g. "t0-fastpath 8/8", "closedloop 414/414"). Stored structurally on the compaction/summary event and recovered by verifiedReadingsOf, so later steps need not re-run the checks.',
        },
          },
          additionalProperties: false,
        },
      },
      {
        type: 'string' as const,
        description: 'Tolerated wrapped form: the SAME content array serialized as JSON text (what a model channel sometimes emits). It is parsed back before validation — prefer passing the array directly.',
      },
    ],
  },
} as const

/** Normalize a seq arg: number, "295", or "295#call_00_xxx" → 295. */
function parseSeq(value: number | string): number {
  const text = String(value).split('#')[0]!.trim()
  const seq = Number(text)
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`billion-context-dsh: invalid seq "${String(value)}" — use a surface seq like 295`)
  }
  return seq
}

/**
 * How small a folded span has to be before its summary may go UNDER the kernel
 * floor (owner rule, 2026-10-16). A few hundred tokens of junk have nothing to
 * be substantive about, and padding them into 50+ characters is filler the
 * model then has to read back.
 */
export const SHORT_SPAN_SUMMARY_TOKENS = 500

/**
 * A sweep stores ONE summary on its first block and a `part k/N` pointer on the
 * rest (de6d00a). That is a storage optimisation, not content: distilling a
 * SUB-range of such a group would hand the model 14 pointers and no text, and a
 * partial fold would consume the head while leaving tail pointers behind.
 * So any distillation edge that lands inside a shared group is widened to the
 * group's full extent (head..tail), and the result says so. Plain message
 * ranges are untouched — they never touch a live carrier in the first place.
 */
function snapSharedSummarySpan(
  session: Session,
  start: number,
  end: number,
): { range: ResolvedSurfaceRange; note: string } | undefined {
  const startRef = blockRefForSummarySeq(session, start)
  const endRef = blockRefForSummarySeq(session, end)
  if (startRef === null && endRef === null) return undefined
  const ledger = rebuildBlockLedger(sessionEventsOf(session))
  const registry = blockRegistry(session)
  const indexOfRef = (ref: string): number => {
    const blockId = registry.find((entry) => entry.kernelBlockId === ref)?.blockId
    return blockId === undefined ? -1 : ledger.findIndex((entry) => entry.blockId === blockId)
  }
  const groupOfRef = (ref: string): { headIndex: number; tailIndex: number } | undefined => {
    const at = indexOfRef(ref)
    if (at < 0) return undefined
    return sharedSummaryGroupOf(ledger, ledger[at]!.blockId)
  }
  const startGroup = startRef === null ? undefined : groupOfRef(startRef)
  const endGroup = endRef === null ? undefined : groupOfRef(endRef)
  if (startGroup === undefined && endGroup === undefined) return undefined
  const headIndex = Math.min(startGroup?.headIndex ?? Number.POSITIVE_INFINITY, endGroup?.headIndex ?? Number.POSITIVE_INFINITY)
  const tailIndex = Math.max(startGroup?.tailIndex ?? -1, endGroup?.tailIndex ?? -1)
  if (!Number.isFinite(headIndex) || tailIndex < 0) return undefined
  const head = ledger[headIndex]
  const tail = ledger[tailIndex]
  if (head?.summarySeq == null || tail?.summarySeq == null) return undefined
  if (head.summarySeq === start && tail.summarySeq === end) return undefined
  const range = resolveSurfaceRange(session, head.summarySeq, tail.summarySeq)
  const refOf = (blockId: string): string => registry.find((entry) => entry.blockId === blockId)?.kernelBlockId ?? blockId.slice(0, 8)
  return {
    range,
    note: `  distillation ${String(startRef ?? start)}..${String(endRef ?? end)} lies inside a shared-summary group — `
      + `widened to ${refOf(head.blockId)}..${refOf(tail.blockId)} so the full summary text is inside the distilled span`,
  }
}

/**
 * The host price of one folded span: every surface event between its edges,
 * inclusive. This is the size the summary floor is judged against.
 */
function foldedSpanTokens(session: Session, start: number, end: number): number {
  let total = 0
  for (let seq = start; seq <= end; seq += 1) {
    const event = eventAtOf(session, seq)
    if (event !== undefined) total += hostPriceEvent(event)
  }
  return total
}

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
export function summaryFloorRefusal(
  session: Session,
  range: { start: number; end: number; startSeq: number; endSeq: number; summary: string },
  floor: number,
): string | undefined {
  if (floor <= 0) return undefined
  // `blockRefForSummarySeq` returns `null` (not undefined) for a plain message.
  const distilled = blockRefForSummarySeq(session, range.start) !== null
    || blockRefForSummarySeq(session, range.end) !== null
  const tokens = foldedSpanTokens(session, range.start, range.end)
  const length = range.summary.trim().length
  const bound = distilled || tokens > SHORT_SPAN_SUMMARY_TOKENS
  if (!bound || length >= floor) return undefined
  return `  seqs ${String(range.startSeq)}..${String(range.endSeq)} skipped — Summary too short (${String(length)} chars, min ${String(floor)}). `
    + `${distilled ? 'A block-ref distillation' : `This span is ~${String(tokens)} tokens`} needs a real summary; `
    + `only spans under ~${String(SHORT_SPAN_SUMMARY_TOKENS)} tokens may fold with a shorter one.`
}

/**
 * ONE summary, MANY blocks (owner ruling, 2026-10-17): a sweep expands one entry
 * into N spans and a carrier split turns one entry into N runs, so the FULL text
 * lands on the FIRST surviving block and the rest carry a pointer a reader can
 * follow. MUST run AFTER the summary floor: the group is built from the entries
 * that will actually land, so (a) a refused head can never leave tail pointers
 * aimed at a block that does not exist, and (b) numbering restarts at the first
 * survivor (`part 2/M`), not at the model's original entry order.
 */
export function applySharedSummaryPointers<T extends { summary: string; sharedSummaryKey?: number }>(
  ranges: readonly T[],
): void {
  const groupsOfEntry = new Map<number, T[]>()
  for (const range of ranges) {
    const key = range.sharedSummaryKey ?? -1
    const list = groupsOfEntry.get(key)
    if (list === undefined) groupsOfEntry.set(key, [range])
    else list.push(range)
  }
  for (const group of groupsOfEntry.values()) {
    if (group.length < 2) continue
    for (const [index, range] of group.entries()) {
      if (index === 0) continue
      range.summary = `[shared summary — part ${String(index + 1)}/${String(group.length)} of this compress call; the full text is on its first block]`
    }
  }
}

/**
 * Match a drilldown mN ref: "m00306" / "m306" (kernel `refToIndex` semantics,
 * `m0*(\d{1,7})`), tolerating a trailing `#callId` fragment (symmetric with
 * `parseSeq`'s `#` handling). Returns the ref index, or null for non-mN input.
 *
 * The width AND the bound mirror the kernel's `REF_PATTERN` / `MAX_INDEX`
 * (0.0.101: `\d{1,7}` and `9999999`; through 0.0.63 both were 5 digits /
 * `99999`). They must be re-checked on every kernel bump (AGENTS.md §4b): a
 * session numbers refs upward and never reuses one, so once it outgrows the
 * old width the kernel keeps handing out `m100000`+ — and a host parser capped
 * at 5 digits rejects acp_status's OWN rows as "not a ref", in exactly the long
 * sessions a ref-width bump exists to rescue. `tests/tools.test.ts` round-trips
 * the kernel's `indexToRef` boundaries, so a future widening turns that test
 * red instead of degrading silently.
 */
const MN_RE = /^m0*(\d{1,7})(?:#.*)?$/i

/** Exported so the ref-width contract test can pin it without a 100K-message fixture. */
export function mnRefIndex(value: string): number | null {
  const match = MN_RE.exec(value.trim())
  if (match === null) return null
  const index = Number(match[1])
  return index >= 1 && index <= 9999999 ? index : null
}

/**
 * Resolve a compress boundary arg to a surface seq. Accepts:
 *  - a bare surface seq (number, "295", "295#call_00_x" — `parseSeq`);
 *  - a drilldown mN ref ("m00306" / "m306") — reverse-mapped via the CURRENT
 *    turn's `messageRefs.byRef` (CoreMessage.id = seq or "seq#callId" → split
 *    on "#"). Unknown mN (never assigned on the current surface) fails with
 *    guidance; a valid mN whose span was already compressed falls through to
 *    the existing recover-stale / already-compressed semantics (rule 7);
 *  - a kernel block ref ("b1") — the id `acp_status` prints per active block and
 *    `decompress` already accepts — resolved to that block's checkpoint seq
 *    (`summarySeqOfKernelBlock`). Naming the checkpoint node is what makes the
 *    fold a tier 2/3 distillation: the resolver then sees the edge ON the
 *    carrier, `blockRefForSummarySeq` hands the kernel the block ref back, and
 *    `liveCheckpointCarriersInSpan`'s guard stands down (that guard exists to
 *    refuse a PLAIN seq range swallowing a live carrier). Before this, the
 *    reject note's own advice — "distill it with the block ids" — led to
 *    `invalid seq "b1"`, i.e. the tool told the model to make a call no parser
 *    accepted. A block id that is not an ACTIVE block (superseded, or never
 *    existed) fails with guidance.
 * `byRef` MUST come from `turn.state.messageRefs` (after `processTurn`), not
 * the persisted store state: acp_status's turn is never persisted, so mN refs
 * shown in a drilldown (including refs for messages that arrived since the
 * last nudge/compress) only exist on the current turn's ref map — a lookup
 * against the stored state would report a false "unknown mN" and dead-loop
 * the model between acp_status and compress.
 */
function parseBoundary(value: number | string, byRef: Record<string, string>, session: Session): number {
  const text = String(value).trim()
  if (/^b\d+$/.test(text)) {
    const seq = summarySeqOfKernelBlock(session, text)
    if (seq === null) {
      throw new Error(
        `billion-context-dsh: block "${text}" is not an active block — run acp_status for the live block ids `
        + '(a block-id boundary distills that block, tier 2/3)',
      )
    }
    return seq
  }
  const index = mnRefIndex(text)
  if (index === null) return parseSeq(value)
  // Normalize to the kernel's padded key ("m00306") — byRef holds exact keys.
  const ref = `m${String(index).padStart(5, '0')}`
  const raw = byRef[ref]
  if (raw === undefined) {
    throw new Error(
      `billion-context-dsh: mN "${text}" not found on the current surface — re-run acp_status for fresh refs (the surface may have moved)`,
    )
  }
  const seq = Number(String(raw).split('#')[0]!)
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(
      `billion-context-dsh: mN "${text}" maps to a non-seq id "${raw}" — re-run acp_status`,
    )
  }
  return seq
}

interface CompressArgs {
  /** Tolerated wrapped-arguments form (model-generated double-nesting). */
  arguments?: string | { content?: CompressArgs['content'] }
  topic?: string
  /**
   * The canonical array, or the same array SERIALIZED as JSON text — a shape
   * DeepSeek-flash emitted live on 2026-10-16 (`{"content": "[{\"startSeq\":…}]"}`),
   * which the host's schema gate rejects before the handler runs unless the
   * declaration admits it. `unwrapCompressArgs` parses it back.
   */
  content?: CompressContent | string
}

type CompressContent = Array<{
  startSeq: number | string
  endSeq: number | string
  summary: string
  topic?: string
  verifiedReadings?: string[]
  /**
   * Host-internal tag (never sent to the kernel): which of the model's content
   * entries produced this item. A sweep expands ONE entry into many spans and a
   * carrier split turns ONE entry into several runs — both must stay recognisable
   * as ONE group, so their shared summary can be stored once (see
   * applySharedSummaryPointers).
   */
  sharedSummaryKey?: number
}>

/**
 * Unwrap the tolerated forms back to the canonical shape:
 * `{ arguments: "{\"content\": [...]}" }`, `{ arguments: { content: [...] } }`,
 * or a `content` that is itself the array serialized as JSON text
 * (`{ content: "[{\"startSeq\": …}]" }`) → `{ content: [...] }`. The direct
 * `{ content: [...] }` form passes through untouched. Returns null when no form
 * carries a usable content (caller raises the guidance message).
 */
function unwrapCompressArgs(args: CompressArgs): CompressContent | null {
  if (args.content !== undefined) return parseWrappedContent(args.content) ?? (Array.isArray(args.content) ? args.content : null)
  if (args.arguments === undefined) return null
  let inner: unknown = args.arguments
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner)
    } catch {
      return null
    }
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return null
  const content = (inner as { content?: unknown }).content
  if (content === undefined) return null
  return parseWrappedContent(content as CompressArgs['content']) ?? (Array.isArray(content) ? content as CompressContent : null)
}

/**
 * A `content` that arrived as JSON TEXT decodes to the array it represents;
 * anything else (a real array, a malformed string, a foreign type) is returned
 * as-is so the normal validation reports it with the caller's own wording.
 */
function parseWrappedContent(content: CompressArgs['content']): CompressContent | undefined {
  if (typeof content !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    return Array.isArray(parsed) ? parsed as CompressContent : undefined
  } catch {
    return undefined
  }
}

/**
 * Peel the tolerated wrapped-arguments envelope `{ arguments: {…} }` that some
 * model channels emit for ANY tool — the same double-nesting that birthed
 * `unwrapCompressArgs` (live-verified on acp_status: a drilldown call arrived
 * as `{"arguments":{"scope":"compressed"}}` and was silently dropped, since
 * only compress unwrapped). The envelope may be an object or a JSON string;
 * inner keys win over outer duplicates. Args without an envelope pass through
 * untouched.
 */
function unwrapEnvelope<T extends object>(args: T): T {
  const envelope = (args as { arguments?: unknown }).arguments
  if (envelope === undefined) return args
  let inner: unknown = envelope
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner)
    } catch {
      return args
    }
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return args
  return { ...args, ...(inner as object) } as T
}

/**
 * Enforce the items-level `required` contract on the EFFECTIVE content, after
 * the wrapped-arguments envelope has been peeled. The DSH schema gate only
 * sees the model's top-level arguments object — when the call arrives wrapped
 * as `{ arguments: { content: [...] } }`, the top-level `content` property is
 * absent there (it lives inside the envelope), so the gate never checks the
 * items and a missing `summary`/`startSeq`/`endSeq` sailed through to the
 * kernel, which fails late with a field-less "Summary is empty" and sent live
 * sessions into a retry loop (the same failure mode the schema gate fix for
 * the direct form closed). Running the SAME check on the unwrapped content
 * closes that window for both forms, and produces the identical
 * `invalid arguments: missing required property "content[0].summary"` surface
 * by reusing the host's `ToolArgsError` instead of a hand-rolled format.
 * An empty/whitespace-only summary counts as missing (the kernel would
 * reject it anyway — fail early with the field name instead).
 */
/** The sweep shorthand's sentinel: `endSeq: "sweep"` (see expandSweepEntries). */
const SWEEP_END = 'sweep'

/** True for the sentinel `endSeq` value, in any casing/whitespace. */
function isSweepEnd(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === SWEEP_END
}

/** A startSeq the sweep shorthand accepts: an integer, or the digits as text. */
function isPlainSeq(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value)
  return typeof value === 'string' && /^\d+$/.test(value.trim())
}

/**
 * Expand the sweep shorthand (owner ruling, 2026-10-17) BEFORE the per-range
 * loop: one entry with `endSeq: "sweep"` and ONE shared summary becomes one entry
 * per span of the sweep that starts at its `startSeq` — the same forward run the
 * table prints (base row + every later non-overlapping offerable span). Each
 * expanded entry then goes through the ordinary pipeline, so stale spans,
 * barriers and duplicates are handled exactly as if the model had listed them.
 *
 * The offerable list is rebuilt from THIS turn's kernel view, not from the
 * remembered table: the model may be acting on a table built a moment ago.
 *
 * @param session - the session being folded.
 * @param turn - the kernel turn whose ranges describe the current surface.
 * @param mediaPriceOf - optional media price resolver (same as the table's).
 * @param content - the parsed content entries.
 * @returns the expanded entries plus one note per expansion (or per refusal).
 */
function expandSweepEntries(
  session: Session,
  turn: ReturnType<CompressionCore['processTurn']>,
  mediaPriceOf: MediaPriceOf | undefined,
  content: CompressContent,
): { content: CompressContent; notes: string[] } {
  if (!content.some((item) => isSweepEnd(item.endSeq))) return { content, notes: [] }
  const view: KernelRangeView = { ranges: turn.nudge?.compressibleRanges ?? [], refs: turn.state.messageRefs }
  const offerable = buildCompressibleSeqRanges(session, view, mediaPriceOf === undefined ? {} : { mediaPriceOf })
  const costs = foldCostsOfRanges(session, offerable, mediaPriceOf)
  const notes: string[] = []
  const out: CompressContent = []
  for (const [entryIndex, item] of content.entries()) {
    if (!isSweepEnd(item.endSeq)) {
      // Nothing to expand: keep the entry, tagged with its own index so a carrier
      // split of that same entry later groups with it.
      out.push({ ...item, sharedSummaryKey: entryIndex })
      continue
    }
    const start = Number(String(item.startSeq).trim())
    // The base row is the offerable span the start lands in; falling back to the
    // first span that starts at/after it keeps a slightly stale seq usable.
    let base = offerable.findIndex((span) => span.start <= start && start <= span.end)
    if (base < 0) base = offerable.findIndex((span) => span.start >= start)
    // `sweepFromBaseRange` needs the row it starts from and at least one span
    // after it; both are the table's own rule, so the expansion matches the line
    // the model read (the sweep it advertises, not a second opinion).
    const sweep = base < 0 ? undefined : sweepFromBaseRange(offerable, costs, base)
    if (sweep === undefined) {
      notes.push(
        `  seqs ${String(item.startSeq)}..sweep — nothing to sweep from there: no offerable span starts at or after it `
        + '(the seq is already compressed, or the table has moved on). Run acp_status for current seqs, or fold a single range explicitly.',
      )
      continue
    }
    notes.push(
      `  seqs ${String(sweep.entries[0]!.start)}..sweep expanded to ${String(sweep.entries.length)} ranges `
      + `(${String(sweep.entries[0]!.start)}..${String(sweep.entries[sweep.entries.length - 1]!.end)}) — `
      + 'your summary is kept in FULL on the first block; the other parts point at it',
    )
    for (const entry of sweep.entries) {
      // Every expanded part keeps the ORIGINAL entry's key, so the group survives
      // the per-range pipeline (guards, splits, rejects) that follows.
      out.push({ ...item, startSeq: entry.start, endSeq: entry.end, sharedSummaryKey: entryIndex })
    }
  }
  return { content: out, notes }
}

function validateContentItems(content: CompressContent): void {
  const violations: string[] = []
  content.forEach((item, index) => {
    const path = `content[${index}]`
    if (item.startSeq === undefined) violations.push(`missing required property "${path}.startSeq"`)
    if (item.endSeq === undefined) violations.push(`missing required property "${path}.endSeq"`)
    else if (isSweepEnd(item.endSeq) && !isPlainSeq(item.startSeq)) {
      // The shorthand needs a REAL surface seq to start from — "sweep from an mN
      // ref" has no defined base span on the current table.
      violations.push(`"${path}.endSeq": "sweep" needs an integer startSeq (the row's first seq), got ${JSON.stringify(item.startSeq)}`)
    }
    if (typeof item.summary !== 'string' || item.summary.trim().length === 0) {
      violations.push(`missing required property "${path}.summary"`)
    }
  })
  if (violations.length > 0) throw new ToolArgsError(violations)
}

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
export function guardedRowsInSpan(guarded: ReadonlySet<number>, shadowed: readonly number[]): number[] {
  const inSpan = new Set(shadowed)
  return [...guarded].filter((seq) => inSpan.has(seq)).sort((a, b) => a - b)
}

/**
 * Advisory note for a plain range that would fold a LIVE block's checkpoint
 * carrier (see `liveCheckpointCarriersInSpan`). Names the block ids the model
 * can use instead — a block-ref boundary is the call that legitimately folds
 * carriers (tier 2/3 distillation).
 */
export function liveCarrierRejectionNote(
  start: number,
  end: number,
  carriers: readonly { seq: number; kernelBlockId: string }[],
): string {
  const list = carriers.map((carrier) => `seq ${carrier.seq} (${carrier.kernelBlockId})`).join(', ')
  const first = carriers[0]!
  // Name the LAST carrier as the end edge too: a valid multi-carrier span is a
  // tier-3 condense, and suggesting `b1..b1` would silently distill only the
  // first parent.
  const last = carriers[carriers.length - 1]!
  return `  seqs ${start}..${end} rejected — checkpoint ${list} carries the visible summary of a still-active block, and a plain seq range never supersedes one. Distill it with the block ids instead (compress({ content: [{ startSeq: "${first.kernelBlockId}", endSeq: "${last.kernelBlockId}", summary }] })), or cut the span around those seqs.`
}

export function protectedRowRejectionNote(
  start: number,
  end: number,
  hits: readonly number[],
  shadowed: readonly number[],
  session?: Session,
): string {
  const preview = hits.slice(0, 4).join(', ')
  const more = hits.length > 4 ? ` +${hits.length - 4} more` : ''
  const first = shadowed.indexOf(hits[0]!)
  const last = shadowed.indexOf(hits[hits.length - 1]!)
  const before = first > 0 ? shadowed.slice(0, first) : []
  const after = last >= 0 && last < shadowed.length - 1 ? shadowed.slice(last + 1) : []
  const slices = [before, after]
    .filter((slice) => slice.length > 0)
    .map((slice) => `${slice[0]}..${slice[slice.length - 1]}`)
  const recovery = slices.length === 0
    ? 'no part of this span is compressible while those rows are current — pick an OLDER span instead (acp_status lists the live ranges)'
    : `the compressible part of this span is seq ${slices.join(' and ')} — submit them as separate content entries (or two compress calls), each with its own summary`
  // Why the guarded rows may not be folded, per channel. Without a session the
  // hits cannot be classified, so the wording stays the instruction-only text
  // this note has always carried (pinned by tests).
  let hasInstructions = false
  let hasCatalog = false
  let hasUserTurn = false
  if (session !== undefined) {
    for (const seq of hits) {
      const event = eventAtOf(session, seq)
      if (event === undefined) continue
      if (!hasInstructions && isAgentInstructionsRow(event)) hasInstructions = true
      if (!hasCatalog && isSkillCatalogRow(event)) hasCatalog = true
      if (!hasUserTurn && isRealUserTurn(event)) hasUserTurn = true
      if (hasInstructions && hasCatalog && hasUserTurn) break
    }
  }
  const reasons: string[] = []
  if (session === undefined) {
    reasons.push('the host re-injects the newest AGENTS.md copy the moment it leaves the surface, so compressing it reclaims nothing')
  } else if (!hasInstructions && !hasCatalog && !hasUserTurn) {
    // A session that identifies none of the hits must NOT claim an AGENTS.md
    // re-injection it cannot confirm: the rows stay guarded, the mechanism
    // stays unnamed.
    reasons.push('these rows must stay visible on the surface')
  } else {
    // Per-channel WHY (issue #185): the guarded channels fail differently when
    // folded — AGENTS.md comes straight back (host presence gate); a skill
    // catalog never does (resend keyed on the catalog digest, not visibility);
    // and the active user turn would vanish from the surface entirely.
    if (hasInstructions) {
      reasons.push('the host re-injects the newest AGENTS.md copy the moment it leaves the surface, so compressing it reclaims nothing')
    }
    if (hasCatalog) {
      reasons.push('a folded skill catalog is never re-sent — its resend gate is the catalog digest, which folding cannot change')
    }
    if (hasUserTurn) {
      reasons.push('the active user message must stay live to preserve conversation intent')
    }
  }
  // A hit set that is ONLY the active user turn must not be explained with the
  // AGENTS.md re-injection story (or its stale-copy escape): neither applies to
  // a user message. `guardedSurfaceSeqsOf` may also protect the newest real user
  // turn alongside the policy rows, hence the two labels.
  const userOnly = hasUserTurn && !hasInstructions && !hasCatalog
  const rowLabel = hasUserTurn ? 'CURRENT guarded row(s)' : 'CURRENT injected instruction row(s)'
  const staleCopyTail = userOnly ? '' : ' (older/stale copies of the same channel are fine to compress)'
  return `  seqs ${start}..${end} rejected — the span covers ${hits.length} ${rowLabel} (seq ${preview}${more}); ${reasons.join('; ')} — ${recovery}${staleCopyTail}`
}

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
export function edgeRefForSeq(
  session: Session,
  byRaw: Readonly<Record<string, string>>,
  seq: number,
  role: 'start' | 'end',
  oppositeSeq: number,
): string | undefined {
  const nodes = session.surface.nodes
  let index = -1
  let oppositeIndex = -1
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i] === seq) index = i
    if (nodes[i] === oppositeSeq) oppositeIndex = i
  }
  if (index < 0 || oppositeIndex < 0) return undefined
  const direct = anchorRefForNode(session, byRaw, seq, role)
  if (direct !== undefined) return direct
  const step = role === 'start' ? 1 : -1
  // Walk from just past this edge toward the opposite edge, INCLUSIVE of it:
  // the opposite edge's own ref is a legitimate answer when nothing in between
  // carries one (e.g. [empty result, text result]).
  for (let i = index + step; i !== oppositeIndex + step; i += step) {
    const ref = anchorRefForNode(session, byRaw, nodes[i]!, role)
    if (ref !== undefined) return ref
  }
  return undefined
}

/** Bare-seq ref for one node, else its multi-call sub-id ref (see edgeRefForSeq). */
function anchorRefForNode(
  session: Session,
  byRaw: Readonly<Record<string, string>>,
  seq: number,
  role: 'start' | 'end',
): string | undefined {
  const direct = byRaw[String(seq)]
  if (direct !== undefined) return direct
  const event = eventAtOf(session, seq)
  if (event?.type !== 'assistant/message') return undefined
  const content = (event.data as { message?: { content?: unknown } }).message?.content
  // The projection emits one sub-message PER CALL, including calls whose id is
  // absent (keyed `${seq}#`), so the gate must mirror that trigger exactly:
  // fewer than 2 calls means this node projected to a bare seq (tier 1 above).
  const ids = toolCallsOf(content).map((call) => call.id ?? '')
  if (ids.length < 2) return undefined
  // Projection order IS content order (projectEvent maps the calls in sequence).
  const ordered = role === 'start' ? ids : [...ids].reverse()
  for (const id of ordered) {
    const ref = byRaw[`${seq}#${id}`]
    if (ref !== undefined) return ref
  }
  return undefined
}

async function handleCompress(env: ToolEnvironment, args: CompressArgs, exec: ToolRunContext): Promise<TextOutput> {
  const agent = requireAgent(exec)
  const session = agent.session
  // Clean orphan tool messages before any range solve: a single orphan result
  // corrupts the pairing balance cache and rejects every large range (issue
  // #18). Every call still in flight — the compress call itself AND any
  // sibling tool called in the same assistant message — must be excluded from
  // orphan pruning: its tool/result lands at the end of the step, and pruning
  // the call now would orphan that result.
  stripOrphanedSurfaceToolMessages(session, openToolCallIds(session))
  const state = env.store.stateFor(session)
  // The kernel gets the FULL log (visible + shadowed): syncBlocks deactivates
  // a block whose consumed messages are absent, and resolveBoundaries refuses
  // to anchor a block ref it cannot find, so tier-2/3 distillation needs the
  // originals present. The token count uses the same priority chain as the
  // nudge (projectedTokens → surfaceTokens → character heuristic).
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surfaceEventsOf(session))
  const tokenCount = resolveTokenCount(agent, surfaceMessages)
  const window = await resolveEffectiveWindow(env, agent)
  const config = kernelConfigFor({ ...env, modelContextLimit: window.limit })

  // Assign refs / advance state exactly like a turn would.
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  env.store.set(session, turn.state)
  const byRaw = turn.state.messageRefs.byRaw
  // mN drilldown refs resolve against the CURRENT turn's ref map (not the
  // stored state) — acp_status's turn is never persisted, so its mN rows only
  // exist here; the deterministic re-assignment yields the same mN for the
  // same messages (see parseBoundary).
  const byRef = turn.state.messageRefs.byRef
  // The thinking that produced THIS call, lifted out of the assistant message
  // that carried it (the `reasoning` blocks next to the compress tool-call).
  // Captured once per call, before anything lands, and stored on every block the
  // call creates — the model is never asked to write a rationale, its actual
  // reasoning is already on the record (`reasoningForToolCall`).
  const thinking = reasoningForToolCall(session.snapshotEvents(), exec.callId)

  // Tolerate the wrapped forms some models emit: double-nested `{ arguments:
  // "…" }` (which the old DSH validator surfaced as `"arguments" must be an
  // object` and sent the model into a retry loop) and a `content` that arrived
  // as the array SERIALIZED as JSON text (deepseek-flash, live 2026-10-16:
  // `{"content": "[{\"startSeq\": 38721, …}]"}`, rejected by the schema gate as
  // `invalid arguments: "content" must be an array`). Both unwrap to the array.
  const rawContent = unwrapCompressArgs(args)
  const content = rawContent
  if (content === null) {
    return {
      text: 'compress: missing content — pass the content array directly: compress({ content: [{ startSeq, endSeq, summary }] })',
    }
  }
  // `endSeq: "sweep"` (owner ruling, 2026-10-17): expand BEFORE validation so the
  // shorthand never reaches the per-range pipeline as a sentinel, and so an
  // expansion that finds nothing reports a teaching note instead of a parse error.
  // Media pricing is not needed here: the sweep's SPAN geometry is text-only, and
  // each expanded entry is priced by the ordinary path below.
  const sweepExpansion = expandSweepEntries(session, turn, undefined, content)
  const sweepNotes = sweepExpansion.notes
  const expanded = sweepExpansion.content
  // Items-level required check AFTER the envelope peel (see
  // validateContentItems for why the schema gate alone cannot do this).
  validateContentItems(expanded)

  const ranges: Array<
    ResolvedSurfaceRange & {
      startSeq: number
      endSeq: number
      startRef: string
      endRef: string
      summary: string
      topic?: string
      /** B3：本段压缩时已绿的验收读数（结构化落盘）。 */
      verifiedReadings?: string[]
      /** Host-internal group key (see `CompressContent.sharedSummaryKey`); never sent. */
      sharedSummaryKey?: number
    }
  > = []
  // Ranges whose whole span was already shadowed by earlier compressions.
  // They land as advisory warnings, never as errors or phantom blocks.
  const alreadyCompressedNotes: string[] = []
  // Ranges rejected because they cover a CURRENT injected instruction row —
  // hard reject before the kernel apply (supersedes the F7 warn-only draft,
  // see protectedRowRejectionNote): the kernel never sees these ranges, so no
  // phantom block can exist. Computed once here: the surface is stable from
  // the orphan strip onward, the deferred compress-pair hide only touches tool
  // events, and every accepted range lands in ONE applyCompression call at the
  // end of the loop — so the set cannot go stale mid-batch.
  const rejectedNotes: string[] = []
  // Range keys (`startRef::endRef`) already claimed by an accepted range in
  // THIS call: several requested ranges can resolve to ONE balanced span
  // (single tool results expand outward to the enclosing pair), and feeding
  // the same span twice makes the kernel stamp a block per request while only
  // one durable transaction can ever land for it (issue #201).
  const seenRangeKeys = new Set<string>()
  const duplicateRangeNotes: string[] = []
  const guardedSeqs = guardedSurfaceSeqsOf(session)
  // Ranges salvaged by cutting them around live checkpoint carriers (see the
  // carrier branch below): facts for the model, not failures.
  const splitNotes: string[] = []
  // Distillation edges widened to their shared-summary group (see
  // snapSharedSummarySpan): the group stores one text + pointers, so a partial
  // fold would distil pointers instead of content.
  const sharedGroupNotes: string[] = []
  const carrierSpans = env.carrierSpans ?? 'split'
  for (const [entryIndex, range] of expanded.entries()) {
    /** Which of the model's entries this range descends from (a sweep's parts and
     *  a split's runs share the key; see applySharedSummaryPointers). */
    const sharedSummaryKey = range.sharedSummaryKey ?? entryIndex
    const startSeq = parseBoundary(range.startSeq, byRef, session)
    const endSeq = parseBoundary(range.endSeq, byRef, session)
    let resolved: ResolvedSurfaceRange
    try {
      // Balance edges FIRST: the requested edges may sit mid-pair or on nodes
      // that project no bare-`${seq}` id (multi-tool-call assistants project to
      // `${seq}#${callId}` sub-ids; empty tool results project to nothing —
      // issue #155). resolveSurfaceRange shifts them to clean
      // tool-pairing-balanced cuts that ANCHOR (bare ref, sub-id, or the
      // empty-result fallback — see edgeRefForSeq), so the resolved refs exist
      // and the shadowed span matches the returned range. Edges shadowed by an
      // earlier compression (stale nudge table / old compress result) are
      // remapped to the still-live content of the span.
      resolved = resolveSurfaceRange(session, startSeq, endSeq)
    } catch (error) {
      if (error instanceof AlreadyCompressedRangeError) {
        const covering = error.coveringBlockIds
        const blockNote = covering.length === 0
          ? ''
          : ` (block ${covering[0]!.slice(0, 8)}${covering.length > 1 ? ` +${covering.length - 1} more` : ''})`
        alreadyCompressedNotes.push(
          `  seqs ${error.start}..${error.end} already compressed${blockNote} — nothing to reclaim; decompress to recover the originals`,
        )
        continue
      }
      throw error
    }
    // Resolve shared-summary pointers at the boundary: a distillation that named
    // a pointer part must include the block carrying the text (and the whole
    // group, so no tail pointer outlives its consumed head).
    const snapped = snapSharedSummarySpan(session, resolved.start, resolved.end)
    if (snapped !== undefined) {
      resolved = snapped.range
      sharedGroupNotes.push(snapped.note)
    }
    // A span is not allowed to FOLD a CURRENT injected policy row: the host
    // re-injects the newest AGENTS.md copy the moment it leaves the surface
    // (compress → re-inject loop fuel, issue #71) and a folded skill catalog
    // never comes back at all (resend keyed on the digest, issue #185), while
    // the active user turn must stay live. Stale copies pass: removing them
    // while the newest stays visible is the real cleanup.
    //
    // What changed on 2026-10-16 is only the RESPONSE to such a span. It used to
    // be a hard reject, which bounced a plain request whose edges were fine and
    // merely straddled a row — the model then had to work out the cut itself
    // (live: `37194..37273` rejected for one AGENTS.md row at seq 37241, retried
    // as `37194..37238`). Now a plain range is SPLIT around the row exactly like
    // a checkpoint carrier: the row stays visible (so nothing re-injects), and
    // the runs on either side fold under the model's own summary. A block-ref
    // boundary (tier 2/3 distill) still refuses instead: that call is explicitly
    // about folding the checkpoint itself.
    //
    // Probe the set that will ACTUALLY be shadowed (`shadowedSeqsOf`, the
    // positional slice the transaction prices) rather than a numeric interval —
    // see guardedRowsInSpan for why the interval false-positives on a locally
    // non-monotonic surface.
    const shadowedSpan = shadowedSeqsOf(session, resolved.start, resolved.end)
    const instructionHits = guardedRowsInSpan(guardedSeqs, shadowedSpan)
    // An edge on an ACTIVE block's checkpoint summary node resolves to the
    // kernel block ref (bN) — the boundary that makes applyCompression distill
    // (tier 2/3) instead of folding the summary as a plain message.
    const startBlockRef = blockRefForSummarySeq(session, resolved.start)
    const endBlockRef = blockRefForSummarySeq(session, resolved.end)
    const startRef = startBlockRef ?? edgeRefForSeq(session, byRaw, resolved.start, 'start', resolved.end)
    const endRef = endBlockRef ?? edgeRefForSeq(session, byRaw, resolved.end, 'end', resolved.start)
    if (startRef === undefined || endRef === undefined) {
      throw new Error(
        `billion-context-dsh: seq ${resolved.start}..${resolved.end} has no assigned ref — `
        + 'the range must be on the current surface (run acp_status for the live seq list)',
      )
    }
    // A plain (message-ref) range must not fold a LIVE block's checkpoint
    // carrier. The kernel keeps that carrier visible — our projection marks it
    // via `summaryOfBlockId`, upstream #335 — but this host transaction replaces
    // the WHOLE span in one `surfaceOp`, so the carrier would leave the surface
    // anyway: the block's summary would vanish while the kernel still counts the
    // block as active. Block-ref boundaries (bN..bM) are the call that SHOULD
    // fold carriers (tier 2/3), so the reject fires only when NEITHER edge is a
    // block ref — the same rule the kernel applies (`resolveBoundaries` reports
    // boundary kind `block` as soon as one edge is a block ref).
    //
    // `split` (default) salvages such a request instead of bouncing it: the span
    // is cut into the runs around each carrier, the foldable ones land as their
    // own blocks carrying the model's own summary, and the carriers stay
    // visible. `reject` restores the pre-2026-10-13 hard refusal. Live evidence
    // for the split: in one long CJK session all 12 carrier rejections were
    // ranges read off acp_status's Surface/drilldown listing — which, unlike the
    // nudge range table, does not break at carriers — and two of them were the
    // identical span retried.
    if (startBlockRef == null && endBlockRef == null) {
      const carriers = liveCheckpointCarriersInSpan(session, shadowedSpan)
      // Both kinds of "must stay visible" row become split points: a live block's
      // checkpoint carrier and a CURRENT injected policy row / active user turn.
      const barrierSeqs = [...new Set([...carriers.map((carrier) => carrier.seq), ...instructionHits])]
        .sort((left, right) => left - right)
      if (barrierSeqs.length > 0) {
        if (carriers.length > 0 && carrierSpans === 'reject') {
          rejectedNotes.push(liveCarrierRejectionNote(resolved.start, resolved.end, carriers))
          continue
        }
        const carrierLabel = carriers.map((carrier) => `seq ${carrier.seq} (${carrier.kernelBlockId})`).join(', ')
        const keptVisible: string[] = []
        if (carriers.length > 0) keptVisible.push(`checkpoint ${carrierLabel}`)
        if (instructionHits.length > 0) {
          keptVisible.push(`current protected row(s) ${instructionHits.join(', ')}`)
        }
        const keptRuns: typeof ranges = []
        const foldedRuns: string[] = []
        for (const run of splitSpanAtSeqs(shadowedSpan, barrierSeqs)) {
          const first = run[0]
          const last = run[run.length - 1]
          if (first === undefined || last === undefined) continue
          let sub: ResolvedSurfaceRange
          try {
            sub = resolveSurfaceRange(session, first, last)
          } catch {
            // A run whose edges cannot anchor (empty result / unbalanced pair)
            // contributes nothing — the row that was kept is the subject here.
            continue
          }
          const subShadowed = shadowedSeqsOf(session, sub.start, sub.end)
          // A guarded row still inside a run is not folded either — the run is
          // skipped (folding it would re-trigger the host injection, issues
          // #71/#185), and if every run is skipped the teaching refusal below
          // says why.
          if (subShadowed.length === 0 || guardedRowsInSpan(guardedSeqs, subShadowed).length > 0) continue
          const subStartRef = blockRefForSummarySeq(session, sub.start)
            ?? edgeRefForSeq(session, byRaw, sub.start, 'start', sub.end)
          const subEndRef = blockRefForSummarySeq(session, sub.end)
            ?? edgeRefForSeq(session, byRaw, sub.end, 'end', sub.start)
          if (subStartRef === undefined || subEndRef === undefined) continue
          if (seenRangeKeys.has(`${subStartRef}::${subEndRef}`)) continue
          keptRuns.push({
            ...sub,
            startSeq: sub.start,
            endSeq: sub.end,
            startRef: subStartRef,
            endRef: subEndRef,
            summary: range.summary,
            sharedSummaryKey,
            ...(range.topic === undefined ? {} : { topic: range.topic }),
            ...(Array.isArray(range.verifiedReadings) && range.verifiedReadings.length > 0
              ? { verifiedReadings: range.verifiedReadings.map(String) }
              : {}),
          })
          foldedRuns.push(`${sub.start}..${sub.end}`)
        }
        // Nothing survived the barriers: fall back to the teaching refusal
        // rather than report a fold that cannot happen.
        if (keptRuns.length === 0) {
          rejectedNotes.push(carriers.length > 0
            ? liveCarrierRejectionNote(resolved.start, resolved.end, carriers)
            : protectedRowRejectionNote(resolved.start, resolved.end, instructionHits, shadowedSpan, session))
          continue
        }
        for (const kept of keptRuns) seenRangeKeys.add(`${kept.startRef}::${kept.endRef}`)
        ranges.push(...keptRuns)
        splitNotes.push(
          `  seqs ${resolved.start}..${resolved.end} split around ${keptVisible.join(' and ')} — folded ${foldedRuns.join(', ')}; `
          + 'the kept row(s) stay visible, so this summary covers ONLY the folded seqs',
        )
        continue
      }
    }
    // A block-ref boundary (tier 2/3 distill) is the one call that folds
    // checkpoints on purpose, so it cannot be split; a CURRENT row inside it
    // stays a refusal.
    if (instructionHits.length > 0) {
      rejectedNotes.push(protectedRowRejectionNote(resolved.start, resolved.end, instructionHits, shadowedSpan, session))
      continue
    }
    const rangeKey = `${startRef}::${endRef}`
    if (seenRangeKeys.has(rangeKey)) {
      // An earlier range in this call already owns this exact span: its summary
      // lands for the whole span, and a second block here could never get its
      // own durable transaction (the span leaves the surface after the first).
      duplicateRangeNotes.push(
        `  seqs ${range.startSeq}..${range.endSeq} resolve to the same span as an earlier range in this call (${resolved.start}..${resolved.end}) — skipped`,
      )
      continue
    }
    seenRangeKeys.add(rangeKey)
    ranges.push({
      ...resolved,
      startSeq,
      endSeq,
      startRef,
      endRef,
      sharedSummaryKey,
      // B3：把该段声明的已绿验收读数带上（缺位=不写键）
      ...(Array.isArray(range.verifiedReadings) && range.verifiedReadings.length > 0
        ? { verifiedReadings: range.verifiedReadings.map(String) }
        : {}),
      summary: range.summary,
      ...(range.topic ?? args.topic) === undefined ? {} : { topic: range.topic ?? args.topic },
    })
  }

  // The summary floor, applied ENTRY BY ENTRY (see summaryFloorRefusal): this is
  // the one thing the kernel cannot do, because it takes the floor per call —
  // so a call that mixes junk slivers with real content waives it for the small
  // spans and keeps it for the large ones, exactly as written.
  //
  // BEFORE the shared-pointer rewrite (owner ruling, 2026-10-17): parts 2..N are
  // 179-char boilerplate, so checking them after the rewrite measured the pointer
  // instead of the model's text — with a raised floor the head was refused while
  // its tail "passed", leaving pointers aimed at a block that never landed.
  const floorNotes: string[] = []
  const foldable = ranges.filter((range) => {
    const refusal = summaryFloorRefusal(session, range, config.compress.minSummaryLength)
    if (refusal === undefined) return true
    floorNotes.push(refusal)
    return false
  })
  // Number the SURVIVORS: full text on the first one that will actually land.
  applySharedSummaryPointers(foldable)

  // Nothing to do: every requested range was already compressed, rejected, or
  // a duplicate of an earlier range in the same call.
  if (foldable.length === 0) {
    const text = ['Compressed 0 block(s), ~0 tokens reclaimed.', ...sweepNotes, ...sharedGroupNotes, ...alreadyCompressedNotes, ...duplicateRangeNotes, ...rejectedNotes, ...splitNotes, ...floorNotes]
    if (alreadyCompressedNotes.length > 0) {
      text.push('  (all requested ranges were already compressed — decompress a block to recover its originals)')
    } else if (duplicateRangeNotes.length > 0 && rejectedNotes.length === 0) {
      text.push('  (nothing compressed — every range resolved to a span an earlier range in this call already covers)')
    } else if (rejectedNotes.length > 0) {
      text.push('  (nothing compressed — every range covered a current guarded row, an injected policy row or the active user turn; see the rejections above)')
    } else if (floorNotes.length > 0) {
      text.push('  (nothing compressed — every range was too big to fold as a stub; give those spans a real summary)')
    }
    return { text: text.join('\n') }
  }

  const applied = env.kernel.applyCompression({
    ranges: foldable.map(({ startRef, endRef, summary, topic }) => ({ startRef, endRef, summary, topic })),
    messages: coreMessages,
    state: turn.state,
    // Two per-CALL kernel knobs are switched off here because this host owns
    // both decisions, per entry:
    //  - `minSummaryLength`: `summaryFloorRefusal` already refused the entries
    //    that owe a real summary, and a small span may be one sentence.
    //  - `minCompressRange` (owner ruling, 2026-10-16): the model reads the fold
    //    cost — rewrites and payback — on every row it is offered, so a small
    //    fold is its call to make, not a blanket threshold's. The kernel's own
    //    use of the knob is untouched: which ranges are worth OFFERING is still
    //    filtered in its nudge decision (pendingByTier), and a block-ref
    //    distillation never tripped this gate anyway.
    config: { ...config, compress: { ...config.compress, minSummaryLength: 0, minCompressRange: 0 } },
    // Deliberately NOT overriding protectedMessageIds: with the full log the
    // kernel's recent/last-user protection is computed over the same
    // non-block-covered messages as the visible feed, so default behavior is
    // preserved. Any 'Excluded N protected message(s)' warning is surfaced.
  })
  // A kernel error for ONE range must not poison the whole call: the other
  // ranges still created blocks. This matters for issue #18's "phantom range"
  // — messages absorbed into an earlier block's effectiveMessageIds (kernel
  // boundary adjustment) but still live on the surface resolve fine but make
  // the kernel throw "Range contains no compressible messages". Fail only
  // when NOTHING landed; otherwise land the successes and surface the
  // failures as advisory lines below.
  if (applied.result.errors.length > 0 && applied.result.blocksCreated === 0) {
    return { text: `compress failed: ${applied.result.errors.join('; ')}` }
  }
  env.store.set(session, applied.state)
  if (applied.result.blocksCreated > 0) {
    // Hide this compress call/result after the tool result lands, so the
    // compaction summary never sits between an assistant tool_calls block and
    // its tool response (strict providers reject that sequence).
    env.compressCallIdsToHide?.add(exec.callId)
    // ONE model choice: this call committed to a fold START, and every age region
    // that start does not fall into is counted as passed over (src/age-region-skips.ts).
    // A sweep is deliberately ONE choice — the earliest seq it folds is the point
    // the model committed to, not each of its entries — and the spans it folds
    // past the start take the count back from every age region they reached into
    // (only for a contiguous run of offers: see src/age-region-skips.ts).
    if (foldable.length > 0) {
      noteAgeRegionChoice(String(session.id), foldable.map((range) => ({ start: range.startSeq, end: range.endSeq })))
    }
  }

  // Match freshly created kernel blocks to the requested ranges by their
  // range key (the kernel stamps startRef/endRef onto each new block).
  const previousIds = new Set(turn.state.blocks.map((block) => block.blockId))
  const newBlocks = applied.state.blocks.filter((block) => !previousIds.has(block.blockId))
  const blockByRangeKey = new Map(newBlocks.map((block) => [`${block.startRef}::${block.endRef}`, block]))
  // Warnings carry two shapes: range-prefixed ("Skipped range (a..b) — …")
  // attributable to a specific range, and free-form ("Excluded N protected
  // message(s) …") attributable to the call as a whole.
  const warningByRangeKey = new Map<string, string[]>()
  const freeWarnings: string[] = []
  for (const warning of applied.result.warnings) {
    const match = /^Skipped range \((.+?)\.\.(.+?)\)/.exec(warning)
    if (match !== null) {
      const key = `${match[1]}::${match[2]}`
      const list = warningByRangeKey.get(key) ?? []
      list.push(warning)
      warningByRangeKey.set(key, list)
    } else {
      freeWarnings.push(warning)
    }
  }

  const lines: string[] = []
  let skippedRanges = 0
  for (const range of ranges) {
    const key = `${range.startRef}::${range.endRef}`
    const block = blockByRangeKey.get(key)
    if (block === undefined) {
      // The kernel skipped this range (already compressed / overlapped): no
      // kernel block was created, so no durable transaction is landed — the
      // ledger must never record a block the kernel does not know.
      skippedRanges += 1
      const warnings = warningByRangeKey.get(key) ?? []
      for (const warning of warnings) lines.push(`  ${warning}`)
      continue
    }
    // The edges were already balanced above; shadow exactly that span.
    const { start, end } = range
    const shadowed = shadowedSeqsOf(session, start, end)
    // Last line of defense before the durable write: if an earlier landed
    // transaction in this batch removed this span from the surface (the kernel
    // can stamp one block per requested range even when several share refs),
    // skip instead of transacting — a summary whose shadowedSeqs no longer
    // name an exact current surface span bricks the session log on next load
    // (issue #201). runCompactionTransaction re-validates and would throw;
    // skipping keeps the rest of the batch landing.
    if (!isExactSurfaceSpan(session, start, end, shadowed)) {
      skippedRanges += 1
      lines.push(`  skipped seqs ${start}..${end}: already shadowed by an earlier range in this call`)
      continue
    }
    // Price the reclaimed tokens in the HOST's token vocabulary (rule 12):
    // prefer the live meter's per-node prices, fall back to the exact mirror.
    // NEVER defaultCountTokens — that overdraws the meter on CJK (issue #54).
    const shadowedTokens = shadowedTokensViaMeter(session, shadowed, agent.ctx)
    const tier = block.tier === 2 || block.tier === 3 ? block.tier : 1
    const parentBlockIds = compactionIdsOfKernelBlocks(session, block.directBlockIds)
    // Provenance follows the LIVE route, not `agent.options`: after a mid-session
    // model switch the latter is a stale snapshot (the PREVIOUS route), so the
    // summary node would be stamped with a route the summary did not come from.
    const { provider, model } = routeFor(agent)
    const { compactionId } = runCompactionTransaction(session, {
      start,
      end,
      shadowedSeqs: shadowed,
      summary: [{ type: 'text', text: range.summary }],
      shadowedTokenCount: shadowedTokens,
      provider,
      model,
      tier,
      kernelBlockId: block.blockId,
      ...(range.topic === undefined ? {} : { topic: range.topic }),
      ...(parentBlockIds.length === 0 ? {} : { parentBlockIds }),
      // Record the kernel block's raw coverage so a restarted engine
      // rehydrates the SAME effective messages (a tier-2 block's coverage is
      // its parents' originals, not the checkpoint node).
      directMessageIds: block.directMessageIds,
      effectiveMessageIds: block.effectiveMessageIds,
      // B3：已绿验收读数随压缩块落盘（缺位=不写键）
      ...(range.verifiedReadings === undefined ? {} : { verifiedReadings: range.verifiedReadings }),
      // 模型挑这一段的真实思考随块落盘（缺位=不写键）
      ...(thinking === undefined ? {} : { reasoning: thinking }),
    })
    const adjusted = start !== range.startSeq || end !== range.endSeq
    // Always report the tier, even tier 1: a silently-downgraded distill
    // (boundary moved off the checkpoint seq → the kernel folds a plain
    // message) must be visible to the model immediately, or the model keeps
    // believing the distillation landed (issue #60, failure mode 2).
    const tierLabel = `, tier ${tier}`
    // B3 must be READABLE, not just durable: echo the recorded readings back in the
    // compress result, otherwise "later steps need not re-run them" is unreachable
    // (the field had no other production reader).
    const readingsLabel = range.verifiedReadings !== undefined && range.verifiedReadings.length > 0
      ? `, verified: ${range.verifiedReadings.join('; ')}`
      : ''
    const note = range.recovered === true
      ? ` (seqs ${range.startSeq}..${range.endSeq} were already shadowed — compressed the live remainder ${start}..${end})`
      : adjusted
        ? ` (adjusted from ${range.startSeq}..${range.endSeq} to balanced edges)`
        : ''
    lines.push(
      `  block ${compactionId.slice(0, 8)}: seqs ${start}..${end}, ${shadowed.length} messages shadowed${tierLabel}${readingsLabel}${note}`,
    )
  }

  // The durable log stores ONE text + pointers for a sweep; the live kernel
  // view is resolved here — AFTER the transactions above landed — so it matches
  // what a restarted engine rehydrates (state.ts). Search, status and any later
  // distillation then see the real text instead of "part k/N".
  {
    const liveLedger = rebuildBlockLedger(sessionEventsOf(session))
    const liveSummaries = resolvedSummariesOf(liveLedger)
    const summaryByKernelId = new Map<string, string>()
    for (const [index, entry] of liveLedger.entries()) {
      if (entry.kernelBlockId === undefined) continue
      summaryByKernelId.set(entry.kernelBlockId, liveSummaries[index]!)
    }
    applied.state.blocks = applied.state.blocks.map((block) => {
      const summary = summaryByKernelId.get(block.blockId)
      return summary === undefined || summary === block.summary ? block : { ...block, summary }
    })
    env.store.set(session, applied.state)
  }

  const summaryLine = `Compressed ${applied.result.blocksCreated} block(s), ~${applied.result.tokensCompressed} tokens reclaimed.`
  const totalSkipped = skippedRanges + alreadyCompressedNotes.length + duplicateRangeNotes.length + rejectedNotes.length + floorNotes.length
  const failedLines = applied.result.errors.map((error) => `  ${error}`)
  const warningLines = [
    ...freeWarnings.map((warning) => `  ${warning}`),
    ...sweepNotes,
    ...sharedGroupNotes,
    ...failedLines,
    ...alreadyCompressedNotes,
    ...duplicateRangeNotes,
    ...rejectedNotes,
    ...splitNotes,
    ...floorNotes,
    ...lines,
  ]
  const footer = totalSkipped > 0
    ? `  (${totalSkipped} range(s) skipped or failed — see above)`
    : ''
  return { text: `${summaryLine}\n${[...warningLines, footer].filter((line) => line !== '').join('\n')}` }
}

const decompressParameters = {
  blockId: { type: 'string' as const, required: true, description: 'Block id: the kernel block ref `bN` shown by acp_status (e.g. b1), or a compaction id / prefix from search_context.' },
  offset: { type: 'integer' as const, description: 'Start position in the block\'s message list (default 0). Blocks are paged by size — each page stays under the host tool-result trim budget (up to 100 messages) — so follow the continue hint in the result to walk the rest.' },
  limit: { type: 'integer' as const, description: 'Messages per page (default 100; values above 100 are capped to 100). Pages are also bounded by a character budget, so long messages return fewer than this per call.' },
} as const

interface DecompressArgs {
  blockId: string
  offset?: number
  limit?: number
}

/** Resolve a block arg to its durable compaction id: exact `bN` kernel ref
 *  first (acp_status shows `bN`), then the compaction-id prefix match that
 *  search_context and /acp-prune have always used. The `bN` branch is exact
 *  (`/^b\d+$/` with `$`), so a UUID that happens to start with `b1` cannot be
 *  shadowed — full UUIDs and 8-char prefixes never match the anchored regex. */
function resolveBlockId(session: Session, arg: string): string | null {
  const byKernelRef = blockIdOfKernelRef(session, arg)
  if (byKernelRef !== null) return byKernelRef
  const ledger = rebuildBlockLedger(sessionEventsOf(session))
  const byPrefix = ledger.find((entry) => entry.blockId.startsWith(arg))
  return byPrefix?.blockId ?? null
}

function handleDecompress(_env: ToolEnvironment, rawArgs: DecompressArgs, exec: ToolRunContext): TextOutput {
  const args = unwrapEnvelope<DecompressArgs>(rawArgs)
  const session = requireAgent(exec).session
  const blockId = resolveBlockId(session, args.blockId)
  if (blockId === null) {
    return { text: `decompress: block "${args.blockId}" not found (see acp_status for the block list)` }
  }
  const ledger = rebuildBlockLedger(sessionEventsOf(session))
  const block = ledger.find((entry) => entry.blockId === blockId)
  if (block === undefined) {
    return { text: `decompress: block "${args.blockId}" not found (see acp_status for the block list)` }
  }
  // Tier-2/3 blocks shadow parent checkpoint nodes: expand to the originals.
  // Page by BOTH message count and rendered chars so a normal page stays under
  // the host's tool-result pruner threshold (DEFAULT_DECOMPRESS_PAGE_CHARS);
  // renderLen prices each message exactly as it will appear on this page.
  const expanded = expandShadowedSeqs(session, block.blockId)
  const page = sliceDecompressPage(
    expanded,
    args.offset ?? 0,
    args.limit ?? DEFAULT_DECOMPRESS_PAGE,
    DEFAULT_DECOMPRESS_PAGE_CHARS,
    (seq) => {
      const event = eventAtOf(session, seq)
      const text = event === undefined ? '' : extractEventText(event)
      return text.length === 0 ? 0 : `[seq ${seq}] ${text}`.length
    },
  )
  if (page.total === 0 || page.seqs.length === 0) {
    const where = page.total === 0 ? '' : ` has ${page.total} messages; offset ${page.offset} is past the end — use an offset below ${page.total}, or omit it`
    return { text: page.total === 0 ? `Block ${block.blockId} — ${block.summary}\n\n(no recoverable content)` : `decompress: block ${block.blockId}${where}` }
  }
  const parts: string[] = []
  for (const seq of page.seqs) {
    const event = eventAtOf(session, seq)
    const text = event === undefined ? '' : extractEventText(event)
    if (text.length > 0) parts.push(`[seq ${seq}] ${text}`)
  }
  const tierNote = block.tier > 1 ? ` (tier ${block.tier}, distills ${block.parentBlockIds.length} block(s))` : ''
  // Marker + continue hint LEAD the payload, not trail it: if a page is ever
  // oversized and the host drops its middle, the "this page is partial" line
  // survives up top rather than being the exact line that gets trimmed away.
  const lines: string[] = []
  lines.push(`[messages ${page.offset + 1}..${page.offset + page.seqs.length} of ${page.total}]`)
  if (!page.exhausted) lines.push(`More available — continue with decompress({ blockId: "${block.blockId}", offset: ${page.offset + page.seqs.length} })`)
  return {
    text: `Block ${block.blockId} — ${block.summary}${tierNote}\n\n${lines.join('\n')}\n\n${parts.join('\n\n') || '(no text content on this page)'}`,
  }
}

const searchParameters = {
  query: { type: 'string' as const, required: true, description: 'Search terms to find inside compressed blocks.' },
  limit: { type: 'integer' as const, description: 'Maximum results (default 5).' },
} as const

interface SearchArgs {
  query: string
  limit?: number
}

/** Event type → kernel message role (drives hybrid role weighting). */
function roleOfEvent(event: SessionEvent): MessageRole | null {
  switch (event.type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/result': return 'tool'
    default: return null
  }
}

// The search corpus (block summaries + all shadowed originals) is a pure
// function of the append-only log: rebuild it once per log snapshot and reuse
// across searches until the next append (issue #133 — the per-call full
// rebuild re-extracted and re-counted every shadowed message on every search;
// the snapshot array is stable until the next append, see sessionEventsOf).
const searchDocsCache = new WeakMap<readonly SessionEvent[], SearchDoc[]>()

/**
 * Build the unified SearchDoc[] from the log: one block doc per ledger entry
 * (ref = compactionId, so `decompress({ blockId })` closes the loop) plus one
 * message doc per shadowed ORIGINAL (expanded through distilled parents; each
 * seq is claimed by the earliest/innermost block that covered it, mirroring
 * pi's owner map — decompress on that block recovers the original).
 * Cached per log snapshot (see searchDocsCache). Exported for the issue #133
 * regression tests (not part of the public API — index.ts re-exports only).
 */
export function buildSearchDocs(session: Session): SearchDoc[] {
  const events = sessionEventsOf(session)
  const cached = searchDocsCache.get(events)
  if (cached !== undefined) return cached
  const ledger = rebuildBlockLedger(events)
  const resolvedSummaries = resolvedSummariesOf(ledger)
  const docs: SearchDoc[] = []
  const claimed = new Set<number>()
  for (const [ledgerIndex, block] of ledger.entries()) {
    // A sweep's later parts carry only a pointer; search must index the text
    // they point at, or a query for the folded material finds 14 dead ends.
    const summary = resolvedSummaries[ledgerIndex] ?? block.summary
    docs.push({
      kind: 'block',
      ref: block.blockId,
      text: summary,
      title: summary.slice(0, 60) || block.blockId,
      blockId: block.blockId,
      tier: block.tier,
      tokens: defaultCountTokens(summary),
    })
    for (const seq of expandShadowedSeqs(session, block.blockId)) {
      if (claimed.has(seq)) continue
      claimed.add(seq)
      const event = eventAtOf(session, seq)
      if (event === undefined) continue
      const role = roleOfEvent(event)
      const text = extractEventText(event)
      if (role === null || text.length === 0) continue
      docs.push({
        kind: 'message',
        ref: `seq ${seq}`,
        text,
        title: `${role}: ${text.slice(0, 60)}`,
        role,
        blockId: block.blockId,
        tier: block.tier,
        tokens: defaultCountTokens(text),
      })
    }
  }
  searchDocsCache.set(events, docs)
  return docs
}

function handleSearch(_env: ToolEnvironment, rawArgs: SearchArgs, exec: ToolRunContext): TextOutput {
  const args = unwrapEnvelope<SearchArgs>(rawArgs)
  const session = requireAgent(exec).session
  if (args.query.trim() === '') return { text: 'search_context: empty query (no matches)' }
  const docs = buildSearchDocs(session)
  // Trust the kernel: hybrid (0.7×BM25 stemmed + 0.3×fuzzy n-gram) is the
  // algorithm contract — no engine-side gate or threshold re-implements
  // search policy. Scores are surfaced so the model can judge a weak hit
  // (fuzzy-only tops out near 0.3).
  const results = searchBlocks(docs, args.query, { limit: args.limit ?? 5, previewLength: 160 })
  if (results.length === 0) return { text: `search_context: no matches for "${args.query}"` }
  const lines = results.map((r) => {
    const kind = r.kind === 'block' ? `block ${r.ref}` : `message ${r.ref} (${r.role ?? '?'}, in block ${r.blockId ?? '?'})`
    return `  - ${kind} (score ${r.score.toFixed(2)}): ${r.preview}`
  })
  return {
    text: `Matches for "${args.query}":\n${lines.join('\n')}\n\nDecompress with: decompress({ blockId })`,
  }
}

/** acp_status drilldown passthrough (kernel buildStatusReport options). All
 *  keys optional — no args = overview. `view`/`tool`/`sort`/`limit` only have
 *  meaning under `scope:"uncompressed"` (`tool` narrows to `view:"messages"`;
 *  `sort:"age"` applies to `scope:"compressed"`); the kernel ignores them in
 *  overview mode (upstream status-tool docstring documented the same scope).
 *  DSH schema compiler: `string` + `enum` supported, no `required: true`
 *  anywhere → all optional (schema.js:192-210). */
const statusParameters = {
  scope: {
    type: 'string' as const,
    enum: ['compressed', 'uncompressed'] as const,
    description: 'Drilldown scope: "compressed" lists compressed blocks, "uncompressed" lists visible messages. Omit for the overview.',
  },
  view: {
    type: 'string' as const,
    enum: ['ranges', 'messages'] as const,
    description: 'Drilldown view under scope:"uncompressed": "ranges" merges visible messages into ranges (default), "messages" lists every message.',
  },
  tool: {
    type: 'string' as const,
    description: 'Filter drilldown rows to one tool name (scope:"uncompressed" + view:"messages" only).',
  },
  sort: {
    type: 'string' as const,
    enum: ['size', 'time', 'tool', 'age'] as const,
    description: 'Row order: size (default, most tokens first), time, tool; "age" applies to compressed blocks.',
  },
  limit: {
    type: 'integer' as const,
    description: 'Cap on rows or blocks shown (default 30).',
  },
}

interface StatusArgs {
  scope?: 'compressed' | 'uncompressed'
  view?: 'ranges' | 'messages'
  tool?: string
  sort?: 'size' | 'time' | 'tool' | 'age'
  limit?: number
}


async function handleStatus(env: ToolEnvironment, rawArgs: StatusArgs, exec: ToolRunContext): Promise<TextOutput> {
  // The model channel may wrap ANY tool's args under `{ arguments: {…} }`;
  // peel it or drilldown params never reach buildStatusReport (live-verified
  // `{"arguments":{"scope":"compressed"}}` silently rendered the overview).
  const args = unwrapEnvelope<StatusArgs>(rawArgs)
  const agent = requireAgent(exec)
  const session = agent.session
  const state = env.store.stateFor(session)
  const surface = surfaceEventsOf(session)
  // One tool-call index for both projections below (P2-5): tool/result
  // toolName/toolCallId are backfilled from the assistant tool-calls.
  const toolNames = buildToolCallIndex(surface)
  const coreMessages = allLogMessages(session)
  const surfaceMessages = eventsToCoreMessages(surface, toolNames)
  const tokenCount = resolveTokenCount(agent, surfaceMessages)
  const window = await resolveEffectiveWindow(env, agent)
  const config = kernelConfigFor({ ...env, modelContextLimit: window.limit })
  // Run the same pipeline the context transform runs, so what acp_status
  // reports matches what the model actually receives. The returned turn.state
  // carries the freshly assigned refs; it is NOT persisted — acp_status is a
  // read-only view, and env.store.set would advance the nudge baseline a
  // second time in the same turn (design §6.1 P2-2).
  const turn = env.kernel.processTurn({ messages: coreMessages, state, config, tokenCount })
  // Status messages = visible surface EXCLUDING checkpoint summary nodes (P1-3).
  const statusMessages = eventsToCoreMessages(
    surface.filter((event) => isCheckpointNode(event) === false),
    toolNames,
  )
  // Upstream-aligned: the kernel renders the breakdown (percentages of the
  // VISIBLE total — no window semantics; drilldown scope/view/tool/sort/limit
  // pass through verbatim); the engine only appends the nudge decision line,
  // the DSH Surface anchor, and — in drilldown mode — the mN-vs-seq note.
  const report = buildStatusReport(turn.state, statusMessages, defaultCountTokens, args)
  const lines = [report]
  // Mirror upstream pi (`if (args.scope) return base`): a drilldown request
  // answers with the kernel report alone — the nudge decision line is an
  // overview concept. The Surface anchor stays in ALL modes: it is the model's
  // compressible-ref locator (design P2-1).
  if (args.scope === undefined) {
    const nudge = turn.nudge
    if (nudge !== undefined) {
      lines.push('', `Nudge: ${nudge.shouldInject ? 'ACTIVE' : 'idle'} — ${nudge.reason}`)
    }
    // Issue #60 P2: the model's only route to T2/T3 distillation is a LIVE
    // checkpoint seq — but acp_status (kernel buildStatusReport) is blind to
    // summary nodes (they are excluded as messages, rule 9) and shows only bN
    // refs. Append an engine-side mapping bN → checkpoint seq for ACTIVE
    // blocks (only active blocks are distillable). Appending is the
    // kernel-alignment contract: the kernel owns the report text, the engine
    // owns the wiring — this row is wiring, never a rewrite of the report.
    const checkpointRows = blockRegistry(session)
      .filter((entry) => entry.active && entry.summarySeq !== null)
      .map((entry) => `${entry.kernelBlockId} → seq ${entry.summarySeq}`)
    if (checkpointRows.length > 0) {
      const crossing = (env.carrierSpans ?? 'split') === 'reject'
        ? 'a plain span that crosses one is refused (carrierSpans:"reject")'
        : 'a plain span that crosses one is split around it, so the carrier stays visible'
      lines.push('', `Checkpoint seqs (active blocks — compress a checkpoint seq to distill it; ${crossing}): ${checkpointRows.join(', ')}`)
    }
    // Two calibers meet in this report: the pressure/nudge line is
    // provider-anchored (the session projection, where images and files carry
    // the live route's price) while the breakdown above is a text-only
    // estimate. They legitimately disagree on media-heavy sessions, and a model
    // reads that disagreement as a broken number unless it is told which is
    // which (issue #117). Emitted only when the surface actually carries media,
    // so a text-only session keeps the kernel report untouched.
    const mediaOnSurface = surface.some((event) => {
      const counts = attachmentsOfEvent(event)
      return counts.images + counts.files > 0
    })
    if (mediaOnSurface) {
      lines.push(
        '',
        'Note: the pressure line is provider-anchored (images/files priced by the live route); the breakdown above is a text-only estimate. They can differ on media-heavy sessions.',
      )
    }
    // The nudge table's `skipped N×` suffix, restated here: acp_status is the
    // other place a model reads compressible ranges, and "your folds keep
    // starting somewhere else" is a fact neither seq order nor fold cost can
    // carry. Same numbers, same age region slots — keyed by AGE REGION INDEX, not by seq.
    const skips = lastAgeRegionSkipsOf(String(session.id))
    const skippedAgeRegions = (inspectCacheOf(String(session.id))?.rows ?? [])
      .map((row, index) => ({ row, skipped: skips[index] ?? 0 }))
      .filter((entry) => entry.skipped > 0)
      .sort((left, right) => right.skipped - left.skipped)
      .slice(0, 5)
    if (skippedAgeRegions.length > 0) {
      lines.push(
        '',
        `Age regions your folds keep passing over (nudge column \`skipped N×\`; every choice of a fold start outside the age region counts once, and a sweep — one contiguous run of compressible ranges — gives that count back to every age region it folded through): `
        + skippedAgeRegions.map((entry) => `seq ${String(entry.row.start)}..${String(entry.row.end)} skipped ${String(entry.skipped)}×`).join(', '),
      )
    }
  }
  lines.push('', `Surface: ${surfaceSummary(session)}`)
  // Drilldown rows carry kernel refs (mN, dense log-order ids) — compress
  // accepts them directly (handleCompress reverse-maps mN → live surface seq
  // via the current turn's messageRefs.byRef; issue #31). The Surface anchor
  // remains the model's compressible-seq locator for nudge-style ranges.
  if (args.scope === 'uncompressed') {
    lines.push(
      '',
      'Note: drilldown rows are kernel refs (mN) — feed them straight to compress (auto-mapped to the live surface seq); an unknown mN fails with guidance. '
      + 'This listing does NOT break at live checkpoint carriers (unlike the nudge range table), so a range read off it can cross one: compress then folds the runs around that carrier instead of the whole span, and says so in its result.',
    )
  }
  return { text: lines.join('\n') }
}

/** Build the four ACP model tools bound to one engine. */
export function makeTools(env: ToolEnvironment): ToolDefinition[] {
  const prompts = env.prompts ?? DEFAULT_RESOLVED
  return [
    defineTool({
      name: 'compress',
      description: prompts.tools.compress,
      parameters: compressParameters,
      output: textOutput(),
      async execute(args, exec) {
        return handleCompress(env, args as CompressArgs, exec)
      },
    }),
    defineTool({
      name: 'decompress',
      description: prompts.tools.decompress,
      parameters: decompressParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleDecompress(env, args as DecompressArgs, exec))
      },
    }),
    defineTool({
      name: 'search_context',
      description: prompts.tools.searchContext,
      parameters: searchParameters,
      output: textOutput(),
      execute(args, exec) {
        return Promise.resolve(handleSearch(env, args as SearchArgs, exec))
      },
    }),
    defineTool({
      name: 'acp_status',
      description: prompts.tools.acpStatus,
      parameters: statusParameters,
      output: textOutput(),
      execute(args, exec) {
        return handleStatus(env, args as StatusArgs, exec)
      },
    }),
  ]
}
