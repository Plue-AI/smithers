import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-INS-01.md; not a qualification receipt.
// Written before implementation: mvp.md §6.1 Reaching the install, M-28; lands with T-INS-04
test("C-INS-01: All supported origins expose usable repository controls", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1 Reaching the install, M-28; lands with T-INS-04")
  // Seed the same signed-in repository on localhost, plain HTTP LAN and HTTPS.
  // Real listener, cookies, live transport and secure-context receipts remain host checks.
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await owner(page)
  await page.goto("/")
  await say(page, "where do we retry webhooks?")
  await expect(page.getByText("src/webhooks/retry.ts", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T9")
  await page.getByRole("button", { name: "Copy link", exact: true }).last().press("Enter")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "SSH", exact: true }).last().press("Enter")
  await expect(page.getByText("ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net", { exact: true }).last()).toBeVisible()
  await say(page, "/wiki.page Webhooks")
  await page.getByRole("button", { name: "Attach file", exact: true }).last().press("Enter")
  await page.getByLabel("File", { exact: true }).setInputFiles({ name: "retries.txt", mimeType: "text/plain", buffer: Buffer.from("redeliver") })
  await expect(page.getByText("retries.txt", { exact: true }).last()).toBeVisible()
  expect(errors).toEqual([])
})
