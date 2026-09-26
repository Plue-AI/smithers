import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { buildPullRequestReview } from "../src/github/buildPullRequestReview.ts";
import { listPullRequestFiles } from "../src/github/listPullRequestFiles.ts";
import { resolvePullRequest } from "../src/github/resolvePullRequest.ts";
import { runGh } from "../src/github/runGh.ts";
import { Review } from "../src/workflow/reviewFlow.ts";
import { layerMemory } from "../src/workflow/reviewLayer.ts";
import { reviewSeatResolver } from "../src/workflow/reviewSeatResolver.ts";
import { resolveReviewSeats } from "../src/workflow/reviewSeats.ts";
import { GH_CREDENTIAL_REASON, ghCredentialsAvailable, liveSuiteGate } from "./support/liveSuite.ts";
import { scriptedSeats } from "./workflow/scriptedSeats.ts";

/**
 * A real end-to-end review of a real pull request against live GitHub.
 *
 * The GitHub half is never faked: the PR is resolved, its files are listed,
 * and its head is fetched with the `gh` CLI, which authenticates from
 * `GITHUB_TOKEN`/`GH_TOKEN` or from a `gh auth login` session. The model half
 * is credentialed separately: a live seat runs when `ANTHROPIC_API_KEY` or
 * `OPENAI_API_KEY` is present, and a scripted seat otherwise, so the GitHub
 * contract is exercised even when no inference budget is available. With only
 * `OPENAI_API_KEY`, point `SMITHERS_REVIEW_SEAT` and
 * `SMITHERS_REVIEW_CHEAP_SEAT` at `openai:` seats, as for the CLI.
 *
 * `SMITHERS_REVIEW_E2E_PR` names the pull request (an `owner/repo#number` or a
 * URL); it defaults to a small, long-lived public PR.
 */
const DEFAULT_PR = "https://github.com/cli/cli/pull/9000";

// Printed, not silent: a suite that skips has to say what it did not prove.
const enabled = liveSuiteGate({
  tag: "review e2e",
  enabled: ghCredentialsAvailable(),
  reason: GH_CREDENTIAL_REASON,
});

const tempDirs: string[] = [];
afterAll(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

/**
 * Whether the model half runs live too.
 *
 * Opt-in and separately credentialed, because inference costs money and its
 * absence must not make the GitHub contract untestable. The default seat is
 * scripted, and it answers with a finding anchored to a line GitHub's own patch
 * reports as commentable, so the whole chain — real diff, real patch, real
 * anchor validation — is exercised either way.
 */
const liveSeat = process.env.SMITHERS_REVIEW_E2E_LIVE_MODEL === "1" &&
  Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());

const liveSeats = liveSeat ? resolveReviewSeats(process.env) : undefined;

/** A seat layer: live when opted into and credentialed, scripted otherwise. */
function seats(anchors: ReadonlyMap<string, number>) {
  if (liveSeats) return reviewSeatResolver(liveSeats, process.env);
  return scriptedSeats((ask) => {
    const path = [...anchors.keys()].find((candidate) => ask.includes(candidate));
    const line = path === undefined ? 0 : anchors.get(path) ?? 0;
    return {
      status: "success",
      message: "",
      summary: null,
      warnings: [],
      comments: path === undefined || line === 0 ? [] : [
        {
          path,
          content: "Scripted finding: this anchor comes from the pull request's own patch.",
          severity: "minor",
          category: "correctness",
          confidence: "plausible",
          startLine: line,
          endLine: line,
          existingCode: "",
          suggestionCode: "",
          thinking: "",
        },
      ],
    };
  });
}

