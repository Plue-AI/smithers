import type { Locator, Page, Response } from "@playwright/test"
import { appReady, awaitBoot, openApp } from "../support/test"

export const productionRepository = "codeplanesmithers/canary-sandbox"

export const bootRunWorkbench = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

export const workflowRpcPosts = (page: Page): string[] => {
  const procedures: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/workflow/rpc") return
    const body = request.postDataJSON() as { readonly procedure?: unknown }
    procedures.push(typeof body.procedure === "string" ? body.procedure : "<missing>")
  })
  return procedures
}

export const runCards = (page: Page) => page.locator('.smithers-card[data-kind="run-trace"]')

export const runCard = (page: Page, runId: string): Locator =>
  page.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${runId}"]`)

export const waitForGatewayProcedure = (page: Page, procedure: string, repo?: string, timeout = 180_000): Promise<Response> =>
  page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
    const body = response.request().postDataJSON() as { readonly procedure?: unknown; readonly repo?: unknown }
    return body.procedure === procedure && (repo === undefined || body.repo === repo)
  }, { timeout })
