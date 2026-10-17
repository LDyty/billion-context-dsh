/**
 * The ACP inspector panel: what the context is made of, what the engine would
 * offer to fold, and — for every block that already landed — the thinking that
 * produced it.
 *
 * One read-only view over one payload. The numbers are the engine's own (the
 * same ones the nudge prints); this file renders them, it never recomputes them.
 * The only action is "copy the call": the panel hands the reader a ready
 * `compress({...})` string instead of writing to the session itself, so a click
 * can never fold something the model did not have a chance to judge.
 */

import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { AcpInspectNode, AcpInspectSnapshot } from '../inspect-types.ts'
import { useHoverTip } from './hoverTip.tsx'

/** Where the host route lives (src/index.ts registers the same path). */
const INSPECT_ROUTE = '/api/billion-context/inspect'

/**
 * The ⚠ threshold, mirroring RANGE_TABLE_COST_WARN_PAYBACK_REQUESTS (src/nudge.ts):
 * a billable payback of this many requests. Duplicated on purpose — the client
 * bundle must not import the engine module.
 */
const WARN_PAYBACK_REQUESTS = 50

/**
 * The billing premise, mirroring `summaryTokenAllowance` (src/region.ts): the
 * summary a fold writes is assumed to be 4.5% of what it folds (80…1000 tokens),
 * measured over 338 folds in the live session.
 */
const BILLING_TIP = '计费口径（缓存未命中价 ÷ 命中价 = 参数里那个倍数，默认 50）：把「命中价」当成 1 块钱算——'
  + '①不折叠的那一次重发，按命中价发的是「被折内容 + 尾部」（从本行起点到最新的整段）；'
  + '②折叠之后实际发的是「尾部 + 摘要」，而且这两部分按未命中价算一次；'
  + '③之后每一发都少带「被折内容 − 摘要」这么多 token，按命中价省。'
  + '回本次数 =（（尾部 + 摘要）× 倍数 −（被折内容 + 尾部））÷（被折内容 − 摘要）。'
  + '摘要按被折内容的 4.5%（80…1000 token）估——实测 338 次折叠的摘要中位数。'

/**
 * 被跳过 is a property of the AGE REGION (src/age-region-skips.ts), not of one
 * interval: the counter moves when a fold CHOOSES a start outside the region, and
 * a sweep that folds through it gives the count back. A region now prints up to
 * three intervals, so the badge is printed once — next to the region's name —
 * instead of repeating on every row.
 */
const SKIP_TIP = '被跳过次数（年龄区域的属性）：模型每次选择折叠起点（sweep（清扫）算一次），起点没落在本年龄区域（ageRegion）里就 +1；如果这一次是 sweep（清扫，一拍折多个连着的区间），其中别的区间落进了本区域，就把这次的 +1 收回去（折穿就不算跳过）。爬得越高说明模型一直从别的年龄区域开始折、且从没折穿本区域；最小的那个数就是它反复选中的年龄区域。同一年龄区域印出的每一行共享这个数字。'

/**
 * The 年龄区域 header tip. The COUNT is configurable (engine `ageRegions`,
 * default 6), so the copy names whatever this build actually produced.
 */
function ageRegionTip(count: number): string {
  return `ageRegion（年龄区域）：可压内容按年龄等分成 ${String(count)} 个年龄区域，1 最老、${String(count)} 最新；`
    + '折叠的起点落在哪个年龄区域，它下面的行就属于哪个区域。'
    + '每个区域印三种角色各一条区间：计费回本最低的、最大的、最旧的（同一区间可以兼多个角色）。'
    + SKIP_TIP
}

/** 行角色（cheapest / largest / oldest）→ 面板里的中文标签。 */
const PICK_LABEL: Record<'cheapest' | 'largest' | 'oldest', string> = {
  cheapest: '最便宜',
  largest: '最大',
  oldest: '最旧',
}

/** `最便宜 · 最旧区间` / `最大区间` —— 本行在它那个年龄区域里担的角色。 */
function PICK_LABEL_OF(picks: readonly ('cheapest' | 'largest' | 'oldest')[]): string {
  return picks.map((pick) => PICK_LABEL[pick]).join(' · ')
}

