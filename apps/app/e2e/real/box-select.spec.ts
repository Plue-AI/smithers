/*
 * Inbox reads stay scoped to one real branch. Multiple boxes refuse before
 * any RPC; a single remaining box or explicit repository selection supplies
 * the target, independently verified by the host's approvals readback.
 */
import type { APIRequestContext, Page, Request } from "@playwright/test"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, expect, productUrl, realApi } from "./support/test"
import { finishFirstVisit } from "./support/first-visit"
import { attachJson, runSlash } from "./issues/local"
import { withOwnedRepository } from "./portable/owned-repository"
import type { OwnedRepository } from "./portable/owned-repository"

type Box = { readonly id: string; readonly name: string; readonly path: string }
type WorkflowCall = { readonly path: string; readonly procedure?: string; readonly workspaceId?: string; readonly selector?: string; readonly body?: Record<string, unknown> }
type WorkflowAnswer = { readonly path: string; readonly status: number; readonly body: string }

const readStatus = async (page: Page, request: APIRequestContext, path: string): Promise<string | undefined> => {
  const response = await realApi(page, request, "GET", path)
  expect(response.status(), `read ${path}`).toBe(200)
  return (await response.json() as { readonly status?: string }).status
}

/** Create `names` as boxes of `repo`, settle each in `state`, and delete every box of `repo` afterwards. */
const withBoxes = async <T>(
  page: Page, request: APIRequestContext, repo: OwnedRepository, names: readonly string[], state: "running" | "suspended",
  use: (boxes: readonly Box[]) => Promise<T>
): Promise<T> => {
  const collection = `${repo.path}/workspaces`
  let bodyFailed = false
  let bodyError: unknown
  try {
    const boxes: Box[] = []
    for (const name of names) {
      const created = await realApi(page, request, "POST", collection, { name, source_bookmark: "main", kind: "container" })
      expect([201, 202], `create box ${name}: ${await created.text()}`).toContain(created.status())
      const id = (await created.json() as { readonly id?: unknown }).id
      expect(id).toEqual(expect.any(String))
      boxes.push({ id: id as string, name, path: `${collection}/${encodeURIComponent(id as string)}` })
    }
    for (const box of boxes) {
      await expect.poll(() => readStatus(page, request, box.path), { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toBe("running")
    }
    if (state === "suspended") {
      for (const box of boxes) expect((await realApi(page, request, "POST", `${box.path}/suspend`)).status(), `suspend ${box.name}`).toBe(200)
      for (const box of boxes) {
        await expect.poll(() => readStatus(page, request, box.path), { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).toBe("suspended")
      }
    }
    return await use(boxes)
  } catch (error) {
    bodyFailed = true
    bodyError = error
    throw error
  } finally {
    try {
      const listed = await realApi(page, request, "GET", collection)
      expect(listed.status()).toBe(200)
      for (const { id } of await listed.json() as ReadonlyArray<{ readonly id: string }>) {
        const path = `${collection}/${encodeURIComponent(id)}`
        expect((await realApi(page, request, "DELETE", path)).status()).toBe(204)
        expect((await realApi(page, request, "GET", path)).status()).toBe(404)
      }
    } catch (cleanupError) {
      if (bodyFailed) throw new AggregateError([bodyError, cleanupError], "box.select scenario and box cleanup failed")
      throw cleanupError
    }
  }
}

/** Every answer the host gives a box call, in order: the receipt a failed run leaves behind. */
const observeAnswers = (page: Page): WorkflowAnswer[] => {
  const answers: WorkflowAnswer[] = []
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname
    if (!path.startsWith("/api/workflow/")) return
    const body = await response.text().catch(() => "")
    answers.push({ path, status: response.status(), body: body.slice(0, 500) })
  })
  return answers
}

/** Every call the browser sends toward a box, in order. */
const observeWorkflow = (page: Page): WorkflowCall[] => {
  const calls: WorkflowCall[] = []
  page.on("request", (sent: Request) => {
    const path = new URL(sent.url()).pathname
    if (!path.startsWith("/api/workflow/")) return
    const body = (() => { try { return sent.postDataJSON() as Record<string, unknown> | null } catch { return null } })()
    const payload = body?.["payload"] as { readonly selector?: { readonly _tag?: string } } | undefined
    calls.push({
      path,
      ...(typeof body?.["procedure"] === "string" ? { procedure: body["procedure"] } : {}),
      ...(typeof body?.["workspaceId"] === "string" ? { workspaceId: body["workspaceId"] } : {}),
      ...(typeof payload?.selector?._tag === "string" ? { selector: payload.selector._tag } : {}),
      ...(body === null ? {} : { body })
    })
  })
  return calls
}

const inboxReads = (calls: readonly WorkflowCall[]): WorkflowCall[] =>
  calls.filter(call => call.procedure === "Projection.Snapshot" && call.selector === "approvals")

/** Open `repo` and wait until the app has read a box list that names every one of `boxes`. */
const openRepository = async (page: Page, repo: OwnedRepository, boxes: readonly Box[]): Promise<void> => {
  const lists = new Set(["/api/user/workspaces", `${repo.path}/workspaces`])
  const listed = page.waitForResponse(async (response) => {
    if (response.request().method() !== "GET" || !lists.has(new URL(response.url()).pathname) || response.status() !== 200) return false
    const text = await response.text()
    return boxes.every(box => text.includes(box.id))
  }, { timeout: 120_000 })
  const startedAt = performance.now()
  await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", startedAt)
  await finishFirstVisit(page)
  await listed
}

/** The chosen box answers the Inbox read, and the card says so; a second Submit reads nothing more. */
const expectInboxOnce = async (page: Page, request: APIRequestContext, repo: OwnedRepository, calls: WorkflowCall[], chosen: Box): Promise<Record<string, unknown>> => {
  const inbox = page.locator('.smithers-card[data-kind="approvals-inbox"]').last()
  await expect(inbox).toBeVisible({ timeout: 300_000 })
  await expect(inbox).toContainText(`No approvals are pending on ${repo.fullName}`, { timeout: 300_000 })
  const reads = inboxReads(calls)
  expect(reads.length).toBeGreaterThan(0)
  expect(calls.filter(call => call.workspaceId !== undefined && call.workspaceId !== chosen.id)).toEqual([])
  // Read the chosen box's Inbox again with the browser's own request: the host answers it, empty.
  expect(reads[0]!.workspaceId).toBe(chosen.id)
  const readback = await realApi(page, request, "POST", "/api/workflow/rpc", reads[0]!.body)
  expect(readback.status()).toBe(200)
  const readbackBody = await readback.json() as { readonly ok?: unknown; readonly payload?: { readonly rows?: unknown } }
  expect(readbackBody.ok).toBe(true)
  expect(readbackBody.payload?.rows).toEqual([])
  return { status: readback.status(), body: readbackBody, reads: reads.length }
}

authenticatedTest("Inbox scope: several running boxes, one gone by Submit", scenario("approvals.inbox-running-scope", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:approvals.list", "host:production", "path:success", "path:error",
    "door:slash", "dimension:ambiguous-box", "dimension:gone-box",
    "evidence:workflow-requests-and-inbox-readback"
  ],
  description: "Two running boxes: Inbox refuses an ambiguous scope without reading either; deleting one leaves a single live target whose Inbox is verified by independent readback."
}), async ({ page, request }, testInfo) => {
  testInfo.setTimeout(1_200_000)
  await withOwnedRepository(page, request, repo => withBoxes(page, request, repo, ["pick-a", "pick-b"], "running", async ([gone, chosen]) => {
    await openRepository(page, repo, [gone!, chosen!])
    const calls = observeWorkflow(page)
    const answers = observeAnswers(page)
    let readback: Record<string, unknown> | undefined
    try {
      await runSlash(page, `/approvals.list ${repo.fullName}`)
      await expect(page.getByText(`Select a box of ${repo.fullName} first.`).last()).toBeVisible()
      expect(calls).toEqual([])

      await runSlash(page, `/box.delete ${gone!.id} ${gone!.name}`)
      await expect.poll(async () => (await realApi(page, request, "GET", gone!.path)).status(), { timeout: 120_000 }).toBe(404)
      expect(calls).toEqual([])
      await runSlash(page, `/approvals.list ${repo.fullName}`)
      readback = await expectInboxOnce(page, request, repo, calls, chosen!)
    } finally {
      await attachJson(testInfo, "box-select-inbox-running", { repo: repo.fullName, gone: gone!.id, chosen: chosen!.id, calls, answers, readback })
    }
  }))
})

