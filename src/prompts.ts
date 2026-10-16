/**
 * M4 — configurable prompt templates: the per-stage model-visible texts
 * (nudge frames, range table, system prompt, tool descriptions) rendered from
 * `config.prompts` templates with named placeholders.
 *
 * Design: docs/configurable-prompts-design.md (v4).
 * - placeholders are `{identifier}` only; literal braces like
 *   `compress({ content: [...] })` are left untouched (spaces/commas break the
 *   identifier rule);
 * - resolvePrompts merges user overrides over DEFAULT_PROMPTS per key
 *   (null/undefined → default, string → override; group-level null → whole
 *   group default for YAML hosts) and validates unknown placeholders at
 *   construction time (fail-fast, no silent typos);
 * - renderTemplate throws when a known placeholder has no value — callers
 *   must provide every value (e.g. tokens via a typeof fallback).
 * @module billion-context-dsh/prompts
 */

import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES } from 'acp-kernel'

/** 用户可写值:字符串模板,或 null(= 用默认,等价于不写)。YAML 宿主写 null 是合法输入。 */
export type PromptInput = string | null

/** 按组生成"每键可选、可 null"的覆盖类型。 */
export type PromptOverride<T> = { [K in keyof T]?: PromptInput }

export interface NudgePrompts {
  /** 普通档首句。占位符:{pct}（`{philosophy}` 仍被校验器接受,但 B6 会把渲染出的哲学段摘掉——它只能经系统提示到达模型) */
  normal: string
  /** 紧急档首句。占位符:{pct}（`{philosophy}` 同上) */
  emergency: string
  /** 指导行（HOW_TO_COMPRESS_RULES）。无占位符 */
  guidance: string
  /** tier 蒸馏行。占位符:{tier} {count} {prevTier} {tokens} {seqs} {firstSeq} {lastSeq} */
  tier: string
  /** 上下文分解。占位符:{system} {tool} {summaries} {code} {text} */
  breakdown: string
  /** 增长行。占位符:{growth} */
  growth: string
  /** 溢出提示。无占位符 */
  tip: string
}

export interface RangeTablePrompts {
  /** 表头。占位符:{surface} */
  header: string
  /**
   * 上下文压力行（表头下面一行）。占位符:{used} {window} {pct}
   * ——当前上下文 tokens、可持续输入预算、占用百分比。
   */
  context: string
  /** 标题。占位符:{count}(表格行数) */
  title: string
  /**
   * 年龄区域头（每个区域印一次，区间就挂在它下面）。
   * 占位符:{region} {age} {skipped}
   */
  region: string
  /** 每行。占位符:{start} {end} {count} {tokens} */
  line: string
  /** 每行的折叠成本。占位符:{reclaimed} {invalidated} {breakEven} {flag} */
  cost: string
  /** 基点行的"清扫"提议。占位符:{entries} {count} {reclaimed} {invalidated} {breakEven} {coverage} */
  batch: string
  /** 表尾调用语法。无占位符 */
  footer: string
}

export interface ToolPrompts {
  /** 工具描述(纯文本,无占位符) */
  compress: string
  decompress: string
  searchContext: string
  acpStatus: string
}

export interface AcpPrompts {
  readonly nudge?: PromptOverride<NudgePrompts>
  readonly rangeTable?: PromptOverride<RangeTablePrompts>
  readonly tools?: PromptOverride<ToolPrompts>
  /** 整段 system prompt 模板;`{philosophy}` 引用 kernel 的 COMPRESS_PHILOSOPHY */
  readonly systemPrompt?: PromptInput
}

/** 解析结果 —— 所有字段已填满(纯 string,无 null)、已校验。构造一次,全程复用。 */
export interface ResolvedPrompts {
  readonly nudge: NudgePrompts
  readonly rangeTable: RangeTablePrompts
  readonly tools: ToolPrompts
  /** 注意:这是【模板】(含 {philosophy}),不是渲染结果。渲染用 renderSystemPrompt。 */
  readonly systemPromptTemplate: string
}

