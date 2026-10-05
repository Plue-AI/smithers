import { expect, type Page } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { fillComposer } from "../composer"

// Owner privilege is required by J1 setup; do not raise the shared member fixture.
export async function owner(page: Page) {
  await installCloudFixture(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
}
export async function say(page: Page, text: string) {
  await fillComposer(page, text)
  await page.keyboard.press("Enter")
}
export const setup = (page: Page) => page.getByRole("region", { name: "Set up Smithers" })
export async function sourceReady(page: Page) {
  await expect(page.getByText("Source ready", { exact: true })).toBeVisible()
  await expect(page.getByText("Machine ready", { exact: true })).toHaveCount(0)
}
export async function firstTodo(page: Page, prompt: string) {
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Add sum")
  await page.getByLabel("Prompt", { exact: true }).fill(prompt)
  await expect(page.getByRole("button", { name: "Append", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect(page.getByText("In review", { exact: true }).first()).toBeVisible()
}

// The setup-only host advertises install; the ordinary demo host opens Home.
export async function installSetup(page: Page) {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test",
    capabilities: ["install"], authFlow: "none", sandbox: { platform: "darwin", mode: "trusted-only" }
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://localhost:4000"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "pending" })),
    this_mac: { memory_gb: 32, disk_free_gb: 400, capacity: 3 },
    github: { signed_in: false, app_installed: false },
    models: [{ role: "fast", provider: "Cerebras", key: "none" }, { role: "coding", provider: "Anthropic", key: "none" }, { role: "jev", provider: "AI Gateway", key: "none" }],
    chatgpt: false, capacity: 3
  } }))
}
