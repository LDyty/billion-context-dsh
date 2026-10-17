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
import { billingPaybackRequests, buildCompressibleSeqRanges, foldCostsOfRanges, shadowedSeqsOf, summaryTokenAllowance } from '../src/region.ts'
import { bestBatchProposal, sweepFromBaseRange } from '../src/region.ts'
import {
  RANGE_TABLE_COST_WARN_BREAK_EVEN,
  RANGE_TABLE_COST_WARN_PAYBACK_REQUESTS,
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
  // re-sending everything after it uncached once, i.e. the expensive default this
  // is meant to stop hiding.
  const view = spanView(session, 0, 1)
  const text = rangeTable(session, view as never)
  // The printed cost is the BILLING payback (owner ruling 2026-10-17): the row's
  // billing number is computed from the same two prices the helper documents.
  assert.match(
    text,
    /fold cost: reclaims ~[\d.]+K? · re-sends [\d.]+K? tok newer uncached once · pays back in ~[\d.]+ request\(s\)/,
    'every row carries its fold cost',
  )
  const ranges = buildCompressibleSeqRanges(session, view as never)
  const costs = foldCostsOfRanges(session, ranges)
  const payback = billingPaybackRequests(costs[0]!.invalidatedTokens, ranges[0]!.tokens, 50)
  assert.ok(
    payback >= RANGE_TABLE_COST_WARN_PAYBACK_REQUESTS,
    `fixture is the expensive case (${payback.toFixed(1)} requests)`,
  )
  assert.ok(text.includes('⚠ expensive'), 'the expensive row is flagged')
  assert.ok(
    text.includes(`~${payback.toFixed(1)} request(s)`),
    'the printed payback is the billing one',
  )
})

/**
 * The owner's own worked example (2026-10-17), as a regression: two identical
 * 200K contexts, B folds the newest 100K into a 20K summary, A folds nothing;
 * each step adds 1K. B's first request costs 100K hit + 20K miss + 1K miss —
 * 900K more than A's; every later request is 80K cheaper (B's context is 80K
 * smaller) → 11.25 requests to break even.
 */
test('billing payback: the owner example — 100K folded of a 200K context, no newer tail', () => {
  const payback = billingPaybackRequests(100_000, 100_000, 50, 20_000)
  assert.equal(Number(payback.toFixed(2)), 11.25, '900K upfront ÷ 80K per request')

  // A fold whose span reaches the newest content has no newer tail: it is
  // profitable from the first request on (the one-time term goes negative).
  assert.equal(billingPaybackRequests(33_100, 33_100, 50, 500), 0, 'suffix fold pays back immediately')

  // The default allowance tracks what is folded (measured: 4.5%, floored/capped).
  assert.equal(summaryTokenAllowance(10_000), 450)
  assert.equal(summaryTokenAllowance(100), 80, 'the terse junk folds keep a small floor')
  assert.equal(summaryTokenAllowance(100_000), 1_000, 'and a big fold does not scale forever')
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

test('sweep proposal: it runs FORWARD from its row, uncapped, and always beats the row alone', () => {
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
  // The owner's rule (2026-10-16): the six rows are six STARTING POINTS, each
  // sweep runs FORWARD to the newest offerable span with NO entry cap, and it
  // never reaches back before its own row. A fold's rewrite is pinned by the
  // batch's earliest entry, so forward extension never grows the rewrite and
  // every added newer span strictly lowers the payback — that is the whole
  // selection rule, and what must hold is the arithmetic.
  let swept = 0
  for (let at = 0; at < ranges.length; at += 1) {
    const sweep = sweepFromBaseRange(ranges, costs, at)
    if (sweep === undefined) continue
    swept += 1
    const earliest = sweep.entries.reduce((best, entry) => (entry.start < best.start ? entry : best))
    assert.equal(
      sweep.invalidatedTokens,
      costs[ranges.findIndex((range) => range.start === earliest.start)]!.invalidatedTokens,
      'the rewrite is the one pinned by the sweep’s EARLIEST entry',
    )
    assert.equal(earliest.start, ranges[at]!.start, 'the sweep starts at its own row, never before it')
    assert.ok(sweep.reclaimedTokens > ranges[at]!.tokens, 'a sweep reclaims more than its base row')
    assert.ok(sweep.breakEvenRequests < costs[at]!.breakEvenRequests, 'and pays back sooner')
    // …and in the BILLING caliber the full forward run is optimal among forward
    // runs: every added newer span both shrinks the one-time re-send and grows the
    // per-request saving, so the payback never gets worse as the sweep extends.
    const paybackOfPrefix = (length: number): number => {
      const entries = sweep.entries.slice(0, length)
      const reclaimed = entries.reduce((sum, entry) => sum + entry.tokens, 0)
      const summary = entries.reduce((sum, entry) => sum + summaryTokenAllowance(entry.tokens), 0)
      return billingPaybackRequests(sweep.invalidatedTokens, reclaimed, 50, summary)
    }
    let previous = paybackOfPrefix(1)
    assert.equal(
      Number(previous.toFixed(6)),
      Number(billingPaybackRequests(costs[at]!.invalidatedTokens, ranges[at]!.tokens, 50).toFixed(6)),
      'a one-entry sweep prices exactly like the row alone',
    )
    for (let length = 2; length <= sweep.entries.length; length += 1) {
      const current = paybackOfPrefix(length)
      assert.ok(current <= previous + 1e-9, `entry ${String(length)} does not worsen the billing payback`)
      assert.ok(current < previous || current === 0, `entry ${String(length)} improves it (or is already free)`)
      previous = current
    }
    assert.ok(sweep.entries.some((entry) => entry.start === ranges[at]!.start), 'the base row is in its own sweep')
    // Uncapped: everything newer that does not overlap is inside.
    const newerDisjoint = ranges.slice(at + 1).filter((candidate) => candidate.start > ranges[at]!.end)
    assert.ok(
      sweep.entries.length >= 1 + newerDisjoint.length || sweep.entries.some((entry) => entry.start > ranges[at]!.end),
      'newer spans ride along',
    )
    for (let index = 1; index < sweep.entries.length; index += 1) {
      assert.ok(sweep.entries[index]!.start > sweep.entries[index - 1]!.end, 'sweep entries are disjoint')
    }
  }
  assert.ok(swept >= 2, `the fixture exercises sweeps (${String(swept)})`)

  // Rendered side: every row that carries a sweep prints a payback lower than
  // its own row, and says how much work the sweep is (messages / summaries).
  const text = rangeTable(session, view as never)
  const rows = text.split('\n')
  let checked = 0
  for (let index = 0; index < rows.length; index += 1) {
    if (!rows[index + 2]?.includes('sweep from here')) continue
    const rowPayback = Number(/pays back in ~([\d.]+) request/.exec(rows[index + 1] ?? '')?.[1])
    const sweepPayback = Number(/pays back in ~([\d.]+) request/.exec(rows[index + 2]!)?.[1])
    assert.ok(sweepPayback < rowPayback, `sweep beats its row (${String(sweepPayback)} < ${String(rowPayback)})`)
    assert.match(rows[index + 2]!, /\(\d+ messages · \d+ spans · 1 shared summary\)/, 'the sweep names its work')
    checked += 1
  }
  assert.ok(checked >= 1, 'the fixture still prints at least one sweep')
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