/** 每槽允许的占位符名集合(构建期校验用)。 */
const NUDGE_ALLOWED: { [K in keyof NudgePrompts]: ReadonlySet<string> } = {
  normal: new Set(['pct', 'philosophy']),
  emergency: new Set(['pct', 'philosophy']),
  guidance: new Set(),
  tier: new Set(['tier', 'count', 'prevTier', 'tokens', 'seqs', 'firstSeq', 'lastSeq']),
  breakdown: new Set(['system', 'tool', 'summaries', 'code', 'text']),
  growth: new Set(['growth']),
  tip: new Set(),
}
const RANGE_TABLE_ALLOWED: { [K in keyof RangeTablePrompts]: ReadonlySet<string> } = {
  header: new Set(['surface']),
  context: new Set(['used', 'window', 'pct']),
  title: new Set(['count']),
  region: new Set(['region', 'age', 'skipped']),
  line: new Set(['start', 'end', 'count', 'tokens', 'toolPct', 'textPct', 'reasoningPct', 'toolRowPct', 'rowMix', 'media', 'skipped']),
  cost: new Set(['reclaimed', 'invalidated', 'breakEven', 'flag']),
  batch: new Set(['count', 'reclaimed', 'invalidated', 'breakEven', 'coverage', 'rowMix', 'toolPct', 'reasoningPct', 'textPct']),
  footer: new Set(),
}
const TOOLS_ALLOWED: { [K in keyof ToolPrompts]: ReadonlySet<string> } = {
  compress: new Set(),
  decompress: new Set(),
  searchContext: new Set(),
  acpStatus: new Set(),
}
const SYSTEM_ALLOWED = new Set(['philosophy', 'howToCompressRules', 'tier2DistillRules', 'tier3CondenseRules'])

/** 校验单个模板:未知 `{ident}` → throw(带槽位路径)。默认模板开发期已核验,不重扫。 */
function validateTemplate(template: string, allowed: ReadonlySet<string>, path: string): string {
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    const name = match[1]!
    if (!allowed.has(name)) {
      throw new Error(
        `${path} contains unknown placeholder {${name}} — allowed: ${[...allowed].join(', ') || '(none)'}`,
      )
    }
  }
  return template
}

/**
 * 纯替换。两个契约:
 * 1. 未知占位符不可能到达这里(构建期已校验);
 * 2. 已知占位符缺值 = 编程错误 → throw(绝不静默渲染空串)。
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(
        `renderTemplate: missing value for placeholder {${name}} in template "${template.slice(0, 60)}…"`,
      )
    }
    return String(value)
  })
}

/**
 * 逐键合并:null / undefined → 默认;字符串 → 覆盖默认(不用 spread,
 * 否则 null 会覆盖默认,与"null = 用默认"矛盾)。组级 null/undefined →
 * 整组用默认(YAML 宿主可能写 `{ nudge: null }`,W3)。
 */
function mergeGroup<T extends Record<keyof T, string>>(
  defaults: T,
  override: PromptOverride<T> | null | undefined,
  allowed: { [K in keyof T]: ReadonlySet<string> },
  path: string,
): T {
  if (override == null) return defaults
  const out = {} as { [K in keyof T]: string }
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const value = override[key]
    out[key] = value === null || value === undefined
      ? defaults[key]
      : validateTemplate(value, allowed[key], `${path}.${String(key)}`)
  }
  return out as T
}

/**
 * 深合并 + 校验;引擎构造期调用一次,出错即抛(fail-fast)。
 * 未传入时返回 DEFAULT_RESOLVED,零校验重跑。
 */
export function resolvePrompts(input?: AcpPrompts): ResolvedPrompts {
  if (input === undefined) return DEFAULT_RESOLVED
  return {
    nudge: mergeGroup(DEFAULT_PROMPTS.nudge, input.nudge, NUDGE_ALLOWED, 'prompts.nudge'),
    rangeTable: mergeGroup(DEFAULT_PROMPTS.rangeTable, input.rangeTable, RANGE_TABLE_ALLOWED, 'prompts.rangeTable'),
    tools: mergeGroup(DEFAULT_PROMPTS.tools, input.tools, TOOLS_ALLOWED, 'prompts.tools'),
    systemPromptTemplate:
      input.systemPrompt === null || input.systemPrompt === undefined
        ? DEFAULT_PROMPTS.systemPromptTemplate
        : validateTemplate(input.systemPrompt, SYSTEM_ALLOWED, 'prompts.systemPrompt'),
  }
}

