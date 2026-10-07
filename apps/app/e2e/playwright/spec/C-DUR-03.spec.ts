import { expect, test } from "../browserTest"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { recoveryFixture } from "./github-recovery-fixture"

// UI projection through the install REST/live provider. Reload is browser
// recovery, not a substitute for production-worker SIGKILL or microVM evidence.
test("C-DUR-03: recovered foreign push stays visible and late Drop stays terminal", async ({ page }) => {
  const model: TodoCard = { ...structuredClone(fixtures.foreign_push.model), n: 1 }
  const fixture = await recoveryFixture(page, model)
  await fixture.open()
  await expect(fixture.card()).toContainText("Review the pushed commit")
  await expect(fixture.card().getByRole("button", { name: "Discard", exact: true })).toBeVisible()
  await fixture.reload()
  await expect(fixture.card()).toContainText("Review the pushed commit")
  await expect(fixture.card().getByRole("button", { name: "Discard", exact: true })).toBeVisible()
  expect(fixture.writes).toEqual([])
  await fixture.card().getByRole("button", { name: "Drop", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).last().press("Enter")
  await expect.poll(() => fixture.writes.length).toBe(1)
  expect(fixture.writes[0]!.body).toEqual({ op: "drop" })
  expect(fixture.writes[0]!.key).toBeTruthy()
  model.state = "dropped"
  model.waits = []
  model.pr = { number: 214, url: "https://github.com/acme/app/pull/214", head: "8b1e204", draft: false, included_items: [1] }
  await fixture.publish()
  await expect(fixture.card()).toContainText("Dropped")
  await fixture.reload()
  await expect(fixture.card()).toContainText("Dropped")
  await expect(fixture.card().getByRole("link", { name: "#214 on GitHub", exact: true })).toHaveCount(1)
  await expect(fixture.card().getByRole("button", { name: "Discard", exact: true })).toHaveCount(0)
  await expect(fixture.card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  expect(fixture.writes).toHaveLength(1)
})
