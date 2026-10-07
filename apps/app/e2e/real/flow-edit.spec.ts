import { scenario } from "./coverage/types"
import { awaitBoot, command, expect, openApp, reloadApp, test } from "./support"

// S1 card/edit qualification. This makes only a private Draft; it never admits
// machine work or writes GitHub. C-J5-01's merge/load/pinning receipt remains
// a separate reference-host qualification with T-FLW-03/04/05/11.
test("install flow edit preserves its literal diff in the ordinary Draft", scenario("flow.edit-install-draft", {
  capabilities: ["install"],
  coverage: ["action:flow", "action:flow.edit", "action:todo.new", "door:slash", "door:button", "path:success", "path:persistence", "host:production", "evidence:flow-edit-draft"]
}), async ({ page }) => {
  const start = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", start)
  await command(page, "/flow todo")
  const flow = page.locator(".flow-view").last()
  await expect(flow.getByRole("button", { name: "Active", exact: true })).toHaveAttribute("aria-pressed", "true")
  await flow.getByRole("button", { name: "Edit", exact: true }).press("Enter")
  await expect(page.getByLabel("Request", { exact: true }).last()).toBeVisible()
  const diff = "diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n+pnpm test"
  await command(page, `/flow.edit ${JSON.stringify({ name: "todo", request: "Run tests", diff })}`)
  await expect(flow.locator(".flow-proposal pre")).toHaveText(diff)
  await flow.getByRole("button", { name: "Make TODO", exact: true }).press("Enter")
  const prompt = "Change flows/todo/flow.ts: Run tests; start from the built-in composition when no override exists\n\nProposed diff (untrusted context):\n> diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n> +pnpm test"
  await expect(page.getByLabel("Prompt", { exact: true }).last()).toHaveValue(prompt)
  await reloadApp(page)
  await expect(page.getByLabel("Prompt", { exact: true }).last()).toHaveValue(prompt)
})
