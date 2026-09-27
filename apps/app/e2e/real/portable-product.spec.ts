import type { APIRequestContext, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, expect, productUrl, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { runSlash } from "./issues/local"
import { withOwnedRepository, pushLocalFixture } from "./portable/owned-repository"

authenticatedTest.setTimeout(180_000)

authenticatedTest("a local Git fixture pushes to the product and its file is browsable", scenario("repositories.local-git-push-file-readback", {
  capabilities: ["identity"],
  description: "Create a product repository through repo.create, push a locally committed Git fixture through smart HTTP, and read the exact file from the product API.",
  coverage: ["action:repo.create", "host:local", "host:production", "path:success", "door:slash", "surface:repository-api", "dimension:local-git-source", "evidence:git-push-and-content-readback"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    const { commit, marker } = await pushLocalFixture(page, request, repo)
    const bookmarks = await realApi(page, request, "GET", `${repo.path}/bookmarks`)
    expect(bookmarks.status()).toBe(200)
    const body = await bookmarks.json() as { readonly items?: ReadonlyArray<{ readonly name?: string; readonly target_commit_id?: string }> }
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fixture", target_commit_id: commit })]))
    const file = await realApi(page, request, "GET", `${repo.path}/contents/fixture.txt?ref=fixture`)
    expect(file.status()).toBe(200)
    const content = await file.json() as { readonly content?: string; readonly encoding?: string }
    expect(["base64", "utf-8"]).toContain(content.encoding)
    expect(content.encoding === "base64" ? Buffer.from(content.content ?? "", "base64").toString("utf8") : content.content).toBe(`${marker}\n`)
  }, "ui")
})

authenticatedTest("an owner opens an issue on a product repository through the UI", scenario("issues.product-create-readback", {
  capabilities: ["identity"],
  coverage: ["action:issues.create", "host:local", "host:production", "path:success", "door:slash", "surface:issues-api", "evidence:ui-create-and-api-readback"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    const title = `Matrix issue ${crypto.randomUUID()}`
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${repo.path}/issues`, { timeout: 15_000 })
    await runSlash(page, `/issues.create ${title} ${repo.fullName}`)
    const response = await created
    expect(response.status()).toBe(201)
    const issue = await response.json() as { readonly number?: number; readonly title?: string }
    expect(issue.title).toBe(title)
    expect(issue.number).toEqual(expect.any(Number))
    const read = await realApi(page, request, "GET", `${repo.path}/issues/${issue.number}`)
    expect(read.status()).toBe(200)
    expect(await read.json()).toMatchObject({ number: issue.number, title })
  })
})

authenticatedTest("an owned issue remains after a reload of the same product window", scenario("issues.product-reload-readback", {
  capabilities: ["identity"],
  coverage: ["action:issues.create", "action:issues.view", "host:local", "host:production", "host:native", "path:persistence", "door:slash", "evidence:reload-and-api-readback"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    const title = `Reload issue ${crypto.randomUUID()}`
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${repo.path}/issues`, { timeout: 15_000 })
    await runSlash(page, `/issues.create ${title} ${repo.fullName}`)
    const creation = await created
    expect(creation.status()).toBe(201)
    const issue = await creation.json() as { readonly number?: number; readonly title?: string }
    expect(issue.number).toEqual(expect.any(Number))
    expect(issue.title).toBe(title)
    await runSlash(page, `/issues.view ${issue.number} ${repo.fullName}`)
    await expect(page.getByRole("heading", { name: `${title} #${issue.number}` })).toBeVisible()
    await reloadApp(page)
    await runSlash(page, `/issues.view ${issue.number} ${repo.fullName}`)
    await expect(page.getByRole("heading", { name: `${title} #${issue.number}` })).toBeVisible()
    const read = await realApi(page, request, "GET", `${repo.path}/issues/${issue.number}`)
    expect(read.status()).toBe(200)
    expect(await read.json()).toMatchObject({ title, number: issue.number })
  })
})

