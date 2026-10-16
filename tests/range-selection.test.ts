/**
 * Nudge range-table selection: THREE ROWS PER AGE REGION (2026-10-16).
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
 * so row 1 is the oldest sixth of that context and row 6 the newest.
 *
 * Later the same day (owner ruling) each age region offers its THREE largest
 * intervals instead of only its largest, printed oldest-first: the table is
 * where the model is meant to choose, so it needs a finer grid than one choice
 * per age. What the age regions are, and how a fold start is attributed to one,
 * is unchanged.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RANGE_TABLE_LIMIT,
  RANGE_TABLE_ROWS_PER_AGE_REGION,
  rangeTableRowsOfGroups,
  selectRangeTableRanges,
  selectRangeTableRows,
} from '../src/nudge.ts'

const range = (start: number, tokens: number) => ({ start, end: start + 1, tokens })

test('range selection: fewer spans than age regions → one row each, oldest first', () => {
  const all = [range(10, 500), range(20, 50_000), range(30, 2_000)]
  assert.deepEqual(selectRangeTableRanges(all).map((entry) => entry.start), [10, 20, 30])
})

test('range selection: one age region offers its three largest intervals, oldest first', () => {
  // The rule at the group level: four intervals in one region, the largest three
  // are offered, printed in surface order (rank is by size, print order is by
  // position).
  const groups = [[range(10, 100), range(20, 400), range(30, 200), range(40, 300)]]
  const rows = rangeTableRowsOfGroups(groups)
  assert.deepEqual(rows.map((row) => row.range.start), [20, 30, 40], 'the smallest interval is left out')
  assert.deepEqual(rows.map((row) => row.rank), [1, 3, 2], 'rank is by size, not by position')
  assert.ok(rows.every((row) => row.ageRegion === 1), 'and all three carry the same age region')
  assert.equal(RANGE_TABLE_ROWS_PER_AGE_REGION, 3, 'the quota is the owner ruling: three')
  // A region with fewer intervals than the quota offers what it has.
  assert.equal(rangeTableRowsOfGroups([[range(10, 100), range(20, 200)]]).length, 2)
})

/**
 * The production ranker is the BILLING PAYBACK (owner ruling, 2026-10-17), not
 * size: inside one age region a smaller, later-starting interval can re-send far
 * less of the prefix than the largest one, so the region must offer the cheapest
 * three. The default ranker stays size-based for the pure-geometry callers.
 */
test('range selection: a payback ranker makes a region offer its cheapest intervals, not its largest', () => {
  const groups = [[range(10, 300), range(20, 100)]]
  assert.deepEqual(
    rangeTableRowsOfGroups(groups).map((row) => row.range.start),
    [10, 20],
    'by default the larger interval ranks first (both fit)',
  )
  const payback = new Map([[10, 5], [20, 1]])
  const cheapest = rangeTableRowsOfGroups(groups, 1, (entry) => payback.get(entry.start) ?? Number.POSITIVE_INFINITY)
  assert.deepEqual(cheapest.map((row) => row.range.start), [20], 'the cheapest interval is the one offered')
  assert.equal(cheapest[0]!.rank, 1, 'and it is rank 1 of its region')
  // Ties fall back to surface order, so a region never shuffles between builds.
  const tied = rangeTableRowsOfGroups(groups, 2, () => 1)
  assert.deepEqual(tied.map((row) => row.range.start), [10, 20], 'equal paybacks keep the oldest-first print order')
})

test('range selection: an older age region keeps a row instead of losing it to the biggest spans', () => {
  // The discriminating shape: six medium spans early, six larger ones late. A
  // size-first table prints the six larger ones and nothing early; the age region
  // policy must spend rows on the early age region too.
  const early = [...Array(6).keys()].map((index) => range(100 + index * 10, 10_000))
  const late = [...Array(6).keys()].map((index) => range(1_000 + index * 10, 12_000))
  const all = [...early, ...late]
  const shown = selectRangeTableRanges(all)
  // 12 intervals across 6 age regions = 2 rows each (the quota is 3, the regions
  // simply do not hold that many).
  assert.equal(shown.length, 12)
  assert.ok(shown.length <= RANGE_TABLE_LIMIT)
  assert.deepEqual(
    shown.map((entry) => entry.start),
    [...shown.map((entry) => entry.start)].sort((a, b) => a - b),
    'rows come back in age region order — oldest first',
  )
  assert.ok(shown.some((entry) => entry.tokens === 10_000), 'the early age region contributes a row')
  assert.ok(
    shown.filter((entry) => entry.tokens === 12_000).length < shown.length,
    'the late spans do not take every row',
  )
})

test('range selection: one dominant span does not collapse the row count', () => {
  // A single heavy span used to swallow the tail into the final age region, dropping
  // the table to four rows on a six-age-region request.
  const all = [range(1, 100_000), ...[...Array(20).keys()].map((index) => range(100 + index * 10, 500))]
  const rows = selectRangeTableRows(all)
  const shown = rows.map((row) => row.range)
  assert.equal(shown[0]!.start, 1, 'the dominant span heads the table')
  assert.deepEqual(
    shown.map((entry) => entry.start),
    [...shown.map((entry) => entry.start)].sort((a, b) => a - b),
    'and the rest still share the remaining age regions in order',
  )
  // The anti-collapse rule still cuts all six age regions (the heavy span used to
  // swallow the tail and leave four), and the region that holds enough slivers now
  // spends its full quota instead of one row.
  assert.equal(new Set(rows.map((row) => row.ageRegion)).size, 6, 'six age regions survive the heavy span')
  assert.ok(shown.length > 6, `more rows than age regions (${String(shown.length)})`)
})

test('range selection: age regions are equal weight, not equal count', () => {
  // One heavy span at the front plus many slivers behind it. Equal-count age regions
  // would hand three rows to the slivers; equal-weight age regions give the heavy span
  // its own row and split the rest by weight.
  const all = [range(1, 100_000), ...[...Array(30).keys()].map((index) => range(100 + index * 10, 100))]
  const rows = selectRangeTableRows(all)
  const shown = rows.map((row) => row.range)
  assert.equal(shown[0]!.start, 1, 'the heavy span heads the table')
  const ageRegionTotal = all.reduce((sum, entry) => sum + entry.tokens, 0)
  // No age region may spend more than the quota on slivers, and the heavy span
  // stays rank 1 inside its own region.
  for (const region of new Set(rows.map((row) => row.ageRegion))) {
    const inRegion = rows.filter((row) => row.ageRegion === region)
    assert.ok(inRegion.length <= RANGE_TABLE_ROWS_PER_AGE_REGION, `region ${String(region)} respects the quota`)
  }
  assert.equal(rows.find((row) => row.range.start === 1)?.rank, 1, 'the heavy span ranks first in its region')
  assert.ok(ageRegionTotal > 0)
})
