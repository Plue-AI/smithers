import { controlTabKey, expect, test } from "./browserTest"
import { identityRoute, signedOutVisitor } from "./identity"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"
import { fillComposer } from "./composer"

test("hosted signed-out root keeps its two doors in the transcript", async ({ page }) => {
  await signedOutVisitor(page)
  let reads = 0
  await page.route("**/api/install", route => { reads++; return route.fulfill({ status: 401, json: { message: "authentication required" } }) })
  await page.goto("/")
  const login = page.getByTestId("login")
  const github = login.getByRole("button", { name: "Continue with GitHub", exact: true })
  const email = login.getByRole("textbox", { name: "Email address", exact: true })
  await expect(github).toBeVisible()
  await expect(email).toBeVisible()
  await expect(page.getByTestId("transcript").getByTestId("login")).toBeVisible()
  expect(reads).toBe(0)
  await github.focus()
  await page.keyboard.press(controlTabKey(page))
  await expect(email).toBeFocused()
  await email.fill("person@example.com")
  await page.keyboard.press(controlTabKey(page))
  await expect(login.getByRole("button", { name: "Continue", exact: true })).toBeFocused()
  await fillComposer(page, "a draft while signed out")
  await expect(page.getByTestId("composer-input")).toHaveValue("a draft while signed out")
  expect(reads).toBe(0)
})

test("an explicit repository sign-in prompt keeps return_to", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.goto("/smithersai/smithers/")
  await fillComposer(page, "/auth.prompt")
  await page.getByTestId("composer-input").press("Enter")
  await page.getByTestId("composer-input").press("Escape")
  const door = page.getByRole("button", { name: "Sign in with GitHub", exact: true }).last()
  await expect(door).toBeVisible()
  await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
  const request = page.waitForRequest(request => new URL(request.url()).pathname === APPLICATION_SIGN_IN_PATH)
  await door.press("Enter")
  expect(new URL((await request).url()).searchParams.get("return_to")).toBe("/smithersai/smithers/")
})

test("signed-out install paints its sign-in action without reading protected setup", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["identity", "install"], authFlow: "redirect", sandbox: null } }))
  await page.route("**/api/auth/session", identityRoute(null))
  let reads = 0
  await page.route("**/api/install", route => { reads++; return route.fulfill({ status: 401, json: { message: "authentication required" } }) })
  await page.goto("/")
  await expect(page.getByTestId("transcript").getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
  expect(reads).toBe(0)
  await fillComposer(page, "a draft while setup is protected")
  await expect(page.getByTestId("composer-input")).toHaveValue("a draft while setup is protected")
  expect(reads).toBe(0)
})
