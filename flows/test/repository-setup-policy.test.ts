import assert from "node:assert/strict"
import { test } from "node:test"
import type { Check } from "../repository/schema.ts"
import { suggestedChecks } from "../repository/setup.ts"

const ai: typeof Check.Type = {
  id: "observability",
  name: "Observability",
  kind: "ai",
  policy: "required",
  paths: ["src/**"],
  rule: "Request handlers record structured success and failure telemetry."
}

test("generated AI checks start report-only while existing command policy is preserved", () => {
  const command: typeof Check.Type = { ...ai, id: "test", kind: "command", rule: "npm test" }
  assert.deepEqual(suggestedChecks([], [ai, command]), [{ ...ai, policy: "report" }, command])
  assert.equal(ai.policy, "required", "normalizing a suggestion cannot mutate the input")
})

test("inspection cannot promote an existing report check or silently rewrite a required rule", () => {
  assert.deepEqual(suggestedChecks([{ ...ai, policy: "report" }], [ai]), [{ ...ai, policy: "report" }])
  assert.deepEqual(
    suggestedChecks([ai], [{ ...ai, policy: "report" }]),
    [ai],
    "unchanged authored policy survives inspection"
  )
  for (
    const suggested of [{ ...ai, rule: "Require telemetry everywhere" }, { ...ai, paths: ["**"] }, {
      ...ai,
      id: "new-rule"
    }]
  ) {
    assert.deepEqual(suggestedChecks([ai], [suggested]), [{ ...suggested, policy: "report" }])
  }
  assert.deepEqual(
    suggestedChecks([{ ...ai, kind: "command" }], [ai]),
    [{ ...ai, policy: "report" }],
    "reusing a command ID cannot grant required AI policy"
  )
})
