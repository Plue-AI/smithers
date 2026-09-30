import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_PATH, actionReferences, cutReviewRelease, isImmutablePin, pinWorkflow, publishCommand, reviewTag } from "../../scripts/review-release.mjs";
import { isAllowedWorkflowRef, isTrustedWorkflow } from "../../src/server/sessions/trustedWorkflow";

const liveWorkflow = readFileSync(new URL("../../../../.github/workflows/review.yml", import.meta.url), "utf8");
const sha = "0123456789abcdef0123456789abcdef01234567";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-release-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "apps/review/action"), { recursive: true });
  writeFileSync(join(dir, WORKFLOW_PATH), liveWorkflow);
  writeFileSync(join(dir, "apps/review/action/action.yml"), "name: review\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "tested revision");
  return dir;
}

describe("review release", () => {
  test("main's reusable workflow floats, so the tag needs the pinned release commit", () => {
    expect(actionReferences(liveWorkflow)).toEqual(["smithersai/smithers/apps/review/action@main"]);
    expect(isImmutablePin(actionReferences(liveWorkflow)[0])).toBe(false);
  });

  test("pinning replaces the one floating reference with the revision", () => {
    const refs = actionReferences(pinWorkflow(liveWorkflow, sha));
    expect(refs).toEqual([`smithersai/smithers/apps/review/action@${sha}`]);
    expect(refs.every(isImmutablePin)).toBe(true);
  });

  test("pinning refuses a short revision and a workflow without exactly one floating reference", () => {
    expect(() => pinWorkflow(liveWorkflow, "main")).toThrow("40-hex");
    expect(() => pinWorkflow(liveWorkflow, sha.slice(0, 39))).toThrow("40-hex");
    expect(() => pinWorkflow("steps: []\n", sha)).toThrow("found 0");
    expect(() => pinWorkflow(liveWorkflow + liveWorkflow, sha)).toThrow("found 2");
  });

  test("the tag never matches the npm publish trigger and needs a full x.y.z", () => {
    expect(reviewTag("1.0.0")).toBe("review-v1.0.0");
    expect(reviewTag("1.0.0").startsWith("v")).toBe(false);
    for (const bad of ["1.0", "v1.0.0", "1.0.0-rc.1", "", "1.0.0 "]) expect(() => reviewTag(bad)).toThrow("x.y.z");
  });

  test("the exact tagged workflow ref is registrable and trusted; unlisted and pull request refs are refused", () => {
    const exact = `smithersai/smithers/${WORKFLOW_PATH}@refs/tags/review-v1.0.0`;
    expect(isAllowedWorkflowRef(exact)).toBe(true);
    expect(isTrustedWorkflow(exact, [exact])).toBe(true);
    expect(isTrustedWorkflow(`smithersai/smithers/${WORKFLOW_PATH}@refs/tags/review-v1.0.1`, [exact])).toBe(false);
    expect(isTrustedWorkflow(`smithersai/smithers/${WORKFLOW_PATH}@refs/heads/main`, [exact])).toBe(false);
    expect(isAllowedWorkflowRef(`smithersai/smithers/${WORKFLOW_PATH}@refs/pull/7/merge`)).toBe(false);
  });

  test("cutting tags a child commit that differs only in the pinned workflow, action tree identical", () => {
    const dir = fixture();
    try {
      const head = git(dir, "rev-parse", "HEAD");
      const before = git(dir, "status", "--porcelain");
      const cut = cutReviewRelease({ version: "1.0.0", revision: "HEAD", cwd: dir });
      expect(cut.sha).toBe(head);
      expect(git(dir, "rev-parse", `${cut.commit}^`)).toBe(head);
      expect(git(dir, "cat-file", "-t", "review-v1.0.0")).toBe("tag");
      expect(git(dir, "rev-parse", "review-v1.0.0^{commit}")).toBe(cut.commit);
      expect(git(dir, "diff", "--name-only", head, cut.commit)).toBe(WORKFLOW_PATH);
      expect(git(dir, "rev-parse", `${head}:apps/review/action`)).toBe(git(dir, "rev-parse", `${cut.commit}:apps/review/action`));
      const pinned = git(dir, "show", `${cut.commit}:${WORKFLOW_PATH}`);
      expect(actionReferences(pinned)).toEqual([`smithersai/smithers/apps/review/action@${head}`]);
      expect(git(dir, "status", "--porcelain")).toBe(before);
      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
      expect(publishCommand(cut.tag)).toBe("git push origin refs/tags/review-v1.0.0");
      expect(() => cutReviewRelease({ version: "1.0.0", revision: "HEAD", cwd: dir })).toThrow("already exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
