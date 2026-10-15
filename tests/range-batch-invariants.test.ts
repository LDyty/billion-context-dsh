/**
 * Batch-proposal invariants across surface shapes (2026-10-15).
 *
 * The proposal layer has to stay legal and monotone on every shape it meets, not
 * just the tidy ladder in the focused tests: a single offerable range, a base row
 * at either end, neighbours that all overlap the base, thousands of tiny ranges,
 * and the ⚠ case where only NEWER neighbours may join. Each case asserts the same
 * contract, so a later change to the extension policy has to keep all of them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bestBatchProposal,
  buildCompressibleSeqRanges,
  foldCostsOfRanges,
  type RangeFoldCost,
  type SeqCompressibleRange,
} from '../src/region.ts'
import {
  RANGE_TABLE_BATCH_MAX_NEW,
  RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE,
  RANGE_TABLE_BATCH_MAX_OLD,
  RANGE_TABLE_BATCH_LABEL_LIMIT,
  RANGE_TABLE_BATCH_MIN_IMPROVEMENT,
  RANGE_TABLE_COST_WARN_BREAK_EVEN,
  rangeTable,
} from '../src/nudge.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendUser, buildTextSession, longText } from './helpers.ts'

/** A view offering the given node-position spans, in order. */
function viewOfPositions(session: ReturnType<typeof buildTextSession>, spans: readonly (readonly [number, number])[]) {
  const nodes = [...session.surface.nodes]
  return {
    ranges: spans.map((_, index) => ({ startRef: `s${index}`, endRef: `e${index}` })),
    refs: {
      byRef: Object.fromEntries(spans.flatMap(([from, to], index) =>
        [[`s${index}`, String(nodes[from]!)], [`e${index}`, String(nodes[to]!)]])),
    },
  }
}

/** Deterministic 32-bit LCG so a failing shape is reproducible. */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Assert every contract a proposal must satisfy, whatever the shape. */
function assertProposalContract(
  proposal: { entries: readonly SeqCompressibleRange[]; reclaimedTokens: number; invalidatedTokens: number; breakEvenRequests: number },
  ranges: readonly SeqCompressibleRange[],
  costs: readonly RangeFoldCost[],
  baseIndex: number,
): void {
  const base = costs[baseIndex]!
  assert.ok(proposal.entries.length > 1, 'a proposal always adds at least one neighbour')
  assert.ok(proposal.entries.some((entry) => entry.start === ranges[baseIndex]!.start), 'the base row stays in its own batch')
  for (let at = 1; at < proposal.entries.length; at += 1) {
    assert.ok(
      proposal.entries[at]!.start > proposal.entries[at - 1]!.end,
      'batch entries are disjoint and position-sorted — an overlapping entry is silently skipped by the tool',
    )
  }
  const reclaimed = proposal.entries.reduce((sum, entry) => sum + entry.tokens, 0)
  assert.equal(proposal.reclaimedTokens, reclaimed, 'reclaimed is the sum of the entries')
  const firstIndex = ranges.findIndex((range) => range.start === proposal.entries[0]!.start)
  assert.ok(firstIndex >= 0, 'the batch opens on an offerable range')
  assert.equal(proposal.invalidatedTokens, costs[firstIndex]!.invalidatedTokens, 'the rewrite is the earliest entry’s rewrite')
  assert.equal(proposal.breakEvenRequests, proposal.invalidatedTokens / proposal.reclaimedTokens)
  assert.ok(proposal.breakEvenRequests < base.breakEvenRequests, 'a proposal is always cheaper per token than its base row')
  assert.ok(
    proposal.breakEvenRequests <= base.breakEvenRequests * (1 - RANGE_TABLE_BATCH_MIN_IMPROVEMENT),
    'and clears the improvement floor',
  )
  // The ⚠ policy: an expensive base row may only reach NEWER neighbours, because
  // its rewrite is fixed by where it starts.
  if (base.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN) {
    assert.ok(
      proposal.entries.every((entry) => entry.start >= ranges[baseIndex]!.start),
      'a flagged row never extends backwards',
    )
    assert.ok(
      proposal.entries.length <= 1 + RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE,
      'a flagged row respects its own new-neighbour cap',
    )
  } else {
    assert.ok(proposal.entries.length <= 1 + RANGE_TABLE_BATCH_MAX_NEW + RANGE_TABLE_BATCH_MAX_OLD, 'a normal row respects both caps')
  }
}

