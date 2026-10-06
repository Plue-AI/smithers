import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-CAT-01; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md Appendix A, Appendix B; lands with T-CAT-01
test("C-CAT-01: Commands show MVP doors and hide retired commands", async ({ page }) => {
  // Required seed: complete member catalog plus repository release-notes flow;
  // unit tests separately prove CLI, tool, actor and runtime tag equality.
  await owner(page)
  await page.route("**/contents/.smithers/factory.json", route => route.fulfill({ json: {
    path: ".smithers/factory.json", encoding: "base64", content: Buffer.from(JSON.stringify({
      flows: [{ id: "release-notes", description: "Write release notes", summary: "Write release notes", featured: true,
        kind: "mdx", path: "flows/release-notes/flow.mdx", capabilities: [], model: null, modelInvocable: true }], on: []
    })).toString("base64")
  } }))
  await page.goto("/")
  await say(page, "/help")
  const commands = page.getByRole("article", { name: "Commands", exact: true }).last()
  await expect(commands).toBeVisible()
  for (const copy of ["Ask", "TODOs and the stack", "Branches and machines", "Files and code", "Review", "Issues", "Wiki", "Flows", "Runs", "GitHub", "Account and settings"]) {
    await expect(commands.getByRole("heading", { name: copy, exact: true })).toBeVisible()
  }
  await expect(commands.getByText("/monitor", { exact: true })).not.toBeVisible()
  await commands.getByText("Advanced", { exact: true }).press("Enter")
  await expect(commands.getByText("/monitor", { exact: true })).toBeVisible()
  await expect(commands.getByText("/release-notes [owner/repo] [JSON object]", { exact: true })).toBeVisible()
  for (const retired of ["/chat.clear", "/billing", "/debug", "/issue-sweep"]) {
    await expect(commands.getByText(retired, { exact: true })).toHaveCount(0)
  }
  await say(page, "/todo T8")
  await expect(page.getByTestId("card-todo:8")).toBeVisible()
})
