import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { ISSUE_REPO, issueTodoInstall } from "./issue-todo-fixture"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Literal oracle: do not derive expected bytes from the production helper.
const recipeDiff = '--- a/.smithers/machine.json\n+++ b/.smithers/machine.json\n@@ -1,1 +1,6 @@\n-{"packages":["jq"]}\n+{\n+  "packages": [\n+    "jq",\n+    "figlet"\n+  ]\n+}\n'

// The shared failure/slash command. Settings binds the same command in T-APP-03;
// guest rebuild and certified TODO failure ingestion need install qualification.
for (const installed of [false, true]) test(`C-APP-03: a missing package drafts only the main machine recipe (${installed ? "install" : "seed fallback"})`, async ({ page }) => {
  if (installed) await issueTodoInstall(page)
  else await owner(page)
  const failed: TodoCard = structuredClone(fixtures.failed.model)
  failed.n = 1
  failed.failure!.missing_tool = { name: "figlet", file: ".smithers/machine.json" }
  await page.route("**/api/todos", route => route.fulfill({ json: [failed] }))
  await page.route("**/api/todos/1", route => route.fulfill({ json: failed }))
  const reads: string[] = []
  await page.route("**/contents/.smithers/machine.json?ref=main", route => {
    reads.push(route.request().url())
    return route.fulfill({ json: { content: '{"packages":["jq"]}', encoding: "utf-8" } })
  })
  await page.goto(installed ? `/${ISSUE_REPO}` : "/")
  await say(page, "/todo T1")
  await page.getByRole("button", { name: "Add to machine image", exact: true }).last().click()
  const draft = page.locator('[data-kind="draft"]').last()
  await expect(draft.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Add figlet to the machine image")
  await expect(draft.locator(".draft-seed pre")).toHaveText(recipeDiff, { useInnerText: false })
  expect(await draft.locator(".draft-seed pre").textContent()).toBe(recipeDiff)
  await expect(draft.locator(".draft-seed code")).toHaveText(".smithers/machine.json")
  await expect(draft.locator(".draft-seed input, .draft-seed textarea, .draft-seed [contenteditable=true]")).toHaveCount(0)
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

test("C-APP-03: the install image Draft stays private to its browser", async ({ page, browser }) => {
  await issueTodoInstall(page)
  await page.route("**/contents/.smithers/machine.json?ref=main", route => route.fulfill({ json: { content: '{"packages":["jq"]}', encoding: "utf-8" } }))
  await page.goto(`/${ISSUE_REPO}`)
  await say(page, '/image.add {"name":"figlet"}')
  const benDraft = page.getByRole("region", { name: "Draft", exact: true })
  await expect(benDraft.locator(".draft-seed pre")).toHaveText(recipeDiff)
  await expect(benDraft).toContainText("Only you")

  const mayaContext = await browser.newContext()
  try {
    const maya = await mayaContext.newPage()
    await issueTodoInstall(maya)
    await maya.route("**/api/user", route => route.fulfill({ json: { id: 2, username: "maya", is_admin: false } }))
    let reads = 0
    await maya.route("**/contents/.smithers/machine.json?ref=main", route => {
      reads++
      return route.fulfill({ json: { content: '{"packages":["jq"]}', encoding: "utf-8" } })
    })
    await maya.goto(new URL(`/${ISSUE_REPO}`, page.url()).href)
    await expect(maya.getByTestId("composer-input")).toBeEditable()
    await expect(maya.getByRole("region", { name: "Draft", exact: true })).toHaveCount(0)
    await say(maya, "/settings")
    const form = maya.getByTestId("card-settings").locator('form[data-flow="image.add"]')
    await form.getByLabel("Package", { exact: true }).fill("Fig Let")
    await form.getByRole("button", { name: "Add to machine image", exact: true }).press("Enter")
    await expect(form.getByRole("alert")).toHaveText("Invalid Debian package name")
    await expect(form.getByLabel("Package", { exact: true })).toHaveValue("Fig Let")
    await expect(maya.getByRole("region", { name: "Draft", exact: true })).toHaveCount(0)
    expect(reads).toBe(0)
    await form.getByLabel("Package", { exact: true }).fill("figlet")
    await form.getByRole("button", { name: "Add to machine image", exact: true }).press("Enter")
    const mayaDraft = maya.getByRole("region", { name: "Draft", exact: true })
    await expect(mayaDraft.getByLabel("Title", { exact: true })).toHaveValue("Add figlet to the machine image")
    await expect(mayaDraft.locator(".draft-seed pre")).toHaveText(recipeDiff)
    expect(reads).toBe(1)
    await mayaDraft.getByRole("button", { name: "Discard", exact: true }).press("Enter")
    await expect(mayaDraft).toHaveCount(0)
    await expect(benDraft.locator(".draft-seed pre")).toHaveText(recipeDiff)
    await page.reload()
    await expect(benDraft.locator(".draft-seed pre")).toHaveText(recipeDiff)
  } finally {
    await mayaContext.close()
  }
})
