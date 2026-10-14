/**
 * Range-table hygiene + nudge actionability (2026-10-14 fragmentation case).
 *
 * Live evidence (session-a41fb964): a 906-node surface offered a 6-entry table
 * in which THREE entries were the same span and one priced at ~0 tokens, while
 * the emergency nudge said "Context limit reached — compress now". The model had
 * no legal target, retried, and its turn degenerated. Two invariants are pinned
 * here: the table never repeats a span / never offers an empty one, and a plain
 * T1 nudge is suppressed when no span is on offer (a tier-2/3 recommendation is
 * still actionable — it targets existing blocks).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import { AcpStateStore } from '../src/state.ts'
import { acpCommand } from '../src/commands.ts'
import { buildCompressibleSeqRanges } from '../src/region.ts'
import { hasActionableTarget } from '../src/nudge.ts'
import { appendTurn, appendUser, longText, buildTextSession } from './helpers.ts'

/** The same span named by two different kernel ranges (duplicate geometry). */
function duplicateSpanView(session: ReturnType<typeof buildTextSession>, from: number, to: number) {
  const nodes = [...session.surface.nodes]
  const start = String(nodes[from]!)
  const end = String(nodes[to]!)
  return {
    ranges: [
      { startRef: 'm00001', endRef: 'm00002' },
      { startRef: 'm00003', endRef: 'm00004' },
    ],
    refs: { byRef: { m00001: start, m00002: end, m00003: start, m00004: end } },
  }
}

test('range table: a span named twice by the kernel is offered once, and never at ~0 tokens', () => {
  const session = buildTextSession(24)
  const ranges = buildCompressibleSeqRanges(session, duplicateSpanView(session, 0, 10) as never)
  const keys = ranges.map((range) => `${range.start}..${range.end}`)
  assert.ok(ranges.length >= 1, 'the span is still offered — dedupe must not drop it entirely')
  assert.equal(new Set(keys).size, keys.length, 'no span is listed twice')
  assert.ok(ranges.every((range) => range.tokens > 0), 'every offered span carries reclaimable tokens')
})

test('/acp-prune status: the context map names the injected rows and the offered table', async () => {
  const session = buildTextSession(12)
  // Two barrier kinds (host state rows the range table must not fold) and one
  // foldable engine-metadata row (the nudge echo) — the map must separate them.
  const injected = (kind: string, plugin?: string) => {
    session.append('user/message', {
      turn: 1,
      step: 1,
      message: { role: 'user', content: [{ type: 'text', text: `injected ${kind}` }] },
      source: plugin === undefined ? { kind } : { kind, plugin },
    } as never, { surfaceOp: 'append' })
  }
  injected('goal')
  injected('time-context')
  injected('plugin:acp-nudge', 'acp-nudge')

  const env = {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    nudgeMaxContextLimitPct: 0.7,
    nudgeEmergencyThresholdPct: 0.85,
    compressCallIdsToHide: new Set<string>(),
  }
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  }
  const result = await acpCommand(env as never).handler({
    commandId: 'cmd-context-map',
    agent,
    rawInput: 'status',
    signal: new AbortController().signal,
  } as never)
  const text = (result as { text: string }).text
  assert.match(text, /── context map ──/, 'the map section is rendered')
  assert.match(text, /surface: \d+ nodes \(seqs \d+\.\.\d+\)/, 'node count + seq span')
  assert.match(text, /injected rows: 2 \(\d+%\) — goal 1 · time-context 1/, 'only the barrier kinds are listed')
  assert.match(text, /compressible: \d+ range\(s\), ~\d+ tokens \(largest \d+\)/, 'offered table summary')
})

test('nudge actionability: an empty offer table makes a plain T1 nudge unactionable', () => {
  const session = buildTextSession(24)
  // A view whose refs resolve to nothing: the kernel believes it can compress,
  // but this surface offers no span at all (the fragmentation case).
  const emptyView = { ranges: [{ startRef: 'm00001', endRef: 'm00002' }], refs: { byRef: {} } }
  const state = { messageRefs: { byRaw: {}, byRef: new Map() } } as never
  assert.equal(
    hasActionableTarget(session, { shouldInject: true, tier: null, compressibleRanges: emptyView.ranges } as never, state),
    false,
    'a plain nudge with nothing on offer is unactionable',
  )

  // The same kernel decision WITH a real offered span is actionable.
  const view = duplicateSpanView(session, 0, 10)
  // `refs.byRef` is a plain ref→id record on the kernel view (see seqOfKernelRef).
  const refsState = { messageRefs: { byRaw: {}, byRef: view.refs.byRef } } as never
  assert.equal(
    hasActionableTarget(session, { shouldInject: true, tier: null, compressibleRanges: view.ranges } as never, refsState),
    true,
    'an offered span makes the nudge actionable',
  )

  // A tier-2 recommendation targets existing blocks, so it needs no plain span.
  assert.equal(
    hasActionableTarget(session, { shouldInject: true, tier: 2, compressibleRanges: [] } as never, state),
    true,
    'a tier-2 distillation stays actionable without a plain range',
  )
})
