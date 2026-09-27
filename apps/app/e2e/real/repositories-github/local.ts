import type { Page, TestInfo } from "@playwright/test"
import {
  awaitBoot,
  closeComposer,
  command,
  expect
} from "../support/test"

export const bootRepositoryWorkbench = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await page.goto("/smithersai/smithers", { waitUntil: "domcontentloaded" })
  await expect(page).toHaveURL(/\/smithersai\/smithers$/)
  await awaitBoot(page, "navigate", startedAt)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

export const enableVerboseEvidence = async (page: Page): Promise<void> => {
  await command(page, "/verbose")
  await expect(page.getByTestId("transcript")).toContainText("Verbose on")
}

export const expectFlowOutcome = async (
  page: Page,
  flow: string,
  args: string,
  outcome: "executed" | "failed"
): Promise<void> => {
  const invocation = `You ran /${flow}${args === "" ? "" : ` ${args}`}`
  await expect(page.locator(".tool-act-line").filter({ hasText: invocation }).last()).toContainText(`→ ${outcome}`)
}

export const attachJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

export const dismissComposer = closeComposer
