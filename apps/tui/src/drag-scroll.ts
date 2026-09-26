/**
 * Keeps a selection drag scrolling its scroll box after the pointer leaves it.
 *
 * opentui autoscrolls a `<scrollbox>` only from drag events it receives, and
 * the renderer sends each drag to the renderable under the pointer. Dragging
 * a transcript selection onto the tab row above or the composer below hits a
 * renderable outside the scroll box, so it never scrolled. Mounted on the root
 * box, these handlers see every bubbled drag and forward it to the scroll box
 * the press started in.
 */
import { type MouseEvent, type Renderable, ScrollBoxRenderable } from "@opentui/core"

const scrollBoxOf = (target: Renderable | null): ScrollBoxRenderable | undefined => {
  for (let node: Renderable | null = target; node !== null; node = node.parent) {
    if (node instanceof ScrollBoxRenderable) return node
  }
  return undefined
}

export interface DragScroll {
  readonly onMouseDown: (event: MouseEvent) => void
  readonly onMouseDrag: (event: MouseEvent) => void
  readonly onMouseUp: (event: MouseEvent) => void
}

/** `selecting` reports whether the renderer is extending a selection. */
export const make = (selecting: () => boolean): DragScroll => {
  let owner: ScrollBoxRenderable | undefined
  return {
    onMouseDown: (event) => {
      owner = scrollBoxOf(event.target)
    },
    onMouseDrag: (event) => {
      if (owner === undefined || owner.isDestroyed || !selecting()) return
      owner.updateAutoScroll(event.x, event.y)
    },
    onMouseUp: () => {
      if (owner !== undefined && !owner.isDestroyed) owner.stopAutoScroll()
      owner = undefined
    }
  }
}
