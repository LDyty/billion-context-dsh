import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyStableBlockSlots, buildLayout, lineageOf, linkPath, type BlockSlot, type NetNode } from '../src/client/network.tsx'
import type { AcpInspectSnapshot } from '../src/inspect-types.ts'

const row = (start: number, end: number, region: number) => ({
  ageRegion: region,
  picks: ['cheapest'] as const,
  start,
  end,
  messages: 1,
  tokens: 100,
  toolPct: 50,
  reasoningPct: 25,
  textPct: 25,
  toolRowPct: 100,
  rowMix: '1 tool',
  rowCounts: { tool: 1, assistant: 0, user: 0, other: 0 },
  invalidated: 1000,
  newer: 900,
  breakEven: 2,
  expensive: false,
  skipped: 0,
})

const sweep = (rowStart: number) => ({
  rowStart,
  entries: 2,
  messages: 2,
  reclaims: 200,
  invalidates: 1000,
  newerTokens: 800,
  breakEven: 1,
  expensive: false,
  rowMix: '2 tool',
  rowCounts: { tool: 2, assistant: 0, user: 0, other: 0 },
  toolPct: 100,
  reasoningPct: 0,
  textPct: 0,
  spans: [{ start: 1, end: 2 }, { start: 5, end: 6 }],
})

const block = (id: string, tier: number, start: number, end: number, parents?: string[]) => ({
  id,
  shortId: id.slice(0, 8),
  start,
  end,
  messages: 1,
  tokens: 100,
  tier,
  createdAt: start,
  summary: `summary ${id}`,
  ...(parents === undefined ? {} : { parents }),
})

test('network layout: region/range/sweep columns, T1–T3 lanes, ownership and lineage', () => {
  const snapshot = {
    rows: [row(1, 2, 1), row(5, 6, 2)],
    sweeps: [sweep(1)],
    complement: undefined,
    regions: [
      { region: 1, start: 1, end: 2, tokens: 100, ranges: 1 },
      { region: 2, start: 5, end: 6, tokens: 100, ranges: 1 },
    ],
    blocks: [block('tier1aaa', 1, 1, 2), block('tier2bbb', 2, 1, 2, ['tier1aaa'])],
    map: [],
  } as unknown as AcpInspectSnapshot
  const layout = buildLayout(snapshot)
  assert.equal(layout.columns.length, 6, 'regions → ranges → sweeps → T1 / T2 / T3')
  assert.deepEqual(
    [...new Set(layout.nodes.map((node) => node.kind))].sort(),
    ['block', 'range', 'region', 'sweep'],
    'every layer is present',
  )
  const kinds = layout.edges.map((edge) => edge.kind)
  assert.equal(kinds.filter((kind) => kind === 'owns').length, 2, 'each range belongs to a region')
  assert.equal(kinds.filter((kind) => kind === 'sweep').length, 1, 'the sweep hangs off its base range')
  assert.equal(kinds.filter((kind) => kind === 'covers').length, 2, 'both blocks cover their range')
  assert.equal(kinds.filter((kind) => kind === 'parent').length, 1, 'tier-2 carries its parent link')
  const blockX = layout.nodes.filter((node) => node.kind === 'block').map((node) => `${String(node.block?.tier)}:${String(node.x)}`)
  assert.equal(new Set(blockX.map((entry) => entry.split(':')[1])).size, 2, 'each tier gets its own column')
  assert.ok(layout.height > 0 && layout.width > 0)
})

test('network layout: a dragged card repoints its live edge', () => {
  const from: NetNode = { id: 'a', kind: 'range', x: 234, y: 44, w: 176, h: 26, title: 'a', sub: '', tokens: 0 }
  const to: NetNode = { id: 'b', kind: 'sweep', x: 830, y: 44, w: 170, h: 48, title: 'b', sub: '', tokens: 0 }
  const before = linkPath(from, to)
  const after = linkPath({ ...from, x: from.x + 100, y: from.y + 60 }, to)
  assert.notEqual(after, before, 'the path follows the drag preview, not the last dropped position')
  assert.ok(after.startsWith('M 510 '), `the start moved with the card (${after})`)
})

