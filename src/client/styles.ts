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
.acp-panel { display: flex; flex-direction: column; gap: 14px; padding: 12px 14px 20px; font-size: 12px; line-height: 1.5; }
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
  background: color-mix(in srgb, CanvasText 92%, Canvas);
  color: Canvas; white-space: pre-line; font-size: 11px; line-height: 1.45;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .28);
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
/* Range table, compact form: composition as a meter instead of three columns,
   the row mix as a sub-line under the range, cost as one cell with an offer
   badge. Detail is hover-only, so the table stays scannable. */
.acp-ranges td { vertical-align: top; }
.acp-ranges .acp-age-region { opacity: .6; text-align: left; }
.acp-ranges .acp-range { text-align: left; }
.acp-sub { display: block; font-size: 10px; opacity: .55; }
.acp-mix { display: inline-flex; width: 56px; height: 8px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, currentColor 10%, transparent); vertical-align: middle; }
.acp-mix > i { display: block; height: 100%; background: currentColor; }
.acp-mix-tool { opacity: .55; }
.acp-mix-reason { opacity: .3; }
.acp-mix-text { opacity: .12; }
/* 代价格与清扫格现在各自成行，不再靠 margin 挤在一行里。 */
.acp-cost-rate { font-size: 11px; }
.acp-badge { display: inline-block; padding: 0 5px; border-radius: 7px; font-size: 10px; background: color-mix(in srgb, currentColor 14%, transparent); }
/* 子行（行构成等）允许折行，免得一个长标签把整列撑宽。 */
.acp-ranges .acp-sub { white-space: normal; }
/* 每个年龄区域现在印 3 个区间（6 → 18 行），表自己带纵向滚动条；表头吸顶，
   滚起来仍然知道哪一列是什么。背景用 Canvas，和面板底一致。 */
.acp-ranges-scroll { max-height: 340px; overflow-y: auto; overscroll-behavior: contain; }
.acp-ranges thead th { position: sticky; top: 0; z-index: 1; background: Canvas; }
.acp-blocks { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
.acp-block { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 6px; padding: 6px 8px; }
.acp-block > summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.acp-block > summary::-webkit-details-marker { display: none; }
.acp-block pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; opacity: .9; max-height: 240px; overflow: auto; }
.acp-why { border-left: 2px solid color-mix(in srgb, currentColor 30%, transparent); padding-left: 8px; }
.acp-copy { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
.acp-copy:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.acp-empty { opacity: .6; font-style: italic; }
.acp-stale { opacity: .45; }
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
