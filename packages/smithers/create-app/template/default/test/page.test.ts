// @vitest-environment happy-dom
import { definePane, type AppCard, type TurnFrame } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import Page from "../app/page.tsx"

vi.mock("../routes.ui.gen.ts", () => ({
  panes: {
    message: definePane({
      props: Schema.Struct({ heading: Schema.String, body: Schema.String }),
      render: ({ heading, body }) => createElement("div", { className: "pane" },
        createElement("h3", { className: "pane-heading" }, heading),
        createElement("p", { className: "pane-body" }, body)
      )
    })
  }
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const card = (id: string, heading: string, body: string): AppCard => ({
  kind: "pane", id, name: "message", props: { heading, body }, fullscreen: false
})

const renderFrames = async (frames: ReadonlyArray<TurnFrame>) => {
  const body = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`
  const request = vi.fn(async () => new Response(body, { status: 200 }))
  vi.stubGlobal("fetch", request)
  await act(() => root.render(createElement(Page)))

  const input = container.querySelector<HTMLInputElement>(".composer-input")
  if (input === null) throw new Error("Chat composer was not rendered")
  await act(() => {
    const setInput = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!
    setInput.call(input, "show pane")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

  const button = container.querySelector<HTMLButtonElement>(".composer-send")
  if (button === null) throw new Error("Chat send button was not rendered")
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

test("a first card.update inserts an absent pane into the chat", async () => {
  await renderFrames([{ type: "card.update", card: card("new", "Inserted", "first update inserts") }])
  expect(container.querySelectorAll(".pane-heading")).toHaveLength(1)
  expect(container.querySelector(".pane-heading")?.textContent).toBe("Inserted")
  expect(container.querySelector(".pane-body")?.textContent).toBe("first update inserts")
})

test("card.update replaces full content at the original card position", async () => {
  await renderFrames([
    { type: "card", card: card("first", "Before", "old body") },
    { type: "card", card: card("second", "Second", "untouched") },
    { type: "card.update", card: card("first", "After", "new body") }
  ])
  expect([...container.querySelectorAll(".pane-heading")].map((node) => node.textContent)).toEqual(["After", "Second"])
  expect([...container.querySelectorAll(".pane-body")].map((node) => node.textContent)).toEqual(["new body", "untouched"])
})
