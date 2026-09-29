import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import type { UserFailure } from "@smthrs/rpc/UserFailure"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { FailureNotice, type FailureNoticeProps } from "./FailureNotice"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

const failure = (overrides: Partial<UserFailure> = {}): UserFailure => ({
  tag: "StackActFailed",
  fault: "infra",
  sentence: "Smithers could not create this history.",
  actions: ["retry"],
  detail: "Error: 503 service_unavailable\n    at post (StackSeam.ts:12)",
  ...overrides
})

const render = (props: FailureNoticeProps) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<FailureNotice {...props} />))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return host
}

test("shows the sentence and keeps the raw detail behind a collapsed Details", () => {
  const host = render({ failure: failure() })
  const notice = host.querySelector<HTMLElement>('[role="alert"]')!
  expect(notice.dataset.fault).toBe("infra")
  expect(notice.dataset.failure).toBe("StackActFailed")
  expect(notice.querySelector("p")?.textContent).toBe("Smithers could not create this history.")
  const details = notice.querySelector("details")!
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.textContent).toBe("Details")
  expect(details.querySelector("pre")?.textContent).toContain("503 service_unavailable")
  expect(notice.querySelector("p")?.textContent).not.toContain("503")
})

test("an unknown failure carries no tag attribute", () => {
  const notice = render({ failure: failure({ tag: null }) }).querySelector<HTMLElement>('[role="alert"]')!
  expect(notice.dataset.failure).toBeUndefined()
})

test("omits Details when there is nothing beyond the sentence", () => {
  expect(render({ failure: failure({ detail: "" }) }).querySelector("details")).toBeNull()
  expect(render({ failure: failure({ detail: "Smithers could not create this history." }) }).querySelector("details")).toBeNull()
})

test("renders a keyboard-operable button for each wired action, in the failure's order", () => {
  const pressed: string[] = []
  const host = render({
    failure: failure({ actions: ["sign-in", "retry", "use-here"] }),
    actions: {
      retry: { onClick: () => { pressed.push("retry") }, "data-flow": "history.show", "data-flow-args": "acme/app" },
      "sign-in": { onClick: () => { pressed.push("sign-in") } },
      "use-here": { onClick: () => {}, label: "Move here" }
    }
  })
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
  expect(buttons.map(button => button.textContent)).toEqual(["Sign in", "Retry", "Move here"])
  expect(buttons.every(button => button.type === "button")).toBe(true)
  expect(buttons[1]!.dataset.flow).toBe("history.show")
  expect(buttons[1]!.dataset.flowArgs).toBe("acme/app")
  buttons[1]!.focus()
  expect(document.activeElement).toBe(buttons[1]!)
  buttons[1]!.click()
  buttons[0]!.click()
  expect(pressed).toEqual(["retry", "sign-in"])
})

test("an action the failure does not offer never renders, even when wired", () => {
  const host = render({ failure: failure({ actions: [] }), actions: { retry: { onClick: () => {} } } })
  expect(host.querySelector("button")).toBeNull()
})

test("a status notice uses the status role and keeps surface children after the actions", () => {
  const host = render({ failure: failure(), role: "status", children: <a href="#upgrade">Upgrade</a> })
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('[role="status"] a')?.textContent).toBe("Upgrade")
})
