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

function RangeTable(props: { snapshot: AcpInspectSnapshot }): ReactElement {
  const { rows, sweeps, map } = props.snapshot
  if (rows.length === 0) return h('div', { className: 'acp-empty' }, '还没有可压范围（等下一次 nudge 生成）')
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
    h('table', { className: 'acp-table' },
    h('thead', null, h('tr', null,
      h('th', null, '段位'), h('th', null, '范围'), h('th', null, '条数'),
      h('th', null, '大小'), h('th', null, 'tool'), h('th', null, '作废'), h('th', null, '回本'), h('th', null, '清扫'), h('th', null, ''))),
    h('tbody', null, rows.map((row) => {
      const sweep = sweepOf(row.start)
      const stale = staleOf(row)
      return h('tr', { key: `${row.start}-${row.end}`, className: stale ? 'acp-stale' : undefined },
        h('td', null, `${row.band}${row.band === 1 ? '（最老）' : ''}`),
        h('td', null, `${row.start}..${row.end}${stale ? '（已过期）' : ''}`),
        h('td', null, String(row.messages)),
        h('td', null, `~${compact(row.tokens)}`),
        h('td', null, `${row.toolPct}%`),
        h('td', null, `~${compact(row.invalidated)}`),
        h('td', { className: row.expensive ? 'acp-warn' : undefined }, `${row.breakEven.toFixed(1)}×`),
        h('td', { className: 'acp-sweep' }, sweep === undefined
          ? '—'
          : `${sweep.entries}条→${compact(sweep.reclaims)} @${sweep.breakEven.toFixed(1)}×`),
        h('td', null, h(CopyButton, {
          text: compressCall(
            sweep?.spans ?? [{ start: row.start, end: row.end }],
            `（替换 ${row.start}..${row.end} 这段已消费的内容：写清做了什么、结论与还需要的路径/取值）`,
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
        h('b', null, `${String(usage.pct)}% 上下文`),
        h('span', null, `${compact(usage.tokens)} / ${compact(usage.window)}`),
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
      h('div', { className: 'acp-section' }, h('h4', null, '可压范围与清扫（与 nudge 同一套数字）'), h(RangeTable, { snapshot })),
      h('div', { className: 'acp-section' }, h('h4', null, `已压块 ${String(snapshot.blocks.length)}（展开看它当时的思考）`), h(Blocks, { blocks: snapshot.blocks })),
      Params({ snapshot }),
    )
  }, [error, sessionId, snapshot])

  return content
}
