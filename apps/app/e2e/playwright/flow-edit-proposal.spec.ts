import { expect, test } from "./browserTest"
import { owner } from "./spec/j1-fixtures"
import { fillComposer } from "./composer"

test("flow edit shows the literal diff before Make TODO drafts its context", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 45_000 })
  const diff = "diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n+pnpm test"
  await fillComposer(page, `/flow.edit ${JSON.stringify({ name: "todo", request: "Run tests\nKeep  whitespace", diff })}`)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.locator(".flow-proposal pre").last()).toHaveText(diff, { timeout: 30_000 })
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Make TODO", exact: true }).last().press("Enter")
  await expect(page.getByRole("textbox", { name: "Title", exact: true }).last()).toHaveValue("Change the TODO flow: Run tests")
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true }).last()).toHaveValue("Change flows/todo/flow.ts: Run tests\nKeep  whitespace; start from the built-in composition when no override exists\n\nProposed diff (untrusted context):\n> diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n> +pnpm test")
})