const landOwnedChange = async (page: Page, request: APIRequestContext, door: "slash" | "button"): Promise<void> => {
  await withOwnedRepository(page, request, async (repo) => {
    const { commit, marker } = await pushLocalFixture(page, request, repo)
    const changesResponse = await realApi(page, request, "GET", `${repo.path}/changes?limit=100`)
    expect(changesResponse.status()).toBe(200)
    const changes = await changesResponse.json() as { readonly items?: ReadonlyArray<{ readonly change_id?: string; readonly commit_id?: string }> }
    const change = changes.items?.find((candidate) => candidate.commit_id === commit)
    expect(change?.change_id).toEqual(expect.any(String))
    const title = `Land ${marker}`
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${repo.path}/landings`, { timeout: 15_000 })
    await runSlash(page, `/prs.create ${title} from:fixture ${repo.fullName}`)
    const creation = await created
    expect(creation.status()).toBe(201)
    const landing = await creation.json() as { readonly number?: number; readonly title?: string; readonly state?: string }
    expect(landing.title).toBe(title)
    expect(landing.number).toEqual(expect.any(Number))
    const read = await realApi(page, request, "GET", `${repo.path}/landings/${landing.number}`)
    expect(read.status()).toBe(200)
    expect(await read.json()).toMatchObject({ number: landing.number, change_ids: [change!.change_id] })
    if (door === "button") {
      await runSlash(page, `/change.view ${change!.change_id}`)
      await expect(page.getByTestId(`card-change-${repo.fullName}-${change!.change_id}`)).toBeVisible()
    }
    const landingResponse = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `${repo.path}/landings/${landing.number}/land`, { timeout: 15_000 })
    if (door === "slash") {
      await runSlash(page, `/prs.land ${landing.number} ${repo.fullName}`)
    } else {
      const land = page.getByTestId(`card-change-${repo.fullName}-${change!.change_id}`).locator('button[data-flow="change.land"]')
      await expect(land).toBeEnabled()
      await land.focus()
      await expect(land).toBeFocused()
      await page.keyboard.press("Enter")
    }
    const accepted = await landingResponse
    expect(accepted.request().postDataJSON()).toEqual({ commit_id: commit })
    expect(accepted.status()).toBe(202)
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", `${repo.path}/landings/${landing.number}`)
      expect(response.status()).toBe(200)
      return (await response.json() as { readonly state?: string }).state
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe("merged")
    const file = await realApi(page, request, "GET", `${repo.path}/contents/fixture.txt?ref=main`)
    expect(file.status()).toBe(200)
    const content = await file.json() as { readonly content?: string; readonly encoding?: string }
    expect(["base64", "utf-8"]).toContain(content.encoding)
    expect(content.encoding === "base64" ? Buffer.from(content.content ?? "", "base64").toString("utf8") : content.content).toBe(`${marker}\n`)
    await reloadApp(page)
    await runSlash(page, `/change.view ${change!.change_id}`)
    const restored = page.getByTestId(`card-change-${repo.fullName}-${change!.change_id}`)
    await expect(restored.locator('button[data-flow="change.land"]')).toBeDisabled()
    await expect(restored.getByText("landed", { exact: true })).toBeVisible()
  })
}

authenticatedTest("a pushed local change opens and lands through the slash command", scenario("landings.local-change-land", {
  capabilities: ["identity"],
  coverage: ["action:prs.create", "action:prs.land", "host:local", "host:production", "path:success", "path:persistence", "door:slash", "dimension:reload", "surface:landing-api", "dimension:local-git-source", "evidence:change-and-landed-bookmark"]
}), async ({ page, request }) => {
  await landOwnedChange(page, request, "slash")
})

authenticatedTest("a pushed local change lands through the change card with the keyboard", scenario("landings.change-card-land", {
  capabilities: ["identity"],
  coverage: ["action:prs.create", "action:change.view", "action:change.land", "host:local", "host:production", "path:success", "path:persistence", "path:keyboard", "door:button", "dimension:keyboard", "dimension:reload", "surface:change-card", "dimension:local-git-source", "evidence:change-and-landed-bookmark"]
}), async ({ page, request }) => {
  await landOwnedChange(page, request, "button")
})