test('batch proposal: single offerable range never proposes anything', () => {
  const session = buildTextSession(24)
  const ranges = buildCompressibleSeqRanges(session, viewOfPositions(session, [[4, 10]]) as never)
  const costs = foldCostsOfRanges(session, ranges)
  assert.equal(bestBatchProposal(ranges, costs, 0, { maxOld: 3, maxNew: 3, minImprovement: 0.25 }), undefined)
})

test('batch proposal: overlapping neighbours cannot be batched', () => {
  const session = buildTextSession(24)
  // Every span shares text with the base, so no disjoint neighbour exists.
  const ranges = buildCompressibleSeqRanges(session, viewOfPositions(session, [[4, 10], [5, 9], [4, 8]]) as never)
  const costs = foldCostsOfRanges(session, ranges)
  const widest = ranges.findIndex((range) => range.start === Math.min(...ranges.map((entry) => entry.start)))
  const overlapping = ranges.filter((range) => !(range.start > ranges[widest]!.end || range.end < ranges[widest]!.start))
  assert.equal(overlapping.length, ranges.length, 'the fixture really is all-overlapping')
  assert.equal(
    bestBatchProposal(ranges, costs, widest, { maxOld: 3, maxNew: 3, minImprovement: 0.25 }),
    undefined,
    'no disjoint neighbour means no proposal — not a batch of one',
  )
  for (let at = 0; at < ranges.length; at += 1) {
    const proposal = bestBatchProposal(ranges, costs, at, { maxOld: 3, maxNew: 3, minImprovement: 0.25 })
    if (proposal !== undefined) assertProposalContract(proposal, ranges, costs, at)
  }
})

test('batch proposal: a flagged newest row has nothing newer to absorb', () => {
  const session = buildTextSession(24)
  const ranges = buildCompressibleSeqRanges(session, viewOfPositions(session, [[0, 2], [4, 6], [8, 18]]) as never)
  const costs = foldCostsOfRanges(session, ranges)
  const last = ranges.length - 1
  const proposal = bestBatchProposal(ranges, costs, last, { maxOld: 0, maxNew: 6, minImprovement: 0.25 })
  assert.equal(proposal, undefined, 'the newest row has no newer neighbour, and a flagged row may not reach back')
})

test('batch proposal: every shape of the random matrix keeps the contract', () => {
  let proposals = 0
  let checked = 0
  for (let seed = 1; seed <= 24; seed += 1) {
    const random = makeRandom(seed * 7919)
    const nodes = 12 + Math.floor(random() * 24)
    const session = buildTextSession(nodes)
    // Random disjoint spans inside the surface, leaving the protected tail alone.
    const spans: Array<[number, number]> = []
    let cursor = 0
    while (cursor + 1 < nodes - 5) {
      const width = 1 + Math.floor(random() * 3)
      const gap = Math.floor(random() * 3)
      spans.push([cursor, Math.min(cursor + width, nodes - 6)])
      cursor += width + 1 + gap
    }
    if (spans.length < 2) continue
    const ranges = buildCompressibleSeqRanges(session, viewOfPositions(session, spans) as never)
    if (ranges.length < 2) continue
    const costs = foldCostsOfRanges(session, ranges)
    for (let at = 0; at < ranges.length; at += 1) {
      checked += 1
      const flagged = costs[at]!.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN
      const proposal = bestBatchProposal(ranges, costs, at, {
        maxOld: flagged ? 0 : RANGE_TABLE_BATCH_MAX_OLD,
        maxNew: flagged ? RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE : RANGE_TABLE_BATCH_MAX_NEW,
        minImprovement: RANGE_TABLE_BATCH_MIN_IMPROVEMENT,
      })
      if (proposal === undefined) continue
      proposals += 1
      assertProposalContract(proposal, ranges, costs, at)
    }
  }
  assert.ok(checked > 40, `matrix covers enough rows (checked ${checked})`)
  assert.ok(proposals > 5, `matrix actually exercises proposals (got ${proposals})`)
})

