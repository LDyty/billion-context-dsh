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
