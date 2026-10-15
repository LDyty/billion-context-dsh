import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'

// Git-source installs (`dsh plugin add github:Tyan66666/billion-context-dsh#<ref>`,
// the form the plugin store shows) ship the repo verbatim: pnpm ≥10/11 blocks
// dependency build scripts by default (`allowBuilds`), and for a git-hosted
// package the approval key must contain the exact resolved commit hash
// (pnpm#12367), so the install can only work if the package carries its build
// output and runs NO build scripts. That is why `dist/` is committed (issue
// #92) — this test pins the two halves of that contract so a future edit
// cannot silently re-break git installs.
//
// Freshness (the committed dist actually matching the current source) is
// maintained by the dist-bot (`.github/workflows/dist-bot.yml`: rebuild and
// push fresh artifacts to main after every merge that can change the build
// output) and backstopped by the CI check (`git status --porcelain -- dist`,
// run daily on a schedule and on the bot's own commits — see ci.yml) —
// neither is expressible inside a unit test.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	main: string
	types: string
	exports: Record<string, string | { types?: string; import?: string }>
	files: string[]
	dsh: { bundle: { patch: string }; client?: { platform?: string; external?: string[] } }
	scripts: Record<string, string>
}

test('the entry points and bundle patch resolve to committed files', () => {
	// The npm tarball ships exactly `files` (+ README/LICENSE/package.json);
	// committing the same paths makes a git clone install-equivalent to the
	// published package. If an entry point gains a path that is neither
	// committed nor built, one of these asserts names it.
	const targets = [pkg.main, pkg.types, pkg.exports['.']?.types, pkg.exports['.']?.import, pkg.dsh.bundle.patch].filter(
		(target): target is string => typeof target === 'string',
	)
	assert.ok(targets.length >= 4, 'package.json must declare main/types/exports and dsh.bundle.patch')
	for (const target of targets) {
		const path = new URL(`../${target}`, import.meta.url)
		assert.ok(existsSync(path), `committed artifact missing: ${target}`)
		assert.ok(statSync(path).size > 0, `committed artifact is empty: ${target}`)
	}
})

/**
 * The browser half's contract (`dsh.client`): the shell evaluates
 * `dist/client.js` as a CLASSIC script whose single statement registers a module
 * factory, and treats the returned object as a cordis plugin. Three things can
 * silently break that: the wrapper (the bundle becomes a module the page never
 * imports), the platform externals (a second copy of react breaks hook identity
 * across plugins), and the declaration itself (no `dsh.client` row in
 * package.json → the shell never loads the file at all).
 */
test('the committed client half keeps the dsh.client bundle contract', () => {
	assert.equal(pkg.dsh.client?.platform, 'web', 'the client half declares the web platform')
	assert.equal(pkg.exports['./client'], './dist/client.js', 'and the ./client export the shell resolves')
	const clientPath = new URL('../dist/client.js', import.meta.url)
	assert.ok(existsSync(clientPath), 'committed artifact missing: dist/client.js')
	const js = readFileSync(clientPath, 'utf8')
	assert.match(
		js,
		/^window\.__ModuleLoader__\.load\(\{ id: "billion-context-dsh", factory: \(require\) => \{/u,
		'the bundle opens the module-loader factory the shell expects',
	)
	assert.match(js, /return module\.exports; \} \}\);/u, 'and closes it by returning the plugin object')
	assert.match(js, /module\.exports=\{name:"billion-context-dsh-ui",inject:\["slots"\],apply:/u, 'exporting the cordis plugin face')
	const required = [...js.matchAll(/require\("([^"]+)"/gu)].map((match) => match[1]!)
	assert.deepEqual(
		[...new Set(required)],
		['react'],
		'the only external is the platform-seeded react — anything else must be declared in dsh.client.external',
	)
	assert.ok(js.includes('/api/billion-context/inspect'), 'and it talks to the host route this repo registers')
})

test('the committed bundle is the ACP engine (ESM, AcpCompactionEngine exported)', () => {
	const js = readFileSync(new URL(`../${pkg.main}`, import.meta.url), 'utf8')
	const dts = readFileSync(new URL(`../${pkg.types}`, import.meta.url), 'utf8')
	// A stale or wrong-file dist would still "exist"; pinning the exported
	// engine name catches a dist built from a different source tree.
	assert.match(dts, /AcpCompactionEngine/u, `dist types must export AcpCompactionEngine (${pkg.types})`)
	assert.match(js, /AcpCompactionEngine/u, `dist bundle must contain AcpCompactionEngine (${pkg.main})`)
})

test('the package defines zero build/lifecycle scripts', () => {
	// pnpm gates `prepare` on git-hosted packages and preinstall/install/
	// postinstall on ALL dependencies behind `allowBuilds`; adding any of
	// them turns every git-source (and potentially store) install into a
	// hard failure (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) that users can
	// only escape with a commit-hash key (pnpm#12367, pnpm#12294). The
	// committed dist makes build steps unnecessary — keep it that way.
	const forbidden = ['prepare', 'preprepare', 'postprepare', 'preinstall', 'install', 'postinstall']
	const present = forbidden.filter((script) => script in pkg.scripts)
	assert.deepEqual(present, [], `no lifecycle build scripts allowed (pnpm 11 blocks them on installs); found: ${present.join(', ')}`)
})