test('network layout: a new block reuses the freed slot instead of shifting existing blocks', () => {
  const snapshot = (blocks: ReturnType<typeof block>[]) => ({
    rows: [row(1, 2, 1), row(5, 6, 2)],
    sweeps: [],
    complement: undefined,
    regions: [
      { region: 1, start: 1, end: 2, tokens: 100, ranges: 1 },
      { region: 2, start: 5, end: 6, tokens: 100, ranges: 1 },
    ],
    blocks,
    map: [],
  }) as unknown as AcpInspectSnapshot
  const slots = new Map<string, BlockSlot>()
  const first = applyStableBlockSlots(buildLayout(snapshot([block('one', 1, 1, 2), block('two', 1, 5, 6)])), slots)
  const twoY = first.nodes.find((node) => node.block?.id === 'two')!.y
  // "one" leaves the window; "three" arrives. "two" must keep its row, and the
  // newcomer takes the freed row instead of pushing everything up.
  const next = applyStableBlockSlots(buildLayout(snapshot([block('two', 1, 5, 6), block('three', 1, 7, 8)])), slots)
  assert.equal(next.nodes.find((node) => node.block?.id === 'two')!.y, twoY, 'existing block does not shift')
  assert.equal(next.nodes.find((node) => node.block?.id === 'three')!.y, 44, 'the newcomer fills the freed row')
})

test('network layout: recommended and complement ranges sit in separate bands', () => {
  const snapshot = {
    rows: [row(1, 2, 1)],
    sweeps: [],
    complement: {
      oldest: 1,
      total: 1,
      regions: [{ region: 1, ranges: [{ start: 3, end: 4, tokens: 50 }] }],
    },
    regions: [{ region: 1, start: 1, end: 4, tokens: 150, ranges: 2 }],
    blocks: [],
    map: [],
  } as unknown as AcpInspectSnapshot
  const layout = buildLayout(snapshot)
  assert.equal(layout.bands.length, 2, 'two labelled bands')
  const recommended = layout.nodes.find((node) => node.span?.start === 1)
  const complement = layout.nodes.find((node) => node.span?.start === 3)
  assert.equal(recommended?.variant, 'recommended')
  assert.equal(complement?.variant, 'complement')
  assert.ok((complement?.x ?? 0) > (recommended?.x ?? 0), 'the complement band sits beside the recommendation band')
})

test('network lineage: a region/range does not fan out to other ranges through a shared sweep', () => {
  const snapshot = {
    rows: [row(1, 2, 1), row(5, 6, 2)],
    sweeps: [{ ...sweep(1), spans: [{ start: 1, end: 2 }, { start: 5, end: 6 }] }],
    complement: undefined,
    regions: [
      { region: 1, start: 1, end: 2, tokens: 100, ranges: 1 },
      { region: 2, start: 5, end: 6, tokens: 100, ranges: 1 },
    ],
    blocks: [block('one', 1, 1, 2), block('two', 1, 5, 6)],
    map: [],
  } as unknown as AcpInspectSnapshot
  const layout = buildLayout(snapshot)
  const region = lineageOf('r:1', layout).nodes
  assert.ok(region.has('g:1:2'), 'the region keeps its own range')
  assert.ok(region.has('s:1'), 'and the sweep that starts there')
  assert.ok(!region.has('g:5:6'), 'but not the other range of that sweep')
  assert.ok(!region.has('r:2'), 'and not the other region')
  const range = lineageOf('g:1:2', layout).nodes
  assert.ok(range.has('r:1') && range.has('s:1'))
  assert.ok(!range.has('g:5:6'), 'a range does not fan out through its sweep')
  const sweepLineage = lineageOf('s:1', layout).nodes
  assert.ok(sweepLineage.has('g:1:2') && sweepLineage.has('g:5:6'), 'a sweep DOES show every range it covers')
})
