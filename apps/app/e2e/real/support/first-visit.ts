import type { Page } from "@playwright/test"
import { expect } from "./test"

export const finishFirstVisit = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("composer-input")).toBeAttached()
}
