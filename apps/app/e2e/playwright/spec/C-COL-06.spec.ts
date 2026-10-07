import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection only: C-COL-06 is an integration check, not a browser receipt.
// Byte-exact Go/Rust codecs, HMAC vectors, protocol constants, exit 78 and UID
// refusal must be qualified by //:machinedWire against ADR 0004's corpus.
// Activation requires a real daemon-backed File seed and a refused connection
// seed; a mocked Saved label cannot prove wire compatibility.
// Written before implementation: spec.md §9.1, ADR 0004, mvp.md §6.8; lands with T-COL-03r
test("C-COL-06: admitted machine edits become saved file bytes", async ({ page }) => {
  test.fixme(true, "Written before implementation: spec.md §9.1, ADR 0004, mvp.md §6.8; lands with T-COL-03r")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await editor.press("Control+End")
  await editor.pressSequentially("\n// Ben keeps retries bounded")
  await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/file src/webhooks/retry.ts")
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
})

// Written before implementation: spec.md §9.1, ADR 0004, mvp.md §6.8; lands with T-COL-03r
test("C-COL-06: a refused machine connection never claims a save", async ({ page }) => {
  test.fixme(true, "Written before implementation: spec.md §9.1, ADR 0004, mvp.md §6.8; lands with T-COL-03r")
  await owner(page)
  await page.goto("/")
  // Seed a refused daemon connection with the captured file still readable.
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(page.getByText("Saved to the machine", { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/file src/webhooks/retry.ts")
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(page.getByText("Saved to the machine", { exact: true })).toHaveCount(0)
})