const KIND_LABEL: Record<AcpInspectNode['kind'], string> = {
  tool: 'tool 工具输出',
  text: 'text 对话',
  checkpoint: 'checkpoint 已压块',
  instruction: 'instruction 旧注入行（可压）',
  protected: 'protected 当前注入行/活跃用户轮（不可压）',
  metadata: 'metadata 引擎行（可压）',
}

/** Compact token/text formatting — the panel reads at a glance or not at all. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}K`
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}K`
  return String(Math.round(value))
}

/**
 * A timestamp that never lies about the day: the panel is read across sessions
 * that live for days (this one folded blocks on the 15th and the 16th), so a
 * bare `HH:MM:SS` cannot say when a block landed. Today keeps the short form
 * (with seconds — that is recency), anything else gets its date.
 */
function stampOf(ms: number): string {
  if (ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/** How old the table snapshot is, in words — staleness is a fact the reader needs. */
function ageOf(ms: number): string {
  if (ms <= 0) return '尚未构建'
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 90) return `${String(seconds)} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${String(minutes)} 分钟前`
  return `${(minutes / 60).toFixed(1)} 小时前`
}

/** One ready-to-paste compress call for a set of spans. */
function compressCall(spans: readonly { start: number; end: number }[], summary: string): string {
  const content = spans.map((span) => `    { startSeq: ${span.start}, endSeq: ${span.end}, summary: ${JSON.stringify(summary)} },`)
  return `compress({ content: [\n${content.join('\n')}\n] })`
}

function CopyButton(props: { text: string }): ReactElement {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return undefined
    const timer = setTimeout(() => { setDone(false) }, 1200)
    return () => { clearTimeout(timer) }
  }, [done])
  return h('button', {
    className: 'acp-copy',
    type: 'button',
    onClick: () => {
      void navigator.clipboard?.writeText(props.text).catch(() => undefined)
      setDone(true)
    },
  }, done ? '已复制' : '复制调用')
}

function ContextMap(props: { map: readonly AcpInspectNode[] }): ReactElement {
  const tip = useHoverTip()
  const total = props.map.reduce((sum, node) => sum + Math.max(node.tokens, 0), 0)
  if (props.map.length === 0 || total <= 0) return h('div', { className: 'acp-empty' }, '无可绘制节点')
  // The card carries what the map cannot: which seq, how big a share of the
  // surface it is, what it is, and — for a barrier — why it cannot be folded.
  const labelOf = (node: AcpInspectNode): string => [
    `seq ${node.seq}`,
    `${KIND_LABEL[node.kind]}`,
    `~${compact(node.tokens)} tokens · ${((node.tokens / total) * 100).toFixed(1)}% 表面`,
    ...(node.barrier === undefined ? [] : [node.barrier]),
  ].join('\n')
  return h('div', null,
    h('div', { className: 'acp-map', ...tip.zoneProps }, props.map.map((node) => h('i', {
      key: node.seq,
      className: `acp-swatch acp-k-${node.kind}`,
      style: { flexGrow: Math.max(node.tokens, 1) },
      // Keyboard focus shows the same card (the slice is a real focus stop).
      tabIndex: 0,
      'data-acp-tip': labelOf(node),
    }))),
    tip.bubble,
    h('div', { className: 'acp-legend' }, Object.entries(KIND_LABEL).map(([kind, label]) =>
      h('span', { key: kind }, h('i', { className: `acp-swatch acp-k-${kind}` }), label))),
  )
}

/**
 * The three-segment character partition as a hairline meter: tool machinery,
 * reasoning scratchpad, the rest — the same three numbers the nudge row prints,
 * drawn instead of tabulated so the table can lose three columns. One ink at
 * three opacities keeps it theme-neutral (the panel's only colour is the ⚠
 * amber); the tooltip and the labels under it carry the exact percentages.
 */
function MixBar(props: { toolPct: number; reasoningPct: number; textPct: number; title: string }): ReactElement {
  return h('span', { className: 'acp-mix', title: props.title },
    h('i', { className: 'acp-mix-tool', style: { width: `${String(props.toolPct)}%` } }),
    h('i', { className: 'acp-mix-reason', style: { width: `${String(props.reasoningPct)}%` } }),
    h('i', { className: 'acp-mix-text', style: { width: `${String(props.textPct)}%` } }),
  )
}

