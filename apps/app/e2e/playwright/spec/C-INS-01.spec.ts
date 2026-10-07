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

for (const native of ["absent", "refused"] as const) {
  test(`C-INS-01: Chat Copy falls back with the native clipboard ${native}`, async ({ page }) => {
    test.setTimeout(180000)
    await owner(page)
    await page.addInitScript(({ native }) => {
      const copied: string[] = []
      Object.defineProperty(window, "__originCopyReceipt", { value: copied })
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: native === "absent" ? undefined : {
        writeText: async () => { throw new DOMException("Refused", "NotAllowedError") },
        write: async () => { throw new DOMException("Refused", "NotAllowedError") }
      } })
      document.execCommand = (command: string) => {
        if (command !== "copy") return false
        copied.push((document.activeElement as HTMLTextAreaElement).value)
        return true
      }
    }, { native })
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 120000 })
    await say(page, "/chat.copy-message plain HTTP message")
    await expect.poll(() => page.evaluate(() => (window as unknown as { __originCopyReceipt: string[] }).__originCopyReceipt)).toEqual(["plain HTTP message"])
    await say(page, "/chat.copy-message second message")
    await expect.poll(() => page.evaluate(() => (window as unknown as { __originCopyReceipt: string[] }).__originCopyReceipt)).toEqual(["plain HTTP message", "second message"])
  })
}
