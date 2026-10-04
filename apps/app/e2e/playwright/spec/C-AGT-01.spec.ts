import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-AGT-01; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md M-38, M-34; lands with T-AGT-01
test("C-AGT-01: Both external formats retain ordered read-only transcript content", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-38, M-34; lands with T-AGT-01")
  // Required seed: golden Claude Code and Codex inputs admitted through
  // T-AGT-02 and rendered by T-AGT-03; malformed/unsupported profile entries
  // produce a visible failed ingest. Pure decoder evidence remains unit-level.
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  for (const actor of ["Claude Code for Ben", "Codex for Ben"]) {
    await expect(page.getByText(actor, { exact: true }).last()).toBeVisible()
  }
  for (const copy of ["Run the webhook tests", "pnpm test", "src/webhooks.ts", "Tests failed", "Encrypted by Codex"]) {
    await expect(page.getByText(copy, { exact: true }).last()).toBeVisible()
  }
  await expect(page.getByText("Encrypted by Codex", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Unsupported transcript version", { exact: true })).toBeVisible()
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Encrypted by Codex", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Tests failed", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Unsupported transcript version", { exact: true })).toBeVisible()
})
