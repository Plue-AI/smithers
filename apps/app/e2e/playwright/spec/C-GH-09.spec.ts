import { expect, test } from "../browserTest"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { recoveryFixture } from "./github-recovery-fixture"

// UI projection only. Exactly-once writes and host restart require the
// PostgreSQL/githubfake process-kill receipt separately.
test("C-GH-09: uncertain PR creation and Drop recover without a duplicate PR card", async ({ page }) => {
  const model: TodoCard = { ...structuredClone(fixtures.working.model), n: 1 }
  const fixture = await recoveryFixture(page, model)
  await fixture.open()
  await expect(fixture.card()).toContainText("Working")
  await expect(fixture.card().getByRole("link", { name: /#\d+ on GitHub/ })).toHaveCount(0)
  await fixture.card().getByRole("button", { name: "Drop", exact: true }).press("Enter")
  const confirm = page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).last()
  await expect(confirm).toBeVisible()
  expect(fixture.writes).toEqual([])
  await confirm.press("Enter")
  await expect.poll(() => fixture.writes.length).toBe(1)
  expect(fixture.writes[0]!.body).toEqual({ op: "drop" })
  expect(fixture.writes[0]!.key).toBeTruthy()
  // A launch acknowledgment does not manufacture the terminal state.
  await expect(fixture.card()).toContainText("Working")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  model.state = "dropped"
  await fixture.publish()
  await expect(fixture.card()).toContainText("Dropped")
  await fixture.reload()
  await expect(fixture.card()).toContainText("Dropped")
  // The server reconciles a late-created PR after Drop. Its retained link
  // must update the same card without making merge available.
  model.pr = { number: 214, url: "https://github.com/acme/app/pull/214", head: "8b1e204", draft: false, included_items: [1] }
  await fixture.publish()
  const link = () => fixture.card().getByRole("link", { name: "#214 on GitHub", exact: true })
  await expect(link()).toHaveCount(1)
  await fixture.reload()
  await expect(link()).toHaveCount(1)
  await expect(fixture.card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  expect(fixture.writes).toHaveLength(1)
})
