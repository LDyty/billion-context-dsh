/**
 * Compression Network — a CAD-style, pan/zoom canvas over the compression
 * lifecycle: age regions → offerable ranges → sweeps → landed blocks (with
 * tier-2/3 parent links). Hover (or pin) a node and its whole lineage lights
 * up; the inspector beside the canvas follows the selection.
 *
 * No graph library: the canvas is ONE transformed layer (`translate3d scale`)
 * with absolute cards and an SVG link layer in the same coordinate space, so
 * pan/zoom only touches one style property. Pan/zoom updates are committed via
 * refs (no React render per frame); only LOD bucket changes, hover, pins and
 * node drops re-render.
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { AcpInspectBlock, AcpInspectRow, AcpInspectSnapshot, AcpInspectSweep } from '../inspect-types.ts'

type NodeKind = 'region' | 'range' | 'sweep' | 'block'
type Lod = 'far' | 'mid' | 'near'

export interface NetNode {
  readonly id: string
  readonly kind: NodeKind
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly title: string
  readonly sub: string
  readonly tokens: number
  readonly region?: number
  readonly row?: AcpInspectRow
  readonly sweep?: AcpInspectSweep
  readonly block?: AcpInspectBlock
  readonly span?: { readonly start: number; readonly end: number }
  /** Range nodes only: the printed recommendation vs the sweep complement. */
  readonly variant?: 'recommended' | 'complement'
}

interface NetEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'owns' | 'sweep' | 'covers' | 'parent'
}

export interface BlockSlot {
  readonly tier: number
  readonly index: number
}

export interface NetLayout {
  readonly nodes: readonly NetNode[]
  readonly edges: readonly NetEdge[]
  readonly columns: readonly { readonly x: number; readonly label: string }[]
  readonly bands: readonly { readonly x: number; readonly y: number; readonly label: string }[]
  readonly width: number
  readonly height: number
}

const PAD = 44
const NODE_W = { region: 150, range: 176, sweep: 170, block: 200 }
const PITCH = { region: 86, range: 40, sweep: 56, block: 52 }
const MAX_BLOCKS = 12
const LANE_GAP = 56
const REGION_GAP = 14
const RANGE_GAP = 14
const SWEEP_GAP = 14
const BLOCK_GAP = 12
const BAND_GAP = 28
/** Target height of a lane before it wraps into another sub-column. */
const TARGET_LANE_HEIGHT = 1040

function colsFor(count: number, pitch: number, maxCols: number): number {
  const rowsPerColumn = Math.max(1, Math.floor(TARGET_LANE_HEIGHT / pitch))
  return Math.max(1, Math.min(maxCols, Math.ceil(count / rowsPerColumn)))
}
const MIN_ZOOM = 0.06
const MAX_ZOOM = 3

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}K`
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}K`
  return String(Math.round(value))
}

const rangeId = (start: number, end: number): string => `g:${String(start)}:${String(end)}`
const regionId = (region: number): string => `r:${String(region)}`
const sweepId = (rowStart: number): string => `s:${String(rowStart)}`
const blockId = (id: string): string => `b:${id}`

