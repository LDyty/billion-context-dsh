/**
 * ACP guidance delivery — keeps the request HEAD byte-stable across wording
 * edits (2026-10-16).
 *
 * The load-bearing compression guidance used to live ONLY in the harness
 * system prompt (`ctx.systemPrompt.section`), i.e. at the very top of every
 * request — before the tool definitions and before every message. A provider
 * caches a request PREFIX, so editing one word up there invalidated every
 * cached block behind it and the next request re-sent the WHOLE context as a
 * fresh miss. Live-measured on session-a41fb964 (≈533K-token context, cache
 * hit = cacheRead / (input + cacheRead + cacheWrite)):
 *
 *   2026-10-16 09:57:29  hit  0.7%  in 525,658   ← first request after a
 *   2026-10-16 10:10:03  hit  1.5%  in 530,738      restart that loaded a
 *                                                   wording/tool-schema change
 *   2026-10-16 09:10:09  hit 99.6%               ← restart, NOTHING changed
 *   2026-10-11 09:23     hit 99.8%  (263 min idle) ← idle alone never breaks it
 *
 * Delivering the same text as a message keeps the two parts a plugin cannot
 * move — the harness system prompt and the tool definitions — untouched by copy
 * edits: the guidance is injected ONCE as a durable row, and a later wording
 * change APPENDS a fresh copy. The older copy stays byte-identical where it
 * sits, so the cached prefix survives it and only the appended copy is re-sent.
 *
 * Placement (see the pre-step listener): the row enters BEFORE the step's own
 * messages. Appending it after the user's turn — the host's own convention for
 * injected rows — would put it INSIDE the very exchange the model is most
 * likely to compress first, and the range geometry would have to cut that span
 * around the barrier (live: the e2e's first exchange came back split and
 * nothing folded). Ahead of the batch it is the conversation's first node, so
 * ordinary spans never cross it.
 *
 * The row is deliberately an `instruction` row (unknown plugin name, see
 * `classifySurfaceEvent`): never offered in the range table, never folded —
 * guidance that can be compressed away is guidance the model has lost, and
 * nothing re-injects it on absence. The newest copy also joins the hard-reject
 * guard set (`protectedSurfaceSeqs`), the same treatment the current AGENTS.md
 * row and the skill catalog get.
 * @module billion-context-dsh/guidance
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { extractText, sourcePluginOf } from './messages.ts'
import { renderSystemPrompt, type ResolvedPrompts } from './prompts.ts'
import { sessionEventsOf } from './session-events.ts'

/** Plugin name of the guidance row (`source.kind === 'plugin:acp-guidance'`). */
export const ACP_GUIDANCE_PLUGIN = 'acp-guidance'

/**
 * V4 producer kind of the guidance row. Same shape the nudge uses
 * (`plugin:acp-nudge`): DSH ≥0.1.7 rejects the legacy wrapper
 * `{ kind: 'plugin', plugin: … }` outright, and `plugin:<name>` is exactly what
 * the host's own V3→V4 migration emits for unregistered plugins.
 */
export const ACP_GUIDANCE_SOURCE_KIND = `plugin:${ACP_GUIDANCE_PLUGIN}`

/**
 * One-line provenance frame. The guidance rides in a user-role row (that is the
 * only durable row a plugin can inject), so the frame says out loud that this
 * is standing plugin context and NOT a user turn — the same reason
 * `SUMMARY_FRAME_PREFIX` exists for model-written summaries. It is also part of
 * the identity compared below: the frame changing is a real change.
 */
export const ACP_GUIDANCE_FRAME = '[plugin:acp-guidance — standing ACP instructions for this session, not a user turn]'

/** The exact text delivered for the CURRENT prompts (frame + rendered guidance). */
export function acpGuidanceText(prompts: ResolvedPrompts): string {
  return `${ACP_GUIDANCE_FRAME}\n${renderSystemPrompt(prompts)}`
}

/**
 * True for injected guidance rows in both durable shapes: the V4 producer kind
 * above and (defensively) the legacy wrapper, resolved through
 * `sourcePluginOf` — a session written by an older build, or migrated by the
 * host on file open, must not look like a session that never carried guidance
 * (that would append a duplicate copy on every start).
 */
export function isAcpGuidanceRow(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: unknown; plugin?: unknown } }).source
  return sourcePluginOf(source) === ACP_GUIDANCE_PLUGIN
}

/** Newest guidance row in the LOG (visible or shadowed), or null when none exists. */
export function newestAcpGuidanceSeqOf(session: Session): number | null {
  const events = sessionEventsOf(session)
  for (let seq = events.length - 1; seq >= 0; seq -= 1) {
    const event = events[seq]
    if (event !== undefined && isAcpGuidanceRow(event)) return seq
  }
  return null
}

/**
 * Text of the newest guidance row, or undefined when the session never carried
 * one. Scans the LOG rather than the visible surface on purpose: a shadowed row
 * still means "this text was already delivered", so a host-side compaction can
 * never provoke an injection loop — the engine only ever reacts to a TEXT
 * change, never to absence.
 */
export function newestAcpGuidanceText(session: Session): string | undefined {
  const events = sessionEventsOf(session)
  for (let seq = events.length - 1; seq >= 0; seq -= 1) {
    const event = events[seq]
    if (event === undefined || !isAcpGuidanceRow(event)) continue
    return extractText((event.data as { content?: unknown }).content)
  }
  return undefined
}

/**
 * The guidance row to inject this step, or undefined when the newest delivered
 * copy already carries the CURRENT text — the whole point being that a
 * re-delivery never edits the older row (which would break the cached prefix
 * again), it appends a new one.
 */
export function acpGuidanceMessageToInject(
  session: Session,
  prompts: ResolvedPrompts,
): UserMessage | undefined {
  const text = acpGuidanceText(prompts)
  if (newestAcpGuidanceText(session) === text) return undefined
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: ACP_GUIDANCE_SOURCE_KIND },
  })
}
