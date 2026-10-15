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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'

const TIP_ID = 'acp-hovertip'
const GAP = 8
const VIEWPORT_MARGIN = 8

interface ActiveTip {
  anchor: Element
  label: string
  side: 'top' | 'bottom'
  rect: { left: number; top: number; width: number; bottom: number }
}

function anchorOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-acp-tip]') : null
}

function tipOf(anchor: Element): ActiveTip | null {
  const label = anchor.getAttribute('data-acp-tip')
  if (label === null || label === '') return null
  const rect = anchor.getBoundingClientRect()
  return {
    anchor,
    label,
    side: anchor.getAttribute('data-acp-tip-side') === 'bottom' ? 'bottom' : 'top',
    rect: { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom },
  }
}

export interface HoverTipZone {
  /** Spread onto the container that holds the annotated elements. */
  zoneProps: {
    onMouseOver: (event: { target: EventTarget | null }) => void
    onMouseOut: (event: { target: EventTarget | null; relatedTarget: EventTarget | null }) => void
    onFocusCapture: (event: { target: EventTarget | null }) => void
    onBlurCapture: (event: { target: EventTarget | null; relatedTarget: EventTarget | null }) => void
    onScrollCapture: () => void
  }
  /** Render once, anywhere in the panel tree — it portals itself to the body. */
  bubble: ReactElement | null
}

export function useHoverTip(): HoverTipZone {
  const [tip, setTip] = useState<ActiveTip | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const show = useCallback((anchor: Element): void => {
    setTip((current) => {
      if (current?.anchor === anchor) return current
      const next = tipOf(anchor)
      if (next === null) return null
      current?.anchor.removeAttribute('aria-describedby')
      anchor.setAttribute('aria-describedby', TIP_ID)
      return next
    })
  }, [])
  const hide = useCallback((): void => {
    setTip((current) => {
      current?.anchor.removeAttribute('aria-describedby')
      return null
    })
  }, [])

  // Moving from one slice straight onto the next never hides: the next
  // mouseover re-anchors, so the card does not blink between neighbours.
  const onMouseOver = useCallback((event: { target: EventTarget | null }): void => {
    const anchor = anchorOf(event.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onMouseOut = useCallback((event: { target: EventTarget | null; relatedTarget: EventTarget | null }): void => {
    if (anchorOf(event.target) !== null && anchorOf(event.relatedTarget) === null) hide()
  }, [hide])
  const onFocusCapture = useCallback((event: { target: EventTarget | null }): void => {
    const anchor = anchorOf(event.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onBlurCapture = useCallback((event: { target: EventTarget | null; relatedTarget: EventTarget | null }): void => {
    if (anchorOf(event.target) !== null && anchorOf(event.relatedTarget) === null) hide()
  }, [hide])

  // A resize or a scroll moves every anchor: retract rather than float detached.
  useEffect(() => {
    if (tip === null) return undefined
    const retract = (): void => { hide() }
    window.addEventListener('resize', retract)
    return () => { window.removeEventListener('resize', retract) }
  }, [tip, hide])

  useLayoutEffect(() => {
    if (tip === null) return
    const element = bubbleRef.current
    if (element === null) return
    const width = element.offsetWidth
    const height = element.offsetHeight
    const { rect } = tip
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - VIEWPORT_MARGIN),
    )
    let top = tip.side === 'top' ? rect.top - height - GAP : rect.bottom + GAP
    if (tip.side === 'top' && top < VIEWPORT_MARGIN) top = rect.bottom + GAP
    else if (tip.side === 'bottom' && top + height > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - height - GAP
    setPlaced({ left, top: Math.max(VIEWPORT_MARGIN, top) })
  }, [tip])

  return {
    zoneProps: { onMouseOver, onMouseOut, onFocusCapture, onBlurCapture, onScrollCapture: hide },
    bubble: tip === null ? null : createPortal(
      <div
        ref={bubbleRef}
        id={TIP_ID}
        role="tooltip"
        className="acp-tip"
        style={placed === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: placed.left, top: placed.top }}
      >{tip.label}</div>,
      document.body,
    ),
  }
}
