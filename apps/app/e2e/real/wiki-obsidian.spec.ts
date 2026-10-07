import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { scenario } from "./coverage/types"
import { command, expect, openApp, realApi } from "./support"
import { authenticatedTest as test } from "./auth-permissions/profile"

// Run on the install Mac itself: filesystem access and the browser must reach
// the same unprivileged install. No mocked routes or shortened worker interval.
test("Settings syncs a Mac folder in both directions without restart", scenario("wiki.obsidian-folder", {
  capabilities: ["install"],
  coverage: ["host:local", "action:settings.obsidian", "door:button", "path:success", "path:persistence", "evidence:folder-revisions"]
}), async ({ page, request }, info) => {
  test.setTimeout(360_000)
  expect(process.platform, "C-J8-03 requires the install Mac").toBe("darwin")
  expect(process.env.SMITHERS_REAL_BASE_URL, "Use the built reference install").toBeTruthy()
  expect(process.env.SMITHERS_REAL_AUTH_KIND).toBe("owner-session")
  expect(process.env.SMITHERS_REAL_E2E_BUILD_SHA).toMatch(/^[0-9a-f]{40}$/)
  const state = process.env.SMITHERS_OBSIDIAN_STATE_ROOT
  expect(state, "The canonical install STATE path is required for refusal proof").toBeTruthy()
  const root = process.env.SMITHERS_OBSIDIAN_EVIDENCE_ROOT
  expect(root, "An owner-provided folder outside STATE is required").toBeTruthy()
  const directory = resolve(root!, `C-J8-03-${info.parallelIndex}-${Date.now()}`)
  const vault = join(directory, "Vault")
  const next = join(directory, "Next")
  await mkdir(vault, { recursive: true })
  await mkdir(next)
  await openApp(page)
  const get = async (path: string) => {
    const response = await realApi(page, request, "GET", path)
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  const install = await get("/api/install")
  const binding = install.repository
  expect(binding?.owner).toBeTruthy()
  expect(binding?.name).toBeTruthy()
  const api = `/api/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}/wiki`
  const user = await get("/api/user")
  const slug = `obsidian-proof-${Date.now()}`
  const filename = `${slug}.md`
  const initial = "---\nunknown: retained\n---\n# Retry\n"
  const diskEdit = initial + "Disk decision.\n"
  const appEdit = diskEdit + "App decision.\n"
  const attachment = Buffer.from([0, 1, 2, 255, 13, 10])
  const created = await realApi(page, request, "POST", api, { title: "Retry", slug, path: filename, body: initial })
  expect(created.status(), await created.text()).toBe(201)
  await writeFile(join(vault, "diagram.png"), attachment)
  await command(page, "/settings")
  const card = page.getByTestId("card-settings").last()
  const folder = card.getByLabel("Obsidian folder", { exact: true })
  const setFolder = async (path: string) => {
    await folder.fill(path)
    await folder.locator("xpath=ancestor::form").getByRole("button", { name: "Change", exact: true }).press("Enter")
    await expect.poll(async () => (await get("/api/install")).wiki_sync?.obsidian?.path).toBe(path)
  }
  // Each poll has one default 60-second worker interval plus HTTP scheduling slack.
  const read = async (path: string) => readFile(path).catch(() => Buffer.alloc(0))
  await setFolder(vault)
  await expect.poll(async () => (await read(join(vault, filename))).toString(), { timeout: 70_000 }).toBe(initial)
  // Visible bytes precede the durable reconciliation receipt. Wait for the
  // successful pass before simulating the next independent person edit.
  await expect.poll(async () => {
    const sync = (await get("/api/install")).wiki_sync?.obsidian
    return sync?.path === vault && !sync.error && Boolean(sync.last_sync_at)
  }, { timeout: 70_000 }).toBe(true)
  await info.attach("folder-before", { body: await read(join(vault, filename)), contentType: "text/markdown" })
  await cp(vault, join(directory, "folder-before"), { recursive: true })
  await writeFile(join(vault, filename), diskEdit)
  await expect.poll(async () => (await get(`${api}/${slug}`)).body, { timeout: 70_000 }).toBe(diskEdit)
  const imported = await get(`${api}/${slug}`)
  expect(imported.author.id).toBe(user.id)
  const importedRevisions = await get(`${api}/${slug}/revisions`)
  expect(importedRevisions).toEqual(expect.arrayContaining([expect.objectContaining({
    body: diskEdit, author: expect.objectContaining({ id: user.id, login: user.username })
  })]))
  await writeFile(join(directory, "imported-revisions.json"), JSON.stringify(importedRevisions, null, 2))
  await command(page, `/wiki.cloud.open ${slug} ${binding.owner}/${binding.name}`)
  const note = page.locator('[data-testid^="card-wiki-open-"]').last()
  await expect(note).toContainText("Disk decision.")
  const documentId = (await note.getAttribute("data-testid"))!.replace(/^card-wiki-open-/, "")
  await command(page, `/wiki.edit ${documentId} ${JSON.stringify(appEdit)}`)
  await expect.poll(async () => (await get(`${api}/${slug}`)).body).toBe(appEdit)
  await expect.poll(async () => (await read(join(vault, filename))).toString(), { timeout: 70_000 }).toBe(appEdit)
  expect(await read(join(vault, "diagram.png"))).toEqual(attachment)
  await setFolder(next)
  await expect.poll(async () => (await read(join(next, filename))).toString(), { timeout: 70_000 }).toBe(appEdit)
  await writeFile(join(vault, filename), initial + "Old folder must stop.\n")
  await writeFile(join(next, filename), appEdit + "New folder decision.\n")
  await expect.poll(async () => (await get(`${api}/${slug}`)).body, { timeout: 70_000 }).toBe(appEdit + "New folder decision.\n")
  expect(await read(join(next, "diagram.png"))).toEqual(attachment)
  await folder.fill(state!)
  await folder.locator("xpath=ancestor::form").getByRole("button", { name: "Change", exact: true }).press("Enter")
  await expect(card.getByRole("alert")).toHaveText("Sync failed")
  await expect(card.locator("details").filter({ hasText: "Obsidian folder refused" })).toHaveCount(1)
  expect((await get("/api/install")).wiki_sync.obsidian.path).toBe(next)
  const revisions = await get(`${api}/${slug}/revisions`)
  await info.attach("page-revisions", { body: JSON.stringify(revisions, null, 2), contentType: "application/json" })
  await info.attach("folder-after", { body: await read(join(next, filename)), contentType: "text/markdown" })
  await cp(next, join(directory, "folder-after"), { recursive: true })
  await info.attach("attachment-after", { body: await read(join(next, "diagram.png")), contentType: "image/png" })
  const screenshot = await card.screenshot()
  await info.attach("Settings", { body: screenshot, contentType: "image/png" })
  await writeFile(join(directory, "Settings.png"), screenshot)
  await writeFile(join(directory, "commit.txt"), process.env.SMITHERS_REAL_E2E_BUILD_SHA ?? "unverified")
  await writeFile(join(directory, "revisions.json"), JSON.stringify(revisions, null, 2))
  // Keep the active folder and receipts on disk. The owner can reopen this vault.
  if (install.wiki_sync?.obsidian?.path) await setFolder(install.wiki_sync.obsidian.path)
})
