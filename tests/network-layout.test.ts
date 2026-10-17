import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLayout } from '../src/client/network.tsx'
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
