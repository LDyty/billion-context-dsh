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

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AcpInspectBlock,
  AcpInspectComplement,
  AcpInspectNode,
  AcpInspectRow,
  AcpInspectSettings,
  AcpInspectSnapshot,
  AcpInspectSweep,
} from './inspect-types.ts'
import { hostMediaStructuralPrice, hostPriceEvent } from './host-tokens.ts'
import { attachmentsOfEvent, classifySurfaceEvent, isCheckpointNode, mediaBlocksOfEvent } from './messages.ts'
import { guardedSurfaceSeqsOf, isToolEvent, rebuildBlockLedger, reasoningOf, staleFoldableHostRowSeqs } from './region.ts'
import { eventAtOf, sessionEventsOf } from './session-events.ts'

/** What the engine remembers about its last range-table build for one session. */
export interface AcpInspectCache {
  /** When `rangeTable` last ran for this session. */
  capturedAt: number
  /** Pressure gauge (the nudge's own number for the same surface). */
  pressure?: number
  /** The sustainable input budget the engine compresses against. */
  window?: number
  /** Where `window` came from (see the snapshot's `usage.windowSource`). */
  windowSource?: 'engine' | 'projection' | 'default'
  breakdown?: {
    tool: number
    text: number
    code: number
    summaries: number
    system: number
  }
  rows: AcpInspectRow[]
  sweeps: AcpInspectSweep[]
  /** The sweep's complement map, when the last build produced one. */
  complement?: AcpInspectComplement
  /** Session id → its cache; replaced in place on every build. */
}

const caches = new Map<string, AcpInspectCache>()

/** Remember the rows/sweeps one range-table build produced. */
export function rememberRangeTable(
  sessionId: string,
  rows: readonly AcpInspectRow[],
  sweeps: readonly AcpInspectSweep[],
  complement?: AcpInspectComplement,
): void {
  const cache = caches.get(sessionId) ?? { capturedAt: 0, rows: [], sweeps: [] }
  cache.capturedAt = Date.now()
  cache.rows = [...rows]
  cache.sweeps = [...sweeps]
  cache.complement = complement
  caches.set(sessionId, cache)
}

/** Remember the pressure gauge (cheap: every pre-step knows it). */
export function rememberPressure(
  sessionId: string,
  pressure: number,
  window: number | undefined,
  windowSource?: 'engine' | 'projection' | 'default',
): void {
  const cache = caches.get(sessionId) ?? { capturedAt: Date.now(), rows: [], sweeps: [] }
  cache.pressure = pressure
  if (window !== undefined) cache.window = window
  if (windowSource !== undefined) cache.windowSource = windowSource
  caches.set(sessionId, cache)
}

/** Remember the surface breakdown (only computed when a nudge actually fires). */
export function rememberBreakdown(sessionId: string, breakdown: AcpInspectCache['breakdown']): void {
  const cache = caches.get(sessionId) ?? { capturedAt: Date.now(), rows: [], sweeps: [] }
  if (breakdown !== undefined) cache.breakdown = breakdown
  caches.set(sessionId, cache)
}

export function inspectCacheOf(sessionId: string): AcpInspectCache | undefined {
  return caches.get(sessionId)
}

/**
 * Mark one session's remembered table as stale.
 *
 * Called when a compression lands (the surface just moved, so EVERY remembered
 * row may name seqs that are gone) and when the session is disposed. The rows
 * are kept — the panel keeps showing the last offer, greyed and marked — but the
 * age is zeroed so the next panel read (or pre-step) rebuilds instead of serving
 * a table whose spans no longer exist.
 */
export function invalidateInspectTable(sessionId: string): void {
  const cache = caches.get(sessionId)
  if (cache !== undefined) cache.capturedAt = 0
}

/** Drop one session's cache (forget on session disposal). */
export function forgetInspectCache(sessionId: string): void {
  caches.delete(sessionId)
}

/** The structural slice of the host `sessions` service the route needs. */
export interface InspectSessionsFace {
  get?(sessionId: string): unknown
}

