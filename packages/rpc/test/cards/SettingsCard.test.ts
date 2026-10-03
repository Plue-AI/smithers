/**
 * Behavioral projection contract checks for Settings.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { SettingsCardSchema } from "../../src/SettingsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Settings.ts"

cardContract("Settings", SettingsCardSchema, fixtures)

describe("Settings capacity boundaries", () => {
  test.each(["machines", "max_machines", "parallel"] as const)(
    "%s accepts zero and rejects negative or fractional capacity",
    (field) => {
      const base = SettingsCardSchema.parse(fixtures.ready)
      for (const value of [0, 1, -1, 0.5]) {
        expect(SettingsCardSchema.safeParse({ ...base, [field]: value }).success).toBe(value === 0 || value === 1)
      }
    }
  )
})
