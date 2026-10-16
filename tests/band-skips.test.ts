/**
 * The per-age-band pass-over counter (src/band-skips.ts).
 *
 * The owner's definition (2026-10-16): six bands, and the number belongs to the
 * BAND SLOT — not to a seq range, not to the content. Each model choice of a fold
 * start counts once for every band that start did NOT fall into; the band it
 * lands in is left alone. A sweep is ONE choice (its earliest seq is the start),
 * and the spans it folds past that start HAND BACK the count of every band they
 * reached into — folding through a band is not passing it over.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  bandSkipsPath,
  forgetBandSkips,
  lastBandSkipsOf,
  noteBandChoice,
  noteBandRegions,
  trackedBandsOf,
} from '../src/band-skips.ts'

/** Point DSH_HOME at a throwaway directory so the sidecar never touches the real home. */
function useTempHome(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acp-band-skips-${label}-`))
  process.env.DSH_HOME = dir
  return dir
}

// The sidecar is REAL I/O, so the whole file runs against a throwaway home from
// the first test on — the first version of this file let its early cases write
// fixtures into the operator's own ~/.dsh before the per-test homes were set.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-band-skips-default-'))

const bands = [
  { start: 10, end: 20 },
  { start: 30, end: 40 },
  { start: 50, end: 60 },
]

/** One folded span, written as the module sees it (a single-seq span covers one seq). */
const at = (seq: number): { start: number; end: number } => ({ start: seq, end: seq })

test('band skips: a build records regions and counts nothing', () => {
  forgetBandSkips('b1')
  noteBandRegions('b1', bands)
  assert.equal(trackedBandsOf('b1'), 3)
  assert.deepEqual([...lastBandSkipsOf('b1')], [0, 0, 0], 'building the table is not a choice')
})

test('band skips: a choice inside a band increments every OTHER band', () => {
  forgetBandSkips('b2')
  noteBandRegions('b2', bands)
  noteBandChoice('b2', [at(35)]) // lands in band 2
  assert.deepEqual([...lastBandSkipsOf('b2')], [1, 0, 1])
  noteBandChoice('b2', [at(12)]) // lands in band 1
  assert.deepEqual([...lastBandSkipsOf('b2')], [1, 1, 2])
})

test('band skips: a start outside every band counts for every band', () => {
  forgetBandSkips('b3')
  noteBandRegions('b3', bands)
  noteBandChoice('b3', [at(5)])   // older than band 1
  assert.deepEqual([...lastBandSkipsOf('b3')], [1, 1, 1])
  noteBandChoice('b3', [at(999)]) // newer than the last band
  assert.deepEqual([...lastBandSkipsOf('b3')], [2, 2, 2])
})

test('band skips: the numbers are keyed to slots, so a rebuild cannot disturb them', () => {
  forgetBandSkips('b4')
  noteBandRegions('b4', bands)
  noteBandChoice('b4', [at(35)])
  // The surface moved: different regions, same three slots.
  noteBandRegions('b4', [
    { start: 100, end: 120 },
    { start: 130, end: 140 },
    { start: 150, end: 160 },
  ])
  assert.deepEqual([...lastBandSkipsOf('b4')], [1, 0, 1], 'the counters survive the rebuild untouched')
  noteBandChoice('b4', [at(135)]) // the NEW band 2
  assert.deepEqual([...lastBandSkipsOf('b4')], [2, 0, 2])
})

test('band skips: a choice with no table on record is ignored, and forget() clears both maps', () => {
  forgetBandSkips('b5')
  noteBandChoice('b5', [at(35)])
  assert.deepEqual([...lastBandSkipsOf('b5')], [], 'nothing to attribute against')
  forgetBandSkips('b5')
  assert.equal(trackedBandsOf('b5'), 0)
  assert.deepEqual([...lastBandSkipsOf('b5')], [])
})

test('band skips: the counters are persisted to the DSH_HOME sidecar', () => {
  const home = useTempHome('persist')
  forgetBandSkips('p1')
  noteBandRegions('p1', bands)
  noteBandChoice('p1', [at(35)])
  noteBandChoice('p1', [at(12)])
  const file = bandSkipsPath()
  assert.ok(file !== undefined && file.startsWith(home), `sidecar lives under DSH_HOME (${String(file)})`)
  const written = JSON.parse(fs.readFileSync(file!, 'utf8')) as { version: number; sessions: Record<string, { skips: number[] }> }
  assert.equal(written.version, 1)
  assert.deepEqual(written.sessions['p1']!.skips, [1, 1, 2], 'the counters, exactly as printed')
})

test('band skips: a restart seeds the counters back from the sidecar', () => {
  const home = useTempHome('restart')
  fs.writeFileSync(path.join(home, 'dsh-acp-band-skips.json'), JSON.stringify({
    version: 1,
    sessions: { p2: { skips: [5, 0, 7], updatedAt: 1 } },
  }), 'utf8')
  // A fresh process's first build for this session reads what the last one left.
  noteBandRegions('p2', bands)
  assert.deepEqual([...lastBandSkipsOf('p2')], [5, 0, 7], 'the day\'s choices survive the restart')
  noteBandChoice('p2', [at(55)]) // lands in band 3
  assert.deepEqual([...lastBandSkipsOf('p2')], [6, 1, 7])
  const written = JSON.parse(fs.readFileSync(path.join(home, 'dsh-acp-band-skips.json'), 'utf8')) as { sessions: Record<string, { skips: number[] }> }
  assert.deepEqual(written.sessions['p2']!.skips, [6, 1, 7], 'and the new choice is written back')
})

test('band skips: a malformed sidecar degrades to zeros instead of throwing', () => {
  const home = useTempHome('broken')
  fs.writeFileSync(path.join(home, 'dsh-acp-band-skips.json'), '{ not json', 'utf8')
  noteBandRegions('p3', bands)
  assert.deepEqual([...lastBandSkipsOf('p3')], [0, 0, 0])
  noteBandChoice('p3', [at(35)])
  assert.deepEqual([...lastBandSkipsOf('p3')], [1, 0, 1], 'and counting still works')
})

// ── sweep retraction (owner rule, 2026-10-16): a call that folds MORE than one
// span hands the count back to every band its other spans reached into. ──

test('band skips: a sweep hands the count back to every band its other spans reach into', () => {
  forgetBandSkips('s1')
  noteBandRegions('s1', bands)
  // ONE call: start in band 2, and it also folds a span in band 1 and one in band 3.
  noteBandChoice('s1', [at(35), at(12), at(55)])
  assert.deepEqual([...lastBandSkipsOf('s1')], [0, 0, 0],
    'a fold that went through a band did not pass it over')
  // …while a single-span call still counts every band it did not start in.
  noteBandChoice('s1', [at(55)])
  assert.deepEqual([...lastBandSkipsOf('s1')], [1, 1, 0])
})

test('band skips: only a multi-span call retracts — one span never does', () => {
  forgetBandSkips('s2')
  noteBandRegions('s2', bands)
  noteBandChoice('s2', [at(35)])
  noteBandChoice('s2', [at(35)])
  assert.deepEqual([...lastBandSkipsOf('s2')], [2, 0, 2], 'two single-span choices are two pass-overs')
  // A two-span call that starts in band 1 and also folds inside band 3: band 2
  // still pays the +1 (the start is not in it) and nothing of this call reached
  // it, so it keeps the count.
  noteBandChoice('s2', [at(55), at(12)])
  assert.deepEqual([...lastBandSkipsOf('s2')], [2, 1, 2])
})

test('band skips: a span that crosses two band regions retracts both', () => {
  forgetBandSkips('s3')
  noteBandRegions('s3', bands)
  // 40..55 leaves band 2 and enters band 3, so both were "passed over" by the
  // start and both are handed back.
  noteBandChoice('s3', [at(12), { start: 40, end: 55 }])
  assert.deepEqual([...lastBandSkipsOf('s3')], [0, 0, 0])
})

test('band skips: a retraction can only ever cancel its own call\'s +1', () => {
  // Every band a sweep reaches into took that same call's +1 a line earlier, so
  // the −1 cancels it exactly: the count is never driven below zero (the floor
  // in the code is defensive, not load-bearing). The start here lands outside
  // every band (seq 5 is older than band 1), so all three took the +1 and only
  // band 1 is handed back by the span at 12.
  forgetBandSkips('s4')
  noteBandRegions('s4', bands)
  noteBandChoice('s4', [at(5), at(12)])
  assert.deepEqual([...lastBandSkipsOf('s4')], [0, 1, 1])
})
