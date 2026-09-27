import type { APIRequestContext, Locator, Page, Request } from "@playwright/test"
import { expect, realApi } from "../support/test"

export type GatewayAnswer = {
  readonly ok: boolean
  readonly payload?: unknown
  readonly error?: unknown
}

export type RunSummary = {
  readonly runId: string
  readonly flowId: string
  readonly status: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly verdict?: string
  readonly finalOutput?: unknown
}

export type RunTracker = {
  readonly runs: Set<string>
  readonly ambiguities: string[]
}

export const acceptedRunId = (
  page: Page,
  repo: string,
  tracker: RunTracker,
  timeout = 180_000
): Promise<string> => {
  const matchesRun = (request: Request): boolean => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/workflow/rpc") return false
    const body = request.postDataJSON() as { readonly repo?: unknown; readonly procedure?: unknown } | null
    return body?.repo === repo && body.procedure === "Run"
  }
  const pending = `Run request for ${repo} has no authoritative accepted id (${crypto.randomUUID()}).`
  const observeRequest = (request: Request): void => {
    if (!matchesRun(request)) return
    tracker.ambiguities.push(pending)
    page.off("request", observeRequest)
  }
  page.on("request", observeRequest)
  const accepted = (async () => {
    const response = await page.waitForResponse((candidate) => matchesRun(candidate.request()), { timeout })
    const answer = await response.json().catch(() => undefined) as GatewayAnswer | undefined
    const runId = typeof (answer?.payload as { readonly runId?: unknown } | undefined)?.runId === "string"
      ? (answer!.payload as { readonly runId: string }).runId
      : undefined
    if (runId !== undefined && runId !== "") {
      tracker.runs.add(runId)
      const index = tracker.ambiguities.indexOf(pending)
      if (index >= 0) tracker.ambiguities.splice(index, 1)
    }
    expect(response.status(), "Run HTTP status").toBe(200)
    expect(answer?.ok, `Run gateway answer: ${JSON.stringify(answer?.error)}`).toBe(true)
    expect(runId, "the accepted Run response must expose its exact server run id").toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/)
    return runId!
  })().finally(() => page.off("request", observeRequest))
  // A preceding UI assertion may fail before the caller reaches its await.
  // Keep the original rejection observable to callers without leaking an
  // unhandled waiter, and preserve any submitted request during teardown.
  void accepted.catch(() => undefined)
  return accepted
}

export const gatewayCall = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  procedure: string,
  payload: unknown,
  /** The box the call names: the relay refuses a call that names none. */
  workspaceId: string
): Promise<GatewayAnswer> => {
  const response = await realApi(page, request, "POST", "/api/workflow/rpc", {
    repo,
    procedure,
    payload,
    workspaceId
  })
  expect(response.status(), `${procedure} HTTP status`).toBe(200)
  const answer = await response.json() as GatewayAnswer
  expect(answer.ok, `${procedure} gateway answer: ${JSON.stringify(answer.error)}`).toBe(true)
  return answer
}

export const exactRunId = async (card: Locator): Promise<string> => {
  await expect(card).toBeVisible({ timeout: 180_000 })
  const runId = await card.getAttribute("data-run-id")
  expect(runId, "the accepted run card must expose its exact server run id").toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/)
  return runId!
}

export const runSummary = (answer: GatewayAnswer): RunSummary | undefined => {
  const rows = (answer.payload as { readonly rows?: ReadonlyArray<RunSummary> } | undefined)?.rows
  return rows?.[0]
}

export const waitForTerminalRun = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  runId: string,
  timeout: number,
  workspaceId: string
): Promise<RunSummary> => {
  let row: RunSummary | undefined
  await expect.poll(async () => {
    const answer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
      selector: { _tag: "run-summary", runId }
    }, workspaceId)
    row = runSummary(answer)
    if (row !== undefined && row.runId !== runId) throw new Error(`Projection for ${runId} returned row ${row.runId}.`)
    return row?.status
  }, { timeout, intervals: [1_000, 2_000, 5_000] }).toMatch(/^(completed|failed|cancelled)$/)
  if (row === undefined) throw new Error(`Run ${runId} reached no terminal projection.`)
  return row
}