/** What the route needs from its host: the context, the live settings, the preset name. */
export interface InspectRouteHost {
  readonly ctx: { get(name: string): unknown }
  /**
   * Make sure a table snapshot exists for this session (the engine builds one on
   * demand when the remembered one is missing or old). Optional: a host that
   * cannot build one simply serves whatever it remembers.
   */
  readonly ensureFresh?: (sessionId: string, session: Session) => Promise<void>
  readonly settings: {
    readonly modelContextLimit?: number
    readonly nudgeMinContextLimitPct?: number
    readonly nudgeMaxContextLimitPct: number
    readonly nudgeEmergencyThresholdPct: number
    readonly cacheMissPriceRatio: number
  }
  readonly preset?: string
  /** Kernel fallback for an absent `nudgeMinContextLimitPct` (the floor it reads). */
  readonly kernelNudgeMinContextLimitPct: number
  /** Fallback denominator when the settings name no explicit limit. */
  readonly defaultContextWindow: number
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
export async function handleInspectRequest(host: InspectRouteHost, request: Request): Promise<Response> {
  const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const body = await request.json() as { sessionId?: unknown }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') {
      return reply({ ok: false, error: { code: 'bad-request', message: 'missing sessionId' } }, 400)
    }
    const sessions = host.ctx.get('sessions') as InspectSessionsFace | undefined
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) as Session | undefined : undefined
    if (session === undefined || session === null) return reply({ ok: true, value: null })
    // The panel must never report "0 tokens" just because the engine has not run
    // a pre-step since the last restart: build the table now (on a CLONED kernel
    // state — see the engine's ensureInspectView) when nothing fresh is on record.
    if (host.ensureFresh !== undefined) await host.ensureFresh(sessionId, session)
    const { settings } = host
    return reply({
      ok: true,
      value: buildInspectSnapshot({
        sessionId,
        session,
        cache: inspectCacheOf(sessionId),
        blocks: inspectBlocksOf(session),
        settings: {
          modelContextLimit: settings.modelContextLimit ?? host.defaultContextWindow,
          // Absent = the kernel's own floor stays in effect; show THAT number
          // rather than a blank the reader would misread as "no limit".
          nudgeMinContextLimitPct: settings.nudgeMinContextLimitPct ?? host.kernelNudgeMinContextLimitPct,
          nudgeMaxContextLimitPct: settings.nudgeMaxContextLimitPct,
          nudgeEmergencyThresholdPct: settings.nudgeEmergencyThresholdPct,
          cacheMissPriceRatio: settings.cacheMissPriceRatio,
          ...(host.preset === undefined ? {} : { preset: host.preset }),
        },
      }),
    })
  } catch (error) {
    return reply({
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    }, 500)
  }
}

/**
 * Build the panel payload: the remembered table, the live surface map, the
 * durable ledger, and the live settings.
 *
 * @param input - session, its cache, the ledger rows, the settings readout.
 * @returns the wire snapshot (never throws for a session-shaped input).
 */
export function buildInspectSnapshot(input: {
  sessionId: string
  session: Session
  cache: AcpInspectCache | undefined
  blocks: readonly AcpInspectBlock[]
  settings: AcpInspectSettings
}): AcpInspectSnapshot {
  const { session, sessionId } = input
  const nodes = session.surface.nodes
  const guarded = guardedSurfaceSeqsOf(session)
  const staleFoldable = staleFoldableHostRowSeqs(session)
  const map: AcpInspectNode[] = []
  for (const seq of nodes) {
    const event = eventAtOf(session, seq)
    if (event === undefined) continue
    const attachments = attachmentsOfEvent(event)
    const media = attachments.images + attachments.files > 0
      ? hostMediaStructuralPrice(mediaBlocksOfEvent(event))
      : 0
    map.push({
      seq,
      tokens: hostPriceEvent(event) + media,
      kind: nodeKindOf(event, guarded.has(seq), staleFoldable.has(seq)),
      ...(guarded.has(seq) ? { barrier: 'current host row — folding it re-injects (or loses) it' } : {}),
    })
  }
  const cache = input.cache
  const pressure = cache?.pressure ?? 0
  const window = cache?.window ?? input.settings.modelContextLimit
  const windowSource = cache?.windowSource
    ?? (input.settings.modelContextLimit === undefined ? 'default' : 'engine')
  return {
    sessionId,
    capturedAt: cache?.capturedAt ?? 0,
    surface: {
      nodes: nodes.length,
      firstSeq: nodes[0] ?? 0,
      lastSeq: nodes[nodes.length - 1] ?? 0,
    },
    usage: {
      tokens: pressure,
      window,
      windowSource,
      pct: window > 0 ? Math.min(100, Math.round((pressure / window) * 100)) : 0,
      breakdown: cache?.breakdown ?? { tool: 0, text: 0, code: 0, summaries: 0, system: 0 },
    },
    map,
    rows: cache?.rows ?? [],
    sweeps: cache?.sweeps ?? [],
    complement: cache?.complement,
    blocks: [...input.blocks],
    settings: input.settings,
  }
}

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
export function inspectBlocksOf(session: Session): AcpInspectBlock[] {
  const ledger = rebuildBlockLedger(sessionEventsOf(session))
  return ledger.map((entry) => {
    // The ledger entry already carries the thinking (decoded from the block's
    // payload); the event lookup is the fallback for a reader that only has the
    // summary node, never the primary path.
    const event = entry.summarySeq === undefined ? undefined : eventAtOf(session, entry.summarySeq)
    const why = entry.reasoning ?? (event === undefined ? undefined : reasoningOf(event))
    return {
      id: entry.blockId,
      shortId: entry.blockId.slice(0, 8),
      start: entry.start,
      end: entry.end,
      messages: entry.shadowedSeqs.length,
      tokens: entry.shadowedTokenCount,
      tier: entry.tier,
      createdAt: entry.createdAt,
      summary: entry.summary,
      ...(why === undefined ? {} : { why }),
    }
  })
}

function nodeKindOf(event: SessionEvent, isGuarded: boolean, isStaleFoldable: boolean): AcpInspectNode['kind'] {
  if (isGuarded) return 'protected'
  if (isCheckpointNode(event)) return 'checkpoint'
  const classification = classifySurfaceEvent(event)
  if (classification === 'instruction') return isStaleFoldable ? 'instruction' : 'protected'
  if (classification === 'metadata') return 'metadata'
  return isToolEvent(event) ? 'tool' : 'text'
}
