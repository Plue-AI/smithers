import { scenario } from "./coverage/types"
import { expect, test } from "./support"
import { FORM_VEHICLE_CARD_ID, openVehicleForm } from "./navigation-frames/cards"

/*
 * Neither scenario here is about the flow behind the card. They are about
 * focus restoration across a maximize cycle and about a tab session's
 * lifecycle, so they ride the shared form vehicle — registered in the
 * deployed build, provider-free, one required input — that
 * navigation-frames/cards.ts owns and documents.
 */

test(
  "a card maximize and restore cycle preserves the selected card and focus",
  scenario("real-card-maximize-restore", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:slash", "door:button", "path:success", "action:tab.card", "action:form.set", "action:card.maximize", "action:card.minimize", "dimension:focus-restoration", "evidence:card-state"]
  }),
  async ({ page }) => {
    const { card } = await openVehicleForm(page, "recovery-maximize-restore")
    const maximize = card.getByRole("button", { name: "Maximize card", exact: true })
    await maximize.click()
    await expect(card).toHaveAttribute("data-maximized", "true")
    const restore = card.getByRole("button", { name: "Restore", exact: true })
    await expect(restore).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(card).toHaveAttribute("data-maximized", "false")
    await expect(card.getByRole("button", { name: "Maximize card", exact: true })).toBeFocused()
    await card.getByRole("button", { name: "Maximize card", exact: true }).click()
    await expect(card).toHaveAttribute("data-maximized", "true")
    await card.getByRole("button", { name: "Restore", exact: true }).click()
    await expect(card).toHaveAttribute("data-maximized", "false")
  }
)

test(
  "a maximized card can move to a tab session and close cleanly",
  scenario("real-card-tab-session-lifecycle", {
    capabilities: [],
    coverage: ["host:local", "host:production", "door:slash", "door:button", "path:success", "action:tab.card", "action:form.set", "action:card.maximize", "action:tab.card", "action:tab.select", "action:tab.close", "dimension:session-lifecycle", "evidence:tab-state"]
  }),
  async ({ page }) => {
    const { card } = await openVehicleForm(page, "recovery-tab-session")
    await card.getByRole("button", { name: "Maximize card", exact: true }).click()
    await expect(card.getByRole("button", { name: "Open in tab", exact: true })).toBeVisible()
    await card.getByRole("button", { name: "Open in tab", exact: true }).click()
    const body = page.getByTestId(`tab-body-${FORM_VEHICLE_CARD_ID}`)
    await expect(body).toBeVisible()
    await expect(body.getByTestId(FORM_VEHICLE_CARD_ID)).toBeVisible()
    await page.keyboard.press("Meta+w")
    await expect(page.getByTestId(`tab-body-${FORM_VEHICLE_CARD_ID}`)).toHaveCount(0)
  }
)
