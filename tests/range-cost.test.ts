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
import { Session } from '@deepseek-ai/dsh-session'
import { buildCompressibleSeqRanges, foldCostsOfRanges, shadowedSeqsOf } from '../src/region.ts'
import { bestBatchProposal } from '../src/region.ts'
import {
  RANGE_TABLE_BATCH_RECOMMEND_BREAK_EVEN,
  RANGE_TABLE_COST_WARN_BREAK_EVEN,
  rangeTable,
} from '../src/nudge.ts'
import { hostPriceEvent, shadowedTokensViaMeter } from '../src/host-tokens.ts'
import {
  appendAssistant,
  appendToolCall,
  appendToolResult,
  appendTurn,
  appendUser,
  buildTextSession,
  longText,
  wholeSurfaceRangeView,
} from './helpers.ts'

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

test('batch proposal: a flagged row may only extend toward newer neighbours', () => {
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
  const ranges = buildCompressibleSeqRanges(session, view as never)
  const costs = foldCostsOfRanges(session, ranges)
  // The flagged row's own search must never reach backwards: its rewrite is
  // fixed by where it starts, so pulling in older neighbours can only deepen the
  // cost the flag warns about (production passes maxOld 0 for a flagged row).
  const flaggedAt = costs.findIndex((cost) => cost.breakEvenRequests >= RANGE_TABLE_COST_WARN_BREAK_EVEN)
  assert.ok(flaggedAt >= 0, 'the fixture still has an expensive row')
  const backwards = bestBatchProposal(ranges, costs, flaggedAt, {
    maxOld: 0,
    maxNew: 6,
    minImprovement: 0,
  })
  for (const entry of backwards?.entries ?? []) {
    assert.ok(entry.start >= ranges[flaggedAt]!.start, 'a flagged row only absorbs newer neighbours')
  }
  // The rendered side of the same contract: whatever a printed batch hangs
  // under, it must be affordable (a proposal is an instruction to go compress).
  // Deliberately NOT "never reaches back": a CHEAP carrier row is allowed to
  // absorb older neighbours (maxOld 3) because its rewrite stays inside the
  // recommend line anyway — only a flagged row is forward-only.
  const text = rangeTable(session, view as never)
  const rows = text.split('\n')
  let checked = 0
  for (let index = 0; index < rows.length; index += 1) {
    if (!rows[index + 2]?.includes('cheaper together')) continue
    const payback = Number(/pays back in ~([\d.]+) request/.exec(rows[index + 2]!)?.[1])
    assert.ok(
      payback <= RANGE_TABLE_BATCH_RECOMMEND_BREAK_EVEN,
      `printed batch pays back within the recommend line (~${payback} requests)`,
    )
    checked += 1
  }
  assert.ok(checked >= 1, 'the fixture still prints at least one proposal')
})

/**
 * The row's numbers must describe the range PRINTED NEXT TO THEM.
 *
 * Live shape (2026-10-15): the kernel handed `buildCompressibleSeqRanges` a
 * range whose HEAD was an unpaired `tool/result`. `resolveSurfaceRange` moved
 * the printed start inward to the next clean cut, but the message count and the
 * token column were summed over the PRE-resolution run, so one row read
 * `- seq 35734..35760 — 11 messages, ~20729 tokens` while both numbers actually
 * described `35729..35760` (the dropped node was a 3905-token tool result).
 * A model compressing what the row PRINTS therefore reclaimed less than the row
 * promised, for the same reason the caliber fix exists at all.
 *
 * The invariant pinned here is the strongest form of "the table says what the
 * fold books": the row's `tokens` equals the host-vocabulary price of exactly
 * `shadowedSeqsOf(row.start, row.end)` — the same slice `handleCompress` prices
 * its `shadowedTokenCount` claim from (rule 12). Reverting to run-pricing adds
 * the dropped node back into the number and fails this equality.
 */
test('range row: count and tokens price the PRINTED span, not the pre-resolution run', () => {
  const session = Session.create('span-price')
  appendTurn(session, 1)
  appendUser(session, longText('ask', 1))
  appendToolCall(session, longText('call', 1), 'c1', 1, 2)
  appendToolResult(session, longText('head result', 2), 'c1', 1, 2)
  // `appendToolResult` returns nothing, so read the node it just appended.
  const dropped = session.surface.nodes[session.surface.nodes.length - 1]!
  appendUser(session, longText('ask2', 3))
  appendAssistant(session, longText('reply2', 4))
  // Tail traffic: keeps the offered span out of the protected recent window.
  for (let index = 0; index < 4; index += 1) {
    appendUser(session, longText('tail', index))
    appendAssistant(session, longText('tail-a', index))
  }

  const nodes = [...session.surface.nodes]
  // The kernel range STARTS at the unpaired tool result — the live shape.
  const view = {
    ranges: [{ startRef: 'm00001', endRef: 'm00002' }],
    refs: { byRef: { m00001: String(dropped), m00002: String(nodes[nodes.length - 1]!) } },
  }
  const ranges = buildCompressibleSeqRanges(session, view as never)
  assert.ok(ranges.length > 0, 'the fixture still offers a span after the resolver moves its head')

  const row = ranges[0]!
  assert.ok(row.start > dropped, 'the resolver moved the head off the unpaired tool result')
  const shadowed = shadowedSeqsOf(session, row.start, row.end)
  assert.ok(!shadowed.includes(dropped), 'the dropped node is not inside the printed range')
  assert.equal(row.count, shadowed.length, 'the printed message count is the printed range')
  assert.equal(
    row.tokens,
    shadowedTokensViaMeter(session, shadowed),
    'the printed token column is the host-vocabulary price of exactly the printed range',
  )
  // Teeth: the price must not still carry the node the range no longer covers.
  assert.notEqual(
    row.tokens,
    shadowedTokensViaMeter(session, [dropped, ...shadowed]),
    'the dropped head is not priced into the row any more',
  )
  assert.ok(hostPriceEvent(session.eventAt(dropped)!) > 0, 'the dropped node really carried tokens')
})
