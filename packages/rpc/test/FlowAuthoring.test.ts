import { describe, expect, test } from "vitest"
import {
  FLOW_AUTHORING_ENTRY,
  FLOW_AUTHORING_PACK,
  FLOW_AUTHORING_STAGES,
  flowAuthoringUnavailable
} from "../src/FlowAuthoring.ts"

describe("flow authoring pack (unit)", () => {
  test("names the public entry and keeps the six stages in pipeline order", () => {
    expect(FLOW_AUTHORING_ENTRY).toBe("create-flow")
    expect(FLOW_AUTHORING_STAGES).toEqual([
      "create-flow/clarify",
      "create-flow/provision",
      "create-flow/design",
      "create-flow/scaffold",
      "create-flow/fix",
      "create-flow/document"
    ])
    expect(FLOW_AUTHORING_PACK).toEqual([
      "create-flow",
      "create-flow/clarify",
      "create-flow/provision",
      "create-flow/design",
      "create-flow/scaffold",
      "create-flow/fix",
      "create-flow/document"
    ])
  })

  test.each([
    [
      "smithersai/smithers",
      "smithersai/smithers's workspace does not have the flow-authoring flow installed, so there is nothing to build your flow with yet. Update the workspace from Settings and run /flow.create again, or use /flow.list to see what it can run today."
    ],
    [
      "WillCory/my.repo",
      "WillCory/my.repo's workspace does not have the flow-authoring flow installed, so there is nothing to build your flow with yet. Update the workspace from Settings and run /flow.create again, or use /flow.list to see what it can run today."
    ]
  ])("names repository %s and both recovery commands when the pack is absent", (repo, expected) => {
    expect(flowAuthoringUnavailable(repo)).toBe(expected)
  })
})
