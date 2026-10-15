/**
 * Skill-catalog visibility (issue #185): the `<available_skills>` list the
 * harness injects at session start (dsh-tool-skill, agent/pre-step) must stay
 * compress-safe. Folding it is NOT self-healing — unlike AGENTS.md rows, the
 * host never re-injects a folded catalog: dsh-tool-skill's resend gate is the
 * catalog DIGEST, and shadowing the visible row changes nothing about it. A
 * folded catalog therefore deletes the model's skill-discovery ability for
 * the rest of the session (live case: a host with pdf-to-md installed went
 * `pip install pypdf` because the catalog had been compressed away).
 *
 * Fix pieces under test:
 * - isSkillCatalogRow recognizes EVERY audited shape (src/messages.ts): the
 *   direct kind 'skill-catalog', the legacy plugin wrapper and V4 producer
 *   kind for 'dsh-tool-skill', AND a content fallback for rows whose source
 *   shape is unusable (no source / kind 'user' / non-string kind) but whose
 *   text carries the <available_skills> marker.
 * - classifySurfaceEvent keeps those rows in the 'instruction' barrier class
 *   on ALL three real-return paths; isRealUserTurn never lets one win the
 *   protected-tail window.
 * - newestSkillCatalogSeqOf pins ONE group (each catalog supersedes all
 *   earlier ones) so guardedSurfaceSeqsOf hard-rejects hand-built ranges over
 *   the CURRENT copy while superseded catalogs stay compressible.
 * - handleCompress and /acp-prune compress reject a span covering the newest
 *   visible catalog and name the channel-specific reason (the host never
 *   re-sends it), before anything durable lands.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { classifySurfaceEvent, isRealUserTurn, isSkillCatalogRow } from '../src/messages.ts'
import { acpCommand } from '../src/commands.ts'
import { buildCompressibleSeqRanges, newestSkillCatalogSeqOf } from '../src/region.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { AcpStateStore } from '../src/state.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { appendTurn, appendUser, appendAssistant, longText, wholeSurfaceRangeView } from './helpers.ts'

/** The durable text the harness stamps into the catalog row. */
const CATALOG_TEXT = '<system-reminder>The available skills are listed below.\n<available_skills>\n- pdf-to-md: convert PDF files to markdown\n- ework-translate: translate between Chinese and English\n</available_skills>\n</system-reminder>'

/** One fake surface event with optional source + real content blocks. */
function catalogEvent(source?: Record<string, unknown>, text = CATALOG_TEXT): never {
  return {
    type: 'user/message',
    seq: 1,
    data: {
      ...(source !== undefined ? { source } : {}),
      content: [{ type: 'text', text }],
    },
  } as never
}

/** Append a catalog-shaped row to a real session and return its surface seq. */
function appendCatalogRow(session: Session, source?: Record<string, unknown>, text = CATALOG_TEXT): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    ...(source !== undefined ? { source } : {}),
  }), { surfaceOp: 'append' })
  return sessionEventsOf(session).length - 1
}

function makeEnv(): ToolEnvironment {
  return {
    kernel: createCore({}) as CompressionCore,
    store: new AcpStateStore(),
    modelContextLimit: 128000,
    compressCallIdsToHide: new Set(),
  }
}

test('#185: isSkillCatalogRow recognizes every audited shape, including the source-less wild one', () => {
  // Audited host shapes, both spellings.
  assert.ok(isSkillCatalogRow(catalogEvent({ kind: 'skill-catalog', form: 'catalog' })), 'direct kind')
  assert.ok(isSkillCatalogRow(catalogEvent({ kind: 'plugin', plugin: 'dsh-tool-skill' })), 'legacy plugin wrapper')
  assert.ok(isSkillCatalogRow(catalogEvent({ kind: 'plugin:dsh-tool-skill' })), 'V4 producer kind')

  // The wild shapes the content fallback exists for (issue #185's live rows):
  // unusable source, marker still in the text.
  assert.ok(isSkillCatalogRow(catalogEvent()), 'source-less user row with the marker')
  assert.ok(isSkillCatalogRow(catalogEvent({ kind: 'user' })), 'kind user with the marker')
  assert.ok(isSkillCatalogRow(catalogEvent({ kind: 42 })), 'non-string kind with the marker')

  // Negatives: no marker, no catalog identity.
  assert.ok(!isSkillCatalogRow(catalogEvent(undefined, 'just a plain question')), 'source-less without the marker stays real content')
  assert.ok(!isSkillCatalogRow(catalogEvent({ kind: 'user' }, 'plain user words')), 'kind user without the marker')
  assert.ok(
    !isSkillCatalogRow({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: CATALOG_TEXT }] } } } as never),
    'an assistant citing the marker is not a catalog row',
  )
})

