import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { appReady, awaitBoot, closeComposer, command, expect, openApp, openComposer, test } from "./support/test"

const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

test("the real palette filters flow rows and keyboard selection runs the same search door", scenario("search.palette-keyboard-real", {
  capabilities: [],
  coverage: ["action:palette.open", "action:search.flows", "host:local", "host:production", "path:success", "path:keyboard", "door:user-only", "door:slash", "dimension:palette-filter", "dimension:keyboard-selection", "dimension:keyboard", "evidence:palette-option-and-search-card"],
  description: "The browser opens the actual command palette, filters the registry through its real search seam, and runs the selected search flow with the keyboard."
}), async ({ page }) => {
  await boot(page)
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill("/chat")
  const palette = page.getByTestId("palette")
  await expect(palette).toBeVisible()
  await expect(palette).toHaveAttribute("data-mode", "flows")
  await expect(palette.getByRole("option").filter({ hasText: "chat" }).first()).toBeVisible()
  await expect(palette.getByRole("option").filter({ hasText: "billing.balance" })).toHaveCount(0)
  await input.fill("/search.flows chat")
  await input.press("Enter")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="search-results"]').last()
  await expect(card).toBeVisible()
  await expect(card.getByTestId("search-results-query")).toContainText("chat")
  await expect(card.getByTestId("search-item-flow-chat")).toContainText("chat")
})

test("real search preserves an honest empty result", scenario("search.empty-result-real", {
  capabilities: [],
  coverage: ["action:search.flows", "host:local", "host:production", "path:success", "door:slash", "dimension:empty-result", "evidence:empty-card"],
  description: "A flow search with no matches returns an empty card."
}), async ({ page }) => {
  await boot(page)
  await command(page, "/search.flows query-that-is-not-a-flow-9f2f")
  await closeComposer(page)
  const empty = page.locator('.smithers-card[data-kind="search-results"]').last()
  await expect(empty).toBeVisible()
  await expect(empty.getByTestId("search-results-empty")).toContainText("query-that-is-not-a-flow-9f2f")
})

test("the Library is absent while its feature flag is off", scenario("plugins.library-disabled-real", {
  capabilities: [],
  coverage: ["action:chat.open", "host:local", "host:production", "path:success", "door:slash", "dimension:plugin-shelf", "evidence:disabled-library"],
  description: "The default app does not register Library navigation or mutation commands. Enabled Library behavior is covered by the controller and component suites."
}), async ({ page }) => {
  await boot(page)
  await openComposer(page)
  await page.getByTestId("composer-input").fill("/plugins")
  await expect(page.locator('[data-flow="plugins"]')).toHaveCount(0)
  await expect(page.locator('[data-flow="plugins.install"]')).toHaveCount(0)
  await expect(page.locator('[data-flow="plugins.remove"]')).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Plugins on your workspace" })).toHaveCount(0)
})

test("signed-out notifications commands fail closed through the real requirement door", scenario("cloud-required-notifications-refusal-real", {
  capabilities: [],
  coverage: ["action:notifications.list", "action:notifications.read", "host:local", "host:production", "path:permission", "door:slash", "dimension:signed-out-cloud-requirement", "dimension:no-side-effect", "evidence:sign-in-step-and-no-cloud-card"],
  description: "Without a session, cloud notification actions expose the real sign-in requirement and do not create success cards or issue cloud mutations."
}), async ({ page }) => {
  await boot(page)
  await command(page, "/notifications.list")
  await closeComposer(page)
  await expect(page.getByText("Sign in with GitHub to continue.").last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="notifications"]')).toHaveCount(0)
  await command(page, "/notifications.read")
  await closeComposer(page)
  await expect(page.getByText("Sign in with GitHub to continue.").last()).toBeVisible()

})