/** Deterministic layered layout — no physics, so the same build always draws the same graph. */
export function buildLayout(snapshot: AcpInspectSnapshot): NetLayout {
  const nodes: NetNode[] = []
  const edges: NetEdge[] = []
  const regionNodes = new Map<number, string>()

  const regions = snapshot.regions.length > 0
    ? snapshot.regions
    : [...new Map(snapshot.rows.map((row) => [row.ageRegion, row])).values()].map((row) => ({
      region: row.ageRegion,
      start: row.start,
      end: row.end,
      tokens: row.tokens,
      ranges: 1,
    }))

  type RangeDef = { start: number; end: number; tokens: number; region: number; row?: AcpInspectRow }
  const recommendedDefs: RangeDef[] = snapshot.rows.map((row) => (
    { start: row.start, end: row.end, tokens: row.tokens, region: row.ageRegion, row }
  ))
  const recommendedKeys = new Set(recommendedDefs.map((def) => `${String(def.start)}:${String(def.end)}`))
  const complementDefs: RangeDef[] = []
  for (const group of snapshot.complement?.regions ?? []) {
    for (const range of group.ranges) {
      const key = `${String(range.start)}:${String(range.end)}`
      if (recommendedKeys.has(key)) continue
      recommendedKeys.add(key)
      complementDefs.push({ start: range.start, end: range.end, tokens: range.tokens, region: group.region })
    }
  }
  const byStart = (left: RangeDef, right: RangeDef): number => left.start - right.start || left.end - right.end
  recommendedDefs.sort(byStart)
  complementDefs.sort(byStart)

  // Adaptive columns: a lane wraps when it would exceed the target height, so
  // adding age regions or ranges widens the graph instead of growing without
  // bound. Region and sweep lanes also wrap; the three block tiers stay fixed.
  const regionCols = colsFor(regions.length, PITCH.region, 2)
  const recommendedCols = colsFor(recommendedDefs.length, PITCH.range, 4)
  const complementCols = colsFor(complementDefs.length, PITCH.range, 6)
  const recommendedWidth = recommendedCols * (NODE_W.range + RANGE_GAP) - RANGE_GAP
  const complementWidth = complementDefs.length === 0
    ? 0
    : BAND_GAP + complementCols * (NODE_W.range + RANGE_GAP) - RANGE_GAP
  const rangeWidth = recommendedWidth + complementWidth
  const sweepCols = colsFor(snapshot.sweeps.length, PITCH.sweep, 3)

  let laneX = PAD
  const regionX = laneX
  laneX += regionCols * (NODE_W.region + REGION_GAP) - REGION_GAP + LANE_GAP
  const rangeX = laneX
  laneX += rangeWidth + LANE_GAP
  const sweepX = laneX
  laneX += sweepCols * (NODE_W.sweep + SWEEP_GAP) - SWEEP_GAP + LANE_GAP
  const blockX = laneX

  regions.forEach((region, index) => {
    const id = regionId(region.region)
    regionNodes.set(region.region, id)
    nodes.push({
      id,
      kind: 'region',
      x: regionX + (index % regionCols) * (NODE_W.region + REGION_GAP),
      y: PAD + Math.floor(index / regionCols) * PITCH.region,
      w: NODE_W.region,
      h: 64,
      title: `年龄区域 ${String(region.region)}`,
      sub: `${String(region.ranges)} 段 · ~${compact(region.tokens)}`,
      tokens: region.tokens,
      region: region.region,
    })
  })

  const rangeNodes = new Map<string, string>()
  const placeRanges = (
    list: readonly RangeDef[],
    startX: number,
    startY: number,
    variant: 'recommended' | 'complement',
    cols: number,
  ): void => {
    list.forEach((def, index) => {
      const id = rangeId(def.start, def.end)
      rangeNodes.set(id, id)
      nodes.push({
        id,
        kind: 'range',
        x: startX + (index % cols) * (NODE_W.range + RANGE_GAP),
        y: startY + Math.floor(index / cols) * PITCH.range,
        w: NODE_W.range,
        h: 32,
        title: `${String(def.start)}..${String(def.end)}`,
        sub: def.row === undefined ? `~${compact(def.tokens)}` : `${String(def.row.messages)} · ~${compact(def.tokens)}`,
        tokens: def.tokens,
        region: def.region,
        ...(def.row === undefined ? {} : { row: def.row }),
        span: { start: def.start, end: def.end },
        variant,
      })
      const owner = regionNodes.get(def.region)
      if (owner !== undefined) edges.push({ id: `o:${owner}:${id}`, from: owner, to: id, kind: 'owns' })
    })
  }
  const bandTop = PAD + 16
  const complementX = rangeX + recommendedWidth + BAND_GAP
  placeRanges(recommendedDefs, rangeX, bandTop, 'recommended', recommendedCols)
  placeRanges(complementDefs, complementX, bandTop, 'complement', complementCols)
  const bands = [
    { x: rangeX, y: PAD, label: `推荐区间 · ${String(recommendedDefs.length)}` },
    ...(complementDefs.length === 0
      ? []
      : [{ x: complementX, y: PAD, label: `补集区间 · ${String(complementDefs.length)}` }]),
  ]

  snapshot.sweeps.forEach((sweep, index) => {
    const id = sweepId(sweep.rowStart)
    nodes.push({
      id,
      kind: 'sweep',
      x: sweepX + (index % sweepCols) * (NODE_W.sweep + SWEEP_GAP),
      y: PAD + Math.floor(index / sweepCols) * PITCH.sweep,
      w: NODE_W.sweep,
      h: 48,
      title: `sweep · ${String(sweep.entries)} 段`,
      sub: `~${compact(sweep.reclaims)} · 回本 ${sweep.breakEven.toFixed(1)}`,
      tokens: sweep.reclaims,
      sweep,
    })
    const base = snapshot.rows.find((row) => row.start === sweep.rowStart)
    const baseNode = base === undefined ? undefined : rangeNodes.get(rangeId(base.start, base.end))
    if (baseNode !== undefined) edges.push({ id: `s:${baseNode}:${id}`, from: baseNode, to: id, kind: 'sweep' })
  })

  // Show every tier-2/3 block (and close its parent chain) plus the most recent
  // tier-1 blocks, so the distillation lineage is actually on the canvas.
  const allBlocks = [...snapshot.blocks]
  const byBlockId = new Map(allBlocks.map((block) => [block.id, block]))
  const selectedBlocks = new Map<string, AcpInspectBlock>()
  const include = (block: AcpInspectBlock): void => {
    if (selectedBlocks.has(block.id)) return
    selectedBlocks.set(block.id, block)
    for (const parent of block.parents ?? []) {
      const entry = byBlockId.get(parent)
      if (entry !== undefined) include(entry)
    }
  }
  for (const block of allBlocks) if (block.tier > 1) include(block)
  for (const block of allBlocks.slice(-MAX_BLOCKS)) include(block)
  const blocks = [...selectedBlocks.values()].sort((left, right) => left.createdAt - right.createdAt)
  // Three tier lanes: T1 (bulk), T2 and T3 each get their own column so the
  // distillation levels read as levels instead of one crowded stack.
  const tiers = [1, 2, 3] as const
  const byTier = new Map<number, AcpInspectBlock[]>(tiers.map((tier) => [tier, []]))
  for (const block of blocks) {
    const tier = block.tier === 2 || block.tier === 3 ? block.tier : 1
    byTier.get(tier)!.push(block)
  }
  const slotOf = new Map<string, { tier: number; index: number }>()
  for (const tier of tiers) {
    const list = byTier.get(tier)!.sort((left, right) => left.createdAt - right.createdAt)
    list.forEach((block, index) => slotOf.set(block.id, { tier, index }))
  }
  const visibleBlocks = new Set(blocks.map((block) => block.id))
  blocks.forEach((block) => {
    const id = blockId(block.id)
    const slot = slotOf.get(block.id) ?? { tier: 1, index: 0 }
    nodes.push({
      id,
      kind: 'block',
      x: blockX + (slot.tier - 1) * (NODE_W.block + BLOCK_GAP),
      y: PAD + slot.index * PITCH.block,
      w: NODE_W.block,
      h: 44,
      title: `${block.shortId} · T${String(block.tier)}`,
      sub: `${String(block.start)}..${String(block.end)} · ~${compact(block.tokens)}`,
      tokens: block.tokens,
      block,
    })
    const owner = [...rangeNodes.entries()].find(([key]) => key === rangeId(block.start, block.end))
    if (owner !== undefined) edges.push({ id: `c:${owner[1]}:${id}`, from: owner[1], to: id, kind: 'covers' })
    for (const parent of block.parents ?? []) {
      if (!visibleBlocks.has(parent)) continue
      edges.push({ id: `p:${id}:${blockId(parent)}`, from: id, to: blockId(parent), kind: 'parent' })
    }
  })

  const placedNodes = nodes
  const height = Math.max(
    PAD * 2,
    placedNodes.reduce((bottom, node) => Math.max(bottom, node.y + node.h), 0) + PAD,
  )
  return {
    nodes: placedNodes,
    edges,
    columns: [
      { x: regionX, label: `年龄区域 · ${String(regions.length)}` },
      { x: rangeX, label: `可压区间 · 推荐 ${String(recommendedDefs.length)} / 补集 ${String(complementDefs.length)}` },
      { x: sweepX, label: `清扫 · ${String(snapshot.sweeps.length)}` },
      ...tiers.map((tier) => ({
        x: blockX + (tier - 1) * (NODE_W.block + BLOCK_GAP),
        label: `T${String(tier)} · ${String(byTier.get(tier)!.length)}`,
      })),
    ],
    bands,
    width: blockX + tiers.length * (NODE_W.block + BLOCK_GAP) - BLOCK_GAP + PAD,
    height,
  }
}

