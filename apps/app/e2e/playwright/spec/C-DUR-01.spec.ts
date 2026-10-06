import { expect, test } from "../browserTest"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { recoveryFixture } from "./github-recovery-fixture"

// Production REST/live card projection; worker/database kills require the
// reference-host suite and are not qualified by a browser reload.
test("C-DUR-01: recovered host retains its question and completed evidence", async ({ page }) => {
  const model: TodoCard = { ...structuredClone(fixtures.needs_you.model), n: 1 }
  model.steps.unshift({ id: "plan", label: "Plan", detail: "Read 3 files", state: "done" })
  model.waits[0]!.actions[0]!.args = { n: "1", wait: "wait-question-1" }
  const fixture = await recoveryFixture(page, model)
  await fixture.open()
  await expect(fixture.card()).toContainText("Include S3 fields?")
  await fixture.reload()
  await expect(fixture.card()).toContainText("Include S3 fields?")
  await expect(fixture.card().getByText("Read 3 files", { exact: true })).toHaveCount(1)
  expect(fixture.writes).toEqual([])
  await fixture.card().getByRole("textbox", { name: "Answer", exact: true }).fill("Include S3 fields")
  await fixture.card().getByRole("button", { name: "Answer", exact: true }).press("Enter")
  await expect.poll(() => fixture.writes.length).toBe(1)
  expect(fixture.writes[0]!.body).toEqual({ wait: "wait-question-1", answer: "Include S3 fields" })
  expect(fixture.writes[0]!.key).toBeTruthy()
})