/**
 * The row mix in the panel's own language. `row.rowMix` is the model-facing
 * English spelling (`3 tool · 2 assistant`); the panel prints Chinese labels,
 * so it reads the raw counts and keeps the English string for the tooltip.
 */
function mixLabel(counts: { readonly tool: number; readonly assistant: number; readonly user: number; readonly other: number }): string {
  const parts: string[] = []
  if (counts.tool > 0) parts.push(`工具 ${String(counts.tool)}`)
  if (counts.assistant > 0) parts.push(`助手 ${String(counts.assistant)}`)
  if (counts.user > 0) parts.push(`用户 ${String(counts.user)}`)
  if (counts.other > 0) parts.push(`其它 ${String(counts.other)}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/**
 * One row as a compact card. A narrow right-sidebar cannot hold a seven-column
 * table without shrinking every number to noise, so each row reads top-down:
 * identity → this row's composition → the sweep's composition → the two costs.
 * The sweep meter is VISIBLE now (it used to live only in a tooltip): watching
 * compression is the panel's job, not a hover game.
 */
function RowCard(props: {
  row: AcpInspectSnapshot['rows'][number]
  sweep?: AcpInspectSnapshot['sweeps'][number]
  stale: boolean
}): ReactElement {
  const { row, sweep, stale } = props
  const range = `${String(row.start)}..${String(row.end)}${stale ? ' （已过期）' : ''}`
  return h('article', { className: stale ? 'acp-prow acp-stale' : 'acp-prow' },
    h('div', { className: 'acp-prow-top' },
      h('span', {
        className: 'acp-chip',
        title: `本行担任的角色：${PICK_LABEL_OF(row.picks)}（每个年龄区域印三种角色：计费回本最低、最大、最旧；同一区间可兼多个角色）。`,
      }, PICK_LABEL_OF(row.picks)),
      h('code', {
        className: 'acp-prow-range',
        title: `seq（事件序号）${String(row.start)}..${String(row.end)}，含首尾${stale ? '；这两个 seq 已不在表面上，行已过期' : ''}。`,
      }, range),
      h('span', { className: 'acp-prow-size' }, `${String(row.messages)} 条 · ~${compact(row.tokens)}`),
      h(CopyButton, {
        text: compressCall(
          sweep?.spans ?? [{ start: row.start, end: row.end }],
          `（替换 ${row.start}..${row.end} 这个区间里已消费的内容：写清做了什么、结论与还需要的路径/取值）`,
        ),
      })),
    h('div', { className: 'acp-mixline' },
      h('span', { className: 'acp-mix-tag' }, '本行'),
      h(MixBar, {
        toolPct: row.toolPct,
        reasoningPct: row.reasoningPct,
        textPct: row.textPct,
        title: `tool（工具）${String(row.toolPct)}% · reasoning（推理）${String(row.reasoningPct)}% · text（正文）${String(row.textPct)}%，按字符算，和为 100%。`,
      }),
      h('span', { className: 'acp-mix-legend' },
        `工具 ${String(row.toolPct)}% · 推理 ${String(row.reasoningPct)}% · 正文 ${String(row.textPct)}%`)),
    h('div', { className: 'acp-mixline' },
      h('span', { className: 'acp-mix-tag' }, '清扫'),
      sweep === undefined
        ? h('span', { className: 'acp-mix-legend acp-muted' }, '这一行后面没有可加的区间')
        : h(MixBar, {
          toolPct: sweep.toolPct,
          reasoningPct: sweep.reasoningPct,
          textPct: sweep.textPct,
          title: `sweep（清扫）的字符三档构成：tool（工具）${String(sweep.toolPct)}% · reasoning（推理）${String(sweep.reasoningPct)}% · text（正文）${String(sweep.textPct)}%，和为 100%。`,
        }),
      sweep === undefined
        ? null
        : h('span', { className: 'acp-mix-legend' },
          `工具 ${String(sweep.toolPct)}% · 推理 ${String(sweep.reasoningPct)}% · 正文 ${String(sweep.textPct)}%`)),
    h('div', { className: 'acp-prow-costs' },
      h('span', { title: `invalidated（作废）~${String(row.invalidated)} token（词元）= 被折内容 + 更新的尾部 ~${String(row.newer)} token：折叠会让下一发请求把这一整段按未命中重发一次。` },
        `作废 ~${compact(row.invalidated)}`),
      h('span', {
        className: row.expensive ? 'acp-warn' : 'acp-muted',
        title: `回本 ${row.breakEven.toFixed(1)} 次请求：${BILLING_TIP}${row.expensive ? `；≥${String(WARN_PAYBACK_REQUESTS)} 次标黄 ⚠` : ''}`,
      }, `${row.expensive ? '⚠ ' : ''}本行回本 ${row.breakEven.toFixed(1)} 次`),
      sweep === undefined
        ? null
        : h('span', {
          className: sweep.expensive ? 'acp-warn' : 'acp-muted',
          title: `清扫 ${String(sweep.entries)} 个区间 → 回收 ~${compact(sweep.reclaims)} token（词元）· ${String(sweep.messages)} 条消息 · 行构成 ${mixLabel(sweep.rowCounts)} · 作废 ~${compact(sweep.invalidates)}（从本行起点到最新的整段重发一次）· 回本 ${sweep.breakEven.toFixed(1)} 次请求。${BILLING_TIP}`,
        }, `${sweep.expensive ? '⚠ ' : ''}清扫 ${String(sweep.entries)} 区间 → 回收 ~${compact(sweep.reclaims)} · 回本 ${sweep.breakEven.toFixed(1)}`)),
  )
}

/**
 * The complement map: intervals a sweep from the oldest printed row folds in
 * addition. `<details>` keeps the body collapsible; its own scroller caps the
 * height so a 300-span session cannot bury the blocks below.
 */
function ComplementBlock(props: { complement: NonNullable<AcpInspectSnapshot['complement']> }): ReactElement {
  const { complement } = props
  const capped = complement.total > 120
  return h('details', { className: 'acp-others', open: true },
    h('summary', null,
      `清扫还会折的区间 ${String(complement.total)} 段`,
      h('span', { className: 'acp-muted' }, `（从 seq ${String(complement.oldest)} 起）`)),
    h('div', { className: 'acp-others-body' },
      complement.regions.map(({ region, ranges }) => {
        const shown = capped && ranges.length > 2 ? [ranges[0]!, ranges[ranges.length - 1]!] : ranges
        const elided = ranges.length - shown.length
        return h('div', { className: 'acp-others-line', key: region },
          h('span', { className: 'acp-others-region' }, `R${String(region)}`),
          h('span', { className: 'acp-others-spans' }, shown.map((range) => `${String(range.start)}..${String(range.end)}`).join(' ')),
          elided > 0 ? h('span', { className: 'acp-muted' }, ` (+${String(elided)} more, ${String(ranges.length)} 段)`) : null)
      })),
  )
}

/** Exported for the offline preview (`scratch-panel-preview.mjs`) and future tests. */
export function RangeTable(props: { snapshot: AcpInspectSnapshot }): ReactElement {
  const { rows, sweeps, map, complement } = props.snapshot
  if (rows.length === 0) return h('div', { className: 'acp-empty' }, '还没有可压区间（等下一次 nudge 生成）')
  const sweepOf = (start: number): AcpInspectSnapshot['sweeps'][number] | undefined =>
    sweeps.find((sweep) => sweep.rowStart === start)
  // A row whose edges are no longer on the live surface describes content that
  // was folded (or shadowed) since this table was built.
  const onSurface = new Set(map.map((node) => node.seq))
  const staleOf = (row: AcpInspectSnapshot['rows'][number]): boolean =>
    !onSurface.has(row.start) || !onSurface.has(row.end)
  const staleCount = rows.filter(staleOf).length
  const regionCount = rows.reduce((max, row) => Math.max(max, row.ageRegion), 0)
  // The age-region header is printed once, then its cards — the six regions read
  // as six chapters instead of eighteen table rows.
  const groups: Array<{ region: number; rows: AcpInspectSnapshot['rows'][number][] }> = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last?.region === row.ageRegion) last.rows.push(row)
    else groups.push({ region: row.ageRegion, rows: [row] })
  }
  return h('div', { className: 'acp-section' },
    staleCount > 0
      ? h('div', { className: 'acp-warn' },
        `${String(staleCount)}/${String(rows.length)} 行已过期（这些 seq 已不在表面上——压过或表面已移动）。`
        + '下次 nudge 或打开面板时会自动重建。')
      : null,
    h('div', { className: 'acp-regions' }, groups.map((group) =>
      h('section', { className: 'acp-region', key: group.region },
        h('header', { className: 'acp-region-head' },
          h('span', { className: 'acp-region-title', title: ageRegionTip(regionCount) },
            `年龄区域 ${String(group.region)}${group.region === 1 ? '（最老）' : group.region === regionCount ? '（最新）' : ''}`),
          h('span', {
            className: group.rows[0]!.skipped > 0 ? 'acp-badge' : 'acp-badge acp-muted',
            title: SKIP_TIP,
          }, `被跳过 ${String(group.rows[0]!.skipped)}×`)),
        group.rows.map((row) => h(RowCard, {
          key: `${String(row.start)}-${String(row.end)}`,
          row,
          sweep: sweepOf(row.start),
          stale: staleOf(row),
        }))))),
    complement === undefined ? null : h(ComplementBlock, { complement }),
  )
}

function Blocks(props: { blocks: AcpInspectSnapshot['blocks'] }): ReactElement {
  if (props.blocks.length === 0) return h('div', { className: 'acp-empty' }, '还没有压缩块')
  return h('div', { className: 'acp-blocks' }, [...props.blocks].reverse().map((block) =>
    h('details', { key: block.id, className: 'acp-block' },
      h('summary', null,
        h('span', null, block.shortId),
        h('span', null, `${block.start}..${block.end}`),
        h('span', null, `${block.messages} 条`),
        h('span', null, `~${compact(block.tokens)}`),
        h('span', { className: 'acp-muted' }, `T${block.tier} · ${stampOf(block.createdAt)}`),
        block.why === undefined ? null : h('span', { className: 'acp-muted' }, '有思考记录'),
      ),
      block.why === undefined ? null : h('pre', { className: 'acp-why' }, block.why),
      h('pre', null, block.summary),
    )))
}

function Params(props: { snapshot: AcpInspectSnapshot }): ReactElement {
  const { settings, usage } = props.snapshot
  const line = `/acp-prune config set nudgeMaxContextLimitPct ${String(settings.nudgeMaxContextLimitPct)}`
  const ratioLine = `/acp-prune config set cacheMissPriceRatio ${String(settings.cacheMissPriceRatio)}`
  const pct = (value: number): string => `${Math.round(value * 100)}%`
  return h('div', { className: 'acp-section' },
    h('h4', null, '参数（引擎实时读取的值）'),
    h('div', null,
      `窗口 ${compact(usage.window)} · nudge 下限 ${pct(settings.nudgeMinContextLimitPct)} · 上限 ${pct(settings.nudgeMaxContextLimitPct)}`
      + ` · 紧急 ${pct(settings.nudgeEmergencyThresholdPct)}`
      + (settings.preset === undefined ? '' : ` · 预设 ${settings.preset}`)),
    // 计费比值：缓存未命中价 ÷ 缓存命中价。nudge 里作为事实印给模型，这里是同一个数，
    // 顺带给出改它的命令。
    h('div', { title: '缓存未命中 ÷ 缓存命中 的单价倍数：模型按这个比值把「折叠一次性重写」换算成钱（作废 ~X token × 这个倍数，对比之后每次请求省下的 ~Y token）。' },
      `计费：缓存未命中 / 命中 = ${String(settings.cacheMissPriceRatio)}×（可设）· 回本 ⚠ 阈值 ${String(WARN_PAYBACK_REQUESTS)} 次 · 摘要按被折内容的 4.5% 估`),
    h('div', { className: 'acp-row-head' },
      h('code', null, line),
      h(CopyButton, { text: line })),
    h('div', { className: 'acp-row-head' },
      h('code', null, ratioLine),
      h(CopyButton, { text: ratioLine })),
  )
}

/** The whole panel body for one session. */
export function AcpInspectorPanel(props: { sessionId?: string }): ReactElement {
  const [snapshot, setSnapshot] = useState<AcpInspectSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionId = props.sessionId

  useEffect(() => {
    if (sessionId === undefined) return undefined
    let live = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(INSPECT_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const payload = await response.json() as { ok?: boolean; value?: AcpInspectSnapshot | null; error?: { message?: string } }
        if (!live) return
        if (payload.ok !== true) {
          setError(payload.error?.message ?? 'inspect route failed')
          return
        }
        setError(null)
        setSnapshot(payload.value ?? null)
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [sessionId])

  const content = useMemo(() => {
    if (error !== null) return h('div', { className: 'acp-empty' }, `读取失败：${error}`)
    if (sessionId === undefined) return h('div', { className: 'acp-empty' }, '未选择会话')
    if (snapshot === null) return h('div', { className: 'acp-empty' }, '正在读取…')
    const { usage, surface } = snapshot
    const breakdown = usage.breakdown
    const windowNote = usage.windowSource === 'engine'
      ? '可持续输入预算'
      : usage.windowSource === 'projection'
        ? '路由原始窗口（未扣输出预留）'
        : '内置默认值（引擎尚未测过这条会话）'
    return h('div', { className: 'acp-panel' },
      h('div', { className: 'acp-head' },
        // 和 nudge 里那行同口径：这个数字不只是钱——缓存命中虽然单价低，量大了账单照样堆；
        // 长上下文还会稀释模型的注意力和推理质量，所以它是「早点压」的理由，不只是告警。
        h('b', { title: '当前上下文占用（token（词元）实测值 ÷ 可持续输入预算）。它同时是两件事：① 钱——缓存命中只是单价低，prefix（前缀）越大每一步的账单越高，量多照样堆；② 注意力——上下文越长，模型的注意力和推理质量越容易被稀释。折叠会让从起点往后的 prefix（前缀）一次性按未命中价重发一次，但那是一次性代价：一次折得越宽（sweep（清扫）越宽），回收越多、回本越快，之后的上下文也越短。' }, `${String(usage.pct)}% 上下文`),
        h('span', { title: '下一步请求要携带的 prefix（前缀）规模：宿主实测的上下文 token（词元）数 / 可持续输入预算（窗口 − 路由的输出预留）。' }, `${compact(usage.tokens)} / ${compact(usage.window)}`),
        h('span', { className: usage.windowSource === 'engine' ? 'acp-muted' : 'acp-warn' }, windowNote),
        h('span', { className: 'acp-muted' }, `表面 ${String(surface.nodes)} 节点 · ${String(surface.firstSeq)}..${String(surface.lastSeq)}`),
        h('span', { className: 'acp-muted' }, `表快照 ${stampOf(snapshot.capturedAt)}（${ageOf(snapshot.capturedAt)}）`),
      ),
      h('div', { className: 'acp-bar' }, h('span', { style: { width: `${String(Math.min(100, usage.pct))}%` } })),
      // Two calibers, named: the pressure above is provider-anchored (it includes
      // the system prompt and tool schemas as fixed overhead), while this line is
      // the engine's TEXT estimate over the visible surface with checkpoint nodes
      // replaced by their blocks' summaries. They do not add up to each other, and
      // pretending otherwise is how a reader ends up distrusting both.
      h('div', { className: 'acp-muted' },
        `文本估算（另一把尺子，不含固定开销）：tool ${compact(breakdown.tool)} · text ${compact(breakdown.text)}`
        + ` · code ${compact(breakdown.code)} · summaries ${compact(breakdown.summaries)}`),
      h('div', { className: 'acp-section' }, h('h4', null, '上下文地图（按提示顺序）'), h(ContextMap, { map: snapshot.map })),
      h('div', { className: 'acp-section' }, h('h4', null, '可压区间与清扫（与 nudge 同一套数字）'), h(RangeTable, { snapshot })),
      h('div', { className: 'acp-section' }, h('h4', null, `已压块 ${String(snapshot.blocks.length)}（展开看它当时的思考）`), h(Blocks, { blocks: snapshot.blocks })),
      Params({ snapshot }),
    )
  }, [error, sessionId, snapshot])

  return content
}
