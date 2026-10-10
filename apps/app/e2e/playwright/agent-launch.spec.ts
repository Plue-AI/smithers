import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"
import { localApiDelete, localApiGet, localApiPost } from "./localApi"

/*
 * T-AGT-02/T-AGT-03 (#3731 ruling b): the host's agent launch and raw transcript preview are deleted. A member's Codex
 * or Claude Code session reaches the branch conversation only as imported entries (spec/C-AGT-01.spec.ts); no door,
 * address or capability starts an agent CLI or reads a transcript here.
 */
test("the retired agent launch and transcript preview have no door", async ({ page, request }) => {
  const external: string[] = []
  page.on("request", sent => { if (new URL(sent.url()).pathname.startsWith("/api/external/")) external.push(`${sent.method()} ${sent.url()}`) })
  for (const address of ["/?codex=0199e2e0-0000-7000-8000-00000000c0de", "/?claude=5b2c9e10-4d3a-4f6e-9a1b-7c8d9e0f1a2b"]) {
    await page.goto(address)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-origin="external"]')).toHaveCount(0)
  }
  expect(external).toEqual([])

  await fillComposer(page, "/help")
  await page.keyboard.press("Enter")
  const help = page.getByRole("article", { name: "Commands", exact: true })
  await expect(help).toBeVisible()
  await help.getByText("Advanced", { exact: true }).click()
  await expect(help.getByRole("button", { name: /agent\.(codex|claude)/ })).toHaveCount(0)
  await expect(help.getByText(/\/agent\.(codex|claude)/)).toHaveCount(0)

  const bootstrap = await (await localApiGet(page, request, "/api/bootstrap")).json() as { capabilities: string[] }
  expect(bootstrap.capabilities.filter(capability => capability.startsWith("launch."))).toEqual([])
  for (const response of [
    await localApiPost(page, request, "/api/external/launch", { agent: "codex", prompt: "Fix the flaky test" }),
    await localApiDelete(page, request, "/api/external/launch"),
    await localApiGet(page, request, "/api/external/sessions?agent=codex&session=0199e2e0&offset=0")
  ]) expect(response.status()).toBe(404)
  expect(external).toEqual([])
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