/**
 * Stable block slots across refreshes. The naive layout re-indexes every tier
 * from the top, so one new compression would shift EVERY existing block upward.
 * This allocator keeps an existing block's row forever, gives a new block the
 * smallest freed row in its tier, and only compacts on "重新布局".
 */
export function applyStableBlockSlots(layout: NetLayout, slots: Map<string, BlockSlot>): NetLayout {
  const present = new Set<string>()
  for (const node of layout.nodes) {
    if (node.kind === 'block' && node.block !== undefined) present.add(node.block.id)
  }
  for (const id of [...slots.keys()]) {
    if (!present.has(id)) slots.delete(id)
  }
  const nodes = layout.nodes.map((node) => ({ ...node }))
  for (const node of nodes) {
    if (node.kind !== 'block' || node.block === undefined) continue
    const tier = node.block.tier === 2 || node.block.tier === 3 ? node.block.tier : 1
    let slot = slots.get(node.block.id)
    if (slot === undefined || slot.tier !== tier) {
      const used = new Set<number>()
      for (const entry of slots.values()) if (entry.tier === tier) used.add(entry.index)
      let index = 0
      while (used.has(index)) index += 1
      slot = { tier, index }
      slots.set(node.block.id, slot)
    }
    node.y = PAD + slot.index * PITCH.block
  }
  const bottom = nodes.reduce((max, node) => Math.max(max, node.y + node.h), 0)
  return { ...layout, nodes, height: Math.max(520, bottom + PAD) }
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.45)
  return `M ${String(x1)} ${String(y1)} C ${String(x1 + dx)} ${String(y1)}, ${String(x2 - dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`
}

/** Forward, backward (tier parent to an earlier tier) or same-column links. */
export function linkPath(from: NetNode, to: NetNode): string {
  const y1 = from.y + from.h / 2
  const y2 = to.y + to.h / 2
  if (to.x + to.w <= from.x) {
    const x1 = from.x
    const x2 = to.x + to.w
    const dx = Math.max(36, (x1 - x2) * 0.45)
    return `M ${String(x1)} ${String(y1)} C ${String(x1 - dx)} ${String(y1)}, ${String(x2 + dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`
  }
  if (to.x >= from.x + from.w) return curve(from.x + from.w, y1, to.x, y2)
  const x1 = from.x + from.w
  const x2 = to.x + to.w
  const dx = Math.max(24, Math.abs(y2 - y1) * 0.5)
  return `M ${String(x1)} ${String(y1)} C ${String(x1 + dx)} ${String(y1)}, ${String(x2 + dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`
}

