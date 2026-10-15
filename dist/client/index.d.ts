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
/** The slice of the client context this bundle touches (structural, never imported). */
interface ClientCtx {
    effect(effect: () => void | (() => void), label?: string): unknown;
    inject(names: readonly string[], callback: (ctx: unknown) => unknown): unknown;
    slots?: {
        inject?(name: string, callback: () => unknown): unknown;
        register?(spec: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): () => void;
    };
}
export declare function apply(ctx: ClientCtx): void;
export {};
