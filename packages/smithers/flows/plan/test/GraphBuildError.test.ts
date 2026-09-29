import { describe, expect, it } from "vitest"
import { GraphBuildError, GraphBuildErrorCode, isFatalDiagnostic } from "../src/GraphBuildError.ts"

describe("GraphBuildError", () => {
  it("is a tagged error naming the site and the fix", () => {
    const error = new GraphBuildError({
      code: "recursion_requires_boundary",
      node: "counter/count-to-100",
      path: [],
      message: "A flow cannot call itself inline. Use .to() to hand off, or .child() for a boundary."
    })
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe("@smthrs/plan/GraphBuildError")
    expect(error.code).toBe("recursion_requires_boundary")
    expect(error.node).toBe("counter/count-to-100")
  })

  it("closes the code set", () => {
    expect(GraphBuildErrorCode.literals).toEqual([
      "planned_value_computed",
      "invalid_all_member",
      "invalid_join",
      "invalid_continuation",
      "recursion_requires_boundary",
      "placement_requires_boundary",
      "cyclic_payload",
      "payload_too_deep",
      "graph_too_deep",
      "duplicate_node",
      "invalid_priority",
      "invalid_payload",
      "unstable_callback",
      "effect_outside_envelope",
      "effect_mode_widening",
      "effect_tier_widening",
      "capability_outside_grant",
      "write_conflict",
      "missing_key_material",
      "dependency_cycle",
      "plan_too_large",
      "payload_too_large",
      "invalid_node"
    ])
  })

  it("makes exactly one code advisory", () => {
    const advisory = GraphBuildErrorCode.literals.filter((code) =>
      !isFatalDiagnostic(new GraphBuildError({ code, node: "n", path: [], message: "m" }))
    )
    expect(advisory).toEqual(["capability_outside_grant"])
  })
})
