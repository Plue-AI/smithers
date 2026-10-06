import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Browser proof of the real TODO seam. Guest timing and delegated credential
// delivery are qualified separately on the reference host.
test("C-J3-05: a steer uses the TODO door and retains the same attempt", async ({ page }) => {
  test.setTimeout(120_000)
  await owner(page)
  let model = { ...fixtures.working.model, steers: [] as typeof fixtures.working.model.steers }
  const requests: unknown[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/12", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      requests.push(body)
      model = { ...model, steers: [...model.steers, { text: body.steer,
        by: { kind: "person", login: "canary-owner", name: "Ben", avatar_url: model.owner.avatar_url, color_index: 0 }, at: "2026-10-06T00:00:00Z" }] }
      await route.fulfill({ status: 202, json: { state: "accepted", attempt: 1 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/smithers-mvp-canary/node")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 60_000 })
  await say(page, "/todo T12")
  await expect(page.getByText("Attempt 1", { exact: true }).last()).toBeVisible()
  await say(page, '/todo.steer T12 use the existing retry helper')
  await expect.poll(() => requests).toEqual([{ steer: "use the existing retry helper" }])
  await say(page, "/todo T12")
  await expect(page.getByText("use the existing retry helper", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Attempt 1", { exact: true }).last()).toBeVisible()
  expect(model.run?.id).toBe("run-41")
  expect(model.branch?.id).toBe("todo-12")
})
