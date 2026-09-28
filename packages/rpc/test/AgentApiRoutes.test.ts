import { describe, expect, test } from "vitest"
import { publicRepoActivityPath } from "../src/AgentApiRoutes.ts"

describe("public repository activity paths (unit)", () => {
  test.each([
    ["smithersai/smithers", "/api/public/repos/smithersai/smithers/activity"],
    ["WillCory/my.repo", "/api/public/repos/WillCory/my.repo/activity"],
    ["my-team/my_repo", "/api/public/repos/my-team/my_repo/activity"]
  ])("formats repository %s without changing its owner or name", (repo, expected) => {
    expect(publicRepoActivityPath(repo)).toBe(expected)
  })
})
