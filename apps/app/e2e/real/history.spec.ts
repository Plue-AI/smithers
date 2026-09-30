/*
 * History (the repository's mythical stack) on the deployed service (#1921).
 * Every write goes through the rendered app's doors (slash and card buttons)
 * against an owned repository; the service's own snapshot is read back
 * independently after each write, and the repository is deleted afterwards.
 */
import { request as http } from "@playwright/test"
import type { APIRequestContext, Locator, Page, Request } from "@playwright/test"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, expect, productUrl, realApi, reloadApp } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { attachJson, runSlash } from "./issues/local"
import { withOwnedRepository, type OwnedRepository } from "./portable/owned-repository"
import { withOwnedImportedRepository } from "./issues/cloud"
import { repositoryApiPath } from "./repositories-github/production"

type Stack = {
  readonly state?: string
  readonly limits?: { readonly maxParallel?: number }
  readonly items?: ReadonlyArray<{ readonly id: string; readonly state: string; readonly issue?: { readonly number?: number } }>
  readonly changes?: ReadonlyArray<unknown>
}
type StackCall = { readonly method: string; readonly path: string; readonly body?: unknown }

const stackPath = (repo: OwnedRepository, suffix = ""): string => `${repo.path}/mythical${suffix}`

/** The service's own snapshot, read with the signed-in session. */
const readStack = async (page: Page, request: APIRequestContext, repo: OwnedRepository): Promise<Stack> => {
  const response = await realApi(page, request, "GET", stackPath(repo))
  expect(response.status(), `read ${stackPath(repo)}`).toBe(200)
  return await response.json() as Stack
}

/** Every write the browser sends to the stack's routes, in order. */
const observeStackWrites = (page: Page, repo: OwnedRepository): StackCall[] => {
  const calls: StackCall[] = []
  const prefix = stackPath(repo)
  page.on("request", (sent: Request) => {
    const path = new URL(sent.url()).pathname
    if (sent.method() === "GET" || !path.startsWith(prefix)) return
    const body = (() => { try { return sent.postDataJSON() as unknown } catch { return undefined } })()
    calls.push({ method: sent.method(), path, ...(body === undefined || body === null ? {} : { body }) })
  })
  return calls
}

const openRepository = async (page: Page, repo: OwnedRepository): Promise<void> => {
  const startedAt = performance.now()
  await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", startedAt)
  await finishFirstVisit(page)
}

const stackCard = (page: Page, repo: OwnedRepository): Locator =>
  page.locator('.smithers-card[data-kind="stack"]').filter({ hasText: repo.fullName }).last()

const toast = (page: Page, status: string, title: string): Locator =>
  page.locator(`.toast[data-toast-status="${status}"]`).filter({ hasText: title })

