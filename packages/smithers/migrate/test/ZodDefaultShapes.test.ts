import { describe, expect, it } from "@effect/vitest"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

// Independently executed against the fixture's Zod 4.4.3: each default below
// bypasses earlier validation on missing/undefined input. Supplying the same
// fallback explicitly, or encoding it, fails. These need operator guidance;
// a printed decoder validating every default would silently change behavior.
describe("defaults outside the safe subset remain guided", () => {
  for (
    const field of [
      "z.object({ name: z.string() }).default({})",
      "z.array(z.string()).min(1).default([])",
      "z.literal(1).default(2)",
      "z.enum([\"a\"]).default(\"b\")",
      "z.string().min(5).default(\"abc\")"
    ]
  ) {
    it(`refuses automatic conversion of ${field}`, () => {
      const chain = `z.object({ value: ${field} })`
      expect(ZodSchemaHints.classify(chain)).toEqual({
        class: "guided",
        reason: "the chain uses a zod form outside the safe subset"
      })
      expect(ZodSchemaHints.print(chain)).toBeUndefined()
      expect(ZodSchemaHints.printField(field)).toBeUndefined()
    })
  }
})