/** 渲染 system prompt 模板(注入 kernel 压缩哲学、压缩规则、蒸馏规则)。 */
export function renderSystemPrompt(prompts: ResolvedPrompts): string {
  return renderTemplate(prompts.systemPromptTemplate, {
    philosophy: COMPRESS_PHILOSOPHY,
    howToCompressRules: HOW_TO_COMPRESS_RULES,
    tier2DistillRules: TIER2_DISTILL_RULES,
    tier3CondenseRules: TIER3_CONDENSE_RULES,
  })
}

/**
 * 默认模板 —— 与 v4 之前的硬编码文案逐字节一致
 * (回归锚点见 tests/prompts.test.ts 的硬编码字面量快照)。
 */
export const DEFAULT_PROMPTS: ResolvedPrompts = {
  nudge: {
    // 与 kernel nudge-text.ts EFFICIENCY_NOTE 逐字对齐——不含 "Context usage is at X%"
    // 陈述(usage 只通过 breakdown 传达);{pct} 仍可用作自定义占位符。
    // B6（2026-09-08）：正文 ≤300 B——philosophy 段移出 nudge（已住系统提示与工具描述），
    // 每拍复读同一份 6 KB 文本=重复计费。
    normal: 'Efficiency nudge: compress consumed ranges early to keep context lean — not an overflow warning. A stronger alert appears only if the context is actually full.',
    emergency: '⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.',
    guidance: HOW_TO_COMPRESS_RULES,
    tier: 'Tier {tier}: {count} tier-{prevTier} block(s) distillable ({tokens} tokens) — distill them by compressing their checkpoint seq(s) [seqs {seqs}] as one range: compress({ content: [{ startSeq: {firstSeq}, endSeq: {lastSeq}, summary }] }).',
    breakdown: 'Context breakdown: {system}K system | {tool}K tool | {summaries}K summaries | {code}K code | {text}K text',
    growth: '+{growth}K since last nudge',
    tip: '💡 Compress all ranges in one call (pass multiple content entries: `content: [{...}, {...}]`).',
  },
  rangeTable: {
    header: 'Surface: {surface}',
    // Facts only, no persuasion (owner ruling, 2026-10-16): these numbers are the
    // model's to weigh, so the line must not argue for compressing.
    context: 'Context: {used} / {window} tokens used ({pct}%)',
    title: 'Compressible ranges ({count} — up to 3 of each age region\'s largest intervals, oldest first; exact surface seqs — usable as-is):',
    // 年龄区域层：区域名 + 编号 + 被跳过（区域的属性，只印一次），下面的区间缩进一层。
    region: '[age region {region}{age} · skipped {skipped}×]',
    // Two figures, two units, each printed where it belongs: the row MIX rides
    // the message count ("7 messages (5 tool · 2 assistant)"), the character
    // partition rides the size column ("[tool 40% | reasoning 35% | text 25%]",
    // summing to 100).
    line: '    - seq {start}..{end} — {count} messages ({rowMix}), ~{tokens} tokens [tool {toolPct}% | reasoning {reasoningPct}% | text {textPct}%]{media}',
    cost: '        fold cost: reclaims ~{reclaimed} · rewrites ~{invalidated} of the cached prefix (pays back in ~{breakEven} request(s)){flag}',
    // No entry labels: a sweep can reach seventy spans, so the line states the
    // batch's totals — including the summed character partition and row mix,
    // the same two figures every row carries — and points at acp_status for the
    // list the model must fetch anyway before compressing.
    batch: '        sweep from here — all {count} spans in ONE call ({coverage}) · ~{reclaimed} tok total ({rowMix}) [tool {toolPct}% | reasoning {reasoningPct}% | text {textPct}%] · rewrites ~{invalidated} of the prefix (pays back in ~{breakEven} request(s))',
    footer: 'Compress with: compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array: batch multiple unrelated segments in one call, each entry its own block. Keep ranges disjoint.\n'
      + 'Sweep entries are not printed: the exact spans of any sweep come from acp_status({ scope: "uncompressed", view: "ranges" }).\n'
      + 'Snapshot taken at nudge time: the seqs go stale once the surface moves (a later compress shadows them), so re-run acp_status for fresh refs before compressing.\n'
      + 'Before you compress any row above, confirm it is truly consumed — if a span still holds live task state (where you are in the task / open TODOs, paths already ruled out, artifacts already done and where they live), carry that state into your summary or keep the span live. Compressing an in-progress span without carrying its state forces a full re-run afterward.',
  },
  tools: {
    // Short, STABLE contracts. The rules these used to carry (timing, the
    // re-verify self-check, how short a summary may be, the summary contract) now live in
    // the ACP guidance text (rule 22, see src/guidance.ts) — that text is
    // delivered ONCE and APPENDED on change, so a wording edit there costs a
    // tail append instead of re-sending the whole context, which is what an
    // edit to a tool description (request HEAD) does. Keep these lines short
    // and until-now-untrue of churn: every word here is paid for by every
    // request of every session.
    compress: 'Compress conversation ranges into dense summaries you write. compress({ content: [{ startSeq, endSeq, summary }] }) — content is an array (one entry per block; keep entries disjoint). Boundaries are SURFACE SEQS (acp_status / the latest nudge table), never the bN block refs. Before you compress, read the standing ACP guidance delivered in this session (the plugin:acp-guidance block, or the ACP system-prompt section): it carries the timing rules, the re-verify self-check, how short a summary may be, the summary contract, and optional verifiedReadings.',
    decompress: 'Recover a compressed block\'s original content, read-only: decompress({ blockId }) — the `bN` ref shown by acp_status (e.g. b1) or a compaction id from search_context. Large blocks are paged: pass offset/limit and follow the continue hint in the result.',
    searchContext: 'Search inside compressed blocks (summaries and original content) for information the model no longer sees in context. When a summary lacks a detail you need (exact values, error strings, decisions, verbatim code), SEARCH the compressed blocks FIRST — never guess or reconstruct from memory: search_context(query) locates the right block, then decompress only that block to recover the original.',
    acpStatus: 'Context status and the live compressible-range table (the seqs to hand to compress): no args = overview; scope/view/tool/sort/limit drill down. Overview percentages are shares of the visible content, not the context window. COMPRESSED BLOCKS refs (bN, e.g. b1) are for decompress — compress boundaries are the Surface: seqs. Drilldown row refs are kernel ids (mN), which compress accepts directly (auto-mapped to the live surface seq).',
  },
  systemPromptTemplate: `Active Context Pruning — model-driven context management

YOU decide whether and when to compress context. The nudge is an efficiency notification: when you see one, consider which ranges you have genuinely consumed and could summarise to keep working context lean.

{philosophy}

WHEN TO COMPRESS:
- A sub-agent or delegated task has returned a large result that you have already extracted the key facts from.
- Verbose command output (build/test logs, git diff, directory listings) where you have already used the information you need.
- Exploration that led nowhere.
- Repeated reads of the same file or repeated status checks once the decision is recorded.
- Resolved discussion threads where a decision has been captured in summary or in code.
- Intermediate steps of a completed multi-step task, once the final result is recorded.
- A task phase has ended — bug hunt complete, root cause found, exploration done, research sprint wrapped.

WHEN NOT TO COMPRESS:
- Content the current step is actively reading or reasoning about.
- Important user messages — preserve their exact intent, constraints, and acceptance criteria.
- Protected tool outputs — hard-excluded from compression ranges, survive intact in visible context.
- Content you will still need to cite verbatim — in review/audit/verification tasks, keep source reads un-compressed until the final report is written. If you compressed it and now need the exact detail, decompress costs a full round-trip; prefer delaying the compress.

{howToCompressRules}

Compression tools (refs are SURFACE SEQS, not ids):
- compress: replace one or more seq ranges, each with your own dense summary. Single range: compress({ content: [{ startSeq, endSeq, summary }] }). Batch multiple unrelated segments in one call (each entry becomes its own block): compress({ content: [{ startSeq: 1, endSeq: 5, summary: '...' }, { startSeq: 12, endSeq: 18, summary: '...' }] }). Keep ranges disjoint — overlapping entries in one batch are skipped. Edges are auto-balanced to tool-call/result boundaries; a trailing #callId fragment in a seq is ignored. Seq refs must be on the current surface: seqs from older nudges or earlier compresses go stale as the surface moves, so a stale span is auto-remapped to its still-live remainder (the result reports the adjusted span), a fully compressed span is reported as already compressed, and invented/other-session seqs fail with guidance. Drilldown mN refs (e.g. m00306) are also accepted as startSeq/endSeq — they are auto-mapped to the live surface seq; an unknown mN (never assigned on the current surface) fails with guidance. The block refs (bN, e.g. b1) in acp_status COMPRESSED BLOCKS are for decompress, NOT compress boundaries.
  Good compression moments: stage or subtask completion whose details you have fully consumed and will not re-check, strategy switches, intermediate milestones, and wrapping up failed exploration — when the details are consumed and no longer critical for the task ahead.
  Before compressing, ask: will I need to re-verify any detail from this range in this task? If yes, keep it live. Never compress content the current step is actively using.
  When you write a summary, turn dead-end exploration into a conclusion (what was tried, why it failed, the next step) — not a blow-by-blow; and keep the summary the ONLY record: self-contained, so a later reader (or you, after decompress) can continue without the original.
  NOT every range deserves that treatment: a span that held only noise, duplicated tool output, retries, or output already superseded by a later result gets a short HONEST summary instead — say what it was and that nothing was kept, and let decompress be the way back to the raw bytes (e.g. "retry logs — nothing kept; decompress for the raw output"). How short is judged per ENTRY by the SIZE of the span you are folding: a span under ~500 tokens may be a single sentence, while a span over that — and any block-ref distillation — still owes a real summary of at least 50 characters. So junk slivers stay short inside a call that also folds real content; there is no whole-call switch. Never pad a junk range into a fake summary, and never silently skip it — the entry is what frees the tokens.
  Optional verifiedReadings: string[] per content entry records acceptance readings that are already green (e.g. "t0-fastpath 8/8") — stored structurally on the compaction event so later steps need not re-run them.
- decompress: recover a compressed block's original content, read-only. decompress({ blockId }) — accept the bN ref shown by acp_status (e.g. b1) or a compaction id. Large blocks page (each page sized to stay under the host tool-result trim budget, up to 100 messages): pass offset/limit and follow the continue hint in the result.
- search_context: when a summary lacks the details you need (exact values, error strings, decisions, verbatim code), SEARCH the compressed blocks FIRST — never guess or reconstruct from memory; search_context(query) locates the right block, decompress only that block.
- acp_status: current context usage and the live compressible-range list. Run it right before compressing — the only seqs that never go stale are the ones you just read. Drilldown (scope/view/tool/sort/limit) lists per-message or per-block sizes; drilldown rows are kernel ids (mN) — compress accepts them directly (auto-mapped to the live surface seq).

Tiered compression: each compressed block appears on the surface as one summary node. Compressing that node again DISTILLS the block (tier 2): the parent summary folds into your new summary and the original messages are freed. Distilling a tier-2 block yields tier 3. Distill when a summary itself is consumed — decompress on the tier-2 block recovers the full originals.

{tier2DistillRules}

{tier3CondenseRules}

When you write a summary, it becomes the ONLY record of that range: keep file paths, signatures, exact values, decisions, and error strings verbatim so a later reader (or you, after decompress) can continue without the original. A mid-task compression must also hand off STATE, not just facts: where you are in the task and what remains (open TODOs), which approaches you already ruled out (dead ends), and which intermediate artifacts are already done and where they live — so the next step continues instead of re-running work you already did. A range that held only noise, duplicated tool output, retries, or output a later result superseded gets a SHORT HONEST summary rather than an invented one — say what it was and that nothing was kept. The summary floor (50 characters) is judged PER ENTRY against the SIZE of the span being folded: a span under ~500 tokens may take a single sentence, while a larger span — and any block-ref distillation — still owes a real summary. A call that mixes junk slivers with real content therefore keeps each entry's own rule; there is no whole-call switch to game. Never pad junk into a fake summary, and never drop the entry: the entry is what frees the tokens. Each age region's header line carries that region's 'skipped N×': every time YOU chose a fold start, each age region that start did NOT fall into was counted once; when that same call folded a CONTIGUOUS RUN of more than one compressible range (a sweep — consecutive offers with nothing compressible left unfolded in between), every age region those other spans reached into gave that count back — a fold that went through an age region did not pass it over, while a batch of unrelated scattered segments counts as the pass-overs it made. So a climbing number marks an age region your folds keep starting somewhere else AND never fold through, and the smallest number is the age region you keep committing to. It counts choices, not wall-clock age (an idle day changes nothing). A high number on an age region whose content is finished is a standing invitation to start there — the fold cost line next to it tells you what going that far back costs in re-sent prefix. Never reuse historical seqs — the surface moves as messages land and compress; verify with acp_status.`,
}

/** 模块级默认缓存:默认参/兜底直接引用,避免每次调用重跑校验。 */
export const DEFAULT_RESOLVED: ResolvedPrompts = DEFAULT_PROMPTS
