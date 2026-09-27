/*
 * What a drawn node is, to a reader who is not looking at it.
 *
 * Both canvases draw the same box and both hand it to React Flow, which owns
 * the element a reader tabs to: it writes `aria-label` from the node's own
 * `ariaLabel` and spreads `domAttributes` last, so this is where the box's
 * role and its open state are stated (D-026: the state is a word before it is
 * a colour, and the word has to reach the accessibility tree too).
 *
 * WHY A BUTTON AND NOT AN OPTION. The canvas used to call itself a `listbox`
 * and the node card inside it an `option`, but React Flow's own wrapper
 * carries `role="application"` and sits between them, and neither its role
 * nor its position is configurable. A listbox that owns an application owns
 * no options at all, so a screen reader was told the graph was an empty list.
 * A node opens a drawer, which is what a button does, and `aria-expanded`
 * says which one is open.
 */

/** The three things a node says about itself, in the order the box shows them. */
export const graphNodeLabel = (
  /** The action or flow this node dispatches; a node that dispatches neither has none. */
  tag: string | undefined,
  id: string,
  /** The engine's own word for where the node got to. */
  word: string
): string => [...(tag === undefined ? [] : [tag]), id, word].join(" ")

/** The attributes that make one drawn node the door it is. */
export const nodeButton = (open: boolean): { readonly role: "button"; readonly "aria-expanded": boolean } => ({
  role: "button",
  "aria-expanded": open
})

/**
 * Which node the browser focus is on, from the element a key event reached.
 *
 * React Flow owns the focus target — the wrapper, which carries the node id in
 * `data-id` — and the node card inside it carries the same id in `data-node`.
 * A key pressed on a focused node therefore arrives on the WRAPPER, where
 * `closest("[data-node]")` finds nothing, because the card is a descendant
 * rather than an ancestor. Reading both is what makes Enter work from the
 * keyboard as well as from a pointer inside the card.
 *
 * `data-id` alone is NOT the node wrapper: React Flow writes the same
 * attribute on every EDGE group, keyed by the edge id (`a-b`), and an edge
 * wraps its own label, which a pointer and the focus can both reach. Read
 * bare, a key pressed there answered with an edge id — a node id no graph
 * has — and the arrows walked from nowhere. The wrapper is the one React
 * Flow classes `react-flow__node`, so that is what is asked for.
 */
export const focusedNodeId = (target: EventTarget | null): string | undefined => {
  if (!(target instanceof Element)) return undefined
  const found = target.closest("[data-node], .react-flow__node[data-id]")
  return found?.getAttribute("data-node") ?? found?.getAttribute("data-id") ?? undefined
}

/** The part of React Flow's instance that moves the camera. */
export interface GraphCamera {
  readonly getZoom: () => number
  readonly fitView: (options: { readonly nodes: Array<{ readonly id: string }>; readonly minZoom: number; readonly maxZoom: number }) => Promise<boolean>
}

/**
 * Focus the node an arrow key walked to and show all of it.
 *
 * React Flow's own focus pan skips a node that is only partly on screen
 * (`getNodesInside(..., partially: true)`), so a walked-to node at the canvas
 * edge stayed clipped. A node not wholly inside the canvas is centred at the
 * current zoom.
 */
export const focusWalkedNode = (canvas: HTMLElement, nodeId: string, camera: GraphCamera | undefined): void => {
  const wrapper = [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")]
    .find((element) => element.dataset.id === nodeId)
  if (wrapper === undefined) return
  wrapper.focus({ preventScroll: true })
  const frame = canvas.getBoundingClientRect()
  const drawn = wrapper.getBoundingClientRect()
  const framed = drawn.top >= frame.top && drawn.bottom <= frame.bottom &&
    drawn.left >= frame.left && drawn.right <= frame.right
  if (framed || camera === undefined) return
  const zoom = camera.getZoom()
  void camera.fitView({ nodes: [{ id: nodeId }], minZoom: zoom, maxZoom: zoom })
}
