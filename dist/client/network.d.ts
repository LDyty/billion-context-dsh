/**
 * Compression Network — a CAD-style, pan/zoom canvas over the compression
 * lifecycle: age regions → offerable ranges → sweeps → landed blocks (with
 * tier-2/3 parent links). Hover (or pin) a node and its whole lineage lights
 * up; the inspector beside the canvas follows the selection.
 *
 * No graph library: the canvas is ONE transformed layer (`translate3d scale`)
 * with absolute cards and an SVG link layer in the same coordinate space, so
 * pan/zoom only touches one style property. Pan/zoom updates are committed via
 * refs (no React render per frame); only LOD bucket changes, hover, pins and
 * node drops re-render.
 */
import { type ReactElement } from 'react';
import type { AcpInspectBlock, AcpInspectRow, AcpInspectSnapshot, AcpInspectSweep } from '../inspect-types.ts';
type NodeKind = 'region' | 'range' | 'sweep' | 'block';
export interface NetNode {
    readonly id: string;
    readonly kind: NodeKind;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly title: string;
    readonly sub: string;
    readonly tokens: number;
    readonly region?: number;
    readonly row?: AcpInspectRow;
    readonly sweep?: AcpInspectSweep;
    readonly block?: AcpInspectBlock;
    readonly span?: {
        readonly start: number;
        readonly end: number;
    };
}
interface NetEdge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly kind: 'owns' | 'sweep' | 'covers' | 'parent';
}
export interface NetLayout {
    readonly nodes: readonly NetNode[];
    readonly edges: readonly NetEdge[];
    readonly columns: readonly {
        readonly x: number;
        readonly label: string;
    }[];
    readonly width: number;
    readonly height: number;
}
/**
 * Collision volume: nodes sharing a column may never overlap — each one owns its
 * box plus {@link NODE_GAP} of empty space. Fixed ids (a node the reader just
 * dragged) keep their exact y; the rest are pushed down around them.
 */
export declare function resolveCollisions(nodes: readonly NetNode[], gap?: number, fixed?: ReadonlySet<string>): NetNode[];
/** Deterministic layered layout — no physics, so the same build always draws the same graph. */
export declare function buildLayout(snapshot: AcpInspectSnapshot): NetLayout;
/** Forward, backward (tier parent to an earlier tier) or same-column links. */
export declare function linkPath(from: NetNode, to: NetNode): string;
export declare function CompressionNetwork(props: {
    snapshot: AcpInspectSnapshot;
    sessionId: string;
    onClose: () => void;
    /** Preview/test seat only: the viewport the static first paint uses (effects do not run in SSR). */
    initialView?: {
        x: number;
        y: number;
        z: number;
    };
}): ReactElement;
export {};
