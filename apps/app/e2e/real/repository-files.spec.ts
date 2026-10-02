import type { APIRequestContext, Locator, Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, closeComposer, command, expect, productUrl, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { attachJson } from "./issues/local"
import {
  newChangeId, pushChangeRevision, pushLocalFixture, pushMainFiles, withOwnedRepository, type OwnedRepository
} from "./portable/owned-repository"

authenticatedTest.setTimeout(240_000)

type Entry = { readonly name?: string; readonly type?: string }
type Content = { readonly content?: string; readonly encoding?: string }

const card = (page: Page, id: string): Locator => page.getByTestId(`card-${id}`)

const openRepository = async (page: Page, repo: OwnedRepository): Promise<void> => {
  const startedAt = performance.now()
  await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", startedAt)
  await finishFirstVisit(page)
}

const slash = async (page: Page, text: string): Promise<void> => {
  await command(page, text)
  await closeComposer(page)
}

const pressKey = async (control: Locator): Promise<void> => {
  await control.focus()
  await expect(control).toBeFocused()
  await control.press("Enter")
}

const listing = async (page: Page, request: APIRequestContext, repo: OwnedRepository, path: string): Promise<ReadonlyArray<string>> => {
  const response = await realApi(page, request, "GET", `${repo.path}/contents/${path}?ref=main`)
  expect(response.status()).toBe(200)
  return (await response.json() as ReadonlyArray<Entry>).map((entry) => String(entry.name)).sort()
}

const fileText = async (page: Page, request: APIRequestContext, repo: OwnedRepository, path: string, ref = "main"): Promise<string> => {
  const response = await realApi(page, request, "GET", `${repo.path}/contents/${path}?ref=${encodeURIComponent(ref)}`)
  expect(response.status()).toBe(200)
  const body = await response.json() as Content
  expect(typeof body.content).toBe("string")
  return body.encoding === "base64" ? Buffer.from(body.content!, "base64").toString("utf8") : body.content!
}

authenticatedTest("files.list, files.read and search.files read seeded bytes from an owned repository and survive reload", scenario("repository.files-list-read-search", {
  capabilities: ["identity"],
  description: "Push a nested file to an owned repository's main, list its root and directory, read the file, find it with search.files and open it from the keyboard; every listing and byte is compared with the contents API, and the file card survives reload.",
  coverage: [
    "action:files.list", "action:files.read", "action:search.files",
    "host:local", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:keyboard", "dimension:reload", "surface:file-card", "evidence:contents-api-readback"
  ]
}), async ({ page, request }, testInfo) => {
  await withOwnedRepository(page, request, async (repo) => {
    const stem = `seeded-${randomUUID().slice(0, 8)}`
    const path = `src/${stem}.ts`
    const bytes = `export const marker = "${randomUUID()}"\n`
    await pushMainFiles(page, request, repo, { [path]: bytes })
    await expect.poll(() => listing(page, request, repo, "src"), { timeout: 30_000 }).toEqual([`${stem}.ts`])
    const root = await listing(page, request, repo, "")
    expect(root).toEqual(expect.arrayContaining(["README.md", "src"]))
    await openRepository(page, repo)

    await slash(page, `/files.list / ${repo.fullName}`)
    const rootCard = card(page, `files-${repo.fullName}-/`)
    await expect(rootCard).toBeVisible({ timeout: 30_000 })
    const rootRows = rootCard.locator(".world-card-row .world-card-title")
    await expect.poll(async () => (await rootRows.allTextContents()).sort()).toEqual(root)

    // The directory row is the listing's button door.
    await pressKey(rootCard.getByRole("button", { name: "src", exact: true }))
    const srcCard = card(page, `files-${repo.fullName}-src`)
    await expect(srcCard).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await srcCard.locator(".world-card-row .world-card-title").allTextContents()).sort()).toEqual([`${stem}.ts`])

    await slash(page, `/files.read ${path} ${repo.fullName}`)
    const fileCard = card(page, `file-${repo.fullName}-${path}`)
    await expect(fileCard).toBeVisible({ timeout: 30_000 })
    await expect(fileCard).toContainText(bytes.trim())
    expect(await fileText(page, request, repo, path)).toBe(bytes)

    const searchFlow = "search.files"
    await slash(page, `/${searchFlow} ${stem}`)
    const search = card(page, `search-${searchFlow}`)
    await expect(search.getByTestId("search-results-query")).toHaveText(`/search.files ${stem} · 1 result`)
    const row = search.getByTestId(`search-item-file-${path}`)
    await expect(row).toBeVisible()
    await pressKey(row.locator("[data-role='open']"))
    await expect(fileCard).toContainText(bytes.trim())

    await reloadApp(page)
    await expect(fileCard).toContainText(bytes.trim(), { timeout: 30_000 })
    await expect(srcCard).toContainText(`${stem}.ts`)
    await attachJson(testInfo, "files-readback", { repo: repo.fullName, root, path, bytes })
  })
})

