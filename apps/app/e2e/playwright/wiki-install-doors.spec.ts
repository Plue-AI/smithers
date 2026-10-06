import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"
import * as Y from "yjs"

test("install wiki doors embed repository pages by vault path", async ({ page }) => {
  test.setTimeout(120_000)
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "install"] })
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud", "install"], authFlow: "credentials", sandbox: null } }))
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://127.0.0.1"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })),
    this_mac: { memory_gb: 64, disk_free_gb: 200, capacity: 4 },
    github: { signed_in: true, app_installed: true }, repository: { owner: "smithersai", name: "smithers" },
    models: [{ role: "fast", provider: "Cerebras", key: "saved" }, { role: "coding", provider: "Anthropic", key: "saved" }, { role: "jev", provider: "Vercel", key: "saved" }],
    chatgpt: false, capacity: 4
  } }))
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, "# Retry decision\n\nKeep every edit.")
  const row = { id: 42, slug: "retries", path: "decisions/retries.md", title: "Retry decision", body: doc.getText("markdown").toString(),
    revision: 3, author: { id: 1, login: "will" }, created_at: "2026-10-05", updated_at: "2026-10-05" }
  await page.route("**/api/repos/smithersai/smithers/wiki?*", route => route.fulfill({ json: [row] }))
  await page.route("**/api/repos/smithersai/smithers/wiki/navigation/index?*", route => route.fulfill({ json: { pages: [{ ...row, metadata: {} }] } }))
  await page.route("**/api/repos/smithersai/smithers/wiki/retries/document?*", route => route.fulfill({ json: {
    page: row, state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), state_vector: Buffer.from(Y.encodeStateVector(doc)).toString("base64")
  } }))
  await page.route("**/api/repos/smithersai/smithers/wiki/retries/stream?*", route => route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" }))
  try {
    await page.goto("/")
    await fillComposer(page, "/wiki")
    await page.getByRole("option", { name: /^\/wiki / }).click()
    await expect(page.getByTestId("card-wiki-index-smithersai/smithers-public")).toContainText("Retry decision", { timeout: 10_000 })
    await fillComposer(page, "/wiki.page decisions/retries")
    await page.getByTestId("composer-send").click()
    const card = page.getByTestId("card-wiki-open-wiki:smithersai/smithers:42")
    await expect(card).toContainText("Keep every edit.", { timeout: 10_000 })
    await expect(card).not.toHaveAttribute("data-maximized", "true")
    await fillComposer(page, "Continue chatting")
    await expect(page.getByTestId("composer-input")).toBeVisible()
    await expect(page.locator('[data-testid^="card-design:wiki:"]')).toHaveCount(0)
  } finally { doc.destroy() }
})
