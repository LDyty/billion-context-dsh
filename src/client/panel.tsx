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
 * The ⚠ threshold, mirroring RANGE_TABLE_COST_WARN_BREAK_EVEN (src/nudge.ts).
 * Duplicated on purpose: the client bundle must not import the engine module.
 */
const WARN_BREAK_EVEN = 6

/**
 * 被跳过 is a property of the AGE REGION (src/age-region-skips.ts), not of one
 * interval: the counter moves when a fold CHOOSES a start outside the region, and
 * a sweep that folds through it gives the count back. A region now prints up to
 * three intervals, so the badge is printed once — next to the region's name —
 * instead of repeating on every row.
 */
const SKIP_TIP = '被跳过次数（年龄区域的属性）：模型每次选择折叠起点（sweep（清扫）算一次），起点没落在本年龄区域（ageRegion）里就 +1；如果这一次是 sweep（清扫，一拍折多个连着的区间），其中别的区间落进了本区域，就把这次的 +1 收回去（折穿就不算跳过）。爬得越高说明模型一直从别的年龄区域开始折、且从没折穿本区域；最小的那个数就是它反复选中的年龄区域。同一年龄区域印出的每一行共享这个数字。'

/** The 年龄区域 header: what a region is, and what the badge beside its name means. */
const AGE_REGION_TIP = 'ageRegion（年龄区域）：可压内容按年龄等分成 6 个年龄区域，1 最老、6 最新；折叠的起点落在哪个年龄区域，它下面的行就属于哪个区域。每个区域印它最大的 3 个区间（按大小取）。'
  + SKIP_TIP

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

