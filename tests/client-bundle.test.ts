/**
 * The browser half, exercised the way the shell exercises it.
 *
 * `dist/client.js` is not imported by the page: the shell evaluates it as a
 * classic script, `window.__ModuleLoader__.load` captures the factory, and the
 * factory is called with a `require` that answers from the seeded module table.
 * This test drives exactly that handoff — with a stub react, since the bundle's
 * only external is `react` — and then runs the returned plugin's `apply` against
 * a stub sidebar so the registration is proved, not assumed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

interface Loaded {
  id: string
  factory: (require: (specifier: string) => unknown) => {
    name?: string
    inject?: string[]
    apply?: (ctx: unknown) => void
  }
}

/** Evaluate the committed bundle and hand back the captured factory. */
function loadClientBundle(): Loaded {
  const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  let captured: Loaded | undefined
  const windowStub = {
    __ModuleLoader__: {
      load: (entry: Loaded) => {
        captured = entry
      },
    },
  }
  // The bundle is a classic script: run it with the shell's window in scope.
  new Function('window', 'document', source)(windowStub, undefined)
  assert.ok(captured !== undefined, 'the bundle registered a module')
  return captured
}

/** The three react entry points the client half uses. */
function reactStub(): unknown {
  const createElement = (type: unknown, props: unknown, ...children: unknown[]): unknown => ({ type, props, children })
  return { createElement, useState: (initial: unknown) => [initial, () => {}], useEffect: () => {}, useMemo: (fn: () => unknown) => fn() }
}

/** The one react-dom entry point the client half uses (the portaled hover card). */
function reactDomStub(): unknown {
  return { createPortal: (element: unknown) => element }
}

test('client half: the shell handoff yields the cordis plugin face', () => {
  const entry = loadClientBundle()
  assert.equal(entry.id, 'billion-context-dsh', 'registered under the package name')
  const plugin = entry.factory((specifier) => {
    // react-dom for the portaled hover card, react/jsx-runtime for the JSX in it.
    assert.ok(
      ['react', 'react-dom', 'react/jsx-runtime'].includes(specifier),
      `the bundle may only require platform modules (asked for ${specifier})`,
    )
    if (specifier === 'react-dom') return reactDomStub()
    if (specifier === 'react/jsx-runtime') return { jsx: reactStub(), jsxs: reactStub(), Fragment: 'Fragment' }
    return reactStub()
  })
  assert.equal(plugin.name, 'billion-context-dsh-ui')
  assert.deepEqual(plugin.inject, ['slots'], 'the panel needs the slot registry')
  assert.equal(typeof plugin.apply, 'function')
})

test('client half: apply registers the right-sidebar tab and its body seat', () => {
  const plugin = loadClientBundle().factory(() => reactStub())
  const tabs: { id?: string; kind?: string; title?: string; guide?: { order?: number }[] }[] = []
  const seats: { name?: string; key?: string }[] = []
  const effects: string[] = []
  const ctx = {
    effect: (effect: () => void, label?: string) => {
      effects.push(label ?? '')
      return effect()
    },
    inject: (names: readonly string[], callback: (ctx: unknown) => unknown) => {
      assert.deepEqual([...names], ['sidebarRightTabs'])
      return callback({
        slots: {
          inject: (_name: string, factory: () => unknown) => factory(),
          register: (spec: { name?: string; key?: string }, component: unknown) => {
            seats.push(spec)
            assert.equal(typeof component, 'function', 'the seat renders the panel component')
            return () => {}
          },
        },
        sidebarRightTabs: {
          register: (spec: { id: string; kind: string; title: () => string; guide?: { order: number }[] }) => {
            tabs.push({ id: spec.id, kind: spec.kind, title: spec.title(), guide: spec.guide })
            return () => {}
          },
        },
      })
    },
  }
  plugin.apply!(ctx)
  assert.equal(tabs.length, 1, 'one tab')
  assert.equal(tabs[0]!.id, 'billion-context-dsh')
  assert.equal(tabs[0]!.kind, 'billion-context-dsh', 'the kind is namespaced, so it cannot collide with a foreign tab')
  assert.equal(tabs[0]!.title, 'ACP 压缩')
  assert.ok((tabs[0]!.guide?.[0]?.order ?? 0) > 10, 'the guide entry sits after the shipped entries')
  assert.deepEqual(seats, [{ name: 'sidebar.right.pane.tab', key: 'billion-context-dsh' }])
})

test('client half: a host without the right sidebar costs the tab, never a throw', () => {
  const plugin = loadClientBundle().factory(() => reactStub())
  const ctx = {
    effect: () => {},
    inject: (_names: readonly string[], callback: (ctx: unknown) => unknown) => callback({ slots: {} }),
  }
  assert.doesNotThrow(() => { plugin.apply!(ctx) })
})
