/**
 * The wire shape the ACP inspector panel reads (`/api/billion-context/inspect`).
 *
 * Types only — the browser half imports this module, the host half fills it, and
 * nothing here may pull in a runtime dependency (the client bundle's purity gate
 * would fail the build).
 *
 * Every number is what the ENGINE already computed and showed: the range rows and
 * their fold costs are the nudge table's own numbers, the sweeps are the proposals
 * it printed, the blocks are the durable ledger, and each block's `why` is the
 * model's own reasoning captured at fold time (src/messages.ts
 * `reasoningForToolCall`). The panel therefore never disagrees with what the model
 * saw, which is the only property that makes it worth looking at.
 */

/** How one surface node reads on the map: what it is and whether it can be folded. */
export type AcpInspectNodeKind =
  | 'tool'
  | 'text'
  | 'checkpoint'
  | 'instruction'
  | 'protected'
  | 'metadata'

/** One node of the live surface, in prompt order. */
export interface AcpInspectNode {
  readonly seq: number
  /** Host-vocabulary price (the same ruler as the ledger and the table). */
  readonly tokens: number
  readonly kind: AcpInspectNodeKind
  /** Why this node is a barrier, when it is one (empty for foldable content). */
  readonly barrier?: string
}

/** One printed range row (up to three per age region) with its fold cost. */
export interface AcpInspectRow {
  /** 1-based age region index; age region 1 is the oldest sixth of the reclaimable content. */
  readonly ageRegion: number
  /**
   * 1-based rank of this row's interval inside its age region by BILLING PAYBACK
   * (1 = that region's cheapest to fold; owner ruling 2026-10-17). Every age
   * region prints up to three intervals
   * ({@link RANGE_TABLE_ROWS_PER_AGE_REGION} in src/nudge.ts).
   */
  readonly rankInAgeRegion: number
  readonly start: number
  readonly end: number
  readonly messages: number
  readonly tokens: number
  /** Share of the row's CHARACTERS held by tool machinery (results + call arguments). */
  readonly toolPct: number
  /**
   * Share of the row's CHARACTERS held by assistant reasoning (`thinking`).
   */
  readonly reasoningPct: number
  /** Share of the row's characters that are neither tool nor reasoning; the three partition 100%. */
  readonly textPct: number
  /** Share of the row's MESSAGES that are tool messages (the kernel's own caliber), printed next to the message count. */
  readonly toolRowPct: number
  /** The row-count caliber as a mix (`3 tool · 2 assistant · 1 user`; empty classes omitted). */
  readonly rowMix: string
  /**
   * The same mix as raw counts (`rowMix` is the model-facing English spelling).
   * The panel renders Chinese labels (`工具 2 · 助手 1`), so it needs numbers,
   * not the pre-rendered string.
   */
  readonly rowCounts: { readonly tool: number; readonly assistant: number; readonly user: number; readonly other: number }
  /** Tokens the fold moves: the folded content plus everything newer (see `newer`). */
  readonly invalidated: number
  /**
   * Tokens NEWER than this span, re-sent uncached once after the fold — the term
   * that dominates the billing payback.
   */
  readonly newer: number
  /**
   * Requests before this fold pays for itself at the provider's CACHE PRICING
   * (see `billingPaybackRequests` in src/region.ts): the newer tail and the
   * summary are charged at the cache-miss price, what the fold reclaims is saved
   * at the cache-hit price. 0 = profitable on the first request.
   */
  readonly breakEven: number
  readonly expensive: boolean
  /**
   * How many times this AGE REGION was passed over: every model choice of a fold
   * start that did not land in this age region (src/age-region-skips.ts). Keyed to the age region
   * slot, not to content — the panel shows the same number the nudge prints,
   * because "the model keeps starting its folds somewhere else" is exactly what
   * a human watching the table needs to know.
   */
  readonly skipped: number
}

/** The sweep printed under one row: everything that can ride along in one call. */
export interface AcpInspectSweep {
  /** The start seq of the row this sweep is attached to. */
  readonly rowStart: number
  readonly entries: number
  readonly messages: number
  readonly reclaims: number
  readonly invalidates: number
  /** Tokens newer than the sweep's start: re-sent uncached once (see the row field). */
  readonly newerTokens: number
  /** Billing payback in requests (see the row field); the ⚠ line is this vs its threshold. */
  readonly breakEven: number
  readonly expensive: boolean
  /**
   * The sweep's AGGREGATE composition — the same figures its printed line
   * carries (summed from raw mass, so the three shares sum to 100). Percentages
   * come from the SAME build that printed the nudge line; the panel never
   * recomputes them.
   */
  readonly rowMix: string
  /** The sweep's aggregate row counts, same shape as a row's. */
  readonly rowCounts: { readonly tool: number; readonly assistant: number; readonly user: number; readonly other: number }
  readonly toolPct: number
  readonly reasoningPct: number
  readonly textPct: number
  /** The entries themselves, in surface order — what a copy-paste call needs. */
  readonly spans: readonly { readonly start: number; readonly end: number }[]
}

/** One durable compressed block. */
export interface AcpInspectBlock {
  readonly id: string
  /** Short id as the tool result prints it. */
  readonly shortId: string
  readonly start: number
  readonly end: number
  readonly messages: number
  readonly tokens: number
  readonly tier: number
  readonly createdAt: number
  readonly summary: string
  /** The model's own thinking while it chose this fold, when it is on record. */
  readonly why?: string
}

/** The knobs the engine actually reads, so the panel shows live values. */
export interface AcpInspectSettings {
  readonly modelContextLimit: number
  readonly nudgeMinContextLimitPct: number
  readonly nudgeMaxContextLimitPct: number
  readonly nudgeEmergencyThresholdPct: number
  /** Cache-miss ÷ cache-hit price ratio the nudge prints (AcpConfig.cacheMissPriceRatio). */
  readonly cacheMissPriceRatio: number
  readonly preset?: string
}

/** The whole payload one panel read returns. */
export interface AcpInspectSnapshot {
  readonly sessionId: string
  /** When the engine last built the range table this snapshot describes. */
  readonly capturedAt: number
  readonly surface: {
    readonly nodes: number
    readonly firstSeq: number
    readonly lastSeq: number
  }
  readonly usage: {
    /** Provider-anchored pressure (the nudge's own gauge). */
    readonly tokens: number
    readonly window: number
    /**
     * Where the denominator came from, so the panel can say it out loud:
     * `engine` = the budget the engine compresses against (explicit setting, or
     * the sustainable input budget the last nudge used), `projection` = the raw
     * route capacity the host disclosed, `default` = the built-in fallback (the
     * least trustworthy case — a session the engine has never measured).
     */
    readonly windowSource: 'engine' | 'projection' | 'default'
    readonly pct: number
    readonly breakdown: {
      readonly tool: number
      readonly text: number
      readonly code: number
      readonly summaries: number
      readonly system: number
    }
  }
  readonly map: readonly AcpInspectNode[]
  readonly rows: readonly AcpInspectRow[]
  readonly sweeps: readonly AcpInspectSweep[]
  readonly blocks: readonly AcpInspectBlock[]
  readonly settings: AcpInspectSettings
}

/** `{ ok: true, value }` / `{ ok: false, error }` — the route envelope. */
export type AcpInspectReply =
  | { readonly ok: true; readonly value: AcpInspectSnapshot | null }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
