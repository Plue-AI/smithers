import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import type { CardActions } from "./CardFamily"
import { billingCardFamily } from "./BillingCards"

/*
 * A grant the billing service did not record says our sentence, keeps its
 * Try again and Cancel doors, and shows the service's words only behind a
 * collapsed Details.
 */

GlobalRegistrator.register()
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

type Grant = Extract<Card, { kind: "grant-confirm" }>
const grant = (payload: Partial<Grant["payload"]>): Grant => ({
  id: "grant-1", kind: "grant-confirm", title: "Grant", status: "active", createdAt: 0, ordinal: 0,
  payload: { login: "octo", amountUsd: 5, phase: "confirm", ...payload }
})

const render = (card: Grant) => {
  const calls: string[] = []
  const actions = { onGrantConfirm: (id: string) => { calls.push(`confirm ${id}`) }, onGrantCancel: (id: string) => { calls.push(`cancel ${id}`) } } as unknown as CardActions
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(billingCardFamily["grant-confirm"].render(card, actions)))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return { host, calls }
}

test("a failed grant says our sentence; the service's words stay behind Details", () => {
  const { host, calls } = render(grant({ phase: "failed", error: "Grant failed (502 {\"error\":\"upstream\"})" }))
  const notice = host.querySelector<HTMLElement>('[data-testid="grant-failure"]')!
  expect(notice.getAttribute("role")).toBe("alert")
  expect(notice.dataset.fault).toBe("infra")
  expect(notice.dataset.failure).toBe("GrantFailed")
  expect(notice.querySelector("p")?.textContent).toBe("The billing service did not record the grant. Not your fault.")
  expect(notice.querySelector("details")?.open).toBe(false)
  expect(notice.querySelector("details pre")?.textContent).toContain("502")
  expect(notice.querySelector("p")?.textContent).not.toContain("502")
  const buttons = [...notice.querySelectorAll("button")]
  expect(buttons.map(button => button.textContent)).toEqual(["Try again", "Cancel"])
  buttons[0]!.click()
  buttons[1]!.click()
  expect(calls).toEqual(["confirm grant-1", "cancel grant-1"])
  expect(host.textContent).not.toContain("Post the grant")
})

test("a failure with no words keeps both doors and no Details", () => {
  const notice = render(grant({ phase: "failed" })).host.querySelector<HTMLElement>('[data-testid="grant-failure"]')!
  expect(notice.querySelector("details")).toBeNull()
  expect([...notice.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Try again", "Cancel"])
})

test("confirm shows Post the grant and no notice", () => {
  const { host } = render(grant({ phase: "confirm" }))
  expect(host.querySelector('[data-testid="grant-failure"]')).toBeNull()
  expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Post the grant", "Cancel"])
})
