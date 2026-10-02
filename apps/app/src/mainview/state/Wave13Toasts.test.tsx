/*
 * Wave 13 B-6 — a correction never renders as an error state.
 *
 * The launch-morning sweep watched a correction ("No — I meant the other
 * repo") and found one `[role="alert"]` on screen: not an error at all, but
 * the "Your repositories are ready to choose" toast, rendered by the shared
 * Alert component whose hardcoded role="alert" is an assertive ERROR
 * landmark. A calm notification is a status, not an alert — only a failed
 * toast may claim the alert role. Pinned here at the render boundary.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { ComponentProps } from "react"
import { ToastStack } from "../ToastStack"
import type { Toast } from "./AppState"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const toast = (id: string, status: Toast["status"]): Toast => ({
  id,
  key: id,
  title: "Your repositories are ready to choose",
  detail: "",
  status,
  createdAt: 1,
  updatedAt: 1
})

const renderToasts = (toasts: ReadonlyArray<Toast>, onDismiss = (_id: string) => {}, options: Partial<ComponentProps<typeof ToastStack>> = {}): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ToastStack toasts={toasts} onDismiss={onDismiss} onAction={() => {}} {...options} />))
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return document.body
}

describe("wave 13 B-6 — a notification is a status, never an alert", () => {
  test("worker buttons route their source and hide controls absent from this host", () => {
    const actions: NonNullable<Toast["action"]>[] = [], dismissed: string[] = []
    const host = renderToasts([{ ...toast("worker", "running"), sourceCard: "card-run" }], id => dismissed.push(id), {
      cards: [{ id: "card-run", kind: "run-trace", title: "Review", status: "active", ordinal: 1, createdAt: 1,
        payload: { repo: "owner/repo", runId: "run-1", workflow: "review", phase: "running", steps: [], result: null, lastSeq: 0 } }],
      // This host lacks Stop: its button is hidden while Steer still routes its source.
      available: action => action.flow !== "flow.run.stop",
      onAction: action => actions.push(action)
    })
    expect(host.querySelector('[data-flow="flow.run.stop"]')).toBeNull()
    // The worker's line is its subagent card's: the turning glyph, the title, the clock.
    expect(host.querySelector(".toast-icon")?.textContent).toMatch(/^[◐◓◑◒]$/)
    expect(host.querySelector(".toast-title")?.textContent).toMatch(/^Review · \d+[smh]/)
    const steer = host.querySelector<HTMLButtonElement>('[data-flow="runs.steer"]')!
    expect(steer.getAttribute("data-flow-args")).toBe("sourceCard=card-run run-1")
    steer.click()
    expect(actions).toEqual([{ label: "Steer", flow: "runs.steer", args: "sourceCard=card-run run-1" }])
    expect(dismissed).toEqual([])
  })

  test("running, ok and cancelled toasts render role=status — no alert surface", () => {
    const host = renderToasts([toast("t1", "running"), toast("t2", "ok"), toast("t3", "cancelled")])
    expect(host.querySelectorAll("[role=\"alert\"]").length).toBe(0)
    expect(host.querySelectorAll(".toast[role=\"status\"]").length).toBe(3)
  })

  test("only a FAILED toast is an alert", () => {
    const host = renderToasts([toast("t1", "ok"), toast("t2", "failed")])
    expect(host.querySelectorAll(".toast[role=\"status\"]").length).toBe(1)
    expect(host.querySelectorAll(".toast[role=\"alert\"]").length).toBe(1)
  })

  test("every status has an icon and only failures offer dismissal", () => {
    const dismissed: string[] = []
    const host = renderToasts([toast("t1", "running"), toast("t2", "ok"), toast("t3", "failed")], id => dismissed.push(id))
    expect(host.querySelector('[aria-label="Working"]')).not.toBeNull()
    expect(host.querySelectorAll('.toast-icon').length).toBe(3)
    const buttons = host.querySelectorAll<HTMLButtonElement>('[data-flow="toast.dismiss"]')
    expect(buttons.length).toBe(1)
    expect(buttons[0]!.closest('.toast')?.getAttribute('data-toast-status')).toBe('failed')
    buttons[0]!.click()
    expect(dismissed).toEqual(["t3"])
  })
  test("opening details keeps a running toast visible", () => {
    const dismissed: string[] = []
    const host = renderToasts([{ ...toast("desktop", "running"), action: { flow: "box.view", args: "ws-1", label: "Open details" } }], id => dismissed.push(id))
    host.querySelector<HTMLButtonElement>('[data-flow="box.view"]')!.click()
    expect(dismissed).toEqual([])
  })

})