test('sweep: the rendered table carries one sweep per row, and keeps its claims', () => {
  for (const nodeCount of [16, 24, 40]) {
    const session = buildTextSession(nodeCount)
    const spans: Array<[number, number]> = []
    for (let cursor = 0; cursor + 1 < nodeCount - 5; cursor += 4) spans.push([cursor, cursor + 2])
    const view = viewOfPositions(session, spans)
    const text = rangeTable(session, view as never)
    const rows = text.split('\n')
    const baseLines = rows.filter((line) => /^\s+- seq /.test(line))
    const sweepLines = rows.filter((line) => line.includes('sweep from here'))
    // One sweep per row at most: the row count is the cap (2026-10-16 policy —
    // every row may carry its own sweep, because the choice is the sweep's SCOPE
    // and two neighbouring rows legitimately print overlapping sweeps).
    assert.ok(sweepLines.length <= baseLines.length, 'never more sweeps than rows')
    for (const line of sweepLines) {
      const entries = [...line.matchAll(/(\d+)\.\.(\d+)/g)].map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
      assert.ok(entries.length > 1, 'a printed sweep lists more than the base row')
      // Every entry carries its size and flavour, and the sweep names its work.
      const labels = [...line.matchAll(/(\d+)\.\.(\d+)\(~([\d.]+K?|\d+) (tool|text|tool \d+%)\)/g)]
      assert.ok(labels.length >= 1 && labels.length <= entries.length, 'entries carry "~size kind" labels')
      for (const label of labels) {
        assert.equal(label[4], 'text', 'a text-only fixture reports text segments')
      }
      for (let at = 1; at < entries.length; at += 1) {
        assert.ok(entries[at]!.start > entries[at - 1]!.end, 'printed entries are disjoint')
      }
      assert.match(line, /\(\d+ messages \/ \d+ summaries to write\)/, 'the sweep states its coverage')
      assert.ok(
        entries.length <= RANGE_TABLE_BATCH_LABEL_LIMIT || line.includes('more spans of this sweep'),
        `a sweep longer than ${String(RANGE_TABLE_BATCH_LABEL_LIMIT)} labels summarises the rest`,
      )
    }
  }
})

/**
 * Rows come from disjoint age bands, so two printed rows can no longer share a
 * start seq — but neighbouring rows still print OVERLAPPING sweeps on purpose:
 * they differ in how far back the fold starts, and that scope choice is what the
 * model is picking between. This used to be deduped (one shared line); it is not
 * any more, so the invariant is "one sweep per row, in printed order" rather
 * than uniqueness.
 */
test('sweep: rows come from disjoint bands, and each row prints at most one sweep', () => {
  const session = buildTextSession(24)
  const text = rangeTable(session, viewOfPositions(session, [[0, 4], [0, 2], [6, 8], [10, 12], [14, 16]]) as never)
  const rows = text.split('\n').filter((line) => /^\s+- seq /.test(line))
  const starts = rows.map((line) => Number(/seq (\d+)/.exec(line)![1]))
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `rows run oldest → newest (${starts.join(',')})`)
  const sweeps = text.split('\n').filter((line) => line.includes('sweep from here'))
  assert.ok(sweeps.length <= rows.length, `at most one sweep per row (${String(sweeps.length)})`)
})

