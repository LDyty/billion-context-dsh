/**
 * The inspector panel's host half: the remembered range table, the surface map,
 * the block ledger with its captured thinking, and the route that serves them.
 *
 * The panel is only worth looking at if it shows what the ENGINE showed, so the
 * assertions here compare the snapshot against the rendered nudge and against the
 * durable ledger rather than against hand-written numbers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createCore } from 'acp-kernel'
import { AcpStateStore } from '../src/state.ts'
import { buildInspectSnapshot, handleInspectRequest, inspectBlocksOf, inspectCacheOf, rememberPressure } from '../src/inspect.ts'
import { buildNudge, rangeTable } from '../src/nudge.ts'
import { runCompactionTransaction } from '../src/region.ts'
import { isDiscardSummary, makeTools } from '../src/tools.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendTurn, appendUser, buildTextSession, longText, wholeSurfaceRangeView } from './helpers.ts'

function makeEnv(limit = 128000): ToolEnvironment {
  return {
    kernel: createCore({}),
    store: new AcpStateStore(),
    modelContextLimit: limit,
    compressCallIdsToHide: new Set(),
  }
}

/** A session with a stale+cured instruction pair, a checkpoint and a tool pair. */
function buildRichSession(): Session {
  const session = Session.create('inspect-fixture')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  appendAssistant(session, longText('a0', 1), 1, 1)
  session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder> Additional instructions from: AGENTS.md v1' }],
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ scope: 'AGENTS.md' }] },
  } as never, { surfaceOp: 'append' }) // stale copy
  appendToolCall(session, longText('call', 2), 'c1', 1, 2)
  appendToolResult(session, longText('res', 3), 'c1', 1, 2)
  session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder> Updated instructions from: AGENTS.md v2' }],
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ scope: 'AGENTS.md' }] },
  } as never, { surfaceOp: 'append' }) // CURRENT — must read `protected`
  const node = session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: '[Model-written summary] earlier work folded' }],
    source: { kind: 'compact-checkpoint', compactionId: 'compact-inspect' },
  } as never, { surfaceOp: 'append' })
  void node
  for (let index = 0; index < 6; index += 1) {
    appendUser(session, longText('tail', index))
    appendAssistant(session, longText('tail-a', index), 1, 10 + index)
  }
  return session
}

