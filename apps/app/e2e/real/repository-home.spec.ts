import { RepositoryHomeSchema } from "@smthrs/rpc/RepositoryHome"
import { scenario } from "./coverage/types"
import { awaitBoot, expect, realApi, reloadApp, test } from "./support/test"

test("the public repository homepage serves its declared apps before and after reload", scenario("repository-home.public-apps-readback", {
  capabilities: ["identity", "cloud"],
  description: "Read the public repository's actual homepage declaration and response, then verify its app tiles and prompt at 320px and after reload. Open the issue tile with Enter and verify sign-in is required without launching work. This canary fails when the deployed backend cannot serve the declared blocks.",
  coverage: ["action:issue.implement", "action:auth.prompt", "host:production", "path:success", "path:permission", "path:persistence", "path:keyboard", "door:button", "surface:repository-home", "dimension:keyboard", "dimension:narrow-viewport", "dimension:reload", "dimension:signed-out", "evidence:homepage-declaration-and-browser-readback"]
}), async ({ page, request }, testInfo) => {
  const repo = "smithersai/smithers"
  const path = `/api/repos/${repo}/home`
  const launches: string[] = []
  page.on("request", entry => {
    if (entry.method() === "POST" && new URL(entry.url()).pathname.startsWith("/api/workflow/")) launches.push(new URL(entry.url()).pathname)
  })
  await page.setViewportSize({ width: 320, height: 800 })
  const observed = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === path)
  void observed.catch(() => undefined)
  const started = performance.now()
  await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", started)
  expect((await realApi(page, request, "GET", "/api/user")).status()).toBe(401)
  const declarationResponse = await realApi(page, request, "GET", `/api/repos/${repo}/contents/.smithers/home.json?ref=main`)
  expect(declarationResponse.status()).toBe(200)
  const file = await declarationResponse.json() as { encoding: string; content: string }
  expect(["utf-8", "base64"]).toContain(file.encoding)
  const declaration = RepositoryHomeSchema.options[0].parse({ kind: "blocks", ...JSON.parse(file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content) })
  const apps = declaration.blocks.filter(block => block.type === "app")
  const prompt = declaration.blocks.find(block => block.type === "prompt")
  expect(apps.length).toBeGreaterThan(0)
  expect(prompt).toBeDefined()
  const response = await observed
  const home = await response.json()
  await testInfo.attach("public-homepage-readback", { contentType: "application/json", body: Buffer.from(JSON.stringify({ repo, declaration, status: response.status(), home })) })
  expect(response.status(), JSON.stringify(home)).toBe(200)
  expect(RepositoryHomeSchema.parse(home)).toMatchObject({ kind: "blocks", blocks: expect.arrayContaining([...apps, prompt]) })
  const assertHome = async () => {
    await expect(page.getByTestId("app-tile")).toHaveCount(apps.length)
    for (const app of apps) await expect(page.getByRole("button", { name: app.title, exact: true })).toBeVisible()
    if (prompt?.title) await expect(page.getByRole("heading", { level: 1, name: prompt.title, exact: true })).toBeVisible()
    await expect(page.getByText("Homepage unavailable", { exact: true })).toHaveCount(0)
    const overflow = await page.locator(".factory-home").evaluate(node => [...node.querySelectorAll<HTMLElement>("button, input, textarea")]
      .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(element => element.tagName))
    expect(overflow).toEqual([])
  }
  await assertHome()
  const reloaded = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === path)
  void reloaded.catch(() => undefined)
  await reloadApp(page)
  expect((await reloaded).status()).toBe(200)
  await assertHome()
  const issueApp = apps.find(app => app.flow === "issue.implement")
  expect(issueApp).toBeDefined()
  await page.getByRole("button", { name: issueApp!.title, exact: true }).press("Enter")
  const signIn = page.getByRole("article").filter({ has: page.getByRole("button", { name: "Sign in with GitHub", exact: true }) }).last()
  await expect(signIn).toBeVisible()
  await expect(page.locator('form.flow-form[data-flow-name="issue.implement"]')).toHaveCount(0)
  expect(launches).toEqual([])
})