describe.skipIf(!enabled)("review a real pull request (live GitHub)", () => {
  test("resolves the PR, reviews its real diff, and anchors findings to commentable lines", async () => {
    const target = process.env.SMITHERS_REVIEW_E2E_PR?.trim() || DEFAULT_PR;
    const owner = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target);
    const slug = owner ? `${owner[1]}/${owner[2]}` : target.split("#")[0];
    const dir = mkdtempSync(join(tmpdir(), "review-pr-e2e-"));
    tempDirs.push(dir);

    // A real clone of a real repository, shallow around the PR's own commits.
    const repoDir = join(dir, "repo");
    await runGh(dir, ["repo", "clone", slug, repoDir, "--", "--filter=blob:none", "--no-checkout"]);

    const pr = await resolvePullRequest(repoDir, target);
    expect(pr.number).toBeGreaterThan(0);
    expect(pr.headSha).toMatch(/^[0-9a-f]{40}$/);

    // The PR head and base must both exist locally, and they must share
    // history: the review diffs a range through `git merge-base`, so a shallow
    // fetch of each end would leave no common ancestor to find. The clone is
    // blobless rather than shallow for exactly that reason.
    execFileSync("git", ["fetch", "origin", `refs/pull/${pr.number}/head:refs/smithers-review/head`], {
      cwd: repoDir,
      stdio: "pipe",
    });
    // The base branch's tip is the wrong end for a merged PR: the head would
    // already be an ancestor of it and the range would be empty. GitHub records
    // the exact commit the PR was opened against, so ask for that.
    const base = (
      JSON.parse(
        await runGh(repoDir, ["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, "--jq", "{sha: .base.sha}"]),
      ) as { sha: string }
    ).sha;
    execFileSync("git", ["fetch", "origin", base], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["checkout", "--detach", "refs/smithers-review/head"], { cwd: repoDir, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

    const prFiles = await listPullRequestFiles(repoDir, pr);
    expect(prFiles.size).toBeGreaterThan(0);

    // One real commentable line per file, straight out of GitHub's patch.
    const anchors = new Map<string, number>();
    for (const [path, file] of prFiles) {
      const first = [...file.commentableLines].sort((left, right) => left - right)[0];
      if (first !== undefined) anchors.set(path, first);
    }
    expect(anchors.size).toBeGreaterThan(0);

    const out = join(dir, "walkthrough.html");
    const result = await Effect.runPromise(
      Review.execute(
        {
          repo: repoDir,
          from: base,
          to: head,
          narrate: false,
          quiz: "off",
          verify: false,
          concurrency: 2,
          out,
        } as never,
        { executionId: `review-pr-e2e-${pr.number}-${Date.now()}` },
      ).pipe(Effect.provide(layerMemory(seats(anchors), process.env)), Effect.orDie),
    );

    console.log(
      `[review e2e] ${slug}#${pr.number}: seat=${liveSeats ? liveSeats.review : "scripted"} ` +
        `status=${result.review.status} ` +
        `files=${result.walkthrough.files} findings=${result.review.comments.length} ` +
        `warnings=${result.review.warnings.map((warning) => warning.type).join(",") || "none"}`,
    );

    // The review read the PR's real diff: its target is the PR's own range and
    // the walkthrough covers files GitHub also reports as changed.
    expect(result.target.mode).toBe("range");
    expect(result.walkthrough.files).toBeGreaterThan(0);
    const reviewedPaths = new Set(result.review.comments.map((comment) => comment.path));
    expect(reviewedPaths.size).toBeGreaterThan(0);
    for (const path of reviewedPaths) expect(prFiles.has(path)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("<!doctype html>");
    // Every file review failing means the seat never answered. That is a
    // configuration failure of this test, not a review with no findings, so it
    // must not read as a pass.
    expect(result.review.status).not.toBe("failed");

    // The payload the CLI would post: every inline comment anchors to a line
    // GitHub's own patch says is commentable.
    const payload = buildPullRequestReview({
      story: result.story,
      findings: [...result.review.comments],
      prFiles,
      headSha: pr.headSha,
      quiz: result.quiz,
      reviewStatus: result.review.status,
      warnings: [...result.review.warnings],
    });
    expect(payload.commit_id).toBe(pr.headSha);
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments.length).toBeGreaterThan(0);
    for (const comment of payload.comments) {
      expect(prFiles.get(comment.path)?.commentableLines.has(comment.line)).toBe(true);
    }
  }, 900_000);
});
