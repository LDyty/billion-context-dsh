/**
 * ACP guidance delivery (src/guidance.ts).
 *
 * Why this exists: the guidance used to live ONLY in the harness system prompt
 * — the very top of every request. A provider caches a request PREFIX, so a
 * one-word copy edit up there invalidated everything behind it and the next
 * request re-sent the whole context as a miss. Live-measured on
 * session-a41fb964 (≈533K context): the request after a restart that loaded a
 * wording-only change hit 0.7% (525,658 uncached input tokens), while a restart
 * with NOTHING changed stayed at 99.6% and 263 minutes of idle stayed at 99.8%.
 *
 * Pieces under test:
 * - the delivered text is frame + rendered guidance, compared by VALUE so a
 *   restart (or a fresh process) never appends a duplicate copy;
 * - a wording change APPENDS a fresh copy and leaves the older row
 *   byte-identical (that is what keeps the cached prefix alive);
 * - the row is an `instruction` barrier (never offered, splits spans) and the
 *   newest copy is never shadowed by a compress — guidance that can be folded
 *   away is guidance the model has lost for good (nothing re-injects it);
 * - `guidanceDelivery: 'system'` still registers the system-prompt section and
 *   injects no row (the pre-2026-10-16 shape stays reachable);
 * - the default 'message' delivery registers NO system section at all — that is
 *   the actual cache-head fix.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createCore, type CompressionCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AcpCompactionEngine, { AcpCompactionEngine as Named } from '../src/index.ts'
import { classifySurfaceEvent, isRealUserTurn } from '../src/messages.ts'
import { buildCompressibleSeqRanges } from '../src/region.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import { AcpStateStore } from '../src/state.ts'
import { sessionEventsOf } from '../src/session-events.ts'
import { resolvePrompts } from '../src/prompts.ts'
import {
  ACP_GUIDANCE_FRAME,
  ACP_GUIDANCE_SOURCE_KIND,
  acpGuidanceMessageToInject,
  acpGuidanceText,
  isAcpGuidanceRow,
  newestAcpGuidanceSeqOf,
  newestAcpGuidanceText,
} from '../src/guidance.ts'
import { appendAssistant, appendTurn, appendUser, longText, wholeSurfaceRangeView } from './helpers.ts'

const PROMPTS = resolvePrompts({})

/** Append one guidance row (the durable shape the harness writes back). */
function appendGuidanceRow(session: Session, text: string): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: ACP_GUIDANCE_SOURCE_KIND },
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

test('guidance: the delivered text is frame + rendered guidance, injected once', () => {
  const session = Session.create('guidance-once')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))

  const first = acpGuidanceMessageToInject(session, PROMPTS)
  assert.ok(first, 'a session that never carried guidance gets one')
  const text = (first.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? '').join('')
  assert.ok(text.startsWith(ACP_GUIDANCE_FRAME), 'the provenance frame leads')
  assert.ok(text.includes('Active Context Pruning'), 'the rendered guidance follows')
  assert.equal(text, acpGuidanceText(PROMPTS), 'the frame + render is the ONE text definition')

  // Deliver it (what the harness does with the returned batch), then ask again:
  // the value is unchanged, so nothing new is appended.
  appendGuidanceRow(session, text)
  assert.equal(acpGuidanceMessageToInject(session, PROMPTS), undefined, 'no duplicate copy on the next step')
  assert.equal(newestAcpGuidanceText(session), text)
})

test('guidance: a wording change APPENDS a copy and leaves the older row byte-identical', () => {
  const session = Session.create('guidance-rewrite')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  const before = acpGuidanceText(PROMPTS)
  const firstSeq = appendGuidanceRow(session, before)

  // Next build ships different copy (exactly what a fix commit does).
  const rewritten = resolvePrompts({ systemPrompt: 'ACP 改写版\n{philosophy}' })
  const next = acpGuidanceMessageToInject(session, rewritten)
  assert.ok(next, 'new copy is delivered')
  const nextText = (next.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? '').join('')
  assert.notEqual(nextText, before)
  appendGuidanceRow(session, nextText)

  // The OLD row is untouched — that is what keeps the cached prefix alive (the
  // provider only re-sends from the appended tail).
  const events = sessionEventsOf(session)
  const oldRow = events[firstSeq]!
  assert.equal(newestAcpGuidanceText(session), nextText, 'the newest copy is the current one')
  assert.equal(
    (oldRow.data as { content: Array<{ text: string }> }).content[0]!.text,
    before,
    'the earlier copy is byte-identical after the rewrite',
  )
  assert.notEqual(newestAcpGuidanceSeqOf(session), firstSeq, 'the newest row is the appended one')
  assert.equal(acpGuidanceMessageToInject(session, rewritten), undefined, 'and it is settled after delivery')
})

test('guidance: recognized in BOTH durable shapes, and a shadowed row still counts as delivered', () => {
  const session = Session.create('guidance-shapes')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  // A log written by an older build / migrated by the host on open.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: acpGuidanceText(PROMPTS) }],
    source: { kind: 'plugin', plugin: 'acp-guidance' },
  } as never), { surfaceOp: 'append' })

  const seq = newestAcpGuidanceSeqOf(session)
  assert.notEqual(seq, null, 'the legacy wrapper shape is recognized')
  assert.ok(isAcpGuidanceRow(sessionEventsOf(session)[seq!]!), 'isAcpGuidanceRow accepts the wrapper')
  assert.equal(
    acpGuidanceMessageToInject(session, PROMPTS),
    undefined,
    'a migrated row is not a reason to append a duplicate',
  )
})

