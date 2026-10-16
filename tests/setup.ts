/**
 * Global test setup (`--import`ed before the runner loads any test file).
 *
 * The engine writes REAL files: the per-age-region skip counters go to
 * `<DSH_HOME>/dsh-acp-age-region-skips.json` (src/age-region-skips.ts). Without this,
 * every test that lands a compress persisted its fixture session ids into the
 * operator's own `~/.dsh` — measured 2026-10-16, first as a stray
 * `dsh-acp-age-region-skips.json` holding `{"multi": …}` from a tools test, then as
 * the same file appearing again whenever the suite ran.
 *
 * Pointing DSH_HOME at a throwaway directory once, here, keeps every test away
 * from the real home and makes `ageRegionSkipsPath()` deterministic.
 * @module billion-context-dsh/tests/setup
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.env.DSH_HOME === undefined || process.env.DSH_HOME.length === 0) {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-home-'))
}
