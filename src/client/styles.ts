/**
 * The panel's stylesheet, injected once as a `<style>` element.
 *
 * No CSS build step on purpose: the client half is a single browser bundle and
 * the shell offers no stylesheet seam to a third-party plugin, so a template
 * literal + one injected tag is the whole pipeline. Class names are prefixed
 * `acp-` so nothing here can collide with harness or other plugins' rules.
 */

export const ACP_PANEL_STYLE_ID = 'billion-context-dsh/panel.css'

export const ACP_PANEL_CSS = `
/* 面板整体自己滚，学 dsh-context 的 .lc-root：宿主那层是「定高 + overflow: hidden」
   的容器，插件根必须 height:100% 自己滚——用 max-height:78vh 时面板比面板体高就被
   宿主裁掉，底部那块黑的和滚不完的滚动条就是这么来的（dsh-context 的注释原话：
   "the supported shell wraps the tab in a definite-height body whose overflow:hidden
   would otherwise clip a grown root"）。scrollbar-gutter 让滚动条出现时内容不抖，
   scrollbar-width: thin 跟宿主一致。 */
.acp-panel { display: flex; flex-direction: column; gap: 14px; padding: 0 14px 20px; font-size: 12px; line-height: 1.5; height: 100%; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-gutter: stable; }
/* 右侧栏/浮窗形态：宿主给这两种容器加了标记属性，dsh-context 用它调内边距，我们照做。 */
[data-sidebar-right-open] .acp-panel,
[data-sidebar-right-float-host] .acp-panel { padding: 0 12px 16px; }
/* 顶部留白交给第一个子元素：面板自身的 padding-top 会让吸顶表头停在内容框顶、
   露出下面那条 12px 的缝（实测 th.top=80、panel.top=68），改成 margin 就没有缝。 */
.acp-panel > *:first-child { margin-top: 12px; }
.acp-panel * { box-sizing: border-box; }
.acp-head { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; }
.acp-head b { font-size: 15px; font-weight: 600; }
.acp-muted { opacity: .6; }
.acp-bar { position: relative; height: 8px; border-radius: 4px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
.acp-bar > span { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: currentColor; opacity: .35; }
.acp-section { display: flex; flex-direction: column; gap: 6px; }
.acp-section > h4 { margin: 0; font-size: 12px; font-weight: 600; opacity: .8; letter-spacing: .02em; }
.acp-map { display: flex; align-items: stretch; height: 34px; border-radius: 6px; overflow: hidden; gap: 0; }
.acp-map > i { display: block; min-width: 1px; }
.acp-map > i:hover, .acp-map > i:focus-visible { filter: brightness(1.35) saturate(1.15); outline: none; }
.acp-tip {
  position: fixed; z-index: 2147483000; pointer-events: none;
  max-width: 300px; padding: 7px 9px; border-radius: 7px;
  /* 宿主设计变量优先（和 dsh-context 的 .lc-tip 同一套 token），没有变量时回落到
     Canvas/CanvasText——皮肤换成什么配色，浮层都跟着走。 */
  background: var(--dsw-alias-bg-layer-2, color-mix(in srgb, CanvasText 92%, Canvas));
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  color: var(--dsw-alias-label-primary, Canvas); white-space: pre-line; font-size: 11px; line-height: 1.45;
  box-shadow: var(--dsw-shadow-lv3, 0 6px 18px rgba(0, 0, 0, .28));
  opacity: 0; animation: acp-tip-in .09s ease-out forwards;
}
@keyframes acp-tip-in { to { opacity: 1; } }
.acp-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; opacity: .75; }
.acp-legend > span { display: inline-flex; align-items: center; gap: 4px; }
.acp-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.acp-k-tool { background: #6aa9ff; }
.acp-k-text { background: #7fd1a6; }
.acp-k-checkpoint { background: #c69cff; }
.acp-k-instruction { background: #ffd166; }
.acp-k-protected { background: #ff8a8a; }
.acp-k-metadata { background: #9aa4b2; }
.acp-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.acp-table th, .acp-table td { padding: 3px 6px; text-align: right; white-space: nowrap; }
.acp-table th:first-child, .acp-table td:first-child { text-align: left; }
.acp-table thead th { font-weight: 600; opacity: .65; border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.acp-table tbody tr + tr td { border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.acp-row-head { display: flex; justify-content: space-between; gap: 8px; }
.acp-warn { color: #ffb454; }
.acp-sweep { opacity: .85; font-size: 11px; }
/* Range cards (2026-10-17): a right-sidebar panel is narrow, so each interval
   reads top-down — identity, this row's composition, the sweep's composition,
   then the two costs. Region headers group the cards into six chapters. */
.acp-regions { display: flex; flex-direction: column; gap: 10px; }
.acp-region { display: flex; flex-direction: column; gap: 4px; }
.acp-region-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 2px 2px; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); font-size: 11px; }
.acp-region-title { font-weight: 600; opacity: .75; letter-spacing: .02em; }
.acp-prow { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border: 1px solid color-mix(in srgb, currentColor 10%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 3%, transparent); }
.acp-prow-top { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.acp-prow-range { font-variant-numeric: tabular-nums; opacity: .9; }
.acp-prow-size { margin-left: auto; font-size: 10px; opacity: .55; font-variant-numeric: tabular-nums; }
.acp-chip { display: inline-block; padding: 0 5px; border-radius: 7px; font-size: 10px; background: color-mix(in srgb, currentColor 12%, transparent); opacity: .8; }
.acp-mixline { display: flex; align-items: center; gap: 6px; min-height: 16px; }
.acp-mix-tag { width: 24px; flex: none; font-size: 10px; opacity: .5; }
.acp-mix-legend { font-size: 10px; opacity: .55; white-space: normal; }
.acp-prow-costs { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10px; opacity: .85; font-variant-numeric: tabular-nums; }
.acp-others { border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 6px; padding: 4px 8px 6px; }
.acp-others > summary { cursor: pointer; font-size: 10px; opacity: .65; }
.acp-others-body { max-height: 180px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.acp-others-line { display: flex; gap: 6px; align-items: baseline; font-size: 10px; font-variant-numeric: tabular-nums; }
.acp-others-region { width: 22px; flex: none; opacity: .45; }
.acp-others-spans { white-space: normal; word-break: break-word; opacity: .8; }
.acp-sub { display: block; font-size: 10px; opacity: .55; }
.acp-mix { display: inline-flex; width: 64px; height: 8px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, currentColor 10%, transparent); vertical-align: middle; flex: none; }
.acp-mix > i { display: block; height: 100%; background: currentColor; }
.acp-mix-tool { opacity: .55; }
.acp-mix-reason { opacity: .3; }
.acp-mix-text { opacity: .12; }
/* 代价格与清扫格现在各自成行，不再靠 margin 挤在一行里。 */
.acp-cost-rate { font-size: 11px; }
.acp-badge { display: inline-block; padding: 0 5px; border-radius: 7px; font-size: 10px; background: color-mix(in srgb, currentColor 14%, transparent); }
/* 表头不做吸顶：sticky th / sticky thead / border-collapse:separate 三种写法在
   Chrome 里都盖不住后画的 tbody（实测行文字压在列名上，z-index 无效），所以表头
   跟着内容滚，只保留面板外层的单条滚动条（见 .acp-panel）。 */
.acp-blocks { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; scrollbar-width: thin; }
.acp-block { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 6px; padding: 6px 8px; }
.acp-block > summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.acp-block > summary::-webkit-details-marker { display: none; }
.acp-block pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; opacity: .9; max-height: 240px; overflow: auto; scrollbar-width: thin; }
.acp-why { border-left: 2px solid color-mix(in srgb, currentColor 30%, transparent); padding-left: 8px; }
.acp-copy { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
.acp-copy:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.acp-empty { opacity: .6; font-style: italic; }
.acp-stale { opacity: .45; }

/* ── Compression Network (CAD canvas) ─────────────────────────────────────── */
.acp-net-open { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-brand-primary, #6aa9ff); font-size: 10.5px; padding: 2px 9px; border-radius: 999px; cursor: pointer; font-family: inherit; }
.acp-net-open:hover { border-color: var(--dsw-alias-brand-primary, #6aa9ff); }
.acp-net-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, #000 62%, transparent); backdrop-filter: blur(3px); }
.acp-net-overlay:fullscreen { background: var(--dsw-alias-bg-layer-1, #14161a); backdrop-filter: none; }
.acp-net-shell { width: min(1600px, 96vw); height: min(920px, 92vh); display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #14161a); color: var(--dsw-alias-label-primary, #e6e8ec); border: 1px solid var(--dsw-alias-border-l2, #2a2f38); border-radius: 12px; overflow: hidden; box-shadow: 0 18px 60px color-mix(in srgb, #000 55%, transparent); }
.acp-net-overlay:fullscreen .acp-net-shell { width: 100vw; height: 100vh; border: 0; border-radius: 0; }
.acp-net-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #2a2f38); }
.acp-net-toolbar b { font-size: 12.5px; }
.acp-net-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #9aa4b2); }
.acp-net-actions { margin-left: auto; display: flex; gap: 4px; }
.acp-net-btn { border: 1px solid var(--dsw-alias-border-l1, #2a2f38); background: var(--dsw-alias-bg-layer-2, #1c2027); color: inherit; border-radius: 6px; font-size: 11px; padding: 2px 9px; cursor: pointer; font-family: inherit; }
.acp-net-btn:hover { border-color: var(--dsw-alias-brand-primary, #6aa9ff); }
.acp-net-close { color: var(--dsw-alias-state-error-primary, #ff8a8a); }
.acp-net-body { flex: 1; min-height: 0; display: flex; }
.acp-net-stage { flex: 1; position: relative; overflow: hidden; outline: none; touch-action: none; cursor: grab; background: var(--dsw-alias-bg-layer-1, #14161a); }
.acp-net-stage:active { cursor: grabbing; }
.acp-net-grid { position: absolute; inset: 0; pointer-events: none; background-image: radial-gradient(circle, color-mix(in srgb, currentColor 16%, transparent) 1px, transparent 1px); background-size: 24px 24px; opacity: .45; }
.acp-net-layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.acp-net-links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.acp-net-col-label { position: absolute; top: 10px; font-size: 11px; font-weight: 650; letter-spacing: .02em; color: var(--dsw-alias-label-tertiary, #9aa4b2); white-space: nowrap; pointer-events: none; }
.acp-net-link { fill: none; stroke: color-mix(in srgb, currentColor 55%, transparent); stroke-width: 1; opacity: .32; transition: opacity .15s, stroke .15s; }
.acp-net-link-owns { stroke: #6aa9ff; opacity: .45; }
.acp-net-link-sweep { stroke: #ffd166; opacity: .72; stroke-width: 1.25; }
.acp-net-link-covers { stroke: #7fd1a6; opacity: .6; stroke-width: 1.25; }
.acp-net-link-parent { stroke: #c69cff; opacity: .82; stroke-width: 1.45; }
.acp-net-link.on { opacity: .95; stroke: var(--dsw-alias-brand-primary, #6aa9ff); stroke-width: 1.4; }
.acp-net-node { position: absolute; box-sizing: border-box; padding: 4px 7px; border: 1px solid var(--dsw-alias-border-l2, #2a2f38); border-radius: 6px; background: var(--dsw-alias-bg-layer-2, #1c2027); color: var(--dsw-alias-label-primary, #e6e8ec); overflow: hidden; cursor: pointer; user-select: none; transition: opacity .15s, box-shadow .15s, border-color .15s; }
.acp-net-node:hover { z-index: 5; border-color: var(--dsw-alias-brand-primary, #6aa9ff); box-shadow: 0 3px 12px color-mix(in srgb, #000 45%, transparent); }
.acp-net-node.pinned { border-color: var(--dsw-alias-brand-primary, #6aa9ff); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #6aa9ff); }
.acp-net-node.moved { z-index: 4; box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary, #6aa9ff) 55%, transparent); }
.acp-net-region { border-left: 3px solid var(--dsw-alias-brand-primary, #6aa9ff); }
.acp-net-range { border-left: 3px solid var(--dsw-alias-state-success-primary, #7fd1a6); }
.acp-net-sweep { border-left: 3px solid var(--dsw-alias-state-warning-primary, #ffd166); }
.acp-net-block { border-left: 3px solid #c69cff; }
.acp-net-tier-1 { border-left-color: #c69cff; }
.acp-net-tier-2 { border-left-color: #ffd166; }
.acp-net-tier-3 { border-left-color: #ff8ad4; }
.acp-net-node-title { display: block; font-size: 10.5px; font-weight: 600; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acp-net-node-sub { display: block; font-size: 9px; line-height: 1.25; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.acp-net-node-stack { display: block; }
.acp-net-node-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.acp-net-node-line .acp-net-node-title { flex: 1 1 auto; min-width: 0; }
.acp-net-node-amount { flex: none; white-space: nowrap; }
.acp-net-node-bar { display: flex; height: 4px; margin-top: 3px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, currentColor 12%, transparent); }
.acp-net-node-bar i { display: block; height: 100%; }
.acp-net-seg-tool { background: #6aa9ff; opacity: .8; }
.acp-net-seg-reason { background: #c69cff; opacity: .7; }
.acp-net-seg-text { background: #7fd1a6; opacity: .7; }
/* Lineage focus: everything not on the hovered/pinned path whispers. */
.acp-net-stage.has-focus .acp-net-node:not(.on) { opacity: .12; }
.acp-net-stage.has-focus .acp-net-link:not(.on) { opacity: .04; }
/* Semantic zoom: far = structure only, mid = labels, near = full detail. */
.acp-net-layer[data-lod="far"] .acp-net-node-title,
.acp-net-layer[data-lod="far"] .acp-net-node-sub,
.acp-net-layer[data-lod="far"] .acp-net-node-bar { display: none; }
.acp-net-layer[data-lod="far"] .acp-net-region .acp-net-node-title { display: block; }
.acp-net-layer[data-lod="far"] .acp-net-node { border-radius: 3px; }
.acp-net-layer[data-lod="far"] .acp-net-region { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #6aa9ff) 46%, transparent); }
.acp-net-layer[data-lod="far"] .acp-net-range { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #7fd1a6) 34%, transparent); }
.acp-net-layer[data-lod="far"] .acp-net-sweep { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #ffd166) 44%, transparent); }
.acp-net-layer[data-lod="far"] .acp-net-block { background: color-mix(in srgb, #c69cff 42%, transparent); }
.acp-net-layer[data-lod="far"] .acp-net-tier-2 { background: color-mix(in srgb, #ffd166 42%, transparent); }
.acp-net-layer[data-lod="far"] .acp-net-tier-3 { background: color-mix(in srgb, #ff8ad4 42%, transparent); }
.acp-net-layer[data-lod="mid"] .acp-net-node-bar { display: none; }
.acp-net-mini { position: absolute; right: 12px; bottom: 12px; width: 160px; height: 114px; border: 1px solid var(--dsw-alias-border-l2, #2a2f38); border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #14161a) 88%, transparent); overflow: hidden; cursor: crosshair; }
.acp-net-mini-canvas { position: absolute; left: 5px; top: 5px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 2px; opacity: .7; }
.acp-net-mini-rect { position: absolute; left: 0; top: 0; width: 100%; height: 100%; border: 1px solid var(--dsw-alias-brand-primary, #6aa9ff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #6aa9ff) 14%, transparent); border-radius: 2px; }
.acp-net-status { position: absolute; left: 12px; bottom: 12px; display: flex; flex-wrap: wrap; gap: 2px 6px; max-width: calc(100% - 200px); font-size: 10px; color: var(--dsw-alias-label-tertiary, #9aa4b2); pointer-events: none; font-variant-numeric: tabular-nums; }
.acp-net-legend { display: inline-flex; flex-wrap: wrap; gap: 8px; }
.acp-net-legend > span { display: inline-flex; align-items: center; gap: 3px; }
.acp-net-key { display: inline-block; width: 14px; height: 2px; border-radius: 1px; }
.acp-net-key-owns { background: #6aa9ff; }
.acp-net-key-sweep { background: #ffd166; }
.acp-net-key-covers { background: #7fd1a6; }
.acp-net-key-parent { background: #c69cff; }
.acp-net-side { width: 300px; flex: none; border-left: 1px solid var(--dsw-alias-border-l1, #2a2f38); padding: 10px 12px; overflow: auto; font-size: 11.5px; line-height: 1.5; }
.acp-net-insp-head { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #9aa4b2); margin-bottom: 4px; }
.acp-net-insp-title { font-size: 12.5px; font-weight: 650; margin-bottom: 3px; }
.acp-net-insp-summary, .acp-net-insp-why { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 10.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #b8c0cc); max-height: 260px; overflow: auto; scrollbar-width: thin; }
.acp-net-insp-why { border-left: 2px solid color-mix(in srgb, currentColor 28%, transparent); padding-left: 8px; opacity: .8; }
@media (max-width: 900px) {
  .acp-net-body { flex-direction: column; }
  .acp-net-side { width: auto; height: 34%; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l1, #2a2f38); }
}
@media (max-width: 640px) {
  .acp-net-shell { width: 98vw; height: 96vh; border-radius: 8px; }
  .acp-net-toolbar { flex-wrap: wrap; gap: 4px 8px; padding: 6px 8px; }
  .acp-net-toolbar b { flex: none; white-space: nowrap; }
  .acp-net-hint { display: none; }
  .acp-net-actions { margin-left: 0; flex-wrap: wrap; }
  .acp-net-btn { padding: 2px 7px; font-size: 10.5px; }
}
`

/** Inject the stylesheet once per document (idempotent). */
export function installPanelStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${ACP_PANEL_STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'billion-context-dsh'
  tag.dataset.pluginCss = ACP_PANEL_STYLE_ID
  tag.textContent = ACP_PANEL_CSS
  document.head.appendChild(tag)
}
