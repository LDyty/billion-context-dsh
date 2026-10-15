/**
 * One hover card for the context map, portaled to `document.body`.
 *
 * Why a portal and not an in-tree bubble: the panel lives inside the right
 * sidebar, whose scroll container and containment can clip or misplace a fixed
 * descendant (the same trap dsh-context's `hoverTip.tsx` documents for the
 * Insights page). The bubble therefore renders as a child of `<body>`, measures
 * itself once per shown anchor, clamps into the viewport, and stays
 * `visibility: hidden` until that measurement lands so it never flashes at an
 * unmeasured position.
 *
 * The anchors are the map's slices: they carry `data-acp-tip` (the card text)
 * and `data-acp-tip-side` ('top' default). Delegation keeps 500 slices from
 * each owning a handler.
 */
import type { ReactElement } from 'react';
export interface HoverTipZone {
    /** Spread onto the container that holds the annotated elements. */
    zoneProps: {
        onMouseOver: (event: {
            target: EventTarget | null;
        }) => void;
        onMouseOut: (event: {
            target: EventTarget | null;
            relatedTarget: EventTarget | null;
        }) => void;
        onFocusCapture: (event: {
            target: EventTarget | null;
        }) => void;
        onBlurCapture: (event: {
            target: EventTarget | null;
            relatedTarget: EventTarget | null;
        }) => void;
        onScrollCapture: () => void;
    };
    /** Render once, anywhere in the panel tree — it portals itself to the body. */
    bubble: ReactElement | null;
}
export declare function useHoverTip(): HoverTipZone;
