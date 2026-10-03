import { scenario } from "./coverage/types"
import { expect, test } from "./support"
import { openVehicleForm } from "./navigation-frames/cards"

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
    coverage: ["host:local", "host:production", "door:slash", "door:button", "path:success", "action:card.maximize", "action:form.set", "action:card.maximize", "action:card.minimize", "dimension:focus-restoration", "evidence:card-state"]
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