test('#185: classifySurfaceEvent keeps catalog rows barred on every real-return path; they never win last-user protection', () => {
  assert.equal(classifySurfaceEvent(catalogEvent({ kind: 'skill-catalog' })), 'instruction', 'direct kind')
  assert.equal(classifySurfaceEvent(catalogEvent({ kind: 'plugin', plugin: 'dsh-tool-skill' })), 'instruction', 'legacy wrapper')
  assert.equal(classifySurfaceEvent(catalogEvent({ kind: 'plugin:dsh-tool-skill' })), 'instruction', 'V4 producer kind')
  assert.equal(classifySurfaceEvent(catalogEvent()), 'instruction', 'source-less with the marker')
  assert.equal(classifySurfaceEvent(catalogEvent({ kind: 'user' })), 'instruction', 'kind user with the marker')
  assert.equal(classifySurfaceEvent(catalogEvent({ kind: 42 })), 'instruction', 'non-string kind with the marker')

  // Negatives stay exactly as before this fix.
  assert.equal(classifySurfaceEvent(catalogEvent(undefined, 'plain question')), 'real', 'source-less without the marker is real content')
  assert.equal(classifySurfaceEvent(catalogEvent({ kind: 'user' }, 'plain user words')), 'real')

  // Protected-tail criterion: a catalog row is never "the user speaking".
  assert.equal(isRealUserTurn(catalogEvent({ kind: 'skill-catalog' })), false)
  assert.equal(isRealUserTurn(catalogEvent()), false, 'even the source-less wild shape cannot win protection')
  assert.equal(isRealUserTurn(catalogEvent({ kind: 'user' }, 'plain user words')), true, 'a real user turn still does')
})

test('#185: newestSkillCatalogSeqOf pins ONE group — the newest visible catalog supersedes all earlier ones', () => {
  const none = Session.create('no-catalog')
  appendTurn(none, 1)
  appendUser(none, longText('q0', 0))
  assert.equal(newestSkillCatalogSeqOf(none), null, 'no catalog ever carried → null')

  const session = Session.create('catalog-group')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  const first = appendCatalogRow(session, { kind: 'skill-catalog' })
  appendUser(session, longText('q1', 1))
  const second = appendCatalogRow(session) // wild shape, later in the log
  assert.equal(newestSkillCatalogSeqOf(session), second, 'the LATEST catalog row wins, regardless of its shape')
  assert.notEqual(newestSkillCatalogSeqOf(session), first, 'an earlier catalog is superseded')
})

test('#185: the range table splits at a source-less catalog row and the REAL last user turn keeps its protection', () => {
  const session = Session.create('catalog-range-table')
  appendTurn(session, 1)                       // seq 0
  appendUser(session, longText('q0', 0))       // seq 1 — before the barrier
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  const realLastUser = 3
  appendUser(session, longText('q1', 2))       // seq 3 — real last user turn
  appendAssistant(session, longText('a1', 3), 1, 3) // seq 4
  const catalog = appendCatalogRow(session)    // seq 5 — LAST user/message on the surface

  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (seq: number): boolean => ranges.some((range) => range.start <= seq && seq <= range.end)
  assert.ok(!covers(catalog), `no offered range may contain the catalog row (seq ${catalog})`)
  assert.ok(!covers(realLastUser), `the real last user turn (seq ${realLastUser}) stays protected even though a catalog row lands after it`)
  assert.ok(ranges.length >= 2, `segments split at the catalog row (got ${ranges.length})`)
  assert.ok(covers(1), 'the pre-barrier segment is still offered')
})

