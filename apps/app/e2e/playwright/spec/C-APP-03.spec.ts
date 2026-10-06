import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// The shared failure/slash command. Settings binds the same command in T-APP-03;
// guest rebuild and certified TODO failure ingestion need install qualification.
test("C-APP-03: a missing package drafts only the main machine recipe", async ({ page }) => {
  await owner(page)
  const failed = structuredClone(fixtures.failed.model)
  failed.n = 1
  failed.failure!.missing_tool = { name: "figlet", file: ".smithers/machine.json" }
  await page.route("**/api/todos", route => route.fulfill({ json: [failed] }))
  await page.route("**/api/todos/1", route => route.fulfill({ json: failed }))
  const reads: string[] = []
  await page.route("**/contents/.smithers/machine.json?ref=main", route => {
    reads.push(route.request().url())
    return route.fulfill({ json: { content: '{"packages":["jq"]}', encoding: "utf-8" } })
  })
  await page.goto("/")
  await say(page, "/todo T1")
  await page.getByRole("button", { name: "Add to machine image", exact: true }).last().click()
  const draft = page.locator('[data-kind="draft"]').last()
  await expect(draft.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Add figlet to machine image")
  await expect(draft.locator(".draft-seed pre")).toContainText('+    "jq",')
  await expect(draft.locator(".draft-seed pre")).toContainText('+    "figlet"')
  expect(reads).toHaveLength(1)
  expect(new URL(reads[0]!).searchParams.get("ref")).toBe("main")
  await page.reload()
  await expect(page.locator(".draft-seed pre").last()).toContainText("figlet")
  await page.getByRole("button", { name: "Discard", exact: true }).last().click()
  await expect(page.locator('[data-kind="draft"]')).toHaveCount(0)
  await say(page, '/image.add {"name":"Fig Let"}')
  await expect(page.getByText("Invalid Debian package name", { exact: true }).last()).toBeVisible()
  await expect(page.locator('[data-kind="draft"]')).toHaveCount(0)
})