authenticatedTest("history on an owned repository: bootstrap, show, lane count, refusals, reload and readback", scenario("history.production-bootstrap-show-parallel", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:history.show", "action:history.bootstrap", "action:history.parallel", "action:history.backfill", "action:history.retry",
    "host:production", "path:success", "path:error", "path:permission", "path:persistence",
    "door:slash", "door:button",
    "dimension:reload", "dimension:duplicate-input", "dimension:chat-during-launch", "dimension:signed-out-refusal",
    "evidence:stack-snapshot-readback"
  ],
  description: "An owned repository shows no history; Bootstrap is acknowledged at once and its notice settles only when the service reads active, while chat stays usable and a repeated bootstrap sends nothing. The lane count is set by slash and by button, an out-of-range count and a signed-out write change nothing, backfill without a GitHub source and retry of an unknown item are refused on the card, and a reload shows what the service holds."
}), async ({ page, request }, testInfo) => {
  testInfo.setTimeout(600_000)
  await withOwnedRepository(page, request, async (repo) => {
    await openRepository(page, repo)
    const writes = observeStackWrites(page, repo)
    const receipts: Record<string, unknown> = { repo: repo.fullName }
    try {
      // Show: the repository has no history yet, and the service agrees.
      expect((await readStack(page, request, repo)).state).toBe("absent")
      await runSlash(page, `/history.show ${repo.fullName}`)
      const card = stackCard(page, repo)
      const bootstrap = card.getByTestId("stack-bootstrap")
      await expect(bootstrap).toBeVisible()
      expect(writes).toEqual([])

      // Bootstrap by button: acknowledged at once, settled by the service's state.
      const acknowledged = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === stackPath(repo, "/bootstrap"))
      await bootstrap.click()
      const ack = await acknowledged
      expect(ack.status()).toBe(202)
      receipts["bootstrapAck"] = await ack.json()
      // Chat stays usable while the history is created; the same request joins the one in flight.
      await runSlash(page, `/history.bootstrap ${repo.fullName}`)
      await expect(toast(page, "ok", "History ready")).toBeVisible({ timeout: 300_000 })
      const active = await readStack(page, request, repo)
      expect(active.state).toBe("active")
      expect(writes.filter((call) => call.path === stackPath(repo, "/bootstrap"))).toHaveLength(1)
      await expect(card.getByTestId("stack-card")).toHaveAttribute("data-stack-state", "active")
      const initial = active.limits?.maxParallel
      expect(initial).toEqual(expect.any(Number))
      await expect(card.getByTestId("stack-lane-count")).toHaveText(`0/${initial} lanes`)

      // Lane count by slash, then by the card's + button.
      await runSlash(page, `/history.parallel 3 ${repo.fullName}`)
      await expect(toast(page, "ok", "3 lanes")).toBeVisible({ timeout: 60_000 })
      await expect(card.getByTestId("stack-lane-count")).toHaveText("0/3 lanes")
      expect((await readStack(page, request, repo)).limits?.maxParallel).toBe(3)
      await card.getByRole("button", { name: "More lanes", exact: true }).click()
      await expect(card.getByTestId("stack-lane-count")).toHaveText("0/4 lanes", { timeout: 60_000 })
      expect((await readStack(page, request, repo)).limits?.maxParallel).toBe(4)
      expect(writes.filter((call) => call.path === stackPath(repo, "/config")).map((call) => call.body))
        .toEqual([{ maxParallel: 3 }, { maxParallel: 4 }])

      // An out-of-range count asks again in the flow's form and sends nothing.
      const before = writes.length
      await runSlash(page, `/history.parallel 9 ${repo.fullName}`)
      await expect(page.locator('form.flow-form[data-flow-name="history.parallel"]').last()).toBeVisible()
      expect(writes.slice(before)).toEqual([])

      // Signed out, the same write is refused and the service still holds 4.
      const anonymous = await http.newContext()
      try {
        const origin = new URL(page.url()).origin
        const read = await anonymous.get(new URL(stackPath(repo), origin).toString())
        const write = await anonymous.put(new URL(stackPath(repo, "/config"), origin).toString(), { data: { maxParallel: 1 } })
        receipts["signedOut"] = { read: read.status(), write: write.status() }
        expect([401, 404]).toContain(read.status())
        expect([401, 403, 404]).toContain(write.status())
      } finally { await anonymous.dispose() }
      expect((await readStack(page, request, repo)).limits?.maxParallel).toBe(4)

      // Backfill needs the repository's GitHub source: the service refuses it and the card says so.
      const backfilled = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === stackPath(repo, "/backfill"))
      await runSlash(page, `/history.backfill ${repo.fullName}`)
      const backfill = await backfilled
      receipts["backfillRefusal"] = { status: backfill.status(), body: await backfill.text() }
      expect(backfill.status()).toBeGreaterThanOrEqual(400)
      expect(backfill.status()).toBeLessThan(500)
      await expect(card.locator('[data-testid="stack-failure"][data-act="backfill"]')).toBeVisible({ timeout: 60_000 })
      expect((await readStack(page, request, repo)).items ?? []).toEqual([])

      // Retrying an item the history does not hold is refused, and nothing changes.
      const missing = "00000000-0000-4000-8000-000000000000"
      const retried = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === stackPath(repo, `/items/${missing}/retry`))
      await runSlash(page, `/history.retry ${missing} ${repo.fullName}`)
      const retry = await retried
      receipts["retryRefusal"] = { status: retry.status(), body: await retry.text() }
      expect(retry.status()).toBe(404)
      await expect(card.locator('[data-testid="stack-failure"][data-act="retry"]')).toBeVisible({ timeout: 60_000 })
      expect((await readStack(page, request, repo)).items ?? []).toEqual([])

      // Reload: the card shows what the service holds.
      await reloadApp(page)
      await runSlash(page, `/history.show ${repo.fullName}`)
      const reloaded = stackCard(page, repo)
      await expect(reloaded.getByTestId("stack-card")).toHaveAttribute("data-stack-state", "active")
      await expect(reloaded.getByTestId("stack-lane-count")).toHaveText("0/4 lanes")
      receipts["final"] = await readStack(page, request, repo)
    } finally {
      await attachJson(testInfo, "history-bootstrap-show-parallel", { ...receipts, writes })
    }
  })
})

