import { controlTabKey, expect, test } from "./browserTest"
import { signedOutVisitor } from "./identity"
import { fillComposer } from "./composer"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"

for (const path of ["/", "/smithersai/smithers/"]) {
  for (const modal of [false, true]) {
  for (const trigger of ["click", "shortcut", "Tab and Enter"] as const) {
    test(`sign-in toast starts OAuth by ${trigger} on ${path}${modal ? " inside a native modal" : " with Chat open"}`, async ({ page }) => {
      await signedOutVisitor(page)
      await page.route("**/api/bootstrap", route => route.fulfill({ json: {
        apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
        capabilities: ["identity", "cloud", "agent", "browser.read"], authFlow: "redirect", sandbox: null
      } }))
      await page.route("**/api/auth/github**", route => route.fulfill({ contentType: "text/html", body: "Sign-in started" }))
      await page.goto(path)
      let input = page.getByTestId("composer-input")
      // A seam that refuses for sign-in offers GitHub through the real
      // flow-failure toast, independently of embedded repository read failures.
      await page.route("**/api/tools/browser-fetch", route => route.fulfill({
        status: 403, json: { message: "Use /auth.sign-in to continue with GitHub." },
      }))
      await fillComposer(page, "/browser.open https://example.com")
      await input.press("Enter")
      const stack = page.getByLabel("Notifications", { exact: true })
      const signIn = stack.getByRole("button", { name: "Sign in", exact: true })
      await expect(signIn).toBeVisible()
      await expect(signIn).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+G Control+Shift+G")
      if (!(await input.isVisible())) await page.keyboard.press("Control+k")
      await expect(input).toBeVisible()
      if (modal) {
        await page.evaluate(() => {
          const dialog = document.createElement("dialog")
          dialog.innerHTML = '<textarea aria-label="Modal draft"></textarea>'
          document.body.append(dialog)
          dialog.showModal()
        })
        input = page.getByRole("textbox", { name: "Modal draft" })
        await expect(page.locator("dialog:modal .toast-stack")).toHaveCount(1)
      }
      if (trigger !== "click" && !(await input.isVisible())) await page.keyboard.press("Control+k")
      if (trigger === "click") await signIn.click()
      else if (trigger === "Tab and Enter") {
        await input.focus()
        for (let stop = 0; stop < 20 && !(await signIn.evaluate(button => button === document.activeElement)); stop++) {
          await page.keyboard.press(controlTabKey(page))
        }
        await expect(signIn).toBeFocused()
        await page.keyboard.press("Enter")
      }
      else {
        await input.focus()
        await input.fill("still typing g")
        await expect(signIn).toBeVisible()
        await page.keyboard.press("Control+Shift+G")
      }
      await expect(page).toHaveURL(url => url.pathname === APPLICATION_SIGN_IN_PATH)
      await expect(page.getByText("Sign-in started", { exact: true })).toBeVisible()
    })
  }
  }
}
