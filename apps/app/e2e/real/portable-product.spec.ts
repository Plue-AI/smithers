import type { APIRequestContext, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, expect, productUrl, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { runSlash } from "./issues/local"
import { installRepository, withProductRepository, type OwnedRepository } from "./portable/owned-repository"

authenticatedTest.setTimeout(180_000)

/*
 * An install's issues are its GitHub repository's (mvp.md §6.3, Appendix A): /issue.new opens one through the
 * install's App and /issue n reads it back from GitHub. Smithers Cloud serves its own issues on the repository
 * (/issues.create, /issues.view). The scenario is the same; the doors are the topology's.
 */
const openIssue = async (page: Page, repo: OwnedRepository, title: string): Promise<number> => {
  if (installRepository() === undefined) {
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${repo.path}/issues`, { timeout: 15_000 })
    await runSlash(page, `/issues.create ${title} ${repo.fullName}`)
    const response = await created
    expect(response.status()).toBe(201)
    const issue = await response.json() as { readonly number?: number; readonly title?: string }
    expect(issue.title).toBe(title)
    expect(issue.number).toEqual(expect.any(Number))
    return issue.number!
  }
  const requested = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/issues", { timeout: 30_000 })
  await runSlash(page, `/issue.new ${title}`)
  const form = page.locator(".smithers-card").filter({ has: page.getByRole("button", { name: "Open on GitHub", exact: true }) }).last()
  await form.getByLabel("Body", { exact: true }).fill(`Opened by the mode matrix: ${title}`)
  await form.getByRole("button", { name: "Open on GitHub", exact: true }).click()
  expect((await requested).status()).toBe(202)
  // Opening is background work (AGENTS.md): the issue card opens once GitHub has numbered the issue.
  const card = page.getByRole("heading", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} #\\d+$`) }).last()
  await expect(card).toBeVisible({ timeout: 60_000 })
  return Number(/#(\d+)$/.exec(await card.innerText())![1])
}

const viewIssue = (page: Page, repo: OwnedRepository, number: number): Promise<void> =>
  runSlash(page, installRepository() === undefined ? `/issues.view ${number} ${repo.fullName}` : `/issue ${number}`)

const readIssue = async (page: Page, request: APIRequestContext, repo: OwnedRepository, number: number): Promise<unknown> => {
  if (installRepository() === undefined) {
    const read = await realApi(page, request, "GET", `${repo.path}/issues/${number}`)
    expect(read.status()).toBe(200)
    return read.json()
  }
  const read = await realApi(page, request, "GET", `/api/issues/${number}`)
  expect(read.status()).toBe(200)
  return (await read.json() as { readonly issue?: unknown }).issue
}

authenticatedTest("an owner opens an issue on a product repository through the UI", scenario("issues.product-create-readback", {
  capabilities: ["identity"],
  coverage: ["action:issues.create", "action:issue.new", "host:local", "host:production", "path:success", "door:slash", "surface:issues-api", "evidence:ui-create-and-api-readback"]
}), async ({ page, request }) => {
  await withProductRepository(page, request, async (repo) => {
    const title = `Matrix issue ${crypto.randomUUID()}`
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    const number = await openIssue(page, repo, title)
    expect(await readIssue(page, request, repo, number)).toMatchObject({ number, title })
  })
})

authenticatedTest("an owned issue remains after a reload of the same product window", scenario("issues.product-reload-readback", {
  capabilities: ["identity"],
  coverage: ["action:issues.create", "action:issues.view", "action:issue.new", "action:issue", "host:local", "host:production", "path:persistence", "door:slash", "evidence:reload-and-api-readback"]
}), async ({ page, request }) => {
  await withProductRepository(page, request, async (repo) => {
    const title = `Reload issue ${crypto.randomUUID()}`
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    const number = await openIssue(page, repo, title)
    await viewIssue(page, repo, number)
    await expect(page.getByRole("heading", { name: `${title} #${number}` })).toBeVisible()
    await reloadApp(page)
    await viewIssue(page, repo, number)
    await expect(page.getByRole("heading", { name: `${title} #${number}` })).toBeVisible()
    expect(await readIssue(page, request, repo, number)).toMatchObject({ title, number })
  })
})
