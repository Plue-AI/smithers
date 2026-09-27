import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { RunCommand } from "./CardFamily"
import { FlowGraphTrigger } from "./FlowGraphTrigger"
import { triggerGraph, type TriggerCardRow } from "./FlowGraphTriggerNode"

/*
 * The trigger panel (L6, D-031/D-043): what Smithers Cloud says about the
 * schedule that fires this flow — its cron in English, its next fire, and the
 * doors its slug addresses. A value the row does not carry is not shown.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"
const NEXT = Date.UTC(2026, 8, 21, 16, 0)

const plueRow = (over: Partial<TriggerCardRow> = {}): TriggerCardRow => ({
  id: "flow:nightly",
  slug: "nightly",
  flowId: "review",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  enabled: true,
  nextFireAt: NEXT,
  ...over
})

const render = (rows: ReadonlyArray<TriggerCardRow>, onRunCommand: RunCommand = () => {}): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <FlowGraphTrigger
        triggers={triggerGraph(rows, "review", []).nodes}
        repo={REPO}
        onRunCommand={onRunCommand}
      />
    )
  })
  return host
}

const texts = (host: HTMLElement, selector: string): Array<string> =>
  [...host.querySelectorAll(selector)].map((element) => element.textContent ?? "")

describe("the schedule", () => {
  test("says its cron in English with its zone, and its state word is disabled or armed", () => {
    const host = render([plueRow({ timezone: "America/New_York" })])
    expect(host.querySelector("[data-testid='trigger-schedule-flow:nightly']")?.textContent)
      .toBe("Every weekday at 09:00 America/New_York")
    expect(host.querySelector("[data-trigger='flow:nightly']")?.getAttribute("data-trigger-state")).toBe("armed")
    const off = render([plueRow({ enabled: false })])
    expect(off.querySelector("[data-trigger='flow:nightly']")?.getAttribute("data-trigger-state")).toBe("disabled")
    expect(off.querySelector("[data-trigger='flow:nightly'] .flow-trigger-word")?.textContent).toBe("disabled")
  })

  test("shows its next fire, the schedule's zone beside UTC", () => {
    const rows = texts(render([plueRow({ timezone: "America/New_York" })]), "[data-testid='trigger-fires-flow:nightly'] li")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("12:00")
    expect(rows[0]).toContain("16:00")
  })

  test("a row with no next fire shows no fire list at all", () => {
    expect(render([plueRow({ nextFireAt: undefined })]).querySelector("[data-testid='trigger-fires-flow:nightly']")).toBeNull()
  })
})

describe("the doors, and the registry each row comes from", () => {
  test("a Plue registration carries Run now and Pause, both addressed by its slug", () => {
    const raised: Array<[string, string | undefined]> = []
    const host = render([plueRow()], (name, args) => { raised.push([name, args]) })
    host.querySelector<HTMLElement>("[data-testid='trigger-run-nightly']")?.click()
    host.querySelector<HTMLElement>("[data-testid='trigger-pause-nightly']")?.click()
    expect(raised).toEqual([
      ["triggers.run", `nightly ${REPO}`],
      ["triggers.pause", JSON.stringify({ slug: "nightly", repo: REPO })]
    ])
  })

  test("a row stored with no slug has no door", () => {
    const host = render([plueRow({ slug: undefined })])
    expect(host.querySelector("[data-flow]")).toBeNull()
  })

  test("a Plue row shows the one next fire it is served, which is all Plue computes", () => {
    const rows = texts(render([plueRow()]), "[data-testid='trigger-fires-flow:nightly'] li")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.match(/16:00/g)).toHaveLength(1)
  })
})

test("no schedule fires this flow, so the panel is not there at all", () => {
  expect(render([]).textContent).toBe("")
})

test("MINIMAL TEXT: the panel is words to act on, never a sentence", () => {
  const host = render([plueRow(), plueRow({ id: "flow:sweep", slug: "sweep", enabled: false })])
  expect(host.textContent ?? "").not.toMatch(/\.(\s|$)/)
})


test("a paused graph schedule has the same Resume door", () => {
  const raised: Array<[string, string | undefined]> = []
  const host = render([plueRow({ enabled: false })], (name, args) => { raised.push([name, args]) })
  const button = host.querySelector<HTMLButtonElement>("[data-testid='trigger-resume-nightly']")!
  expect(button.tagName).toBe("BUTTON")
  button.click()
  expect(raised).toEqual([["triggers.resume", `nightly ${REPO}`]])
  expect(host.querySelector("[data-testid='trigger-pause-nightly']")).toBeNull()
  expect(host.querySelector("[data-testid='trigger-run-nightly']") === null).toBe(true)
})