test('inspect: the snapshot serves the remembered table, map kinds and settings', () => {
  const session = buildRichSession()
  // Building the table is what remembers it (the engine does this on every pre-step).
  const text = rangeTable(session, wholeSurfaceRangeView(session) as never)
  const snapshot = buildInspectSnapshot({
    sessionId: String(session.id),
    session,
    cache: inspectCacheOf(String(session.id)),
    blocks: [],
    settings: {
      modelContextLimit: 200000,
      nudgeMinContextLimitPct: 0.7,
      nudgeMaxContextLimitPct: 0.85,
      nudgeEmergencyThresholdPct: 0.95,
    },
  })

  assert.ok(text.includes('Compressible ranges'), 'the fixture really renders a table')
  assert.ok(snapshot.rows.length > 0, 'the snapshot carries the rows')
  assert.equal(snapshot.rows[0]!.band, 1, 'bands are numbered from the oldest')
  // The panel's rows ARE the printed rows: same seqs, same tokens.
  for (const row of snapshot.rows) {
    assert.ok(text.includes(`${row.start}..${row.end}`), `row ${row.start}..${row.end} appears in the nudge text`)
    assert.ok(text.includes(`~${row.tokens} tokens`), `row ${row.start}..${row.end} prints the same size`)
  }
  for (const sweep of snapshot.sweeps) {
    assert.ok(
      text.includes(`all ${sweep.entries} spans in ONE call`),
      `sweep under ${sweep.rowStart} prints the same entry count`,
    )
    assert.ok(sweep.spans.length === sweep.entries, 'the sweep carries one span per entry (copy-paste ready)')
  }
  assert.equal(snapshot.surface.nodes, session.surface.nodes.length)
  assert.equal(snapshot.usage.window, 200000, 'the panel shows the configured window')
  // The panel mirrors the nudge's `offered N×` column too (same counter).
  assert.ok(snapshot.rows.every((row) => row.offered >= 1), 'every row carries its offer count')
  assert.equal(snapshot.rows[0]!.offered, 1, 'and a first build reports 1')
  // …and the reasoning column: the panel prints the SAME character-based share
  // the nudge row prints (one remembered build, no recomputation).
  for (const row of snapshot.rows) {
    assert.ok(Number.isInteger(row.reasoningPct) && row.reasoningPct >= 0 && row.reasoningPct <= 100,
      `row ${row.start}..${row.end} carries its reasoning share`)
    assert.ok(text.includes(`| reasoning ${row.reasoningPct}% |`),
      `row ${row.start}..${row.end} prints the same reasoning share as the panel`)
    assert.ok(text.includes(`${String(row.messages)} messages (${row.rowMix})`),
      `row ${row.start}..${row.end} prints the same row mix as the panel`)
  }

  // The map's legend matches the engine's folding decision, not a second opinion.
  const kinds = new Map(snapshot.map.map((node) => [node.seq, node.kind]))
  const instructionRows = session.surface.nodes.filter((seq) => {
    const event = session.eventAt(seq)
    return (event?.data as { source?: { kind?: string } } | undefined)?.source?.kind === 'agent-instructions'
  })
  assert.equal(instructionRows.length, 2, 'the fixture has a stale and a current instruction row')
  assert.equal(kinds.get(instructionRows[0]!), 'instruction', 'the superseded copy reads as foldable')
  assert.equal(kinds.get(instructionRows[1]!), 'protected', 'the CURRENT copy reads as protected')
  const checkpointSeq = session.surface.nodes.find((seq) => {
    const event = session.eventAt(seq)
    return (event?.data as { source?: { kind?: string } } | undefined)?.source?.kind === 'compact-checkpoint'
  })
  assert.equal(kinds.get(checkpointSeq!), 'checkpoint')
  assert.ok([...kinds.values()].includes('tool'), 'tool traffic is labelled')
  assert.ok([...kinds.values()].includes('text'), 'conversation is labelled')
})

test('inspect: the ledger carries each block with the thinking that produced it', () => {
  const session = buildTextSession(12)
  const thinking = 'These tool outputs are consumed; folding from near the tail keeps the prefix rewrite cheap.'
  runCompactionTransaction(session, {
    start: 1,
    end: 5,
    shadowedSeqs: [1, 2, 3, 4, 5],
    summary: [{ type: 'text', text: 'Earlier work: JWT access tokens, 15 minute expiry, refresh in Redis.' }],
    shadowedTokenCount: 1234,
    provider: 'p',
    model: 'm',
    reasoning: thinking,
  })
  const blocks = inspectBlocksOf(session)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.tokens, 1234, 'the ledger price rides through')
  assert.equal(blocks[0]!.messages, 5, 'and the shadowed message count')
  assert.equal(blocks[0]!.why, thinking, 'the model’s own thinking is on the panel')
  assert.equal(blocks[0]!.shortId, blocks[0]!.id.slice(0, 8))
})

