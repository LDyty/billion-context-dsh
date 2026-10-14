/**
 * Nudge range-table selection: "the oldest among the large" (2026-10-14).
 *
 * Live context: a 914-node surface offered 128 ranges (~539K tokens, largest
 * 124,877). Oldest-first spent the six printed rows on 195-token slivers while
 * the big span sat unlisted; size-first would push the model to compress fresh
 * work. The policy keeps both properties: consider the largest few, print the
 * OLDEST of those.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RANGE_TABLE_LARGE_WINDOW,
  RANGE_TABLE_LIMIT,
  selectRangeTableRanges,
} from '../src/nudge.ts'

const range = (start: number, tokens: number) => ({ start, end: start + 1, tokens })

test('range selection: small tables keep their full oldest-first order', () => {
  const all = [range(10, 500), range(20, 50_000), range(30, 2_000)]
  assert.deepEqual(selectRangeTableRanges(all), all)
})

test('range selection: the printed rows are the oldest of the largest', () => {
  // Ten ranges: the slivers are oldest, the big ones sit late.
  const all = [
    range(100, 100), range(110, 150), range(120, 200),
    range(200, 5_000), range(210, 6_000), range(220, 7_000),
    range(230, 40_000), range(240, 50_000), range(250, 60_000),
    range(260, 12_000),
  ]
  const shown = selectRangeTableRanges(all)
  assert.equal(shown.length, RANGE_TABLE_LIMIT)
  // Oldest-first among the printed rows.
  const starts = shown.map((entry) => entry.start)
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'printed rows stay oldest-first')
  // Every printed row is among the largest window: no sliver sneaks in.
  const window = [...all].sort((a, b) => b.tokens - a.tokens).slice(0, RANGE_TABLE_LARGE_WINDOW)
  const floor = Math.min(...window.map((entry) => entry.tokens))
  assert.ok(
    shown.every((entry) => entry.tokens >= floor),
    `every printed row clears the large window floor (${floor}); got ${shown.map((entry) => entry.tokens).join(', ')}`,
  )
  // The policy's defining property: anything OLDER than a printed row that was
  // left out is no larger than the smallest printed row — i.e. the table never
  // hides an old big span behind a young small one.
  const printed = new Set(shown)
  const smallestPrinted = Math.min(...shown.map((entry) => entry.tokens))
  for (const candidate of shown) {
    for (const other of all) {
      if (printed.has(other) || other.start > candidate.start) continue
      assert.ok(
        other.tokens <= smallestPrinted,
        `older unprinted span ${other.start} (${other.tokens}) must not exceed the smallest printed row (${smallestPrinted})`,
      )
    }
  }
})