/** File an issue on the GitHub source through GitHub's own form, labeled as the skip label `question`. */
const fileGitHubQuestion = async (github: Page, url: string, title: string): Promise<number> => {
  await github.goto(`${url}/issues/new?${new URLSearchParams({ title, labels: "question" })}`, { waitUntil: "domcontentloaded" })
  const titleInput = github.getByRole("textbox", { name: /^(Add a )?title/i }).first()
  await expect(titleInput).toHaveValue(title, { timeout: 30_000 })
  await github.getByRole("button", { name: /^(Create|Submit new issue)$/ }).last().click()
  await github.waitForURL((candidate) => /\/issues\/\d+$/.test(candidate.pathname), { timeout: 60_000 })
  const number = Number(/\/issues\/(\d+)$/.exec(new URL(github.url()).pathname)![1])
  await expect(github.getByRole("link", { name: "question", exact: true }).first()).toBeVisible({ timeout: 30_000 })
  return number
}

authenticatedTest("history backfill on an imported GitHub repository admits its open issue, and retry refuses it", scenario("history.production-backfill-retry", {
  capabilities: ["identity", "cloud", "github"],
  coverage: [
    "action:history.bootstrap", "action:history.backfill", "action:history.retry", "action:history.show",
    "host:production", "path:success", "path:error",
    "door:slash", "dimension:authenticated-private-repository", "dimension:duplicate-input",
    "evidence:stack-snapshot-readback"
  ],
  description: "An owned GitHub source with one open issue labeled question is imported; the history is created, backfill admits the issue as skipped (by the service's own reason) and a repeated backfill adds nothing, and retrying the skipped issue is refused while the service still holds it skipped."
}), async ({ page, context, request }, testInfo) => {
  testInfo.setTimeout(1_200_000)
  await withOwnedImportedRepository({ page, context, request }, testInfo, async (fixture) => {
    const repo: OwnedRepository = { name: fixture.repo.split("/")[1]!, fullName: fixture.repo, path: repositoryApiPath(fixture.repo) }
    const title = `History backfill ${Date.now().toString(36)}`
    const receipts: Record<string, unknown> = { repo: repo.fullName, title }
    const writes = observeStackWrites(page, repo)
    try {
      const number = await fileGitHubQuestion(fixture.github.page, fixture.github.url, title)
      receipts["issue"] = number

      await runSlash(page, `/history.bootstrap ${repo.fullName}`)
      await expect(toast(page, "ok", "History ready")).toBeVisible({ timeout: 300_000 })
      expect((await readStack(page, request, repo)).state).toBe("active")
      // Hold the history to one lane before anything is admitted.
      await runSlash(page, `/history.parallel 1 ${repo.fullName}`)
      await expect.poll(async () => (await readStack(page, request, repo)).limits?.maxParallel, { timeout: 60_000 }).toBe(1)

      const admitted = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === stackPath(repo, "/backfill"), { timeout: 120_000 })
      await runSlash(page, `/history.backfill ${repo.fullName}`)
      const backfill = await admitted
      receipts["backfill"] = { status: backfill.status() }
      expect(backfill.status()).toBe(202)
      await expect(toast(page, "ok", "Issues admitted")).toBeVisible({ timeout: 120_000 })
      const after = await readStack(page, request, repo)
      const items = (after.items ?? []).filter((item) => item.issue?.number === number)
      receipts["items"] = after.items
      expect(items).toHaveLength(1)
      expect(items[0]!.state).toBe("skipped")
      const item = items[0]!

      await runSlash(page, `/history.show ${repo.fullName}`)
      const card = stackCard(page, repo as OwnedRepository)
      await expect(card.getByTestId("stack-card")).toHaveAttribute("data-stack-state", "active")
      await expect(card).toContainText(title)

      // The same backfill again admits nothing new.
      const again = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === stackPath(repo, "/backfill"), { timeout: 120_000 })
      await runSlash(page, `/history.backfill ${repo.fullName}`)
      expect((await again).status()).toBe(202)
      await expect.poll(async () => (await readStack(page, request, repo)).items?.filter((row) => row.issue?.number === number).length).toBe(1)

      // A skipped issue is admission's to decide, not retry's: the service refuses it and nothing changes.
      const retried = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === stackPath(repo, `/items/${item.id}/retry`))
      await runSlash(page, `/history.retry ${item.id} ${repo.fullName}`)
      const retry = await retried
      receipts["retryRefusal"] = { status: retry.status(), body: await retry.text() }
      expect(retry.status()).toBe(409)
      await expect(card.locator('[data-testid="stack-failure"][data-act="retry"]')).toBeVisible({ timeout: 60_000 })
      const final = await readStack(page, request, repo)
      expect(final.items?.find((row) => row.id === item.id)?.state).toBe("skipped")
      receipts["final"] = final
    } finally {
      await attachJson(testInfo, "history-backfill-retry", { ...receipts, writes })
    }
  })
})
