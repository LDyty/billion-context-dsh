/**
 * The ACP inspector panel: what the context is made of, what the engine would
 * offer to fold, and — for every block that already landed — the thinking that
 * produced it.
 *
 * One read-only view over one payload. The numbers are the engine's own (the
 * same ones the nudge prints); this file renders them, it never recomputes them.
 * The only action is "copy the call": the panel hands the reader a ready
 * `compress({...})` string instead of writing to the session itself, so a click
 * can never fold something the model did not have a chance to judge.
 */
import type { ReactElement } from 'react';
import type { AcpInspectSnapshot } from '../inspect-types.ts';
/** Exported for the offline preview (`scratch-panel-preview.mjs`) and future tests. */
export declare function RangeTable(props: {
    snapshot: AcpInspectSnapshot;
}): ReactElement;
/** The whole panel body for one session. */
export declare function AcpInspectorPanel(props: {
    sessionId?: string;
}): ReactElement;
