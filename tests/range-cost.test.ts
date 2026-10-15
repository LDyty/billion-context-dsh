/**
 * Fold-cost annotations on the nudge range table (2026-10-15).
 *
 * The provider caches a request prefix, so folding a span re-sends every node at
 * and after the span's start as one fresh miss. The cost therefore falls as the
 * span's start moves toward the tail and does not depend on how big the span is —
 * live-measured on one long session: ~3K cold tokens at a 76K-token surface,
 * ~208K at 267K. The table prints that number per row so the model can weigh a
 * cheap-but-tiny span against an expensive-but-large one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCompressibleSeqRanges, foldCostsOfRanges } from '../src/region.ts'
import { bestBatchProposal } from '../src/region.ts'
import { RANGE_TABLE_COST_WARN_BREAK_EVEN, rangeTable } from '../src/nudge.ts'
import { buildTextSession, wholeSurfaceRangeView } from './helpers.ts'

/** A kernel range view offering exactly one span, by node position. */
function spanView(session: ReturnType<typeof buildTextSession>, from: number, to: number) {
  const nodes = [...session.surface.nodes]
  return {
    ranges: [{ startRef: 'm00001', endRef: 'm00002' }],
    refs: { byRef: { m00001: String(nodes[from]!), m00002: String(nodes[to]!) } },
  }
}

/** A kernel range view offering two disjoint spans, so ordering properties have two rows. */
function twoSpanView(session: ReturnType<typeof buildTextSession>) {
  const nodes = [...session.surface.nodes]
  return {
    ranges: [
      { startRef: 'a1', endRef: 'a2' },
      { startRef: 'b1', endRef: 'b2' },
    ],
    refs: {
      byRef: {
        a1: String(nodes[0]!), a2: String(nodes[2]!),
        b1: String(nodes[6]!), b2: String(nodes[9]!),
      },
    },
  }
}

/** A kernel range view offering five disjoint spans, so batch proposals have neighbours. */
function fiveSpanView(session: ReturnType<typeof buildTextSession>) {
  const nodes = [...session.surface.nodes]
  const bounds = [[0, 2], [4, 6], [8, 10], [12, 14], [16, 18]]
  return {
    ranges: bounds.map(([from, to], index) => ({ startRef: `s${index}`, endRef: `e${index}`, from, to })),
    refs: {
      byRef: Object.fromEntries(
        bounds.flatMap(([from, to], index) => [[`s${index}`, String(nodes[from]!)], [`e${index}`, String(nodes[to]!)]]),
      ),
    },
  }
}

test('fold cost: invalidation falls with a later start and never undershoots the span', () => {
  const session = buildTextSession(24)
  const ranges = buildCompressibleSeqRanges(session, twoSpanView(session) as never)
  assert.ok(ranges.length >= 2, 'fixture offers at least two spans')
  const costs = foldCostsOfRanges(session, ranges)
  assert.equal(costs.length, ranges.length, 'one cost entry per offered range')
  for (let at = 0; at < ranges.length; at += 1) {
    const cost = costs[at]!
    const range = ranges[at]!
    assert.ok(cost.invalidatedTokens >= range.tokens, 'a fold re-sends at least the span it replaces')
    assert.equal(cost.breakEvenRequests, cost.invalidatedTokens / range.tokens)
    if (at > 0) {
      assert.ok(
        cost.invalidatedTokens <= costs[at - 1]!.invalidatedTokens,
        'a later span start invalidates no more than an earlier one',
      )
    }
  }
})

test('fold cost: the table prints it, and flags a span that pays back too slowly', () => {
  const session = buildTextSession(24)
  // A two-node span at the head of a 24-node surface: it reclaims little while
  // rewriting everything after it, i.e. the expensive default this is meant to
  // stop hiding.
  const view = spanView(session, 0, 1)
  const text = rangeTable(session, view as never)
  assert.match(
    text,
    /fold cost: reclaims ~[\d.]+K? · rewrites ~[\d.]+K? tok of the cached prefix \(pays back in ~[\d.]+ request\(s\)\)/,
    'every row carries its fold cost',
  )
  const costs = foldCostsOfRanges(session, buildCompressibleSeqRanges(session, view as never))
  assert.ok(costs[0]!.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN, 'fixture is the expensive case')
  assert.ok(text.includes('⚠ expensive'), 'the expensive row is flagged')
  assert.ok(
    text.includes(`~${costs[0]!.breakEvenRequests.toFixed(1)} request(s)`),
    'the printed break-even is the computed one',
  )
})

test('batch proposal: extending forward divides the same rewrite over more tokens', () => {
  const session = buildTextSession(24)
  const ranges = buildCompressibleSeqRanges(session, fiveSpanView(session) as never)
  assert.equal(ranges.length, 5, 'fixture offers five spans')
  const costs = foldCostsOfRanges(session, ranges)
  const base = costs[0]!
  const proposal = bestBatchProposal(ranges, costs, 0, { maxOld: 3, maxNew: 3, minImprovement: 0.25 })
  assert.ok(proposal, 'the earliest, most expensive span gets a proposal')
  assert.ok(proposal.entries.length > 1, 'a proposal adds neighbours')
  assert.equal(proposal.entries[0]!.start, ranges[0]!.start, 'forward-only extension keeps the batch start')
  assert.equal(proposal.invalidatedTokens, base.invalidatedTokens, 'the rewrite is unchanged by newer neighbours')
  assert.ok(proposal.reclaimedTokens > ranges[0]!.tokens, 'the batch reclaims more than its base row')
  assert.ok(proposal.breakEvenRequests < base.breakEvenRequests, 'so the batch pays back sooner')
  // Disjoint by construction: the tool skips overlapping entries in one call.
  for (let at = 1; at < proposal.entries.length; at += 1) {
    assert.ok(proposal.entries[at]!.start > proposal.entries[at - 1]!.end, 'batch entries never overlap')
  }
})

test('batch proposal: no extension, no proposal — and the improvement floor gates it', () => {
  const session = buildTextSession(24)
  const ranges = buildCompressibleSeqRanges(session, fiveSpanView(session) as never)
  const costs = foldCostsOfRanges(session, ranges)
  assert.equal(bestBatchProposal(ranges, costs, 0, { maxOld: 0, maxNew: 0, minImprovement: 0 }), undefined)
  assert.equal(
    bestBatchProposal(ranges, costs, 0, { maxOld: 3, maxNew: 3, minImprovement: 0.99 }),
    undefined,
    'a marginal gain is not printed',
  )
})

test('batch proposal: a flagged row extends only toward newer neighbours', () => {
  const session = buildTextSession(24)
  const text = rangeTable(session, fiveSpanView(session) as never)
  assert.match(text, /cheaper together — batch \d+ entries in ONE call: /, 'the base row carries its batch')
  const rows = text.split('\n')
  // Proposals are claimed worst-cost-first, so the row that carries one is the
  // flagged one — and its batch must not reach backwards.
  const at = rows.findIndex((line, index) =>
    line.includes('- seq ')
    && rows[index + 1]?.includes('⚠')
    && rows[index + 2]?.includes('cheaper together'))
  assert.ok(at >= 0, 'the flagged row carries the escape hatch')
  const baseStart = Number(/seq (\d+)/.exec(rows[at]!)![1])
  const batchLine = rows[at + 2]!
  const entryStarts = [...batchLine.matchAll(/(\d+)\.\.\d+/g)].map((match) => Number(match[1]))
  assert.ok(entryStarts.every((start) => start >= baseStart), 'no entry starts before the flagged base row')
})
