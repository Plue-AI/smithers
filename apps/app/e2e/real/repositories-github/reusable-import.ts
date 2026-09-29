import { open, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { APIRequestContext, BrowserContext, Page, TestInfo } from "@playwright/test"
import { runSlash } from "../issues/local"
import { expect, realApi } from "../support/test"
import { attachProductionJson, bootProductionRepository, cloudRepoPath, deleteOwnedCloudRepository, waitForImportJobId } from "./production"
import { assertRetainedSource, RETAINED_GITHUB_ID, RETAINED_GITHUB_SOURCE } from "./reusable-source"

type Fixtures = { readonly page: Page; readonly request: APIRequestContext; readonly context: BrowserContext }

/** The lease survives a crashed process: an operator must investigate an abandoned import before removing it. */
export const withRetainedGitHubImport = async (
  { page, request, context }: Fixtures,
  testInfo: TestInfo,
  body: (repo: string) => Promise<void>
): Promise<void> => {
  const repo = RETAINED_GITHUB_SOURCE
  assertRetainedSource(repo, RETAINED_GITHUB_ID)
  const leasePath = join(tmpdir(), "smithers-e2e-retained-github-import-1384168397.lock")
  const lease = await open(leasePath, "wx")
  let submitted = false
  let jobId: string | undefined
  let settled = false
  let destinationCreated = false
  let cleanupFailed = false
  let failure: unknown
  try {
    await lease.writeFile(JSON.stringify({ repo, pid: process.pid }))
    const github = await context.newPage()
    try {
      await github.goto(`https://github.com/${repo}`, { waitUntil: "domcontentloaded" })
      const id = await github.locator('meta[name="octolytics-dimension-repository_id"]').getAttribute("content")
      assertRetainedSource(repo, id ?? "")
      if (process.env.SMITHERS_REAL_AUTH_KIND !== "application-token") {
        await expect(github.getByText("Private", { exact: true }).first()).toBeVisible()
      }
    } finally {
      await github.close()
    }

    const absent = await realApi(page, request, "GET", cloudRepoPath(repo))
    expect(absent.status(), "retained import requires an absent destination").toBe(404)
    await bootProductionRepository(page, repo)
    const starting = context.waitForEvent("response", { predicate: (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/github/import"
    })
    submitted = true
    await runSlash(page, `/repos.import ${repo}`)
    const start = await starting
    const payload = await start.json().catch(() => undefined) as { readonly importJobId?: unknown; readonly import_job_id?: unknown; readonly job_id?: unknown } | undefined
    const candidate = payload?.importJobId ?? payload?.import_job_id ?? payload?.job_id
    if (typeof candidate !== "string" || candidate === "") throw new Error("Retained import did not return an authoritative job id; preserve the destination.")
    jobId = candidate
    expect([200, 202]).toContain(start.status())
    const terminal = await waitForImportJobId(page, request, jobId)
    settled = true
    expect(terminal.status).toBe("ready")
    const destination = terminal.repository as { readonly owner?: unknown; readonly name?: unknown } | undefined
    if (typeof destination?.owner !== "string" || typeof destination.name !== "string") {
      throw new Error("Retained import completed without a repository destination; preserve it.")
    }
    expect(`${destination.owner}/${destination.name}`).toBe(repo)
    destinationCreated = true
    const mirror = await realApi(page, request, "GET", cloudRepoPath(repo))
    expect(mirror.status()).toBe(200)
    await attachProductionJson(testInfo, "retained-github-import", { repo, sourceId: RETAINED_GITHUB_ID, jobId, terminal, mirrorStatus: mirror.status() })
    await body(repo)
  } catch (error) {
    failure = error
  } finally {
    // Never delete the registered GitHub source. An ambiguous job or destination
    // is left intact for an operator instead of racing an in-flight import.
    if (submitted && jobId !== undefined && !settled) {
      try { await waitForImportJobId(page, request, jobId); settled = true } catch (error) { failure = new AggregateError([failure, error], "Retained import job could not be drained") }
    }
    if (destinationCreated && settled) {
      try { await deleteOwnedCloudRepository(page, request, repo) } catch (error) {
        cleanupFailed = true
        failure = new AggregateError([failure, error], "Retained import mirror cleanup failed")
      }
    }
    await lease.close()
    if (cleanupFailed || (submitted && (!settled || !destinationCreated))) {
      failure = new Error(`Retained import destination needs inspection; lease held at ${leasePath}`, { cause: failure })
    } else {
      await unlink(leasePath)
    }
  }
  if (failure !== undefined) throw failure
}
