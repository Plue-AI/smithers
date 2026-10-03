import { expect, test } from "./browserTest"
import type { Todo } from "@smthrs/rpc/Todo"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"

// T-STK-01's read door consumes the REST resource, not the richer card model.
test("the TODO command reads its REST resource and keeps Chat usable", async ({ page }) => {
  await installCloudFixture(page)
  const todo: Todo = {
    n: 12, title: "Add the footer link", state: "queued", amendments: 0, lessons: 0,
    branch: { id: "b12", name: "smithers/add-the-footer-link" }, created_by: { kind: "person", id: 1 },
    seq: 1, created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z"
  }
  let reads = 0
  await page.route(url => url.pathname === "/api/todos/12", async route => {
    reads++
    await route.fulfill({ json: todo })
  })
  await page.goto("/")
  await expect(page.getByTestId("setup-checklist")).toBeVisible()
  await fillComposer(page, "/todo T12")
  await page.getByTestId("composer-send").click()
  await expect.poll(() => reads).toBe(1)
  await expect(page.getByRole("region", { name: "T12", exact: true })).toBeVisible()
  await fillComposer(page, "Chat remains usable")
  await expect(page.getByTestId("composer-input")).toContainText("Chat remains usable")
})
