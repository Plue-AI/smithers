import type { Locator, Page, Response } from "@playwright/test"
import { appEntryPath, appReady, awaitBoot, expect } from "../support/test"

import { assertTurnTrafficProtocol, inspectTurnTraffic } from "./traffic"
import type { TurnFrame, TurnTrafficOptions } from "./traffic"
export { parseTurnFrames } from "./traffic"
export type { TurnFrame } from "./traffic"

export const transcript = (page: Page): Locator => page.getByTestId("transcript")

export const assistantMessages = (page: Page): Locator =>
  transcript(page).locator('.smithers-chat-message[data-role="assistant"]')

/** Enter the actual workbench. Tutorial completion is a separate UI feature. */
export const bootWorkspace = async (page: Page, origin?: string): Promise<void> => {
  const startedAt = performance.now()
  const entry = process.env.SMITHERS_REAL_E2E_HOST === "production" ? appEntryPath() : "/smithersai/smithers"
  await page.goto(origin ? new URL(entry, origin).toString() : entry, { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

export const frameLocation = (page: Page): Promise<{ readonly workspaceId: string; readonly branchId: string; readonly frameId: string }> =>
  page.evaluate(() => {
    const state = history.state as { location?: { workspaceId?: unknown; branchId?: unknown; frameId?: unknown } } | null
    const location = state?.location
    if (typeof location?.workspaceId !== "string" || typeof location.branchId !== "string" || typeof location.frameId !== "string") throw new Error("The app has not written its durable frame pointer")
    return { workspaceId: location.workspaceId, branchId: location.branchId, frameId: location.frameId }
  })

export const completedAssistantContaining = async (page: Page, text: string): Promise<Locator> => {
  const answer = assistantMessages(page).filter({ hasText: text }).last()
  await expect(answer).toBeVisible({ timeout: 90_000 })
  await expect(answer.locator(".bubble-system-note")).toHaveCount(0)
  await expect(transcript(page)).toHaveAttribute("aria-busy", "false")
  return answer
}

const isTurnResponse = (response: Response): boolean => {
  const url = new URL(response.url())
  return response.request().method() === "POST" && url.pathname === "/api/agent/turn"
}

export const nextTurnResponse = (page: Page, timeout = 30_000): Promise<Response> =>
  page.waitForResponse(isTurnResponse, { timeout })

const captureTrafficBytes = async (page: Page, pathname: string, complete: (body: string) => boolean, validateHeaders?: (headers: Readonly<Record<string, unknown>>) => void): Promise<{
  readonly read: () => Promise<readonly string[]>
}> => {
  // The application cancels its stream reader after the terminal frame. Chromium
  // may discard that response body, so observe bytes as they arrive via CDP.
  // Network observation does not replace or intercept requests or responses.
  const session = await page.context().newCDPSession(page)
  const requests = new Set<string>()
  const bodies = new Map<string, { prefix: Buffer; chunks: Buffer[]; ready: Promise<void>; error?: unknown }>()
  session.on("Network.requestWillBeSent", (event: { requestId: string; request: { method: string; url: string } }) => {
    if (event.request.method === "POST" && new URL(event.request.url).pathname === pathname) requests.add(event.requestId)
  })
  session.on("Network.responseReceived", (event: { requestId: string; response: { headers: Record<string, unknown> } }) => {
    if (!requests.has(event.requestId)) return
    const body = { prefix: Buffer.alloc(0), chunks: [] as Buffer[], ready: Promise.resolve(), error: undefined as unknown }
    bodies.set(event.requestId, body)
    try { validateHeaders?.(event.response.headers) } catch (error) { body.error = error }
    body.ready = session.send("Network.streamResourceContent", { requestId: event.requestId }).then((result: { bufferedData: string }) => {
      body.prefix = Buffer.from(result.bufferedData, "base64")
    }, (error: unknown) => { body.error = error })
  })
  session.on("Network.dataReceived", (event: { requestId: string; data?: string }) => {
    if (event.data !== undefined) bodies.get(event.requestId)?.chunks.push(Buffer.from(event.data, "base64"))
  })
  await session.send("Network.enable")
  const text = (): string[] => [...bodies.values()].map((body) => Buffer.concat([body.prefix, ...body.chunks]).toString("utf8"))
  return {
    read: async () => {
      try {
        await expect.poll(() => bodies.size, { timeout: 10_000 }).toBeGreaterThan(0)
        await Promise.all([...bodies.values()].map((body) => body.ready))
        await expect.poll(() => {
          for (const body of bodies.values()) if (body.error !== undefined) throw body.error
          return text().every(complete)
        }, { timeout: 10_000 }).toBe(true)
        return text()
      } finally { await session.detach() }
    }
  }
}

export const captureTurnTraffic = (page: Page, options: TurnTrafficOptions = {}) => captureTrafficBytes(page, "/api/agent/turn",
  body => inspectTurnTraffic(body, options).complete,
  headers => assertTurnTrafficProtocol(headers, options.protocol ?? "journal-v1"))

export const captureCancelReply = (page: Page) => captureTrafficBytes(page, "/api/agent/turn/cancel", (body) => {
  if (body.trim() === "") return false
  try { JSON.parse(body); return true } catch { return false } // A partial network chunk is not a complete JSON reply.
})


export const toolExecution = (
  frames: readonly TurnFrame[],
  flow: string
): { readonly action?: unknown; readonly name?: unknown; readonly args?: unknown } | undefined => {
  for (const frame of frames) {
    if (frame.type !== "tool_call" || frame.name !== "commands" || typeof frame.arguments !== "string") continue
    const input = JSON.parse(frame.arguments) as { readonly action?: unknown; readonly name?: unknown; readonly args?: unknown }
    if (input.action === "execute" && input.name === flow) return input
  }
  return undefined
}
