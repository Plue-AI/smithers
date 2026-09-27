import type { Locator, Page } from "./browserTest"
import { controlTabKey, expect, test } from "./browserTest"

/*
 * THE FORM LAW meets the keyboard rule (apps/app/AGENTS.md). CT005 on live
 * main 64998e1a (2026-09-16): Cmd+K, `/files.read`, Enter rendered the Path
 * form, but the composer hid first, so document.activeElement fell to <body>
 * and Tab walked the shell instead of the field the human was asked for.
 * These run the real shell and flow; the typed text proves the focus, never
 * a class or a computed style.
*/

test.beforeEach(async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud", "cloud.terminal"], authFlow: "native-handoff", sandbox: null,
  } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.route("**/api/repos/smithersai/smithers/contents", route => route.fulfill({ json: [] }))
})

const README = { path: "README.md", name: "README.md", type: "file", encoding: "utf-8", content: "# Smithers\n", size: 11 }

/** Open the repository, then Ctrl+K, `/files.read`, Enter: the Path form for the selected repository. */
const askForPath = async (page: Page) => {
  await page.goto("/smithersai/smithers/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await page.keyboard.press("Control+k")
  const composer = page.getByTestId("composer-input")
  await expect(composer).toBeFocused()
  await composer.fill("/files.read")
  await composer.press("Enter")
  const form = page.locator(".flow-form[data-flow-name='files.read']")
  await expect(form).toBeVisible()
  await expect(composer).toBeHidden()
  return { composer, form, path: form.getByTestId("flow-form-path") }
}

const activeElement = (page: Page) => page.evaluate(() => {
  const active = document.activeElement
  if (active === null || active === document.body) return "body"
  return active.getAttribute("data-testid") ?? `${active.tagName.toLowerCase()}:${(active.textContent ?? "").trim().slice(0, 20)}`
})

test("T1: the slash door hands the keyboard to the missing Path field, and Tab stays in the form", async ({ page }) => {
  const { form, path } = await askForPath(page)
  await expect(path).toBeFocused()
  await page.keyboard.type("README.md")
  await expect(path).toHaveValue("README.md")
  await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
  await page.keyboard.press(controlTabKey(page))
  await expect(form.getByTestId("flow-form-cancel")).toBeFocused()
  await page.keyboard.press(controlTabKey(page))
  await expect(form.getByTestId("flow-form-submit")).toBeFocused()
  await page.reload()
  await expect(page.getByTestId("flow-form-path")).toHaveValue("README.md")
})

test("T1: a keyboard submission keeps the keyboard at the form card, never on <body>", async ({ page }) => {
  await page.route("**/api/repos/smithersai/smithers/contents/README.md*", (route) => route.fulfill({ json: README }))
  const { form, path } = await askForPath(page)
  await expect(path).toBeFocused()
  await page.keyboard.type("README.md")
  await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
  await page.keyboard.press("Enter")
  await expect(path).toBeDisabled()
  await expect(form).toBeFocused()
  expect(await activeElement(page)).not.toBe("body")
})

test("T1: a maximized form stays open while editing and reveals the submitted result", async ({ page }) => {
  await page.route("**/api/repos/smithersai/smithers/contents/README.md*", route => route.fulfill({ json: README }))
  const { form, path } = await askForPath(page)
  const card = form.locator("xpath=ancestor::section[1]")
  await card.locator('[data-testid^="card-maximize-"]').click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await path.fill("README.md")
  await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await path.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(page.getByTestId("card-file-smithersai/smithers-README.md")).toBeVisible()
})

test("T1: a restored form after reload does not take the keyboard; Cancel returns it to the next control", async ({ page }) => {
  const { path } = await askForPath(page)
  await expect(path).toBeFocused()
  await page.reload()
  const form = page.locator(".flow-form[data-flow-name='files.read']")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(form).toBeVisible()
  expect(await activeElement(page)).not.toBe("flow-form-path")
  await form.getByTestId("flow-form-cancel").focus()
  await page.keyboard.press("Enter")
  await expect(form).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeFocused()
})

/*
 * The inventory is a SUGGESTION (flows/entries/files.ts): a repository path is
 * not a closed enumeration, so the Path field is a text input from the first
 * frame to the last and the file list arrives as its datalist. The arrival is
 * read from the suggestions, never from the control's tag, because the control
 * never changes.
 */
const heldInventory = async (page: Page) => {
  let release!: () => void
  const inventory = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/repos/smithersai/smithers/contents", async route => {
    await inventory
    await route.fulfill({ json: [{ name: "README.md", path: "README.md", type: "file" }] })
  })
  return { release: () => release() }
}

const suggestion = (form: Locator): Locator => form.locator("datalist option").first()

test("T1: delayed file options keep the focused path field usable from the keyboard", async ({ page }) => {
  const held = await heldInventory(page)
  await page.route("**/api/repos/smithersai/smithers/contents/README.md*", route => route.fulfill({ json: README }))
  try {
    const { form, path } = await askForPath(page)
    await expect(path).toHaveJSProperty("tagName", "INPUT")
    await expect(path).toBeFocused()
    held.release()
    await expect(suggestion(form)).toHaveAttribute("value", "README.md")
    await expect(path).toHaveJSProperty("tagName", "INPUT")
    await expect(path).toBeFocused()
    // Nothing is filled in yet, so Tab has no Submit to reach.
    await expect(form.getByTestId("flow-form-submit")).toBeDisabled()
    await page.keyboard.type("README.md")
    await expect(path).toHaveValue("README.md")
    // The draft commits through form.set, so Submit becomes a tab stop only once the card holds it.
    await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
    await page.keyboard.press(controlTabKey(page))
    await expect(form.getByTestId("flow-form-cancel")).toBeFocused()
    await page.keyboard.press(controlTabKey(page))
    await expect(form.getByTestId("flow-form-submit")).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(form).toBeFocused()
    await expect(form.locator("xpath=ancestor::section[1]")).toHaveAttribute("data-status", "acted")
  } finally { held.release() }
})

test("T1: a path typed before the file options arrive survives them and reads that file", async ({ page }) => {
  const held = await heldInventory(page)
  await page.route("**/api/repos/smithersai/smithers/contents/README.md*", route => route.fulfill({ json: README }))
  try {
    const { form, path } = await askForPath(page)
    await expect(path).toBeFocused()
    await page.keyboard.type("REA")
    await expect(path).toHaveValue("REA")
    held.release()
    await expect(suggestion(form)).toHaveAttribute("value", "README.md")
    // The half-typed path is still on screen, in the same control, still holding the keyboard.
    await expect(path).toHaveValue("REA")
    await expect(path).toHaveJSProperty("tagName", "INPUT")
    await expect(path).toBeFocused()
    await page.keyboard.type("DME.md")
    await expect(path).toHaveValue("README.md")
    // The input buffer precedes its durable draft; Enter uses the card's readiness.
    await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("card-file-smithersai/smithers-README.md")).toBeVisible({ timeout: 15_000 })
  } finally { held.release() }
})

test("T1: delayed file options leave a newer Chat draft and its focus alone", async ({ page }) => {
  const held = await heldInventory(page)
  try {
    const { composer, form, path } = await askForPath(page)
    await expect(path).toBeFocused()
    await page.keyboard.press("Control+k")
    await composer.fill("Keep this draft while file options arrive")
    held.release()
    await expect(suggestion(form)).toHaveAttribute("value", "README.md")
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue("Keep this draft while file options arrive")
  } finally { held.release() }
})
