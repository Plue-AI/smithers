/**
 * Behavioral projection contract checks for Setup.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { SetupCardSchema } from "../../src/SetupCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Setup.ts"

cardContract("Setup", SetupCardSchema, fixtures)

describe("Setup progress boundaries", () => {
  test.each(["source", "machine"] as const)("%s progress stays within zero to one hundred", (field) => {
    const base = SetupCardSchema.parse(fixtures.done)
    for (const value of [0, 0.5, 100, -0.001, 100.001, NaN, Infinity]) {
      const changed = structuredClone(base)
      changed[field].pct = value
      expect(SetupCardSchema.safeParse(changed).success).toBe(value >= 0 && value <= 100)
    }
  })
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.com"])(
    "rejects unsafe address %s",
    (url) => {
      const changed = structuredClone(fixtures.done)
      changed.address.addresses = [url]
      expect(SetupCardSchema.safeParse(changed).success).toBe(false)
    }
  )
})