/** Exported for the offline preview (`scratch-panel-preview.mjs`) and future tests. */
export function RangeTable(props: { snapshot: AcpInspectSnapshot }): ReactElement {
  const { rows, sweeps, map } = props.snapshot
  if (rows.length === 0) return h('div', { className: 'acp-empty' }, '还没有可压区间（等下一次 nudge 生成）')
  const sweepOf = (start: number): AcpInspectSnapshot['sweeps'][number] | undefined =>
    sweeps.find((sweep) => sweep.rowStart === start)
  // A row whose edges are no longer on the live surface describes content that
  // was folded (or shadowed) since this table was built. Saying so beats letting
  // the reader copy a call for seqs that do not exist any more.
  const onSurface = new Set(map.map((node) => node.seq))
  const staleOf = (row: AcpInspectSnapshot['rows'][number]): boolean =>
    !onSurface.has(row.start) || !onSurface.has(row.end)
  const staleCount = rows.filter(staleOf).length
  return h('div', { className: 'acp-section' },
    staleCount > 0
      ? h('div', { className: 'acp-warn' },
        `${String(staleCount)}/${String(rows.length)} 行已过期（这些 seq 已不在表面上——压过或表面已移动）。`
        + '下次 nudge 或打开面板时会自动重建。')
      : null,
    // Seven columns, not twelve: the composition became a meter with its three
    // shares spelled out underneath, the row mix a sub-line under the range,
    // 作废/回本/被跳过 one cost cell, and the sweep line keeps its own cell.
    // Every column answers on hover too, and every English term in a tooltip
    // carries its Chinese gloss right beside it.
    // The table itself does not scroll: the PANEL does (`.acp-panel`), so the 18
    // rows and everything below them (已压块 / 参数) scroll as one column with a
    // single scrollbar, and the header sticks to the panel's scrollport.
    h('table', { className: 'acp-table acp-ranges' },
    h('thead', null, h('tr', null,
      h('th', { title: AGE_REGION_TIP }, '年龄区域'),
      // 列名不叫「范围」：这个说法会和整张表的「可压范围」撞车，读者分不清是
      // 「这一行要折的那个区间」还是「整张表所有可压的区间」。一行 = 一个区间；
      // 每个年龄区域印它最大的 3 个区间。
      h('th', { title: '区间（seq（事件序号）起止，含首尾）：本行折叠时实际覆盖的那个区间。每个年龄区域印它最大的 3 个（按大小取，行仍按 seq 从老到新排）。下面那行是行构成（按消息条数）：tool（工具调用与工具结果）· assistant（助手）· user（用户）· other（其它引擎行）。' }, '区间'),
      h('th', { title: 'token（词元）估算值，宿主口径：行的 JSON 长度加上 role（角色）开销。~ 表示估算。' }, '大小'),
      h('th', { title: '按字符算的三档构成，相加为 100%：tool（工具：工具调用参数 + 工具结果）· reasoning（推理：草稿）· text（正文：用户消息、助手正文、注入行）。' }, '构成'),
      h('th', { title: 'invalidated（作废）＝ 折叠这一行会让下一发请求重发多少 prefix（前缀）；breakEven（回本）＝ 赚回这次重写需要几次请求，≥6 标黄 ⚠。被跳过次数是年龄区域的属性，印在「年龄区域」那一格。' }, '代价'),
      h('th', { title: 'sweep（清扫）：从本行的起点只向新的方向、不封顶地连着折叠（N 个区间 → 回收 token（词元）量 · 回本倍数）；与 nudge（提醒文本）里那一行是同一组数字。' }, '清扫'),
      h('th', { title: '复制一条可直接粘贴的 compress（压缩）调用。' }, ''))),
    h('tbody', null, rows.map((row, rowIndex) => {
      const sweep = sweepOf(row.start)
      const stale = staleOf(row)
      // Three rows share one age region, so the number is printed once per group
      // (and the leaders of the group carry a muted ditto) — the column reads as
      // the six 年龄区域 it is, not as eighteen unrelated rows.
      const firstOfRegion = rows[rowIndex - 1]?.ageRegion !== row.ageRegion
      return h('tr', { key: `${row.start}-${row.end}`, className: stale ? 'acp-stale' : undefined },
        h('td', {
          className: 'acp-age-region',
          title: `ageRegion（年龄区域）${String(row.ageRegion)}：${row.ageRegion === 1 ? '最老的年龄区域' : `从老到新数第 ${String(row.ageRegion)} 个年龄区域`}`
            + `；本行是它印出的第 ${String(row.rankInAgeRegion)} 大区间（每个年龄区域最多印 3 个，按大小取，行的先后仍按 seq 从老到新）。${SKIP_TIP}`,
        }, firstOfRegion
          ? h('div', null,
            h('div', null, row.ageRegion === 1 ? '1 最老' : String(row.ageRegion)),
            // The region's pass-over count, printed where the region is named.
            h('div', null, h('span', {
              className: row.skipped > 0 ? 'acp-badge' : 'acp-badge acp-muted',
              title: SKIP_TIP,
            }, `被跳过 ${String(row.skipped)}×`)))
          : h('span', { className: 'acp-muted' }, '〃')),
        h('td', { className: 'acp-range' },
          h('span', {
            title: `seq（事件序号）${String(row.start)}..${String(row.end)}，含首尾${stale ? '；这两个 seq 已不在表面上，行已过期' : ''}。`,
          }, `${String(row.start)}..${String(row.end)}${stale ? ' （已过期）' : ''}`),
          h('span', {
            className: 'acp-sub',
            title: `行构成，按消息条数算：tool（工具）· assistant（助手）· user（用户）· other（其它）。模型侧看到的英文写法是 ${row.rowMix}。`,
          }, `${String(row.messages)} 条 · ${mixLabel(row.rowCounts)}`)),
        h('td', { title: 'token（词元）估算值，宿主口径：行的 JSON 长度加上 role（角色）开销。' }, `~${compact(row.tokens)}`),
        h('td', null,
          h(MixBar, {
            toolPct: row.toolPct,
            reasoningPct: row.reasoningPct,
            textPct: row.textPct,
            title: `tool（工具）${String(row.toolPct)}% · reasoning（推理）${String(row.reasoningPct)}% · text（正文）${String(row.textPct)}%，按字符算，和为 100%。`,
          }),
          h('span', { className: 'acp-sub' },
            `工具 ${String(row.toolPct)}% · 推理 ${String(row.reasoningPct)}% · 正文 ${String(row.textPct)}%`)),
        h('td', null,
          h('div', { title: `invalidated（作废）~${String(row.invalidated)} token（词元）：折叠这一行会让下一发请求重发这么多 prefix（前缀）。` },
            `作废 ~${compact(row.invalidated)}`),
          h('div', {
            className: row.expensive ? 'acp-warn acp-cost-rate' : 'acp-muted acp-cost-rate',
            title: `breakEven（回本）${row.breakEven.toFixed(1)}×：约这么多次请求之后，省下的内容才盖过这次重写的浪费${row.expensive ? '；≥6 次标黄 ⚠' : ''}。`,
          }, `${row.expensive ? '⚠ ' : ''}回本 ${row.breakEven.toFixed(1)}×`)),
        h('td', {
          className: 'acp-sweep',
          // Same figures the nudge's sweep line carries: the panel is a view of
          // one remembered build, never a second opinion.
          title: sweep === undefined
            ? '这一行后面没有可加的区间'
            : `sweep（清扫）：${String(sweep.entries)} 个区间 → ${String(sweep.messages)} 条消息折叠成 ${String(sweep.entries)} 份摘要 · `
              + `回收 ~${compact(sweep.reclaims)} token（词元）· 行构成 ${mixLabel(sweep.rowCounts)} · `
              + `字符三档 tool（工具）${String(sweep.toolPct)}% · reasoning（推理）${String(sweep.reasoningPct)}% · text（正文）${String(sweep.textPct)}% · `
              + `作废 ~${compact(sweep.invalidates)} token（词元）（这一批折叠会让下一发请求重发这么多 prefix（前缀））· `
              + `回本 ${sweep.breakEven.toFixed(1)}×（把这批的作废赚回来约需要的请求数${sweep.breakEven >= WARN_BREAK_EVEN ? '，≥6 次标黄 ⚠' : ''}）· `
              + `从本行的起点只向新的方向、不封顶；和 nudge（提醒文本）里那一行是同一组数字。`,
        }, sweep === undefined
          ? '—'
          : h('div', null,
            `${String(sweep.entries)} 个区间 → ~${compact(sweep.reclaims)}`,
            // The sweep's own payback, explained where it is read: the row's 代价
            // cell prices folding THAT span alone, this one prices the whole
            // recommended batch — the two numbers answer different questions and
            // the sweep is usually the cheaper of them.
            h('span', {
              className: sweep.breakEven >= WARN_BREAK_EVEN
                ? 'acp-sub acp-warn'
                : 'acp-sub',
              title: `回本 ${sweep.breakEven.toFixed(1)}×：这一批整体折叠的 breakEven（回本）——把这 ${String(sweep.entries)} 个区间折掉会造成 ~${compact(sweep.invalidates)} token（词元）的 prefix（前缀）重写，约 ${sweep.breakEven.toFixed(1)} 次请求之后省下的内容才盖过它。${sweep.breakEven >= WARN_BREAK_EVEN ? '≥6 次标黄 ⚠。' : ''}和「代价」那一格的区别：那边只算这一行自己的区间，这边算整批。`,
            }, `${sweep.breakEven >= WARN_BREAK_EVEN ? '⚠ ' : ''}回本 ${sweep.breakEven.toFixed(1)}×`))),
        h('td', null, h(CopyButton, {
          text: compressCall(
            sweep?.spans ?? [{ start: row.start, end: row.end }],
            `（替换 ${row.start}..${row.end} 这个区间里已消费的内容：写清做了什么、结论与还需要的路径/取值）`,
          ),
        })),
      )
    })),
    ),
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
  const pct = (value: number): string => `${Math.round(value * 100)}%`
  return h('div', { className: 'acp-section' },
    h('h4', null, '参数（引擎实时读取的值）'),
    h('div', null,
      `窗口 ${compact(usage.window)} · nudge 下限 ${pct(settings.nudgeMinContextLimitPct)} · 上限 ${pct(settings.nudgeMaxContextLimitPct)}`
      + ` · 紧急 ${pct(settings.nudgeEmergencyThresholdPct)}`
      + (settings.preset === undefined ? '' : ` · 预设 ${settings.preset}`)),
    h('div', { className: 'acp-row-head' },
      h('code', null, line),
      h(CopyButton, { text: line })),
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
        h('b', { title: '当前上下文占用（token（词元）实测值 ÷ 可持续输入预算）。它同时是两件事：① 钱——即使按缓存命中的低价算，prefix（前缀）越大每一步的账单越高，折叠会让从起点往后的 prefix 一次性按未命中价重发，之后整体变短；② 注意力——上下文越长，模型的注意力和推理质量越容易被稀释。' }, `${String(usage.pct)}% 上下文`),
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