/**
 * Real geometry from a live nudge (2026-10-15 17:44, session-a41fb964): the six
 * rows the model actually saw, including a nested pair (32774..32804 contains
 * 32789..32804). The batch search has to stay legal on that shape, not only on
 * the tidy ladders the other cases build.
 */
test('batch proposal: live table geometry with nested rows keeps the contract', () => {
  const [surfaceStart, surfaceEnd, surfaceTokens] = [26824, 35585, 350_000]
  const rows = [
    { start: 31546, end: 31567, tokens: 2089 },
    { start: 32774, end: 32804, tokens: 4789 },
    { start: 32789, end: 32804, tokens: 3708 },
    { start: 34818, end: 34859, tokens: 1995 },
    { start: 35367, end: 35430, tokens: 2939 },
    { start: 35470, end: 35526, tokens: 10986 },
  ].map((row) => ({ ...row, count: 1, toolPct: 100, images: 0, files: 0 }))
  // Production hands the search its position-sorted offerable list, so the
  // fixture sorts by start rather than by the table's printed order.
  rows.sort((a, b) => a.start - b.start)
  const costs = rows.map((row) => {
    const position = Math.max(0, Math.min(1, 1 - (row.start - surfaceStart) / (surfaceEnd - surfaceStart)))
    const invalidatedTokens = surfaceTokens * position
    return { invalidatedTokens, breakEvenRequests: invalidatedTokens / row.tokens }
  })
  let proposals = 0
  for (let at = 0; at < rows.length; at += 1) {
    const flagged = costs[at]!.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN
    const proposal = bestBatchProposal(rows, costs, at, {
      maxOld: flagged ? 0 : RANGE_TABLE_BATCH_MAX_OLD,
      maxNew: flagged ? RANGE_TABLE_BATCH_MAX_NEW_EXPENSIVE : RANGE_TABLE_BATCH_MAX_NEW,
      minImprovement: RANGE_TABLE_BATCH_MIN_IMPROVEMENT,
    })
    if (proposal === undefined) continue
    proposals += 1
    assertProposalContract(proposal, rows, costs, at)
  }
  assert.ok(proposals >= 2, `the live shape produces proposals (got ${proposals})`)
  // The nested pair overlaps, so the containing row can never ride along inside
  // the contained row's batch — the tool would silently skip it.
  const nested = bestBatchProposal(rows, costs, 2, { maxOld: 3, maxNew: 3, minImprovement: 0.01 })
  if (nested !== undefined) {
    assert.ok(
      nested.entries.every((entry) => !(entry.start === 32774 && entry.end === 32804)),
      'the containing row cannot join the contained row’s batch',
    )
  }
})

test('sweep: entry labels report each segment flavour, not just the row above', () => {
  const session = buildTextSession(40)
  appendToolCall(session, 'tool run', 'c1', 1, 1)
  // A sweep pulls in whatever lowers payback, including the tool span sitting
  // between the text rows; the labels must say which is which.
  appendToolResult(session, longText('toolout', 1).repeat(24), 'c1', 1, 1)
  // Four more text messages keep the tool rows out of the protected tail.
  for (let index = 0; index < 4; index += 1) {
    appendUser(session, longText('tail', index))
    appendAssistant(session, longText('tail-reply', index))
  }
  // The tool pair lands right after the 40 text nodes, above the protected tail.
  const text = rangeTable(session, viewOfPositions(session, [[0, 1], [40, 41]]) as never)
  const batchLine = text.split('\n').find((line) => line.includes('sweep from here'))
  assert.ok(batchLine, 'the text span and the tool span sweep together')
  const kinds = [...batchLine.matchAll(/\(~[\d.]+K? (tool|text|tool \d+%)\)/g)].map((match) => match[1])
  assert.ok(kinds.includes('text'), `text segments are labelled text (${batchLine})`)
  assert.ok(
    kinds.some((kind) => kind === 'tool' || kind.startsWith('tool ')),
    `tool segments are labelled tool (${batchLine})`,
  )
})
