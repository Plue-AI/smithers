import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { appReady, awaitBoot, command, expect, openApp, openComposer, reloadApp, test } from "./support"
import { DRAFT_RECOVERY_STORAGE_KEY } from "../../src/mainview/state/DraftRecovery"

const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

test(
  "theme and palette survive an immediate reload",
  scenario("local-appearance-immediate-reload", {
    capabilities: [],
    description: "Reloads immediately after real appearance commands without a settling delay.",
    coverage: [
      "host:local", "host:production", "door:slash", "path:persistence", "action:appearance.theme",
      "action:appearance.dark-mode", "dimension:immediate-reload", "evidence:persisted-appearance-after-reload"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    await command(page, "/appearance.theme paper")
    const before = await page.locator("html").getAttribute("data-theme")
    await command(page, "/appearance.dark-mode")
    const expectedTheme = before === "dark" ? "light" : "dark"
    await expect(page.locator("html")).toHaveAttribute("data-theme", expectedTheme)
    await expect(page.locator("html")).toHaveAttribute("data-palette", "paper")
    await reloadApp(page)
    await expect(page.locator("html")).toHaveAttribute("data-theme", expectedTheme)
    await expect(page.locator("html")).toHaveAttribute("data-palette", "paper")
  }
)

test(
  "composer draft survives an immediate reload while the overlay stays closed",
  scenario("local-composer-draft-immediate-reload", {
    capabilities: [],
    coverage: [
      "host:local", "host:production", "door:user-only", "path:persistence", "action:palette.open",
      "dimension:composer-draft", "dimension:immediate-reload", "evidence:persisted-draft-after-reload"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    await openComposer(page)
    await page.getByTestId("composer-input").fill("draft survives immediate reload")
    await reloadApp(page)
    await expect(page.getByTestId("composer-input")).toBeHidden()
    await openComposer(page)
    await expect(page.getByTestId("composer-input")).toHaveValue("draft survives immediate reload")
  }
)

test(
  "multiline composer draft survives an immediate reload while the overlay stays closed",
  scenario("local-composer-multiline-draft-immediate-reload", {
    capabilities: [],
    coverage: [
      "host:local", "host:production", "door:user-only", "path:persistence", "action:palette.open",
      "dimension:composer-draft", "dimension:multiline", "dimension:immediate-reload",
      "evidence:persisted-multiline-draft-after-reload"
    ]
  }),
  async ({ page }) => {
    const draft = "first line\nsecond line"
    await boot(page)
    await openComposer(page)
    await page.getByTestId("composer-input").fill(draft)
    await reloadApp(page)
    await expect(page.getByTestId("composer-input")).toBeHidden()
    await openComposer(page)
    await expect(page.getByTestId("composer-input")).toHaveValue(draft)
  }
)

test(
  "clearing a durable composer draft survives an immediate reload while the overlay stays closed",
  scenario("local-composer-clear-immediate-reload", {
    capabilities: [],
    coverage: [
      "host:local", "host:production", "door:user-only", "path:persistence", "action:palette.open",
      "dimension:composer-draft", "dimension:clear-to-empty", "dimension:immediate-reload",
      "evidence:persisted-empty-draft-after-reload"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    await openComposer(page)
    await page.getByTestId("composer-input").fill("durable baseline")
    await page.waitForFunction(key => localStorage.getItem(key) === null, DRAFT_RECOVERY_STORAGE_KEY)
    await reloadApp(page)
    await expect(page.getByTestId("composer-input")).toBeHidden()
    await openComposer(page)
    await expect(page.getByTestId("composer-input")).toHaveValue("durable baseline")

    await page.getByTestId("composer-input").fill("")
    await reloadApp(page)
    await expect(page.getByTestId("composer-input")).toBeHidden()
    await openComposer(page)
    await expect(page.getByTestId("composer-input")).toHaveValue("")
  }
)
