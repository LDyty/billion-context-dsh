/**
 * The per-age-region pass-over counter (src/age-region-skips.ts).
 *
 * The owner's definition (2026-10-16): six age regions, and the number belongs to the
 * AGE REGION SLOT — not to a seq range, not to the content. Each model choice of a fold
 * start counts once for every age region that start did NOT fall into; the age region it
 * lands in is left alone. A sweep is ONE choice (its earliest seq is the start),
 * and the spans it folds past that start HAND BACK the count of every age region they
 * reached into — folding through an age region is not passing it over.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ageRegionSkipsPath,
  forgetAgeRegionSkips,
  lastAgeRegionSkipsOf,
  noteAgeRegionChoice,
  noteAgeRegions,
  trackedAgeRegionsOf,
} from '../src/age-region-skips.ts'

/** Point DSH_HOME at a throwaway directory so the sidecar never touches the real home. */
function useTempHome(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acp-age-region-skips-${label}-`))
  process.env.DSH_HOME = dir
  return dir
}

// The sidecar is REAL I/O, so the whole file runs against a throwaway home from
// the first test on — the first version of this file let its early cases write
// fixtures into the operator's own ~/.dsh before the per-test homes were set.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-age-region-skips-default-'))

const ageRegions = [
  { start: 10, end: 20 },
  { start: 30, end: 40 },
  { start: 50, end: 60 },
]

/** One folded span, written as the module sees it (a single-seq span covers one seq). */
const at = (seq: number): { start: number; end: number } => ({ start: seq, end: seq })

test('age region skips: a build records regions and counts nothing', () => {
  forgetAgeRegionSkips('b1')
  noteAgeRegions('b1', ageRegions)
  assert.equal(trackedAgeRegionsOf('b1'), 3)
  assert.deepEqual([...lastAgeRegionSkipsOf('b1')], [0, 0, 0], 'building the table is not a choice')
})

test('age region skips: a choice inside an age region increments every OTHER age region', () => {
  forgetAgeRegionSkips('b2')
  noteAgeRegions('b2', ageRegions)
  noteAgeRegionChoice('b2', [at(35)]) // lands in ageRegion 2
  assert.deepEqual([...lastAgeRegionSkipsOf('b2')], [1, 0, 1])
  noteAgeRegionChoice('b2', [at(12)]) // lands in ageRegion 1
  assert.deepEqual([...lastAgeRegionSkipsOf('b2')], [1, 1, 2])
})

test('age region skips: a start outside every age region counts for every age region', () => {
  forgetAgeRegionSkips('b3')
  noteAgeRegions('b3', ageRegions)
  noteAgeRegionChoice('b3', [at(5)])   // older than ageRegion 1
  assert.deepEqual([...lastAgeRegionSkipsOf('b3')], [1, 1, 1])
  noteAgeRegionChoice('b3', [at(999)]) // newer than the last ageRegion
  assert.deepEqual([...lastAgeRegionSkipsOf('b3')], [2, 2, 2])
})

test('age region skips: the numbers are keyed to slots, so a rebuild cannot disturb them', () => {
  forgetAgeRegionSkips('b4')
  noteAgeRegions('b4', ageRegions)
  noteAgeRegionChoice('b4', [at(35)])
  // The surface moved: different regions, same three slots.
  noteAgeRegions('b4', [
    { start: 100, end: 120 },
    { start: 130, end: 140 },
    { start: 150, end: 160 },
  ])
  assert.deepEqual([...lastAgeRegionSkipsOf('b4')], [1, 0, 1], 'the counters survive the rebuild untouched')
  noteAgeRegionChoice('b4', [at(135)]) // the NEW ageRegion 2
  assert.deepEqual([...lastAgeRegionSkipsOf('b4')], [2, 0, 2])
})

test('age region skips: a choice with no table on record is ignored, and forget() clears both maps', () => {
  forgetAgeRegionSkips('b5')
  noteAgeRegionChoice('b5', [at(35)])
  assert.deepEqual([...lastAgeRegionSkipsOf('b5')], [], 'nothing to attribute against')
  forgetAgeRegionSkips('b5')
  assert.equal(trackedAgeRegionsOf('b5'), 0)
  assert.deepEqual([...lastAgeRegionSkipsOf('b5')], [])
})

test('age region skips: the counters are persisted to the DSH_HOME sidecar', () => {
  const home = useTempHome('persist')
  forgetAgeRegionSkips('p1')
  noteAgeRegions('p1', ageRegions)
  noteAgeRegionChoice('p1', [at(35)])
  noteAgeRegionChoice('p1', [at(12)])
  const file = ageRegionSkipsPath()
  assert.ok(file !== undefined && file.startsWith(home), `sidecar lives under DSH_HOME (${String(file)})`)
  const written = JSON.parse(fs.readFileSync(file!, 'utf8')) as { version: number; sessions: Record<string, { skips: number[] }> }
  assert.equal(written.version, 1)
  assert.deepEqual(written.sessions['p1']!.skips, [1, 1, 2], 'the counters, exactly as printed')
})

test('age region skips: a restart seeds the counters back from the sidecar', () => {
  const home = useTempHome('restart')
  fs.writeFileSync(path.join(home, 'dsh-acp-age-region-skips.json'), JSON.stringify({
    version: 1,
    sessions: { p2: { skips: [5, 0, 7], updatedAt: 1 } },
  }), 'utf8')
  // A fresh process's first build for this session reads what the last one left.
  noteAgeRegions('p2', ageRegions)
  assert.deepEqual([...lastAgeRegionSkipsOf('p2')], [5, 0, 7], 'the day\'s choices survive the restart')
  noteAgeRegionChoice('p2', [at(55)]) // lands in ageRegion 3
  assert.deepEqual([...lastAgeRegionSkipsOf('p2')], [6, 1, 7])
  const written = JSON.parse(fs.readFileSync(path.join(home, 'dsh-acp-age-region-skips.json'), 'utf8')) as { sessions: Record<string, { skips: number[] }> }
  assert.deepEqual(written.sessions['p2']!.skips, [6, 1, 7], 'and the new choice is written back')
})

test('age region skips: the pre-rename sidecar is read once and written forward', () => {
  // The concept was called `band` until the 2026-10-16 wording ruling. Renaming
  // the FILE must not zero a day of counters, so the old name is read as a
  // one-way fallback and immediately written out under the new name.
  const home = useTempHome('legacy')
  fs.writeFileSync(path.join(home, 'dsh-acp-band-skips.json'), JSON.stringify({
    version: 1,
    sessions: { old: { skips: [4, 0, 2], updatedAt: 1 } },
  }), 'utf8')
  noteAgeRegions('old', ageRegions)
  assert.deepEqual([...lastAgeRegionSkipsOf('old')], [4, 0, 2], 'the counters survive the rename')
  const migrated = JSON.parse(
    fs.readFileSync(path.join(home, 'dsh-acp-age-region-skips.json'), 'utf8'),
  ) as { sessions: Record<string, { skips: number[] }> }
  assert.deepEqual(migrated.sessions['old']!.skips, [4, 0, 2], 'and they are written forward under the new name')
})

test('age region skips: a malformed sidecar degrades to zeros instead of throwing', () => {
  const home = useTempHome('broken')
  fs.writeFileSync(path.join(home, 'dsh-acp-age-region-skips.json'), '{ not json', 'utf8')
  noteAgeRegions('p3', ageRegions)
  assert.deepEqual([...lastAgeRegionSkipsOf('p3')], [0, 0, 0])
  noteAgeRegionChoice('p3', [at(35)])
  assert.deepEqual([...lastAgeRegionSkipsOf('p3')], [1, 0, 1], 'and counting still works')
})

// ── sweep retraction (owner rule, 2026-10-16): a call that folds MORE than one
// span hands the count back to every age region its other spans reached into. ──

test('age region skips: a sweep hands the count back to every age region its other spans reach into', () => {
  forgetAgeRegionSkips('s1')
  noteAgeRegions('s1', ageRegions)
  // ONE call: start in age region 2, and it also folds a span in age region 1 and one in age region 3.
  noteAgeRegionChoice('s1', [at(35), at(12), at(55)])
  assert.deepEqual([...lastAgeRegionSkipsOf('s1')], [0, 0, 0],
    'a fold that went through an age region did not pass it over')
  // …while a single-span call still counts every age region it did not start in.
  noteAgeRegionChoice('s1', [at(55)])
  assert.deepEqual([...lastAgeRegionSkipsOf('s1')], [1, 1, 0])
})

test('age region skips: only a multi-span call retracts — one span never does', () => {
  forgetAgeRegionSkips('s2')
  noteAgeRegions('s2', ageRegions)
  noteAgeRegionChoice('s2', [at(35)])
  noteAgeRegionChoice('s2', [at(35)])
  assert.deepEqual([...lastAgeRegionSkipsOf('s2')], [2, 0, 2], 'two single-span choices are two pass-overs')
  // A two-span call that starts in age region 1 and also folds inside age region 3: age region 2
  // still pays the +1 (the start is not in it) and nothing of this call reached
  // it, so it keeps the count.
  noteAgeRegionChoice('s2', [at(55), at(12)])
  assert.deepEqual([...lastAgeRegionSkipsOf('s2')], [2, 1, 2])
})

test('age region skips: a span that crosses two age region regions retracts both', () => {
  forgetAgeRegionSkips('s3')
  noteAgeRegions('s3', ageRegions)
  // 40..55 leaves age region 2 and enters age region 3, so both were "passed over" by the
  // start and both are handed back.
  noteAgeRegionChoice('s3', [at(12), { start: 40, end: 55 }])
  assert.deepEqual([...lastAgeRegionSkipsOf('s3')], [0, 0, 0])
})

test('age region skips: a retraction can only ever cancel its own call\'s +1', () => {
  // Every age region a sweep reaches into took that same call's +1 a line earlier, so
  // the −1 cancels it exactly: the count is never driven below zero (the floor
  // in the code is defensive, not load-bearing). The start here lands outside
  // every age region (seq 5 is older than age region 1), so all three took the +1 and only
  // age region 1 is handed back by the span at 12.
  forgetAgeRegionSkips('s4')
  noteAgeRegions('s4', ageRegions)
  noteAgeRegionChoice('s4', [at(5), at(12)])
  assert.deepEqual([...lastAgeRegionSkipsOf('s4')], [0, 1, 1])
})