test('#185: handleCompress splits around the current catalog; a superseded catalog still compresses', async () => {
  const env = makeEnv()
  const session = Session.create('catalog-compress')
  appendTurn(session, 1)                          // seq 0
  appendUser(session, longText('q0', 0))          // seq 1
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  appendCatalogRow(session, { kind: 'skill-catalog' }) // seq 3 — superseded by seq 6
  appendUser(session, longText('q1', 3))          // seq 4
  appendAssistant(session, longText('a1', 4), 1, 4) // seq 5
  const currentCatalog = appendCatalogRow(session) // seq 6 — CURRENT (wild shape)
  appendUser(session, longText('q2', 7))          // seq 7
  appendAssistant(session, longText('a2', 8), 1, 8) // seq 8

  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress, 'compress tool registered')
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const exec = { callId: 'call-acp', name: 'compress', arguments: {}, signal: new AbortController().signal, agent } as never
  const summary = 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute.'

  // A span covering the CURRENT catalog (seq 6) is CUT around it (2026-10-16,
  // the same salvage rule as a checkpoint carrier): what matters is that the
  // catalog stays visible — folding it would lose skill discovery permanently,
  // because its resend gate is the digest and folding cannot change it — and the
  // cut guarantees exactly that while the runs on either side fold.
  const split = await compress.execute({ content: [{ startSeq: 1, endSeq: 7, summary }] } as never, exec)
  const splitText = (split as { text: string }).text
  assert.match(splitText, /Compressed 1 block/)
  assert.match(splitText, /split around current protected row\(s\) 6/, 'the cut names the catalog row it kept')
  const shadowed = sessionEventsOf(session)
    .filter((event) => event.type === 'compaction/summary' || event.type === 'compaction/prune')
    .flatMap((event) => (event.data as { shadowedSeqs?: number[] }).shadowedSeqs ?? [])
  assert.ok(!shadowed.includes(6), 'the CURRENT catalog row is never shadowed')

  // The SUPERSEDED catalog (seq 3) is the legitimate cleanup: compressing it
  // while the newest stays visible triggers no resend and must succeed. Fresh
  // session: the split above already folded 1..5 here.
  const staleSession = Session.create('catalog-compress-stale')
  appendTurn(staleSession, 1)
  appendUser(staleSession, longText('q0s', 0))
  appendAssistant(staleSession, longText('a0s', 1), 1, 1)
  appendCatalogRow(staleSession, { kind: 'skill-catalog' })
  appendUser(staleSession, longText('q1s', 3))
  appendAssistant(staleSession, longText('a1s', 4), 1, 4)
  appendCatalogRow(staleSession)
  appendUser(staleSession, longText('q2s', 7))
  appendAssistant(staleSession, longText('a2s', 8), 1, 8)
  const staleExec = {
    ...(exec as object),
    agent: { ...(agent as object), session: staleSession, id: staleSession.id },
  } as never
  const accepted = await compress.execute({ content: [{ startSeq: 1, endSeq: 5, summary }] } as never, staleExec)
  const acceptedText = (accepted as { text: string }).text
  assert.match(acceptedText, /Compressed 1 block/, 'a span covering only the stale catalog lands')
  assert.ok(
    sessionEventsOf(staleSession).some((event) => String((event as { type?: string }).type) === 'compaction/summary'),
    'the accepted compression wrote its durable summary event',
  )
})

test('#185: /acp-prune compress cuts around the current catalog on the human path', async () => {
  const env = makeEnv()
  const session = Session.create('catalog-command')
  appendTurn(session, 1)                          // seq 0
  appendUser(session, longText('q0', 0))          // seq 1
  appendAssistant(session, longText('a0', 1), 1, 1) // seq 2
  appendCatalogRow(session, { kind: 'skill-catalog' }) // seq 3 — superseded
  appendUser(session, longText('q1', 3))          // seq 4
  appendAssistant(session, longText('a1', 4), 1, 4) // seq 5
  const currentCatalog = appendCatalogRow(session) // seq 6 — CURRENT
  appendUser(session, longText('q2', 7))          // seq 7
  appendAssistant(session, longText('a2', 8), 1, 8) // seq 8

  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const command = acpCommand(env)
  const run = (rawInput: string) => command.handler({
    commandId: 'cmd-test' as never,
    agent,
    rawInput,
    signal: new AbortController().signal,
  } as never) as Promise<{ kind: string; text: string }>

  // Explicit human intent does not override the arithmetic either — but the
  // arithmetic now says "keep the catalog, fold around it", so the command cuts.
  const split = await run(`compress 1 ${currentCatalog} stale early work folded away`)
  assert.equal(split.kind, 'success')
  assert.match(split.text, new RegExp(`around current protected row\\(s\\) ${currentCatalog}`), 'the kept catalog row is named')
  const shadowed = sessionEventsOf(session)
    .filter((event) => event.type === 'compaction/summary' || event.type === 'compaction/prune')
    .flatMap((event) => (event.data as { shadowedSeqs?: number[] }).shadowedSeqs ?? [])
  assert.ok(!shadowed.includes(currentCatalog), 'the current catalog row survives the human path')

  // The stale-copy cleanup path still works through the command too (fresh
  // session: the cut above already folded the runs here).
  const staleSession = Session.create('catalog-command-stale')
  appendTurn(staleSession, 1)
  appendUser(staleSession, longText('q0c', 0))
  appendAssistant(staleSession, longText('a0c', 1), 1, 1)
  appendCatalogRow(staleSession, { kind: 'skill-catalog' })
  appendUser(staleSession, longText('q1c', 3))
  appendAssistant(staleSession, longText('a1c', 4), 1, 4)
  appendCatalogRow(staleSession)
  appendUser(staleSession, longText('q2c', 7))
  appendAssistant(staleSession, longText('a2c', 8), 1, 8)
  const staleAgent = {
    id: staleSession.id,
    session: staleSession,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const staleRun = (rawInput: string) => command.handler({
    commandId: 'cmd-test-2' as never,
    agent: staleAgent,
    rawInput,
    signal: new AbortController().signal,
  } as never) as Promise<{ kind: string; text: string }>
  const accepted = await staleRun('compress 1 5 stale early work folded away')
  assert.equal(accepted.kind, 'success')
  assert.doesNotMatch(accepted.text, /rejected/)
  assert.ok(
    sessionEventsOf(session).some((event) => String((event as { type?: string }).type) === 'compaction/summary'),
    'the accepted command wrote its durable summary event',
  )
})
