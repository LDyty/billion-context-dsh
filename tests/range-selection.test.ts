/**
 * Nudge range-table selection: ONE ROW PER AGE REGION (2026-10-16).
 *
 * Replaces the plain size-first policy of 2026-10-15. Size-first had one blind
 * spot: on a big surface the six rows come from wherever the largest spans
 * happen to sit, so older scattered content is never offered — measured on the
 * live surface, the oldest age region held 26 offerable spans (median ~1.3K tokens)
 * and none of them could ever reach a six-row size-first table.
 *
 * The age regions are equal WEIGHT, not equal count: equal-count groups gave the
 * oldest age region 26 spans against the newest age region's 7, letting one region
 * monopolise rows. Walking the surface in order and closing an age region at
 * `total ÷ 6` tokens gives every row the same share of the reclaimable context,
 * so row 1 is the oldest sixth of that context and row 6 the newest. Each age region
 * offers its LARGEST span as the base row.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RANGE_TABLE_LIMIT,
  selectRangeTableRanges,
} from '../src/nudge.ts'

const range = (start: number, tokens: number) => ({ start, end: start + 1, tokens })

test('range selection: fewer spans than age regions → one row each, oldest first', () => {
  const all = [range(10, 500), range(20, 50_000), range(30, 2_000)]
  assert.deepEqual(selectRangeTableRanges(all).map((entry) => entry.start), [10, 20, 30])
})

test('range selection: an older age region keeps a row instead of losing it to the biggest spans', () => {
  // The discriminating shape: six medium spans early, six larger ones late. A
  // size-first table prints the six larger ones and nothing early; the age region
  // policy must spend rows on the early age region too.
  const early = [...Array(6).keys()].map((index) => range(100 + index * 10, 10_000))
  const late = [...Array(6).keys()].map((index) => range(1_000 + index * 10, 12_000))
  const all = [...early, ...late]
  const shown = selectRangeTableRanges(all)
  assert.equal(shown.length, RANGE_TABLE_LIMIT)
  assert.deepEqual(
    shown.map((entry) => entry.start),
    [...shown.map((entry) => entry.start)].sort((a, b) => a - b),
    'rows come back in age region order — oldest first',
  )
  assert.ok(shown.some((entry) => entry.tokens === 10_000), 'the early age region contributes a row')
  assert.ok(
    shown.filter((entry) => entry.tokens === 12_000).length < 6,
    'the late spans do not take every row',
  )
})

test('range selection: one dominant span does not collapse the row count', () => {
  // A single heavy span used to swallow the tail into the final age region, dropping
  // the table to four rows on a six-age-region request.
  const all = [range(1, 100_000), ...[...Array(20).keys()].map((index) => range(100 + index * 10, 500))]
  const shown = selectRangeTableRanges(all)
  assert.equal(shown.length, RANGE_TABLE_LIMIT)
  assert.equal(shown[0]!.start, 1, 'the dominant span heads the table')
  assert.deepEqual(
    shown.map((entry) => entry.start),
    [...shown.map((entry) => entry.start)].sort((a, b) => a - b),
    'and the rest still share the remaining age regions in order',
  )
})

test('range selection: age regions are equal weight, not equal count', () => {
  // One heavy span at the front plus many slivers behind it. Equal-count age regions
  // would hand three rows to the slivers; equal-weight age regions give the heavy span
  // its own row and split the rest by weight.
  const all = [range(1, 100_000), ...[...Array(30).keys()].map((index) => range(100 + index * 10, 100))]
  const shown = selectRangeTableRanges(all)
  assert.equal(shown[0]!.start, 1, 'the heavy span heads the table')
  const ageRegionTotal = all.reduce((sum, entry) => sum + entry.tokens, 0)
  assert.ok(
    shown.filter((entry) => entry.tokens === 100).length <= RANGE_TABLE_LIMIT - 1,
    `slivers share the remaining rows rather than owning three (${String(shown.length)})`,
  )
  assert.ok(ageRegionTotal > 0)
})
