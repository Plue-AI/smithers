import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import run3 from "../../../e2e/fixtures/burndown/run-3.json"
import type { Card } from "../state/AppState"
import { BurndownBody } from "./BurndownCard"

/*
 * The burndown's in-place confirmation in a live DOM: focus moves to its safe
 * answer once, when it opens, and a new reading of the run never moves it.
 */

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

type RunCard = Extract<Card, { kind: "run-trace" }>

/** A running sweep's card; every call is a new payload, as a journal poll delivers. */
const card = (events: ReadonlyArray<Record<string, unknown>>): RunCard => ({
  id: "flow-run-r", kind: "run-trace", title: "issue-sweep", status: "active", createdAt: 1, ordinal: 1,
  payload: {
    repo: "smithersai/smithers", runId: "r", workflow: "issue-sweep", phase: "running", steps: [], result: null, lastSeq: 0,
    input: run3.input, events: [...events]
  } as RunCard["payload"]
})

test("a new journal reading while the confirmation is open leaves focus where the user put it", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  const draw = (subject: RunCard) => act(() => root.render(<BurndownBody card={subject} onRunCommand={() => {}} now={1790900100000} />))
  const events = run3.events as ReadonlyArray<Record<string, unknown>>
  draw(card(events.slice(0, -1)))

  act(() => host.querySelector<HTMLButtonElement>('[data-testid="burndown-stop"]')!.click())
  const confirm = host.querySelector('[data-testid="burndown-confirm"]')!
  expect(confirm.getAttribute("role")).toBe("alertdialog")
  expect(document.getElementById(confirm.getAttribute("aria-labelledby")!)?.textContent).toBe("Stop for now?")
  const [stop, notYet] = [...confirm.querySelectorAll("button")]
  expect(notYet?.textContent).toBe("Not yet")
  expect(document.activeElement).toBe(notYet!)

  // The user moves to the act; the run's next reading arrives.
  stop!.focus()
  draw(card(events))
  expect(host.querySelector('[data-testid="burndown-confirm"]')).not.toBeNull()
  expect(document.activeElement).toBe(stop!)
})