test('guidance: the row is an instruction barrier and never the user speaking', () => {
  const session = Session.create('guidance-class')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  const seq = appendGuidanceRow(session, acpGuidanceText(PROMPTS))
  const event = sessionEventsOf(session)[seq]!

  assert.equal(classifySurfaceEvent(event), 'instruction', 'barrier: never offered in the range table')
  assert.equal(isRealUserTurn(event), false, 'and it can never win the last-real-user protection window')

  const ranges = buildCompressibleSeqRanges(session, wholeSurfaceRangeView(session), { preserveRecent: 0 })
  const covers = (target: number): boolean => ranges.some((range) => range.start <= target && target <= range.end)
  assert.ok(!covers(seq), `no offered range may contain the guidance row (seq ${seq})`)
})

test('guidance: a compress over the row is cut around it — the current copy is never shadowed', async () => {
  const env = makeEnv()
  const session = Session.create('guidance-compress')
  appendTurn(session, 1)                                          // seq 0
  appendUser(session, longText('q0', 0))                          // seq 1
  appendAssistant(session, longText('a0', 1), 1, 1)               // seq 2
  appendGuidanceRow(session, 'first copy — superseded')           // seq 3
  appendUser(session, longText('q1', 3))                          // seq 4
  appendAssistant(session, longText('a1', 4), 1, 4)               // seq 5
  const guidanceSeq = appendGuidanceRow(session, acpGuidanceText(PROMPTS)) // seq 6 — CURRENT
  appendUser(session, longText('q2', 7))                          // seq 7
  appendAssistant(session, longText('a2', 8), 1, 8)               // seq 8

  const compress = makeTools(env).find((definition) => definition.name === 'compress')
  assert.ok(compress, 'compress tool registered')
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: { tokenMeter: undefined },
  } as never
  const exec = { callId: 'call-guidance', name: 'compress', arguments: {}, signal: new AbortController().signal, agent } as never
  const summary = 'Authentication system: JWT access tokens with 15 minute expiry, refresh tokens in Redis with 30 day TTL, login flow in src/auth/login.ts with sliding-window rate limiting at 10 requests per minute.'

  const result = await compress.execute({ content: [{ startSeq: 1, endSeq: 7, summary }] } as never, exec)
  const text = (result as { text: string }).text
  assert.match(text, /split around current protected row\(s\) 6/, 'the cut names the guidance row it kept')
  const shadowed = sessionEventsOf(session)
    .filter((event) => event.type === 'compaction/summary' || event.type === 'compaction/prune')
    .flatMap((event) => (event.data as { shadowedSeqs?: number[] }).shadowedSeqs ?? [])
  assert.ok(!shadowed.includes(guidanceSeq), 'the guidance row is never shadowed')
})

test("guidance: engine-level — 'message' (default) injects the row and registers NO system section", async () => {
  const ctx = new Context()
  const sections: Array<{ name: string }> = []
  ctx.provide('systemPrompt' as never, { section: (opts: never) => sections.push(opts as never) } as never)
  ctx.plugin(AcpCompactionEngine as never, { modelContextLimit: 16000, autoNudge: false } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const engine = ctx.compaction as Named
  assert.ok(engine instanceof Named)
  assert.equal(engine.config.guidanceDelivery, 'message', 'message delivery is the default')
  assert.equal(sections.length, 0, 'the system prompt (the request HEAD) is left untouched')

  const session = Session.create('guidance-engine')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as never

  const first = (await ctx.waterfall(
    'agent/pre-step' as never,
    { agent } as never,
    async () => ({
      kind: 'enter',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
    }) as never,
  )) as never as { kind: string; messages: Array<{ id?: string; content: Array<{ text?: string }> }> }
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 2, 'the guidance row joins the batch (autoNudge is off, so no nudge)')
  assert.ok(first.messages[0]!.content[0]!.text!.startsWith(ACP_GUIDANCE_FRAME))
  assert.equal(first.messages[1]!.id, 'u1', 'it enters BEFORE the step messages, so spans never cross it')

  // Deliver it the way the harness does, then re-run the step: nothing more.
  session.append('user/message', first.messages[0] as never, { surfaceOp: 'append' })
  const second = (await ctx.waterfall(
    'agent/pre-step' as never,
    { agent } as never,
    async () => ({ kind: 'enter', messages: [] }) as never,
  )) as never as { kind: string; messages: unknown[] }
  assert.equal(second.messages.length, 0, 'no duplicate row once the text is already delivered')
})

test("guidance: 'system' delivery registers the section and injects no row (the pre-fix shape stays reachable)", async () => {
  const ctx = new Context()
  const sections: Array<{ name: string; text: string }> = []
  ctx.provide('systemPrompt' as never, { section: (opts: never) => sections.push(opts as never) } as never)
  ctx.plugin(AcpCompactionEngine as never, { modelContextLimit: 16000, autoNudge: false, guidanceDelivery: 'system' } as never)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const engine = ctx.compaction as Named
  assert.equal(engine.config.guidanceDelivery, 'system')
  assert.equal(sections.length, 1, 'the ACP section is registered')
  assert.ok(sections[0]!.text.includes('Active Context Pruning'))

  const session = Session.create('guidance-system')
  appendTurn(session, 1)
  appendUser(session, longText('q0', 0))
  const agent = { id: session.id, session, options: { provider: 'test-provider', model: 'test-model' }, ctx: new Context() } as never
  const decision = (await ctx.waterfall(
    'agent/pre-step' as never,
    { agent } as never,
    async () => ({ kind: 'enter', messages: [] }) as never,
  )) as never as { kind: string; messages: unknown[] }
  assert.equal(decision.messages.length, 0, 'no guidance row on the system path')
})
