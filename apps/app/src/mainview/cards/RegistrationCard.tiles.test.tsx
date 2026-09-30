import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { Tiles } from "./RegistrationCard"

/*
 * The agent-written tile (docs/mvp/REGISTRATION.md): the traced floor, and
 * Jev's estimated range beside it when the run recorded one.
 */

GlobalRegistrator.register()
const roots: Root[] = []

afterAll(async () => {
  for (const root of roots) flushSync(() => root.unmount())
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const tile = (share: Parameters<typeof Tiles>[0]["report"]["agent-share"]): HTMLElement | null => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    const root = createRoot(host)
    roots.push(root)
    root.render(
      <Tiles
        report={{ ...(share === undefined ? {} : { "agent-share": share }), unavailable: [], sequences: [] }}
        repo="acme/widgets"
        stagger={false}
        onRunCommand={() => {}}
      />
    )
  })
  return host.querySelector("section")
}

test("the agent-written tile shows the traced floor and the estimated range", () => {
  const shown = tile({ _tag: "agent-share", commits: 50, traced: 9, markers: [], estimate: { low: 30, high: 50, sampled: 30 } })
  expect(shown?.querySelector(".registration-label")?.textContent).toBe("Agent-written")
  expect(shown?.querySelector(".registration-big")?.textContent).toBe("≥18%")
  expect(shown?.querySelector(".registration-sub")?.textContent).toBe("traced · 30–50% est.")
  const settled = tile({ _tag: "agent-share", commits: 4, traced: 4, markers: [], estimate: { low: 100, high: 100, sampled: 0 } })
  expect(settled?.querySelector(".registration-sub")?.textContent).toBe("traced · 100% est.")
})

test("without an estimate the tile shows only the traced floor, and no commits shows no tile", () => {
  const floor = tile({ _tag: "agent-share", commits: 4, traced: 1, markers: ["AGENTS.md"] })
  expect(floor?.querySelector(".registration-big")?.textContent).toBe("≥25%")
  expect(floor?.querySelector(".registration-sub")?.textContent).toBe("traced")
  expect(tile({ _tag: "agent-share", commits: 0, traced: 0, markers: [] })).toBeNull()
})
