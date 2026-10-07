import type { Locator, Page, Response } from "@playwright/test"
import { appEntryPath, appReady, awaitBoot, expect } from "../support/test"

import { admittedReplyFrames, sharedPromptRequest, sharedStopRequest } from "./shared-traffic"
import { parseTurnFrames as parseFrames } from "./traffic"
import type { TurnFrame } from "./traffic"
export const parseTurnFrames = (bodies: readonly string[]) => parseFrames(bodies, { protocol: "legacy" })
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

const isTurnResponse = (response: Response): boolean =>
  sharedPromptRequest(response.request().method(), response.url())

export const nextTurnResponse = (page: Page, timeout = 30_000): Promise<Response> =>
  page.waitForResponse(isTurnResponse, { timeout })

/** Read the admitted reply from the same durable conversation the app projects. */
export const sharedReplyFrames = async (page: Page, admission: Response): Promise<readonly TurnFrame[]> => {
  expect(admission.status()).toBe(202)
  const receipt = await admission.json() as { turnId: string }
  const conversation = new URL(admission.url())
  conversation.pathname = conversation.pathname.replace(/\/prompt$/, "")
  let frames: readonly TurnFrame[] = []
  await expect.poll(async () => {
    const response = await page.context().request.get(conversation.toString())
    expect(response.status()).toBe(200)
    frames = admittedReplyFrames(await response.json(), receipt.turnId)
    return frames.at(-1)?.type === "done"
  }, { timeout: 90_000 }).toBe(true)
  // Validate the complete, ordered terminal reply; never synthesize frames.
  return parseTurnFrames([frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"])
}

export const captureTurnTraffic = async (page: Page) => {
  const admission = nextTurnResponse(page, 90_000)
  return { read: async () => [(await sharedReplyFrames(page, await admission)).map(frame => JSON.stringify(frame)).join("\n") + "\n"] }
}

export const isStopResponse = (response: Response): boolean =>
  sharedStopRequest(response.request().method(), response.url())

export const captureCancelReply = async (page: Page) => {
  const reply = page.waitForResponse(isStopResponse)
  return { read: async () => [await (await reply).text()] }
}

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
