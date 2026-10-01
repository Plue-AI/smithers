import type { Locator, Page } from "@playwright/test"
import { appEntryPath, appReady, awaitBoot, closeComposer, command, expect, openApp } from "../support/test"
import type { FlowName } from "../../../src/mainview/flows/FlowName"

/*
 * THE FORM VEHICLE. The scenarios that open this form (navigation-frames.spec.ts,
 * navigation-recovery.spec.ts) are about card identity, frame history, tab
 * sessions and the physical OPFS database — not about the flow behind the
 * form. That flow is a VEHICLE, and it is chosen against three criteria,
 * never by convenience:
 *
 *   1. REGISTERED IN THE DEPLOYED BUILD. No release flag gates it, so a
 *      scenario driving it can honestly claim `host:production`.
 *   2. PROVIDER-FREE. Opening the form dials no model and no upstream, so a
 *      red here is the subject's fault and never a provider's.
 *   3. A REQUIRED INPUT. The form-draft, focus and fork scenarios need one
 *      field to hold an unfinished value across a frame transition.
 *
 * `tab.card` meets all three — `tabFlows` is registered unconditionally in
 * Flows.ts, its handler only reads local state, and its `cardId` field is
 * required — and a card id no card has refuses without mutating anything if
 * the form is ever submitted.
 *
 * The vehicle was `wiki.open`, then `tab.read` until the terminal and harness
 * tabs retired (#2229). Re-point FORM_VEHICLE_FLOW and FORM_VEHICLE_FIELD to
 * change the vehicle again; the card and field ids below derive from them.
 */
const FORM_VEHICLE_FLOW: FlowName = "tab.card"
const FORM_VEHICLE_FIELD = "cardId"
export const FORM_VEHICLE_CARD_ID = `card-form-${FORM_VEHICLE_FLOW}`
/** The vehicle's required field, for the scenarios that re-locate it on a page they booted themselves. */
export const FORM_VEHICLE_FIELD_TESTID = `flow-form-${FORM_VEHICLE_FIELD}`
export const PRACTICE_REPOSITORY = "practice:smithersai/hello-server"
export const LOCAL_REPOSITORY_PATH = "/smithersai/smithers"

export interface VehicleForm {
  readonly card: Locator
  /** The vehicle's one required field, holding whatever value the scenario put there. */
  readonly input: Locator
}

export interface FrameLocation {
  readonly workspaceId: string
  readonly branchId: string
  readonly frameId: string
}

export type ConversationEntry = (page: Page) => Promise<void>

/** `startedAt` is a reading taken before the navigation, so the boot's cost includes it. */
const expectAppReady = async (page: Page, startedAt = performance.now()): Promise<void> => {
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

/** Enter the configured real app surface; production's marketing root is never used. */
export const enterPortableApp = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await expectAppReady(page, startedAt)
}

/** Enter URL-pointer mode. This surface is local-only because production's root is marketing. */
export const enterUrlApp = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await page.goto("/w/workspace-main/b/branch-main/f/frame-root%3Abranch-main")
  await expectAppReady(page, startedAt)
  expect(decodedFramePath(page)).toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
}

/** Enter a canonical, slashless /owner/repo path whose frame pointer lives in history.state. */
export const enterCanonicalRepositoryApp = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  if (process.env.SMITHERS_REAL_E2E_HOST !== "production") await page.goto(LOCAL_REPOSITORY_PATH)
  await expectAppReady(page, startedAt)
  const expectedPath = process.env.SMITHERS_REAL_E2E_HOST === "production" ? appEntryPath() : LOCAL_REPOSITORY_PATH
  expect(new URL(page.url()).pathname).toBe(expectedPath)
  expect(new URL(page.url()).pathname.endsWith("/")).toBe(false)
}

/** Open the form vehicle through its real slash door and leave `value` unfinished in its required field. */
export const openVehicleForm = async (
  page: Page,
  value: string,
  enter: ConversationEntry = enterPortableApp
): Promise<VehicleForm> => {
  await enter(page)
  await command(page, `/${FORM_VEHICLE_FLOW}`)
  const card = page.getByTestId(FORM_VEHICLE_CARD_ID)
  const input = card.getByTestId(FORM_VEHICLE_FIELD_TESTID)
  await expect(card).toBeVisible()
  await expect(card.locator(`form[data-flow-name="${FORM_VEHICLE_FLOW}"]`)).toBeVisible()
  await closeComposer(page)
  await input.fill(value)
  await expect(input).toHaveValue(value)
  return { card, input }
}

/** Open the shipped practice issue stack. It proves local card behavior, not a provider call. */
export const openPracticeIssues = async (page: Page): Promise<Locator> => {
  if (process.env.SMITHERS_REAL_E2E_HOST === "production") {
    // The signed-out practice tests must not enter the private canary repo.
    const startedAt = performance.now()
    await page.goto(LOCAL_REPOSITORY_PATH)
    await expectAppReady(page, startedAt)
  } else await enterUrlApp(page)
  await command(page, `/issues.list open ${PRACTICE_REPOSITORY}`)
  await closeComposer(page)
  const card = page.getByTestId("card-practice-issues")
  await expect(card).toHaveAttribute("data-kind", "issue-list")
  return card
}

export const expectSameElement = async (locator: Locator, original: Awaited<ReturnType<Locator["elementHandle"]>>): Promise<void> => {
  if (original === null) throw new Error("The card disappeared before its component identity could be captured.")
  expect(await locator.evaluate((current, prior) => current === prior, original)).toBe(true)
}

export const decodedFramePath = (page: Page): string => decodeURIComponent(new URL(page.url()).pathname)

/** Read the frame location from a canonical repository page's real browser history entry. */
export const frameLocation = async (page: Page): Promise<FrameLocation> => page.evaluate(() => {
  const location: unknown = typeof history.state === "object" && history.state !== null
    ? (history.state as { readonly location?: unknown }).location
    : undefined
  if (typeof location !== "object" || location === null) throw new Error("history.state has no frame location.")
  const candidate = location as Partial<FrameLocation>
  if (typeof candidate.workspaceId !== "string" || typeof candidate.branchId !== "string" || typeof candidate.frameId !== "string") {
    throw new Error("history.state carries an invalid frame location.")
  }
  return { workspaceId: candidate.workspaceId, branchId: candidate.branchId, frameId: candidate.frameId }
})
