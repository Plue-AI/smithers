import { expect, test } from "../playwright/browserTest"
import { say } from "../playwright/composer"
import { scenario } from "./coverage/types"

test("C-APP-03: production coding check opens the machine image Draft", scenario("todo.missing-tool-image-draft", {
  capabilities: [],
  coverage: ["action:todo", "action:image.add", "host:local", "path:success", "door:slash", "door:button", "surface:todo", "dimension:missing-tool", "evidence:draft-seed-and-todo-api-readback"]
}), async ({ page, context }) => {
  const origin = process.env.SMITHERS_MISSING_TOOL_ORIGIN
  const n = process.env.SMITHERS_MISSING_TOOL_N
  if (!origin || !n) throw new Error("Run through TestTodoMissingToolCodingReceiptBrowser")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_MISSING_TOOL_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  await page.goto(origin!)
  await say(page, `/todo T${n}`)
  const todo = page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
  await expect(todo.getByRole("button", { name: "Add to machine image", exact: true })).toBeVisible()
  await todo.getByRole("button", { name: "Add to machine image", exact: true }).click()
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Add figlet to the machine image")
  await expect(draft.locator(".draft-seed code")).toHaveText(".smithers/machine.json")
  await expect(draft.locator(".draft-seed pre")).toHaveText('--- a/.smithers/machine.json\n+++ b/.smithers/machine.json\n@@ -1,1 +1,6 @@\n-{"packages":["jq"]}\n+{\n+  "packages": [\n+    "jq",\n+    "figlet"\n+  ]\n+}\n')
  await expect(draft.locator(".draft-seed input, .draft-seed textarea, .draft-seed [contenteditable=true]")).toHaveCount(0)
  const response = await page.request.get(`${origin}/api/todos`)
  expect(response.status()).toBe(200)
  expect(await response.json()).toHaveLength(1)
  await draft.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(page.getByRole("region", { name: "Draft", exact: true })).toHaveCount(0)
})
