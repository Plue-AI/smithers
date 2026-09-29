import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ToastStack } from "./ToastStack"
import type { Toast } from "./state/AppState"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

const RAW = "TypeError: Failed to fetch\n    at listRuns (runs.ts:259)"
const toast = (status: Toast["status"], detail: string): Toast =>
  ({ id: `toast-${status}`, key: status, title: "Loading runs…", detail, status, createdAt: 1, updatedAt: 1 })

const render = (toasts: ReadonlyArray<Toast>): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ToastStack toasts={toasts} onDismiss={() => {}} onAction={() => {}} />))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return document.body
}

test("a failed toast keeps its title in view and its caught detail behind a collapsed Details", () => {
  const notice = render([toast("failed", RAW)]).querySelector<HTMLElement>('.toast[data-toast-status="failed"]')!
  expect(notice.querySelector(".toast-title")?.textContent).toBe("Loading runs…")
  const details = notice.querySelector<HTMLDetailsElement>("details.toast-detail")!
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.textContent).toBe("Details")
  expect(details.querySelector("pre")?.textContent).toBe(RAW)
  expect(details.querySelector("pre")?.tabIndex).toBe(0)
  // Nothing outside the collapsed Details carries the raw text.
  const visible = [...notice.childNodes].map(node => node.textContent ?? "").join("").replace(details.textContent ?? "", "")
  expect(visible).not.toContain("Failed to fetch")
})

test("running, done and cancelled toasts show their detail as progress words, not behind Details", () => {
  const host = render([toast("running", "3 of 5 checked"), toast("ok", "12 runs"), toast("cancelled", "Cancelled")])
  for (const [status, detail] of [["running", "3 of 5 checked"], ["ok", "12 runs"], ["cancelled", "Cancelled"]] as const) {
    const notice = host.querySelector<HTMLElement>(`.toast[data-toast-status="${status}"]`)!
    expect(notice.querySelector("details")).toBeNull()
    expect(notice.querySelector(".toast-detail")?.textContent).toBe(detail)
  }
})

test("a toast with no detail draws neither the line nor the Details", () => {
  const host = render([toast("failed", ""), toast("ok", "")])
  expect(host.querySelector(".toast-detail")).toBeNull()
  expect(host.querySelector("details")).toBeNull()
})
