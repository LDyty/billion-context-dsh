import { defineConfig } from 'tsup'

// Bundle the adapter into one self-contained dist/index.js. acp-kernel is
// deliberately INLINED (not external), matching billion-context-pi: zero
// runtime deps. tsup externalizes `dependencies` BY DEFAULT, so the inline
// requires an explicit noExternal — without it dist/index.js ships
// `import ... from "acp-kernel"` and the published package silently gains a
// runtime dep (this exact drift shipped through v0.2.4). The @deepseek-ai/*
// seam packages stay external — the hosting DSH deployment provides them.
/**
 * The package ships TWO halves (the `dsh.client` dual-face contract, mirrored
 * from the harness's own client plugins):
 *
 *  - `dist/index.js` — the host half: a plain cordis plugin, built first with
 *    `clean: true` (it owns the output directory).
 *  - `dist/client.js` — the browser half, loaded by the web shell because
 *    package.json declares `dsh.client`. It is NOT an ES module the page
 *    imports: the shell evaluates it as a classic script whose single statement
 *    is `window.__ModuleLoader__.load({ id, factory })`, and the factory returns
 *    the plugin object that the module table then registers. Hence the banner /
 *    intro / footer triplet below (the same handoff every `dsh.client` package
 *    uses) and the CJS format: the bundle's `require(...)` calls are answered by
 *    the injected factory argument, which resolves platform modules (`react`,
 *    `react/jsx-runtime`) from the shell's frozen table.
 *
 * The client half must stay PURE: react is the only import it is allowed to
 * leave unresolved (plus whatever `dsh.client.external` adds later). Bundling a
 * second copy of a shared runtime would break `instanceof` and hook identity
 * across plugins, so the externals list is a contract, not a size optimization.
 */
const CLIENT_PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom'] as const

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: true,
    external: [/^@deepseek-ai\//],
    noExternal: ['acp-kernel'],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    // The host config above already cleaned the directory.
    clean: false,
    minify: true,
    // `type: module` in package.json would otherwise emit client.cjs.
    outExtension: () => ({ js: '.js' }),
    external: [...CLIENT_PLATFORM_MODULES],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env': '{}',
    },
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "billion-context-dsh", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: 'return module.exports; } });',
    },
  },
])