authenticatedTest("Inbox scope: several suspended boxes", scenario("approvals.inbox-suspended-scope", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:approvals.list", "action:repo.select", "host:production", "path:success",
    "door:slash", "dimension:resumable-box",
    "evidence:workflow-requests-and-inbox-readback"
  ],
  description: "Two suspended boxes: Inbox refuses an ambiguous scope without touching either; explicit repository branch selection scopes the read to one and leaves the other suspended."
}), async ({ page, request }, testInfo) => {
  testInfo.setTimeout(1_500_000)
  await withOwnedRepository(page, request, repo => withBoxes(page, request, repo, ["pick-a", "pick-b"], "suspended", async ([other, chosen]) => {
    await openRepository(page, repo, [other!, chosen!])
    const calls = observeWorkflow(page)
    const answers = observeAnswers(page)
    let readback: Record<string, unknown> | undefined
    try {
      await runSlash(page, `/approvals.list ${repo.fullName}`)
      await expect(page.getByText(`Select a box of ${repo.fullName} first.`).last()).toBeVisible()
      expect(calls).toEqual([])

      await runSlash(page, `/repo.select ${repo.fullName}#workspace:${chosen!.id}`)
      await runSlash(page, `/approvals.list ${repo.fullName}`)
      readback = await expectInboxOnce(page, request, repo, calls, chosen!)
      expect(await readStatus(page, request, other!.path)).toBe("suspended")
    } finally {
      await attachJson(testInfo, "box-select-inbox-suspended", { repo: repo.fullName, other: other!.id, chosen: chosen!.id, calls, answers, readback })
    }
  }))
})