/** Undirected lineage: drawn edges + range↔sweep membership (not drawn as hundreds of paths). */
function lineageOf(id: string, layout: NetLayout, snapshot: AcpInspectSnapshot): { nodes: Set<string>; edges: Set<string> } {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    const set = adjacency.get(a) ?? new Set<string>()
    set.add(b)
    adjacency.set(a, set)
  }
  for (const edge of layout.edges) {
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }
  const rangeByKey = new Map<string, string>()
  for (const node of layout.nodes) {
    if (node.kind === 'range' && node.span !== undefined) rangeByKey.set(rangeId(node.span.start, node.span.end), node.id)
  }
  for (const node of layout.nodes) {
    if (node.kind !== 'sweep' || node.sweep === undefined) continue
    for (const span of node.sweep.spans) {
      const target = rangeByKey.get(rangeId(span.start, span.end))
      if (target === undefined) continue
      link(node.id, target)
      link(target, node.id)
    }
  }
  const nodes = new Set<string>([id])
  const edges = new Set<string>()
  let frontier = [id]
  for (let depth = 0; depth < 3; depth += 1) {
    const next: string[] = []
    for (const current of frontier) {
      for (const peer of adjacency.get(current) ?? []) {
        if (nodes.has(peer)) continue
        nodes.add(peer)
        next.push(peer)
      }
    }
    frontier = next
  }
  for (const edge of layout.edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) edges.add(edge.id)
  }
  return { nodes, edges }
}

function mixText(row: AcpInspectRow): string {
  return `工具 ${String(row.toolPct)}% · 推理 ${String(row.reasoningPct)}% · 正文 ${String(row.textPct)}%`
}

function Inspector(props: {
  snapshot: AcpInspectSnapshot
  node?: NetNode
  pinned: boolean
}): ReactElement {
  const { node } = props
  if (node === undefined) {
    return h('div', { className: 'acp-net-inspector acp-muted' },
      '悬停节点查看详情；点击固定，Esc 清除。')
  }
  const body: ReactElement[] = []
  if (node.kind === 'region') {
    const region = props.snapshot.regions.find((entry) => entry.region === node.region)
    body.push(
      h('div', { className: 'acp-net-insp-title' }, node.title),
      h('div', null, `区间 ${String(region?.ranges ?? '—')} 段 · 可压 ~${compact(node.tokens)} token`),
      h('div', { className: 'acp-muted' }, `seq ${String(region?.start ?? '—')}..${String(region?.end ?? '—')}`),
    )
  } else if (node.kind === 'range') {
    const row = node.row
    body.push(
      h('div', { className: 'acp-net-insp-title' }, `区间 ${node.title}`),
      h('div', null, row === undefined ? `补集区间 · ~${compact(node.tokens)} token` : `${String(row.messages)} 条 · ~${compact(row.tokens)} token`),
      ...(row === undefined ? [] : [
        h('div', null, mixText(row)),
        h('div', { className: row.expensive ? 'acp-warn' : 'acp-muted' }, `作废 ~${compact(row.invalidated)} · 本行回本 ${row.breakEven.toFixed(1)} 次`),
      ]),
    )
  } else if (node.kind === 'sweep' && node.sweep !== undefined) {
    const sweep = node.sweep
    body.push(
      h('div', { className: 'acp-net-insp-title' }, `sweep 从 seq ${String(sweep.rowStart)}`),
      h('div', null, `${String(sweep.entries)} 区间 · ${String(sweep.messages)} 条消息 · 回收 ~${compact(sweep.reclaims)}`),
      h('div', { className: sweep.expensive ? 'acp-warn' : 'acp-muted' }, `回本 ${sweep.breakEven.toFixed(1)} 次 · 作废 ~${compact(sweep.invalidates)}`),
      h('div', null, `构成：工具 ${String(sweep.toolPct)}% · 推理 ${String(sweep.reasoningPct)}% · 正文 ${String(sweep.textPct)}%`),
    )
  } else if (node.kind === 'block' && node.block !== undefined) {
    const block = node.block
    body.push(
      h('div', { className: 'acp-net-insp-title' }, `${block.shortId} · Tier ${String(block.tier)}`),
      h('div', null, `seq ${String(block.start)}..${String(block.end)} · ${String(block.messages)} 条 · ~${compact(block.tokens)} token`),
      ...(block.parents === undefined ? [] : [h('div', { className: 'acp-muted' }, `父块：${block.parents.map((id) => id.slice(0, 8)).join(' · ')}`)]),
      h('pre', { className: 'acp-net-insp-summary' }, block.summary),
      ...(block.why === undefined ? [] : [h('pre', { className: 'acp-net-insp-why' }, block.why)]),
    )
  }
  return h('div', { className: 'acp-net-inspector' },
    h('div', { className: 'acp-net-insp-head' },
      h('span', null, node.kind === 'region' ? '年龄区域' : node.kind === 'range' ? '可压区间' : node.kind === 'sweep' ? '清扫' : '已压块'),
      props.pinned ? h('span', { className: 'acp-badge' }, '已固定') : null),
    ...body)
}