authenticatedTest("branches.list, commits.list and commits.read follow a pushed branch to its commit from the keyboard", scenario("repository.branches-commits-readback", {
  capabilities: ["identity"],
  description: "Push a fixture branch to an owned repository, list its branches, open the branch's commits and the newest commit from the keyboard, and compare the branch heads, commit ids and changed path with the bookmarks and changes APIs before and after reload.",
  coverage: [
    "action:branches.list", "action:commits.list", "action:commits.read",
    "host:local", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:keyboard", "dimension:reload", "surface:commit-card", "evidence:bookmarks-and-changes-api-readback"
  ]
}), async ({ page, request }, testInfo) => {
  await withOwnedRepository(page, request, async (repo) => {
    const { commit, marker } = await pushLocalFixture(page, request, repo)
    type Head = { readonly commit: string; readonly change: string }
    const bookmarks = async (): Promise<Record<string, Head>> => {
      const response = await realApi(page, request, "GET", `${repo.path}/bookmarks`)
      expect(response.status()).toBe(200)
      const body = await response.json() as { readonly items?: ReadonlyArray<{ readonly name?: string; readonly target_commit_id?: string; readonly target_change_id?: string }> }
      return Object.fromEntries((body.items ?? []).map((item) => [String(item.name), { commit: String(item.target_commit_id), change: String(item.target_change_id) }]))
    }
    await expect.poll(async () => (await bookmarks()).fixture?.commit, { timeout: 30_000 }).toBe(commit)
    const heads = await bookmarks()
    expect(Object.keys(heads).sort()).toEqual(["fixture", "main"])
    const changeId = heads.fixture!.change
    const change = await realApi(page, request, "GET", `${repo.path}/changes/${changeId}`)
    expect(change.status()).toBe(200)
    expect(await change.json()).toMatchObject({ change_id: changeId, commit_id: commit })
    await openRepository(page, repo)

    await slash(page, `/branches.list ${repo.fullName}`)
    const branches = card(page, `branches-${repo.fullName}`)
    await expect(branches).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await branches.locator(".branches-row-open .world-card-title").allTextContents()).sort()).toEqual(["fixture", "main"])
    await expect(branches.getByRole("button", { name: /^fixture/ })).toContainText(commit.slice(0, 8))

    await pressKey(branches.getByRole("button", { name: /^fixture/ }))
    const commits = card(page, `commits-${repo.fullName}-fixture`)
    await expect(commits).toBeVisible({ timeout: 30_000 })
    const commitRow = commits.locator(`[data-commit-id="${commit}"]`)
    await expect(commitRow).toContainText("Add local fixture")

    await pressKey(commitRow.locator("[data-row-open]"))
    const detail = card(page, `commit-${repo.fullName}-${changeId}`)
    await expect(detail).toBeVisible({ timeout: 30_000 })
    await expect(detail).toContainText("Add local fixture")
    await expect(detail.getByRole("region", { name: "Diff of fixture.txt" })).toContainText(marker)

    await reloadApp(page)
    await expect(detail.getByRole("region", { name: "Diff of fixture.txt" })).toContainText(marker, { timeout: 30_000 })
    await expect(commits.locator(`[data-commit-id="${commit}"]`)).toBeVisible()
    await attachJson(testInfo, "branches-commits-readback", { repo: repo.fullName, heads, changeId, commit })
  })
})

authenticatedTest("files.open-diff reads a changed file at the diff's pinned commit", scenario("repository.diff-open-file", {
  capabilities: ["identity"],
  description: "Push one revision of a change to an owned repository, open its diff, press Open file on the changed path, and compare the file card with the contents API at the pinned commit before and after reload.",
  coverage: [
    "action:files.open-diff", "action:change.diff",
    "host:local", "path:success", "path:persistence", "path:keyboard", "door:button", "door:slash",
    "dimension:keyboard", "dimension:reload", "surface:diff-card", "evidence:pinned-contents-api-readback"
  ]
}), async ({ page, request }, testInfo) => {
  await withOwnedRepository(page, request, async (repo) => {
    const changeId = newChangeId()
    const bytes = `pinned ${randomUUID()}\n`
    const commit = await pushChangeRevision(page, request, repo, changeId, { "notes/pinned.txt": bytes })
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", `${repo.path}/changes/${changeId}`)
      return response.status() === 200 ? (await response.json() as { readonly commit_id?: string }).commit_id : undefined
    }, { timeout: 30_000 }).toBe(commit)
    expect(await fileText(page, request, repo, "notes/pinned.txt", commit)).toBe(bytes)
    await openRepository(page, repo)

    await slash(page, `/change.diff ${changeId}`)
    const diff = card(page, `diff-${repo.fullName}-${changeId}`)
    await expect(diff).toBeVisible({ timeout: 30_000 })
    await expect(diff).toContainText("notes/pinned.txt")
    await pressKey(diff.getByRole("button", { name: "Open file", exact: true }))
    await expect(diff).toHaveAttribute("data-kind", "file")
    await expect(diff).toContainText(bytes.trim())

    await reloadApp(page)
    await expect(diff).toHaveAttribute("data-kind", "file", { timeout: 30_000 })
    await expect(diff).toContainText(bytes.trim())
    await attachJson(testInfo, "diff-open-file-readback", { repo: repo.fullName, changeId, commit, bytes })
  })
})
