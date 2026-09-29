// @vitest-environment happy-dom
import * as Schema from "effect/Schema"
import { act, createElement } from "react"
import type { FunctionComponent } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { definePane } from "../src/ui.ts"

interface Root {
  render(node: ReturnType<typeof createElement>): void
  unmount(): void
}
// This package's typecheck has no JSX setting and no react-dom types, so the
// template page and react-dom load through specifiers tsc does not follow.
const pageModule: string = "../template/default/app/page.tsx"
const reactDomClient: string = "react-dom/client"
const { default: Page } = await import(/* @vite-ignore */ pageModule) as { default: FunctionComponent }
const { createRoot } = await import(/* @vite-ignore */ reactDomClient) as { createRoot: (node: Element) => Root }

// The page imports its pane registry when a turn starts. Route the template's
// `message` pane schema without loading its flows.
vi.mock("../template/default/routes.ui.gen.ts", () => ({
  panes: {
    message: definePane({
      props: Schema.Struct({ heading: Schema.String, body: Schema.String }),
      render: ({ heading }) => heading
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

const send = async () => {
  await act(() => root.render(createElement(Page)))
  const input = container.querySelector("input")!
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!
    setter.call(input, "hello")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Send")!
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

const expectCollapsedDetail = (raw: string) => {
  const details = container.querySelector("details")
  expect(details?.open).toBe(false)
  expect(details?.querySelector("summary")?.textContent).toBe("Details")
  expect(details?.querySelector("pre")?.textContent).toContain(raw)
  const visible = Array.from(container.querySelectorAll(".answer-error")).map((node) => node.textContent).join("\n")
  expect(visible).not.toContain(raw)
}

describe("default page failures", () => {
  test("a failed request shows one plain sentence and keeps the raw text behind Details", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("raw-network-detail"))))
    await send()
    expect(container.querySelector(".answer-error")?.textContent).toBe("The app did not answer. Try again.")
    expectCollapsedDetail("raw-network-detail")
  })

  test("a card the pane rejects shows one plain sentence and keeps the schema text behind Details", async () => {
    const frame = JSON.stringify({
      type: "card",
      card: { kind: "pane", id: "c1", name: "message", props: { heading: 7 } }
    })
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(`${frame}\n`, { status: 200 }))))
    await send()
    expect(container.querySelector(".answer-error")?.textContent).toBe("This card sent data the pane cannot show.")
    expectCollapsedDetail("heading")
  })
})
