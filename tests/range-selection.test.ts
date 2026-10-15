/**
 * Nudge range-table selection: "largest first, oldest among equals" (2026-10-15).
 *
 * Live context: a 914-node surface offered 128 ranges (~539K tokens, largest
 * 124,877). Oldest-first spent the six printed rows on 195-token slivers while
 * the big span sat unlisted. Sizing the rows is what makes them worth a model
 * turn, and folding an old span invalidates every cached token after it — so the
 * table ranks by size (ties oldest) instead of by age.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RANGE_TABLE_LIMIT,
  selectRangeTableRanges,
} from '../src/nudge.ts'

const range = (start: number, tokens: number) => ({ start, end: start + 1, tokens })

test('range selection: small tables come back size-ranked, oldest among equals', () => {
  const all = [range(10, 500), range(20, 50_000), range(30, 2_000)]
  assert.deepEqual(selectRangeTableRanges(all).map((entry) => entry.start), [20, 30, 10])
})

test('range selection: the printed rows are the largest, oldest among equals', () => {
  // Ten ranges: the slivers are oldest, the big ones sit late.
  const all = [
    range(100, 100), range(110, 150), range(120, 200),
    range(200, 5_000), range(210, 6_000), range(220, 7_000),
    range(230, 40_000), range(240, 50_000), range(250, 60_000),
    range(260, 12_000),
  ]
  const shown = selectRangeTableRanges(all)
  assert.equal(shown.length, RANGE_TABLE_LIMIT)
  // Size-ranked: the six printed rows are exactly the six largest, in order.
  assert.deepEqual(shown.map((entry) => entry.start), [250, 240, 230, 260, 220, 210])
  const tokens = shown.map((entry) => entry.tokens)
  assert.deepEqual(tokens, [...tokens].sort((a, b) => b - a), 'printed rows run largest first')
  // Nothing printed is smaller than anything left out: no sliver sneaks in.
  const smallestPrinted = Math.min(...tokens)
  for (const other of all) {
    if (shown.includes(other)) continue
    assert.ok(other.tokens <= smallestPrinted, `unprinted ${other.start} (${other.tokens}) must not exceed ${smallestPrinted}`)
  }
})

test('range selection: equal sizes keep the older span first', () => {
  const all = [range(300, 9_000), range(100, 9_000), range(200, 9_000)]
  assert.deepEqual(selectRangeTableRanges(all).map((entry) => entry.start), [100, 200, 300])
})
