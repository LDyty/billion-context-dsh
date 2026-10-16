/**
 * The "this row keeps coming back" counter.
 *
 * It exists because the model cannot tell a span it has skipped 20 times from one
 * it is seeing for the first time, and wall-clock age is not a substitute (an
 * operator who returns the next day makes hours-old content look ancient). What
 * the table can honestly report is how many builds have offered a row covering
 * this start — a fact about the model's own chances to act.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetOffers, noteFoldLanded, noteOfferedRows, offeredBuildsOf } from '../src/offer-count.ts'
import { RANGE_TABLE_OFFERED_MIN, rangeTable } from '../src/nudge.ts'
import { buildTextSession, wholeSurfaceRangeView } from './helpers.ts'

test('offer count: coverage counts, so a drifting edge does not reset it', () => {
  forgetOffers('s1')
  // Build 1 offers 10..20.
  assert.deepEqual([...noteOfferedRows('s1', [{ start: 10, end: 20 }])], [[10, 1]])
  // Build 2's row starts one seq later (the surface grew): it is the same piece
  // of content, so its count continues rather than restarting.
  assert.deepEqual([...noteOfferedRows('s1', [{ start: 12, end: 20 }])], [[12, 2]])
  // Build 3 offers a row that does NOT cover 10 any more (it starts later).
  assert.deepEqual([...noteOfferedRows('s1', [{ start: 21, end: 30 }])], [[21, 1]])
  assert.equal(offeredBuildsOf('s1'), 3)
})

test('offer count: a landed fold forgets the offers it replaced', () => {
  forgetOffers('s2')
  noteOfferedRows('s2', [{ start: 100, end: 120 }])
  noteOfferedRows('s2', [{ start: 100, end: 120 }])
  assert.deepEqual([...noteOfferedRows('s2', [{ start: 100, end: 120 }])], [[100, 3]])
  // The fold covers 100..120 — exactly the content those three builds described.
  noteFoldLanded('s2', [100, 105, 110, 120])
  assert.equal(offeredBuildsOf('s2'), 0, 'the replaced builds are forgotten')
  assert.deepEqual([...noteOfferedRows('s2', [{ start: 130, end: 140 }])], [[130, 1]], 'and counting restarts')
})

test('offer count: a fold elsewhere does not wipe an unrelated history', () => {
  forgetOffers('s3')
  noteOfferedRows('s3', [{ start: 1, end: 10 }, { start: 500, end: 510 }])
  noteFoldLanded('s3', [500, 505, 510])
  assert.equal(offeredBuildsOf('s3'), 1, 'the build that also offered 1..10 survives')
  assert.deepEqual([...noteOfferedRows('s3', [{ start: 1, end: 10 }])], [[1, 2]], 'so 1..10 keeps its count')
})

test('offer count: the table prints the count only after the floor', () => {
  const session = buildTextSession(24)
  const view = wholeSurfaceRangeView(session)
  const id = String(session.id)
  forgetOffers(id)
  const first = rangeTable(session, view as never)
  const second = rangeTable(session, view as never)
  assert.ok(!first.includes('offered '), 'the first offer says nothing')
  assert.ok(!second.includes('offered '), 'and neither does the second (a repeat is normal)')
  const third = rangeTable(session, view as never)
  assert.match(third, / · offered 3×/, `the third prints the count (floor ${String(RANGE_TABLE_OFFERED_MIN)})`)
})

test('offer count: building the table for the PANEL does not count as an offer', () => {
  const session = buildTextSession(24)
  const view = wholeSurfaceRangeView(session)
  const id = String(session.id)
  forgetOffers(id)
  // The inspector rebuilds the table on demand; those builds never reach the
  // model, so they must not inflate the count.
  for (let index = 0; index < 5; index += 1) rangeTable(session, view as never, undefined, undefined, { recordOffers: false })
  assert.equal(offeredBuildsOf(id), 0)
  const shown = rangeTable(session, view as never)
  assert.ok(!shown.includes('offered '), 'so the first real offer still says nothing')
})
