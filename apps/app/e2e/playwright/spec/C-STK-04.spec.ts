import { expect, test } from "../browserTest"
import { mergeOwner, say } from "./j1-fixtures"
import { fixtures as homeFixtures } from "../../../../../packages/rpc/test/fixtures/Home"
import { fixtures as todoFixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Mounted provider projection. Real polling, containment and transaction
// recovery are exercised by mythical_order_integration_test.go; HTTP role and
// stale-revision refusals by stack_attention_integration_test.go.
test("C-STK-04: out-of-order attention binds OK to the displayed revision and retains the contained TODO", async ({ page }) => {
  await mergeOwner(page)
  const sentence = "T3 merged before T2; T2's change is in T3's commit"
  let model = { ...structuredClone(homeFixtures.active.model), items: [], attention: [{
    kind: "order" as const, id: "order-3", revision: 1, text: sentence,
    actions: [{ tag: "order.ok" as const, label: "OK" }]
  }] }
  let publish = () => {}
  let cursor = 0
  const merged = { ...structuredClone(todoFixtures.merged.model), n: 2, merged_via: 3 }
  await page.route("**/api/todos/2", route => route.fulfill({ json: merged }))
  await page.route("**/api/todos", route => route.fulfill({ json: [merged] }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic === "home") {
      publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: model }))
      publish()
    } else if (frame.topic === "todo:2") socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: merged }))
    else socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
  }))
  const presses: unknown[] = []
  await page.route("**/api/stack/attention/order-3", async route => {
    const body = route.request().postDataJSON()
    presses.push(body)
    if (body.revision === 1) {
      model = { ...model, attention: [{ ...model.attention[0]!, revision: 2, text: sentence + "\nT4 merged out of order; containment of T1 is unverified" }] }
      await route.fulfill({ status: 409, json: { class: "conflict", code: "stale_attention", message: "The attention changed; review it again" } })
      publish()
    } else {
      model = { ...model, attention: [] }
      await route.fulfill({ status: 204 })
      publish()
    }
  })
  await page.goto("/smithers-mvp-canary/node")
  await expect(page.getByText(sentence, { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "OK", exact: true }).click()
  await expect.poll(() => presses).toEqual([{ revision: 1 }])
  await expect(page.getByText("T4 merged out of order; containment of T1 is unverified", { exact: false }).last()).toBeVisible()
  await page.getByRole("button", { name: "OK", exact: true }).click()
  await expect.poll(() => presses).toEqual([{ revision: 1 }, { revision: 2 }])
  await expect(page.getByRole("button", { name: "OK", exact: true })).toHaveCount(0)
  await say(page, "/todo T2")
  await expect(page.locator(".smithers-card").last()).toContainText("in T3's commit")
  await page.reload()
  await say(page, "/todo T2")
  await expect(page.locator(".smithers-card").last()).toContainText("in T3's commit")
})
