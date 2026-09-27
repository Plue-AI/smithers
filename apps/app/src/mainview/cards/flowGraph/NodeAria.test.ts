/*
 * What the surface reads a key off.
 *
 * The DOM below is React Flow's own: a node wrapper carries the node id in
 * `data-id` and classes itself `react-flow__node`; an edge group carries the
 * EDGE id in the same attribute and classes itself `react-flow__edge`. Both
 * hold focusable content, so both can be the target of a key event, and only
 * one of them names a node.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { focusedNodeId, focusWalkedNode, graphNodeLabel, nodeButton } from "./NodeAria"

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })

const element = (html: string): Element => {
  const host = document.createElement("div")
  host.innerHTML = html
  return host.firstElementChild!
}

describe("focusedNodeId", () => {
  test("reads the node id off React Flow's own wrapper", () => {
    const wrapper = element('<div class="react-flow__node" data-id="root.flow"><span>root.flow</span></div>')
    expect(focusedNodeId(wrapper)).toBe("root.flow")
    expect(focusedNodeId(wrapper.firstElementChild)).toBe("root.flow")
  })

  test("reads it off the card inside the wrapper, where a pointer lands", () => {
    const wrapper = element(
      '<div class="react-flow__node" data-id="root.flow"><div data-node="root.flow"><b>x</b></div></div>'
    )
    expect(focusedNodeId(wrapper.querySelector("b"))).toBe("root.flow")
  })

  test("answers nothing on an edge, whose data-id is an edge id and no node", () => {
    // React Flow keys an edge group `<source>-<target>`; reading it bare
    // handed the arrows a node id no graph has.
    const edge = element(
      '<g class="react-flow__edge" data-id="root.flow-root"><text class="react-flow__edge-textwrapper">value</text></g>'
    )
    expect(focusedNodeId(edge)).toBeUndefined()
    expect(focusedNodeId(edge.querySelector("text"))).toBeUndefined()
  })

  test("an edge inside a node's subtree still answers the node, never the edge", () => {
    const wrapper = element(
      '<div class="react-flow__node" data-id="root"><g class="react-flow__edge" data-id="a-b"><i>e</i></g></div>'
    )
    expect(focusedNodeId(wrapper.querySelector("i"))).toBe("root")
  })

  test("answers nothing off the canvas, and nothing for a target that is no element", () => {
    expect(focusedNodeId(element('<div class="react-flow__pane"></div>'))).toBeUndefined()
    expect(focusedNodeId(null)).toBeUndefined()
    expect(focusedNodeId(new EventTarget())).toBeUndefined()
  })
})

describe("the node's own words", () => {
  test("a dispatching node says its action, its id and the engine's word", () => {
    expect(graphNodeLabel("gateway/graph/Steady", "root.flow.then.map.all.steady", "run"))
      .toBe("gateway/graph/Steady root.flow.then.map.all.steady run")
  })

  test("a node that dispatches nothing says the other two", () => {
    expect(graphNodeLabel(undefined, "root.flow.then.map", "run")).toBe("root.flow.then.map run")
  })

  test("a node is a button, and aria-expanded says which one is open", () => {
    expect(nodeButton(true)).toEqual({ role: "button", "aria-expanded": true })
    expect(nodeButton(false)).toEqual({ role: "button", "aria-expanded": false })
  })
})

describe("focusWalkedNode", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  const walk = (drawn: DOMRect) => {
    const canvas = element('<div><div class="react-flow__node" data-id="gate" tabindex="0"></div></div>') as HTMLElement
    document.body.append(canvas)
    canvas.getBoundingClientRect = () => rect(0, 0, 400, 300)
    const node = canvas.querySelector<HTMLElement>(".react-flow__node")!
    node.getBoundingClientRect = () => drawn
    const fits: Array<unknown> = []
    focusWalkedNode(canvas, "gate", { getZoom: () => 1, fitView: async (options) => { fits.push(options); return true } })
    const focused = document.activeElement === node
    canvas.remove()
    return { fits, focused }
  }

  test("a node wholly on the canvas is focused and the camera stays", () => {
    expect(walk(rect(10, 10, 100, 40))).toEqual({ fits: [], focused: true })
  })

  // React Flow's own focus pan counts a partly drawn node as visible.
  test("a node partly off the canvas is centred at the current zoom", () => {
    expect(walk(rect(350, 10, 100, 40))).toEqual({
      fits: [{ nodes: [{ id: "gate" }], minZoom: 1, maxZoom: 1 }],
      focused: true
    })
  })
})