export function CompressionNetwork(props: {
  snapshot: AcpInspectSnapshot
  sessionId: string
  onClose: () => void
  /** Preview/test seat only: the viewport the static first paint uses (effects do not run in SSR). */
  initialView?: { x: number; y: number; z: number }
}): ReactElement {
  const { snapshot, sessionId } = props
  const baseLayout = useMemo(() => buildLayout(snapshot), [snapshot])
  const blockSlotsRef = useRef(new Map<string, BlockSlot>())
  const [slotEpoch, setSlotEpoch] = useState(0)
  const layout = useMemo(
    () => applyStableBlockSlots(baseLayout, blockSlotsRef.current),
    [baseLayout, slotEpoch],
  )
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const movedRef = useRef<Record<string, { x: number; y: number }>>({})
  useEffect(() => { movedRef.current = moved }, [moved])
  const seenBlocksRef = useRef<Set<string> | null>(null)
  const [newBlocks, setNewBlocks] = useState<Set<string>>(new Set())
  useEffect(() => {
    const ids = new Set(
      layout.nodes
        .filter((node) => node.kind === 'block' && node.block !== undefined)
        .map((node) => node.block!.id),
    )
    const seen = seenBlocksRef.current
    if (seen === null) {
      seenBlocksRef.current = ids
      return undefined
    }
    const added = [...ids].filter((id) => !seen.has(id))
    seenBlocksRef.current = ids
    if (added.length === 0) return undefined
    setNewBlocks(new Set(added))
    const timer = window.setTimeout(() => setNewBlocks(new Set()), 8000)
    return () => window.clearTimeout(timer)
  }, [layout])
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const initialView = props.initialView ?? { x: 0, y: 0, z: 1 }
  const [lod, setLod] = useState<Lod>(initialView.z < 0.42 ? 'far' : initialView.z < 1.1 ? 'mid' : 'near')
  const focusId = pinnedId ?? hoverId
  const lineage = useMemo(
    () => (focusId === null ? undefined : lineageOf(focusId, layout, snapshot)),
    [focusId, layout, snapshot],
  )
  const placed = useMemo(
    () => layout.nodes.map((node) => ({ ...node, ...(moved[node.id] ?? {}) })),
    [layout, moved],
  )
  const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed])
  const canvasHeight = useMemo(
    () => Math.max(layout.height, placed.reduce((bottom, node) => Math.max(bottom, node.y + node.h), 0) + PAD),
    [layout.height, placed],
  )
  // A compression can remove the hovered/pinned node; keeping the focus id would
  // leave `has-focus` on with no lineage, dimming the whole refreshed canvas.
  useEffect(() => {
    if (hoverId !== null && !byId.has(hoverId)) setHoverId(null)
    if (pinnedId !== null && !byId.has(pinnedId)) setPinnedId(null)
  }, [byId, hoverId, pinnedId])

  const overlayRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const miniRectRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLSpanElement>(null)
  const viewRef = useRef(initialView)
  /** True once the reader pans/zooms manually; auto-fit then stops following. */
  const userViewRef = useRef(false)
  const lodRef = useRef<Lod>(initialView.z < 0.42 ? 'far' : initialView.z < 1.1 ? 'mid' : 'near')
  const saveTimer = useRef<number | undefined>(undefined)
  const storageKey = `acp-net:${sessionId}`

  const persist = useCallback((overrideMoved?: Record<string, { x: number; y: number }>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ view: viewRef.current, moved: overrideMoved ?? movedRef.current }))
    } catch {
      /* private mode / quota: the view simply is not remembered */
    }
  }, [storageKey])

  const apply = useCallback(() => {
    const view = viewRef.current
    if (layerRef.current !== null) {
      layerRef.current.style.transform = `translate3d(${String(view.x)}px, ${String(view.y)}px, 0) scale(${String(view.z)})`
    }
    if (zoomRef.current !== null) zoomRef.current.textContent = `${String(Math.round(view.z * 100))}%`
    if (gridRef.current !== null) {
      const step = Math.max(10, 24 * view.z)
      gridRef.current.style.backgroundSize = `${String(step)}px ${String(step)}px`
      gridRef.current.style.backgroundPosition = `${String(view.x)}px ${String(view.y)}px`
    }
    const stage = stageRef.current
    if (stage !== null && miniRectRef.current !== null) {
      const scale = Math.min(150 / layout.width, 104 / canvasHeight)
      const rect = miniRectRef.current
      rect.style.left = `${String(5 + (-view.x / view.z) * scale)}px`
      rect.style.top = `${String(5 + (-view.y / view.z) * scale)}px`
      rect.style.width = `${String((stage.clientWidth / view.z) * scale)}px`
      rect.style.height = `${String((stage.clientHeight / view.z) * scale)}px`
    }
    const next: Lod = view.z < 0.42 ? 'far' : view.z < 1.1 ? 'mid' : 'near'
    if (next !== lodRef.current) {
      lodRef.current = next
      setLod(next)
    }
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(persist, 280)
  }, [canvasHeight, layout.width, persist])

  const fit = useCallback(() => {
    userViewRef.current = false
    const stage = stageRef.current
    if (stage === null) return
    const width = stage.clientWidth
    const height = stage.clientHeight
    const z = Math.max(MIN_ZOOM, Math.min((width - 80) / layout.width, (height - 80) / canvasHeight, 1.15))
    viewRef.current = {
      x: (width - layout.width * z) / 2,
      y: (height - canvasHeight * z) / 2,
      z,
    }
    apply()
  }, [apply, canvasHeight, layout.width])

  /**
   * One-click re-layout: forget every dragged node position, compact the stable
   * block slots, and fit the current data. The clean state is written back to
   * localStorage.
   */
  const relayout = useCallback(() => {
    blockSlotsRef.current.clear()
    setSlotEpoch((epoch) => epoch + 1)
    setNewBlocks(new Set())
    movedRef.current = {}
    setMoved({})
    userViewRef.current = false
    try {
      localStorage.removeItem(storageKey)
    } catch {
      /* ignore */
    }
    // Fit after the cleared positions have rendered (canvasHeight may shrink).
    window.requestAnimationFrame(() => fit())
  }, [fit, storageKey])

  // The panel polls the inspect route every 5s; a compression changes the canvas
  // dimensions. A passive reader follows the new graph (auto-fit); a reader who
  // has panned/zoomed keeps their viewport and only the grid/minimap re-pin.
  useEffect(() => {
    if (userViewRef.current) apply()
    else fit()
  }, [apply, fit])

  const zoomBy = useCallback((factor: number) => {
    const stage = stageRef.current
    if (stage === null) return
    const view = viewRef.current
    const cx = stage.clientWidth / 2
    const cy = stage.clientHeight / 2
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * factor))
    userViewRef.current = true
    const k = z / view.z
    viewRef.current = { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, z }
    apply()
  }, [apply])

  // Restore the remembered viewport ONCE per session. This effect used to list
  // `apply`/`fit` (which depend on `moved`): a node drop changed `moved`, which
  // re-created apply/fit, which re-ran this effect, which called setMoved with a
  // freshly parsed object — an infinite render loop that froze the canvas on the
  // first drag. The functions read refs, so the mount-time closures stay valid.
  useEffect(() => {
    let saved: { view?: { x: number; y: number; z: number }; moved?: Record<string, { x: number; y: number }> } | undefined
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw !== null) saved = JSON.parse(raw) as typeof saved
    } catch {
      saved = undefined
    }
    if (saved?.moved !== undefined) {
      movedRef.current = saved.moved
      setMoved(saved.moved)
    }
    const frame = requestAnimationFrame(() => {
      if (saved?.view !== undefined && Number.isFinite(saved.view.z) && saved.view.z > 0) {
        viewRef.current = saved.view
        userViewRef.current = true
        apply()
      } else {
        fit()
      }
      stageRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  // Wheel must not scroll the panel behind the overlay; React's synthetic wheel
  // listener is passive in some hosts, so attach a native non-passive one.
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      const view = viewRef.current
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * Math.exp(-event.deltaY * 0.0014)))
      userViewRef.current = true
      const k = z / view.z
      viewRef.current = { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, z }
      apply()
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [apply])

  const panRef = useRef<{ pointer: number; x: number; y: number; vx: number; vy: number } | null>(null)
  const dragRef = useRef<{ pointer: number; id: string; x: number; y: number; nx: number; ny: number; moved: boolean } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null)

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchRef.current = {
        distance: Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0)),
        zoom: viewRef.current.z,
        x: ((a?.x ?? 0) + (b?.x ?? 0)) / 2,
        y: ((a?.y ?? 0) + (b?.y ?? 0)) / 2,
      }
      return
    }
    const target = (event.target as Element).closest<HTMLElement>('[data-net-node]')
    if (target !== null) {
      const id = target.getAttribute('data-net-node')
      const node = id === null ? undefined : byId.get(id)
      if (node === undefined) return
      // A previous drop may have left its drag-preview transform on the DOM node
      // (React does not own `style.transform` here). Clear it before measuring,
      // or the next drag starts from a doubled offset.
      target.style.transform = ''
      dragRef.current = { pointer: event.pointerId, id: node.id, x: event.clientX, y: event.clientY, nx: node.x, ny: node.y, moved: false }
    } else {
      panRef.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, vx: viewRef.current.x, vy: viewRef.current.y }
    }
    try {
      stageRef.current?.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic events / hosts without capture: panning still works via bubble */
    }
  }

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 2 && pinchRef.current !== null) {
      const [a, b] = [...pointers.current.values()]
      const distance = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))
      const base = pinchRef.current
      const view = viewRef.current
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base.zoom * (distance / Math.max(1, base.distance))))
      const k = z / view.z
      const mx = ((a?.x ?? 0) + (b?.x ?? 0)) / 2
      const my = ((a?.y ?? 0) + (b?.y ?? 0)) / 2
      userViewRef.current = true
      viewRef.current = { x: mx - (mx - view.x) * k, y: my - (my - view.y) * k, z }
      apply()
      return
    }
    const drag = dragRef.current
    if (drag !== null) {
      const dx = (event.clientX - drag.x) / viewRef.current.z
      const dy = (event.clientY - drag.y) / viewRef.current.z
      if (!drag.moved && Math.hypot(dx, dy) < 3) return
      drag.moved = true
      const element = stageRef.current?.querySelector<HTMLElement>(`[data-net-node="${drag.id}"]`)
      if (element !== null && element !== undefined) element.style.transform = `translate(${String(dx)}px, ${String(dy)}px)`
      // Live edges: the dragged card is only a CSS transform, so React's paths
      // still describe the old position. Re-point every edge touching it as the
      // pointer moves, otherwise the card detaches from its links mid-drag.
      const node = byId.get(drag.id)
      if (node !== undefined && stageRef.current !== null) {
        const preview = { ...node, x: node.x + dx, y: node.y + dy }
        for (const path of stageRef.current.querySelectorAll<SVGPathElement>('path[data-net-edge]')) {
          const fromId = path.getAttribute('data-from')
          const toId = path.getAttribute('data-to')
          if (fromId !== drag.id && toId !== drag.id) continue
          const from = fromId === drag.id ? preview : byId.get(fromId ?? '')
          const to = toId === drag.id ? preview : byId.get(toId ?? '')
          if (from === undefined || to === undefined) continue
          path.setAttribute('d', linkPath(from, to))
        }
      }
      return
    }
    const pan = panRef.current
    if (pan !== null) {
      userViewRef.current = true
      viewRef.current = {
        ...viewRef.current,
        x: pan.vx + (event.clientX - pan.x),
        y: pan.vy + (event.clientY - pan.y),
      }
      apply()
    }
  }

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    const drag = dragRef.current
    if (drag !== null && drag.pointer === event.pointerId) {
      const dx = (event.clientX - drag.x) / viewRef.current.z
      const dy = (event.clientY - drag.y) / viewRef.current.z
      if (drag.moved) {
        userViewRef.current = true
        const next = { ...movedRef.current, [drag.id]: { x: drag.nx + dx, y: drag.ny + dy } }
        movedRef.current = next
        // CRITICAL: drop the drag-preview translate BEFORE the committed left/top
        // lands. Otherwise the node renders at left/top + translate(dx,dy) and
        // visibly teleports on release.
        const element = stageRef.current?.querySelector<HTMLElement>(`[data-net-node="${drag.id}"]`)
        if (element !== null && element !== undefined) element.style.transform = ''
        setMoved(next)
        persist(next)
      } else {
        const element = stageRef.current?.querySelector<HTMLElement>(`[data-net-node="${drag.id}"]`)
        if (element !== null && element !== undefined) element.style.transform = ''
        setPinnedId((current) => (current === drag.id ? null : drag.id))
      }
      dragRef.current = null
      return
    }
    if (panRef.current?.pointer === event.pointerId) panRef.current = null
  }

  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    const drag = dragRef.current
    if (drag !== null && drag.pointer === event.pointerId) {
      const element = stageRef.current?.querySelector<HTMLElement>(`[data-net-node="${drag.id}"]`)
      if (element !== null && element !== undefined) element.style.transform = ''
      dragRef.current = null
      // Re-render the untouched paths (the live preview may have moved them).
      setMoved((current) => ({ ...current }))
    }
    if (panRef.current?.pointer === event.pointerId) panRef.current = null
  }

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (pinnedId !== null) setPinnedId(null)
      else props.onClose()
      return
    }
    const step = 60
    const view = viewRef.current
    if (event.key === 'ArrowLeft') viewRef.current = { ...view, x: view.x + step }
    else if (event.key === 'ArrowRight') viewRef.current = { ...view, x: view.x - step }
    else if (event.key === 'ArrowUp') viewRef.current = { ...view, y: view.y + step }
    else if (event.key === 'ArrowDown') viewRef.current = { ...view, y: view.y - step }
    else if (event.key === '+' || event.key === '=') { zoomBy(1.2); return }
    else if (event.key === '-') { zoomBy(1 / 1.2); return }
    else if (event.key === '0') { fit(); return }
    else if (event.key === 'r' || event.key === 'R') { relayout(); return }
    else return
    event.preventDefault()
    apply()
  }

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement !== null) { void document.exitFullscreen() }
    else { void overlayRef.current?.requestFullscreen?.().catch(() => undefined) }
  }

  const miniJump = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    const stage = stageRef.current
    const mini = event.currentTarget.getBoundingClientRect()
    if (stage === null) return
    const scale = Math.min(150 / layout.width, 104 / canvasHeight)
    const worldX = (event.clientX - mini.left - 5) / scale
    const worldY = (event.clientY - mini.top - 5) / scale
    const view = viewRef.current
    userViewRef.current = true
    viewRef.current = {
      ...view,
      x: stage.clientWidth / 2 - worldX * view.z,
      y: stage.clientHeight / 2 - worldY * view.z,
    }
    apply()
  }

  const activeNode = focusId === null ? undefined : byId.get(focusId)
  const miniScale = Math.min(150 / layout.width, 104 / canvasHeight)
  const captured = snapshot.capturedAt > 0
    ? new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '—'
  const overlay = h('div', { className: 'acp-net-overlay', ref: overlayRef, role: 'dialog', 'aria-label': '压缩网络' },
    h('div', { className: 'acp-net-shell' },
      h('header', { className: 'acp-net-toolbar' },
        h('b', null, '压缩网络'),
        h('span', { className: 'acp-net-hint' }, '拖拽平移 · 滚轮缩放 · 拖节点改位 · 点击固定 · 双击适配 · R 重新布局'),
        h('div', { className: 'acp-net-actions' },
          h('button', { className: 'acp-net-btn', onClick: () => zoomBy(1.2) }, '+'),
          h('button', { className: 'acp-net-btn', onClick: () => zoomBy(1 / 1.2) }, '−'),
          h('button', { className: 'acp-net-btn', onClick: fit }, '适配'),
          newBlocks.size > 0
            ? h('button', {
              className: 'acp-net-btn acp-net-newbtn',
              title: '画布刷新后新增的已压块；点击适配到新布局',
              onClick: () => { fit(); setNewBlocks(new Set()) },
            }, `新增 ${String(newBlocks.size)} 块 · 定位`)
            : null,
          h('button', {
            className: 'acp-net-btn',
            title: '清除所有拖动位置，按当前数据重新排版并适配视图（快捷键 R）',
            onClick: relayout,
          }, '重新布局'),
          h('button', { className: 'acp-net-btn', onClick: toggleFullscreen }, '全屏'),
          h('button', { className: 'acp-net-btn acp-net-close', onClick: props.onClose }, '关闭'))),
      h('div', { className: 'acp-net-body' },
        h('div', {
          className: `acp-net-stage${focusId === null ? '' : ' has-focus'}`,
          ref: stageRef,
          tabIndex: 0,
          onPointerDown: pointerDown,
          onPointerMove: pointerMove,
          onPointerUp: pointerUp,
          onPointerCancel: pointerCancel,
          onDoubleClick: fit,
          onKeyDown: keyDown,
        },
        h('div', { className: 'acp-net-grid', ref: gridRef }),
        h('div', {
          className: 'acp-net-layer',
          ref: layerRef,
          'data-lod': lod,
          style: { transform: `translate3d(${String(initialView.x)}px, ${String(initialView.y)}px, 0) scale(${String(initialView.z)})` },
        },
          layout.columns.map((column) => h('div', {
            key: column.label,
            className: 'acp-net-col-label',
            style: { left: `${String(column.x)}px` },
          }, column.label)),
          layout.bands.map((band) => h('div', {
            key: band.label,
            className: 'acp-net-band',
            style: { left: `${String(band.x)}px`, top: `${String(band.y)}px` },
          }, band.label)),
          h('svg', { className: 'acp-net-links', width: layout.width, height: canvasHeight, 'aria-hidden': true },
            layout.edges.map((edge) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (from === undefined || to === undefined) return null
              const on = lineage?.edges.has(edge.id) ?? false
              const path = linkPath(from, to)
              return h('path', {
                key: edge.id,
                d: path,
                'data-net-edge': edge.id,
                'data-from': edge.from,
                'data-to': edge.to,
                className: `acp-net-link acp-net-link-${edge.kind}${on ? ' on' : ''}`,
                vectorEffect: 'non-scaling-stroke',
              })
            })),
          placed.map((node) => {
            const on = lineage?.nodes.has(node.id) ?? false
            return h('div', {
              key: node.id,
              'data-net-node': node.id,
              className: `acp-net-node acp-net-${node.kind}${node.kind === 'range' ? ` acp-net-range-${node.variant ?? 'recommended'}` : ''}${node.block === undefined ? '' : ` acp-net-tier-${String(node.block.tier)}`}${node.block !== undefined && newBlocks.has(node.block.id) ? ' new' : ''}${on ? ' on' : ''}${node.id === focusId ? ' focus' : ''}${node.id === pinnedId ? ' pinned' : ''}${moved[node.id] === undefined ? '' : ' moved'}`,
              style: { left: `${String(node.x)}px`, top: `${String(node.y)}px`, width: `${String(node.w)}px`, height: `${String(node.h)}px` },
              onPointerEnter: () => setHoverId(node.id),
              onPointerLeave: () => setHoverId((current) => (current === node.id ? null : current)),
            },
            node.kind === 'range'
              ? h('span', { className: 'acp-net-node-line' },
                h('span', { className: 'acp-net-node-title' }, node.title),
                h('span', { className: 'acp-net-node-sub acp-net-node-amount' }, node.sub))
              : h('span', { className: 'acp-net-node-stack' },
                h('span', { className: 'acp-net-node-title' }, node.title),
                h('span', { className: 'acp-net-node-sub' }, node.sub)),
            node.kind === 'range' && node.row !== undefined
              ? h('span', { className: 'acp-net-node-bar' },
                h('i', { style: { width: `${String(node.row.toolPct)}%` }, className: 'acp-net-seg-tool' }),
                h('i', { style: { width: `${String(node.row.reasoningPct)}%` }, className: 'acp-net-seg-reason' }),
                h('i', { style: { width: `${String(node.row.textPct)}%` }, className: 'acp-net-seg-text' }))
              : null,
            node.kind === 'sweep' && node.sweep !== undefined
              ? h('span', { className: 'acp-net-node-bar' },
                h('i', { style: { width: `${String(node.sweep.toolPct)}%` }, className: 'acp-net-seg-tool' }),
                h('i', { style: { width: `${String(node.sweep.reasoningPct)}%` }, className: 'acp-net-seg-reason' }),
                h('i', { style: { width: `${String(node.sweep.textPct)}%` }, className: 'acp-net-seg-text' }))
              : null)
          })),
        h('div', { className: 'acp-net-mini', onPointerDown: miniJump },
          h('div', {
            className: 'acp-net-mini-canvas',
            style: { width: `${String(layout.width * miniScale)}px`, height: `${String(canvasHeight * miniScale)}px` },
          }),
          h('div', { className: 'acp-net-mini-rect', ref: miniRectRef })),
        h('div', { className: 'acp-net-status' },
          h('span', { ref: zoomRef }, `${String(Math.round(initialView.z * 100))}%`),
          h('span', null, ` · ${String(placed.length)} 节点 · ${String(layout.edges.length)} 连线 · 快照 ${captured}`),
          h('span', { className: 'acp-net-legend' },
            h('span', null, h('i', { className: 'acp-net-key acp-net-key-owns' }), '归属'),
            h('span', null, h('i', { className: 'acp-net-key acp-net-key-sweep' }), '清扫'),
            h('span', null, h('i', { className: 'acp-net-key acp-net-key-covers' }), '覆盖'),
            h('span', null, h('i', { className: 'acp-net-key acp-net-key-parent' }), '父链')))),
        h('aside', { className: 'acp-net-side' },
          h(Inspector, { snapshot, node: activeNode, pinned: pinnedId !== null && pinnedId === focusId })))),
  )
  // Portal to <body>: the panel lives inside the sidebar's scroll/transform
  // context, where a fixed overlay can be clipped. SSR keeps the inline shape.
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
