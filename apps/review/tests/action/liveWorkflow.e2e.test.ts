import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { gateEvent } from "../../action/src/gateEvent.ts";
import { runGh } from "../../src/github/runGh.ts";
import { GH_CREDENTIAL_REASON, ghCredentialsAvailable, liveSuiteGate } from "../support/liveSuite.ts";

/**
 * What `.github/workflows/pr-review.yml` and the reusable `review.yml` it calls do
 * with a real GitHub event.
 *
 * The workflow itself cannot be run from here: its first step mints a GitHub
 * OIDC token, which only Actions issues, and its review posts to a pull
 * request. What IS reachable is everything the workflow decides before it
 * spends anything, and this suite drives that against a real `pull_request`
 * event fetched live from GitHub: the gate's own decision, and the workflow
 * file's agreement with the action it calls.
 *
 * Skips with a named reason when the `gh` CLI has no credential.
 */
const enabled = liveSuiteGate({
  tag: "pr-review e2e",
  enabled: ghCredentialsAvailable(),
  reason: GH_CREDENTIAL_REASON,
});

/** This app's own directory: any real directory works as gh's cwd for an API call. */
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type WorkflowFile = {
  on: Record<string, { types?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    uses?: string;
    permissions?: Record<string, string>;
    steps?: Array<{ uses?: string }>;
    env?: Record<string, string>;
  }>;
};
const readWorkflow = (name: string) =>
  parse(readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), "utf8")) as WorkflowFile;
const workflow = readWorkflow("pr-review.yml");
const reusable = readWorkflow("review.yml");
const reviewPermissions = { "id-token": "write", contents: "read", "pull-requests": "write" };

describe("pr-review.yml", () => {
  test("calls main's reusable review workflow, the only token the service accepts", () => {
    // On pull_request this file comes from the pull request; its token names
    // review.yml@refs/heads/main only while it calls that workflow by name.
    expect(workflow.jobs.review.uses).toBe("smithersai/smithers/.github/workflows/review.yml@main");
    expect(workflow.jobs.review.steps).toBeUndefined();
    expect(Object.keys(workflow.jobs)).toEqual(["review"]);
  });

  test("grants exactly the three permissions the review needs, only to the review job", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.review.permissions).toEqual(reviewPermissions);
  });

  test("triggers only on the events the gate reviews", () => {
    // The gate skips every other pull_request action with a reason, so a
    // trigger the gate does not review is a job that starts and does nothing.
    expect(new Set(workflow.on.pull_request?.types)).toEqual(
      new Set(["opened", "synchronize", "reopened", "ready_for_review"]),
    );
    expect(workflow.on.issue_comment?.types).toEqual(["created"]);
  });

  test("carries no provider key or 0.x subscription secret", () => {
    expect(workflow.jobs.review.env).toBeUndefined();
    expect(reusable.jobs.review.env).toBeUndefined();
  });
});

describe("review.yml", () => {
  test("takes no inputs and runs main's action, never the pull request's action code", () => {
    // An input could redirect the token or change what runs; a local
    // `uses: ./…` would run the pull request's checkout with the identity.
    expect(reusable.on).toEqual({ workflow_call: null });
    expect(reusable.jobs.review.steps?.map((entry) => entry.uses)).toEqual(["smithersai/smithers/apps/review/action@main"]);
    expect(reusable.jobs.review.permissions).toEqual(reviewPermissions);
  });
});

describe.skipIf(!enabled)("the gate against a live GitHub pull request", () => {
  const target = process.env.SMITHERS_REVIEW_E2E_PR?.trim() || "https://github.com/cli/cli/pull/9000";
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target);
  const slug = match ? `${match[1]}/${match[2]}` : target.split("#")[0];
  const number = match ? Number(match[3]) : Number(target.split("#")[1]);

  /** The `pull_request` payload GitHub would hand the workflow, from the API. */
  async function livePullRequest(): Promise<Record<string, unknown>> {
    return JSON.parse(await runGh(PKG_ROOT, ["api", `repos/${slug}/pulls/${number}`])) as Record<string, unknown>;
  }

  test("reviews a real same-repo pull request and reports its number", async () => {
    const pr = await livePullRequest();
    const decision = await gateEvent({
      eventName: "pull_request",
      payload: { action: "synchronize", pull_request: pr },
    });
    expect(decision.run).toBe(true);
    if (decision.run) {
      expect(decision.prNumber).toBe(number);
      expect(decision.headSha).toMatch(/^[0-9a-f]{40}$/);
    }
  }, 120_000);

  test("skips the same real pull request when the action does not change the diff", async () => {
    const pr = await livePullRequest();
    const decision = await gateEvent({ eventName: "pull_request", payload: { action: "labeled", pull_request: pr } });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toContain("labeled");
  }, 120_000);

  test("the gate step writes the outputs the workflow's later steps read", async () => {
    // The real composite step, spawned the way action.yml spawns it.
    const dir = mkdtempSync(join(tmpdir(), "pr-review-gate-"));
    try {
      const eventPath = join(dir, "event.json");
      const outputPath = join(dir, "output");
      const pr = await livePullRequest();
      writeFileSync(eventPath, JSON.stringify({ action: "synchronize", pull_request: pr }));
      writeFileSync(outputPath, "");
      const gate = fileURLToPath(new URL("../../action/src/runGate.ts", import.meta.url));
      const result = spawnSync("bun", [gate], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
        },
      });
      expect(result.status).toBe(0);
      const written = readFileSync(outputPath, "utf8");
      expect(written).toContain("should-run=true");
      expect(written).toContain(`pr-number=${number}`);
      expect(written).toContain(`head-sha=${(pr.head as { sha: string }).sha}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
