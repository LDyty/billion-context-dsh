/**
 * billion-context-dsh — browser half.
 *
 * Loaded by the web shell because package.json declares `dsh.client`
 * (`platform: 'web'` + the `./client` export). It registers ONE seat: the ACP
 * panel as a tab of the right sidebar, next to the harness's own Context tab.
 *
 * Everything here is optional by construction. The sidebar's tab registry may be
 * absent (a host without the right column), the session id may be missing while
 * the chat has no session, and the host route may be unregistered (a process
 * without a web server) — each of those costs the panel and nothing else, which
 * is why the registration rides a deferred `inject` and every face is re-proved
 * at runtime instead of trusted.
 *
 * The module's export shape (`module.exports = { name, inject, apply }`) is the
 * `dsh.client` bundle contract: the shell wraps the bundle in
 * `window.__ModuleLoader__.load({ id, factory })` and treats the returned object
 * as a cordis plugin (see tsdown/tsup banner in tsup.config.ts).
 */

import { createElement as h } from 'react'
import { AcpInspectorPanel } from './panel.tsx'
import { installPanelStyles } from './styles.ts'

const TAB_ID = 'billion-context-dsh'
/** Namespaced: the tab registry throws when a kind collides in a non-coexisting band. */
const TAB_KIND = 'billion-context-dsh'
/** After the shipped Files (10) and dsh-context's Context (20) entries. */
const GUIDE_ORDER = 30
const TAB_TITLE = 'ACP 压缩'
const GUIDE_DESCRIPTION = '上下文构成、可压范围与清扫、每块的思考'

/** The slice of the client context this bundle touches (structural, never imported). */
interface ClientCtx {
  effect(effect: () => void | (() => void), label?: string): unknown
  inject(names: readonly string[], callback: (ctx: unknown) => unknown): unknown
  slots?: {
    inject?(name: string, callback: () => unknown): unknown
    register?(spec: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): () => void
  }
}

interface SidebarTabsFace {
  register(spec: {
    id: string
    kind: string
    title: () => string
    guide?: readonly { order: number; title: () => string; description: () => string; icon?: () => unknown }[]
  }): unknown
}

/** A minimal 16px inline icon, so the sidebar entry is not a bare label. */
function AcpIcon(): unknown {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('rect', { x: 1.5, y: 3.5, width: 13, height: 3, rx: 1, fill: 'currentColor', opacity: 0.75 }),
    h('rect', { x: 1.5, y: 7.5, width: 8, height: 3, rx: 1, fill: 'currentColor', opacity: 0.5 }),
    h('rect', { x: 1.5, y: 11.5, width: 5, height: 2, rx: 1, fill: 'currentColor', opacity: 0.35 }),
  )
}

export function apply(ctx: ClientCtx): void {
  installPanelStyles()
  ctx.inject(['sidebarRightTabs'], (raw) => {
    const injected = raw as ClientCtx & { sidebarRightTabs?: SidebarTabsFace }
    const tabs = injected.sidebarRightTabs
    const slots = injected.slots
    if (tabs === undefined || typeof tabs.register !== 'function') return undefined
    if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return undefined
    const disposers: (() => void)[] = []
    const own = (result: unknown): void => {
      if (typeof result === 'function') disposers.push(result as () => void)
    }
    try {
      own(tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => TAB_TITLE,
        guide: [{ order: GUIDE_ORDER, title: () => TAB_TITLE, description: () => GUIDE_DESCRIPTION, icon: AcpIcon }],
      }))
      own(slots.inject('sidebar.right.pane.tab', () => slots.register!(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        (props) => h(AcpInspectorPanel, { sessionId: props['sessionId'] as string | undefined }),
      )))
    } catch {
      for (const dispose of disposers) dispose()
      return undefined
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

module.exports = {
  name: 'billion-context-dsh-ui',
  inject: ['slots'],
  apply,
}