test('inspect route: bad body, unknown session, and a real snapshot', async () => {
  const session = buildRichSession()
  rangeTable(session, wholeSurfaceRangeView(session) as never)
  const host = {
    ctx: { get: (name: string) => (name === 'sessions' ? { get: (id: string) => (id === String(session.id) ? session : undefined) } : undefined) },
    settings: {
      modelContextLimit: 128000,
      nudgeMinContextLimitPct: 0.7,
      nudgeMaxContextLimitPct: 0.85,
      nudgeEmergencyThresholdPct: 0.95,
    },
    kernelNudgeMinContextLimitPct: 0.45,
    defaultContextWindow: 128000,
  }
  const post = (body: unknown): Request => new Request('http://local/api/billion-context/inspect', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  const bad = await handleInspectRequest(host, post({}))
  assert.equal(bad.status, 400, 'a body without a sessionId is refused')
  const missing = await handleInspectRequest(host, post({ sessionId: 'nope' }))
  assert.equal(missing.status, 200)
  assert.deepEqual(await missing.json(), { ok: true, value: null }, 'an unknown session resolves to null, not an error')
  const good = await handleInspectRequest(host, post({ sessionId: String(session.id) }))
  assert.equal(good.status, 200)
  const payload = await good.json() as { ok: boolean; value: { rows: unknown[]; map: unknown[] } | null }
  assert.equal(payload.ok, true)
  assert.ok((payload.value?.rows.length ?? 0) > 0, 'the real read carries the rows')
  assert.ok((payload.value?.map.length ?? 0) > 0, 'and the surface map')
})

test('inspect: a session the engine never built a table for still answers (empty rows)', () => {
  const session = buildTextSession(12)
  const snapshot = buildInspectSnapshot({
    sessionId: String(session.id),
    session,
    cache: undefined,
    blocks: [],
    settings: {
      modelContextLimit: 128000,
      nudgeMinContextLimitPct: 0.7,
      nudgeMaxContextLimitPct: 0.85,
      nudgeEmergencyThresholdPct: 0.95,
    },
  })
  assert.deepEqual(snapshot.rows, [], 'no remembered build → no rows (the panel says so instead of inventing them)')
  assert.equal(snapshot.capturedAt, 0)
  assert.ok(snapshot.map.length > 0, 'the live map is still served')
})

test('inspect: the panel mirrors each row\'s sweep (same entries/reclaims/payback), including "no sweep"', () => {
  // The panel's 清扫 column is built from the SAME remembered sweep objects the
  // nudge printed, so the two surfaces cannot drift: every row that printed a
  // sweep line has a snapshot sweep with the identical entry count, reclaim, and
  // payback, and a row that printed nothing has none.
  const session = buildTextSession(24)
  const spans: [number, number][] = [[0, 2], [4, 6], [8, 10], [12, 14], [16, 18]]
  const nodes = [...session.surface.nodes]
  const view = {
    ranges: spans.map(([,], index) => ({ startRef: `s${index}`, endRef: `e${index}` })),
    refs: {
      byRef: Object.fromEntries(spans.flatMap(([from, to], index) => [
        [`s${index}`, String(nodes[from]!)],
        [`e${index}`, String(nodes[to]!)],
      ])),
    },
  }
  const text = rangeTable(session, view as never)
  const snapshot = buildInspectSnapshot({
    sessionId: String(session.id),
    session,
    cache: inspectCacheOf(String(session.id)),
    blocks: [],
    settings: {
      modelContextLimit: 200000,
      nudgeMinContextLimitPct: 0.7,
      nudgeMaxContextLimitPct: 0.85,
      nudgeEmergencyThresholdPct: 0.95,
    },
  })

  // The nudge names sweeps by the seq they start at; the rows carry the same
  // starts. Pair them up through the printed text.
  const lines = text.split('\n')
  let withSweep = 0
  let withoutSweep = 0
  for (const [index, line] of lines.entries()) {
    const rowMatch = /^\s+- seq (\d+)\.\.(\d+) —/.exec(line)
    if (rowMatch === null) continue
    const start = Number(rowMatch[1])
    const sweepLine = lines[index + 2] ?? ''
    const sweep = snapshot.sweeps.find((entry) => entry.rowStart === start)
    if (sweepLine.includes('sweep from here')) {
      withSweep += 1
      assert.ok(sweep, `row ${start} printed a sweep, so the panel has one too`)
      const entries = Number(/all (\d+) spans/.exec(sweepLine)![1])
      assert.equal(sweep!.entries, entries, `row ${start}: the panel lists the same entry count`)
      assert.equal(sweep!.spans.length, entries, 'and one span per entry (copy-paste ready)')
      assert.ok(sweepLine.includes(`~${compactSweepTokens(sweep!.reclaims)} tok total`), `row ${start}: same reclaim`)
      assert.ok(
        sweepLine.includes(`pays back in ~${sweep!.breakEven.toFixed(1)} request(s)`),
        `row ${start}: same payback`,
      )
      // The panel carries the sweep's AGGREGATE composition too, and it is the
      // same three figures the printed line shows (one build, one ruler).
      assert.ok(sweepLine.includes(`(${sweep!.rowMix})`), `row ${start}: same sweep row mix`)
      assert.ok(
        sweepLine.includes(`[tool ${String(sweep!.toolPct)}% | reasoning ${String(sweep!.reasoningPct)}% | text ${String(sweep!.textPct)}%]`),
        `row ${start}: same sweep partition`,
      )
      assert.equal(sweep!.toolPct + sweep!.reasoningPct + sweep!.textPct, 100, 'the sweep partition sums to 100')
      // Forward-only: the sweep starts at the row it is printed under and never
      // reaches back before it (the 2026-10-16 owner rule).
      assert.ok(sweep!.spans.every((span) => span.start >= start), `row ${start}: the sweep never starts earlier`)
      assert.equal(sweep!.spans[0]!.start, start, `row ${start}: the sweep starts AT its own row`)
    } else {
      withoutSweep += 1
      assert.equal(sweep, undefined, `row ${start} printed no sweep, so the panel has none`)
    }
  }
  assert.ok(withSweep >= 1, 'the fixture prints at least one sweep')
  assert.ok(withoutSweep >= 1, 'and at least one row has nothing newer to absorb')
})

/** Mirror of the nudge's `compactTokens` for the reclaim column. */
function compactSweepTokens(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(1)}K` : String(Math.round(tokens))
}

test('inspect: the panel says WHERE its denominator came from', () => {
  const session = buildTextSession(12)
  const settings = {
    modelContextLimit: 800000,
    nudgeMinContextLimitPct: 0.7,
    nudgeMaxContextLimitPct: 0.85,
    nudgeEmergencyThresholdPct: 0.95,
  }
  const snap = (): { usage: { window: number; windowSource: string; pct: number } } => buildInspectSnapshot({
    sessionId: String(session.id),
    session,
    cache: inspectCacheOf(String(session.id)),
    blocks: [],
    settings,
  })
  // No cache at all, but an explicit setting: the engine's own budget.
  assert.equal(snap().usage.windowSource, 'engine')
  assert.equal(snap().usage.window, 800000)
  // A raw route capacity (no output reservation subtracted) is NOT the engine's
  // budget, and the panel must be able to tell the reader which one it shows.
  rememberPressure(String(session.id), 100000, 744000, 'projection')
  assert.equal(snap().usage.windowSource, 'projection')
  assert.equal(snap().usage.window, 744000)
  assert.equal(snap().usage.pct, 13)
  rememberPressure(String(session.id), 100000, 744000, 'engine')
  assert.equal(snap().usage.windowSource, 'engine', 'a nudge-recorded window upgrades the badge')
})

test('inspect: buildNudge remembers the pressure gauge the engine decided on', async () => {
  const env = makeEnv()
  const session = buildTextSession(40)
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const outcome = buildNudge(agent, env, new Map(), new Map())
  const cache = inspectCacheOf(String(session.id))
  assert.ok(cache !== undefined, 'a pre-step remembers something even when the nudge stays silent')
  assert.ok((cache?.pressure ?? 0) > 0, `the pressure gauge is recorded (${String(cache?.pressure)})`)
  if (outcome !== null) {
    assert.ok(cache?.breakdown !== undefined, 'an injected nudge also records the surface breakdown')
  }
})
