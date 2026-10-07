import type { APIRequestContext, Locator, Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, closeComposer, command, expect, productUrl, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { attachJson } from "./issues/local"
import {
  newChangeId, pushChangeRevision, pushMainFiles, withOwnedRepository, type OwnedRepository
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
    "action:files.list", "action:file", "action:search.files",
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

    await slash(page, `/file ${path} ${repo.fullName}`)
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
