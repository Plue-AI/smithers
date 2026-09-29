import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatMeter, chatMeterOf } from "./ChatMeter"
import type { ChatUsage } from "./state/AppState"

const usage: ChatUsage = { branchId: "b", input: 20_000, output: 900, cached: 18_800, context: 10_112, modelId: "gpt-4o" }
const render = (value: ChatUsage | undefined, branchId = "b") => renderToStaticMarkup(<ChatMeter usage={value} branchId={branchId} />)

describe("ChatMeter", () => {
  test("renders the window share and cache hit rate, with the levels in words for a screen reader", () => {
    const html = render(usage)
    expect(html.replace(/<[^>]+>/g, "")).toBe("7.9%/128k · cache 94%")
    expect(html).toContain('aria-label="20k tokens in, 900 out, 7.9% of 128k window, cache 94%"')
    expect(html).toContain('role="img"')
  })

  test("omits the window for a model the catalog does not know", () => {
    expect(render({ ...usage, modelId: undefined }).replace(/<[^>]+>/g, "")).toBe("cache 94%")
    expect(render({ ...usage, modelId: "house-model" }).replace(/<[^>]+>/g, "")).toBe("cache 94%")
  })

  test("renders nothing without usage, for another conversation, or with no part to show", () => {
    expect(render(undefined)).toBe("")
    expect(render(usage, "other")).toBe("")
    expect(chatMeterOf(usage, "other")).toBeUndefined()
    expect(render({ ...usage, modelId: undefined, cached: undefined })).toBe("")
  })

  test("marks a nearly full window as danger and a cold cache as a warning", () => {
    const html = render({ ...usage, context: 120_000, cached: 1_000 })
    expect(html).toContain('data-level="danger"')
    expect(html).toContain('data-level="warning"')
  })
})
