import { describe, expect, it } from "vitest"
import { isLegacyObjectModule } from "../src/internal/LegacyModule.ts"

const bytes = (source: string) => new TextEncoder().encode(source)

describe("retained Core object modules", () => {
  for (
    const [declaration, alias] of [
      ["import * as Flow from \"@smthrs/core/Flow\"", "Flow"],
      ["import * as Legacy from \"@smthrs/core/Flow\"", "Legacy"],
      ["import { Flow } from \"@smthrs/core\"", "Flow"],
      ["import { Digest, Flow as Legacy, Annotations } from \"@smthrs/core\"", "Legacy"]
    ]
  ) {
    it(`recognizes ${declaration}`, () => {
      expect(isLegacyObjectModule(bytes(`${declaration}; export default ${alias}.make({ name: "old" })`))).toBe(true)
      expect(isLegacyObjectModule(bytes(`${declaration}; export default ${alias}.make("new", {})`))).toBe(false)
    })
  }
  it("ignores non-Flow named imports and unrelated constructors", () => {
    expect(isLegacyObjectModule(bytes("import { Digest } from \"@smthrs/core\"; Digest.make({})"))).toBe(false)
    expect(isLegacyObjectModule(bytes("import { Flow } from \"@smthrs/flow\"; Flow.make({})"))).toBe(false)
  })
})
