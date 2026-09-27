import { describe, expect, test } from "bun:test";
import {
  allowedWorkflowRefs,
  DEFAULT_TRUSTED_WORKFLOW_REF,
  isAllowedWorkflowRef,
  isTrustedWorkflow,
} from "../../src/server/sessions/trustedWorkflow.ts";

const main = DEFAULT_TRUSTED_WORKFLOW_REF;

describe("isTrustedWorkflow", () => {
  test("accepts the reusable review workflow at main, owner and repo in any case", () => {
    expect(isTrustedWorkflow(main, [main])).toBe(true);
    expect(isTrustedWorkflow("SmithersAI/Smithers/.github/workflows/review.yml@refs/heads/main", [main])).toBe(true);
  });

  test.each([
    ["the caller's own file at the pull request merge ref", "octo/widgets/.github/workflows/pr-review.yml@refs/pull/42/merge"],
    ["the trusted file at a pull request ref", "smithersai/smithers/.github/workflows/review.yml@refs/pull/42/merge"],
    ["the trusted file on a pushed branch", "smithersai/smithers/.github/workflows/review.yml@refs/heads/agent-work"],
    ["a branch that only starts with main", "smithersai/smithers/.github/workflows/review.yml@refs/heads/main-evil"],
    ["a tag named main", "smithersai/smithers/.github/workflows/review.yml@refs/tags/main"],
    ["a different workflow file at main", "smithersai/smithers/.github/workflows/pr-review.yml@refs/heads/main"],
    ["a file whose name only differs in case", "smithersai/smithers/.github/workflows/Review.yml@refs/heads/main"],
    ["the same path in a fork", "attacker/smithers/.github/workflows/review.yml@refs/heads/main"],
    ["a path outside .github/workflows", "smithersai/smithers/review.yml@refs/heads/main"],
    ["a claim with trailing text", `${main} `],
    ["an empty claim", ""],
    ["no ref", "smithersai/smithers/.github/workflows/review.yml"],
  ])("refuses %s", (_, claim) => {
    expect(isTrustedWorkflow(claim, [main])).toBe(false);
  });

  test.each([undefined, null, 42, ["x"], { ref: main }])("refuses a missing or non-string claim: %j", (claim) => {
    expect(isTrustedWorkflow(claim, [main])).toBe(false);
  });

  test("trusts only what a registration allows", () => {
    const own = "octo/widgets/.github/workflows/smithers-review.yml@refs/heads/main";
    const pinned = `smithersai/smithers/.github/workflows/review.yml@${"a".repeat(40)}`;
    expect(isTrustedWorkflow(own, [own, pinned])).toBe(true);
    expect(isTrustedWorkflow(pinned, [own, pinned])).toBe(true);
    expect(isTrustedWorkflow(main, [own, pinned])).toBe(false);
    expect(isTrustedWorkflow(main, [])).toBe(false);
  });
});

describe("allowed workflow refs", () => {
  test("NULL is the default; a stored list is used; a corrupt value allows nothing", () => {
    expect(allowedWorkflowRefs(null)).toEqual([main]);
    const own = "octo/widgets/.github/workflows/smithers-review.yml@refs/tags/v1";
    expect(allowedWorkflowRefs(JSON.stringify([own]))).toEqual([own]);
    for (const corrupt of ["", "{", "[]", '"x"', JSON.stringify(["octo/widgets/.github/workflows/a.yml@refs/pull/1/merge"])]) {
      expect(allowedWorkflowRefs(corrupt)).toEqual([]);
    }
  });

  test("an operator may register branches, tags and commit SHAs, never a pull request ref", () => {
    expect(isAllowedWorkflowRef(main)).toBe(true);
    expect(isAllowedWorkflowRef("octo/widgets/.github/workflows/r.yaml@refs/tags/v1.2.0")).toBe(true);
    expect(isAllowedWorkflowRef(`octo/widgets/.github/workflows/r.yml@${"0".repeat(40)}`)).toBe(true);
    expect(isAllowedWorkflowRef("octo/widgets/.github/workflows/r.yml@refs/pull/1/merge")).toBe(false);
    expect(isAllowedWorkflowRef("octo/widgets/.github/workflows/r.yml@main")).toBe(false);
    expect(isAllowedWorkflowRef("octo/widgets/.github/workflows/r.yml@abc123")).toBe(false);
    expect(isAllowedWorkflowRef(7)).toBe(false);
  });
});
