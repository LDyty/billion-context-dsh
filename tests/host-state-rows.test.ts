/**
 * Audited host "state echo" rows — the 2026-10-14 fragmentation root fix.
 *
 * goal rounds, time snapshots, and agent-team deliveries each write a fresh
 * row, so only the NEWEST row of a kind carries current state; older rows are
 * history (like a finished turn) and must not keep splitting compressible
 * spans. Live case: 241 such rows (goal 186 / time-context 20 / team-message 17)
 * chopped a 906-node surface into 3-4 node runs, the offered table collapsed to
 * six entries and the nudge demanded a compression with no legal target. The
 * newest row of each kind stays a barrier, and AGENTS.md rows are untouched
 * (folding a current instruction row provokes an immediate re-injection).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildCompressibleSeqRanges, staleFoldableHostRowSeqs } from '../src/region.ts'
import { appendAssistant, appendUser, buildTextSession, longText, wholeSurfaceRangeView } from './helpers.ts'

/** Append one host state-echo row and return its surface seq. */
function inject(session: Session, kind: string, extra: Record<string, unknown> = {}): number {
  session.append('user/message', {
    turn: 1,
    step: 1,
    message: { role: 'user', content: [{ type: 'text', text: `state echo ${kind}` }] },
    source: { kind, ...extra },
  } as never, { surfaceOp: 'append' })
  const nodes = session.surface.nodes
  return nodes[nodes.length - 1]!
}

const covers = (ranges: { start: number; end: number }[], seq: number): boolean =>
  ranges.some((range) => range.start <= seq && seq <= range.end)

test('host state echoes: a superseded row stops splitting spans, the newest one still does', () => {
  const session = buildTextSession(4)
  const staleGoal = inject(session, 'goal', { goalId: 'g1', revision: 1, round: 1 })
  appendUser(session, longText('mid', 1))
  appendAssistant(session, longText('mid-a', 1))
  const newestGoal = inject(session, 'goal', { goalId: 'g1', revision: 1, round: 2 })
  const staleTime = inject(session, 'time-context')
  const newestTime = inject(session, 'time-context')
  // Tail traffic: keeps the newest echo rows out of the protected recent window.
  for (let index = 0; index < 4; index += 1) {
    appendUser(session, longText('tail', index))
    appendAssistant(session, longText('tail-a', index))
  }

  const stale = staleFoldableHostRowSeqs(session)
  assert.ok(stale.has(staleGoal), 'the superseded goal row is foldable')
  assert.ok(!stale.has(newestGoal), 'the newest goal row stays a barrier')
  assert.ok(stale.has(staleTime), 'the superseded time-context row is foldable')
  assert.ok(!stale.has(newestTime), 'the newest time-context row stays a barrier')

  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session) as never)
  assert.ok(ranges.length > 0, 'the fixture offers at least one span')
  assert.ok(covers(ranges, staleGoal), 'a span may cross the superseded goal row now')
  assert.ok(!covers(ranges, newestGoal), 'no span crosses the newest goal row')
  assert.ok(!covers(ranges, newestTime), 'no span crosses the newest time-context row')
})

test('host state echoes: instruction rows are never covered by the audit', () => {
  const session = buildTextSession(4)
  const instructions = inject(session, 'agent-instructions', { form: 'instructions', changes: [{ scope: 'AGENTS.md' }] })
  const other = inject(session, 'runtime-context')
  for (let index = 0; index < 4; index += 1) {
    appendUser(session, longText('tail', index))
    appendAssistant(session, longText('tail-a', index))
  }

  const stale = staleFoldableHostRowSeqs(session)
  assert.ok(!stale.has(instructions), 'AGENTS.md rows are never treated as superseded state echoes')
  assert.ok(!stale.has(other), 'an already-foldable kind needs no override')
})
