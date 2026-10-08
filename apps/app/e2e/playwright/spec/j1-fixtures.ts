import { expect, type Page } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { fillComposer } from "../composer"

// Owner privilege is required by J1 setup; do not raise the shared member fixture.
export async function owner(page: Page) {
  await installCloudFixture(page)
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
}
export async function say(page: Page, text: string) {
  await fillComposer(page, text)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
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

/** Browser session and served install identity for owner-only TODO controls. */
export async function mergeOwner(page: Page, defaultWrites: boolean[] = []) {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/members", route => route.fulfill({ json: { members: [{ login: "benortiz", name: "Ben", avatar_url: "https://example.com/ben.png", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/smithers-mvp-canary/node/settings/access" } }))
  let preapproved = false
  // This action requires a maintainer; the shared browser identity has no roster role.
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "benortiz", is_admin: false } }))
  await page.route("**/api/install", route => {
    if (route.request().method() === "PUT") {
      preapproved = route.request().postDataJSON().todo_preapprove_default
      defaultWrites.push(preapproved)
    }
    return route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://localhost:4000"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })),
    this_mac: { memory_gb: 64, disk_free_gb: 200, capacity: 4 },
    github: { owner: "benortiz", signed_in: true, app_installed: true },
    health: { process: "ok", postgres_bytes: 1024, disk_free_gb: 200,
      github: { health: "fresh", rate_remaining: 4900, rate_limit: 5000 } },
    models: ["fast", "coding", "jev"].map(role => ({ role, provider: "OpenAI", key: "saved" })),
    chatgpt: false, capacity: 4, todo_preapprove_default: preapproved, can_assign_models: true
  } }) })
}
