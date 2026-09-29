import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PullRequestReviewPayload } from "../../src/github/buildPullRequestReview.ts";
import { listPullRequestFiles, type PullRequestFile } from "../../src/github/listPullRequestFiles.ts";
import { postPullRequestReview } from "../../src/github/postPullRequestReview.ts";
import { resolvePullRequest, type PullRequestTarget } from "../../src/github/resolvePullRequest.ts";

type GhCall = {
  repoDir: string;
  args: string[];
  stdin?: string;
};

const ghCalls: GhCall[] = [];
const ghResponses: Array<string | Error> = [];

// Injected directly into the helpers (they accept runGh as a parameter). This
// avoids `mock.module`, which is process-global in bun and leaks across test
// files (on Linux it would replace the real runGh for runGh.test.ts).
const runGhMock = mock(async (repoDir: string, args: string[], stdin?: string) => {
  ghCalls.push({ repoDir, args, stdin });
  const response = ghResponses.shift();
  if (response instanceof Error) throw response;
  return response ?? "";
});

afterEach(() => {
  ghCalls.length = 0;
  ghResponses.length = 0;
  runGhMock.mockClear();
});

const pr: PullRequestTarget = {
  owner: "smithersai",
  repo: "smithers",
  number: 306,
  url: "https://github.com/smithersai/smithers/pull/306",
  baseRefName: "main",
  baseSha: "a".repeat(40),
  headRefName: "fix-i306-w8",
  headSha: "abc123",
  title: "Fix the widget",
  body: "Closes #306.",
};

describe("GitHub PR posting helpers", () => {
  test("resolvePullRequest resolves coordinates from gh pr view JSON", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 306,
        url: "https://github.com/smithersai/smithers/pull/306",
        baseRefName: "main",
        baseRefOid: "f".repeat(40),
        headRefName: "fix-i306-w8",
        headRefOid: "abc123",
        title: "Fix the widget",
        body: "Closes #306.",
      }),
      "a".repeat(40),
    );

    await expect(resolvePullRequest("/repo", "306", runGhMock)).resolves.toEqual(pr);
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: ["pr", "view", "306", "--json", "number,url,baseRefName,headRefName,headRefOid,title,body"],
      },
      {
        repoDir: "/repo",
        args: ["api", "repos/smithersai/smithers/git/ref/heads/main", "--jq", ".object.sha", "--hostname", "github.com"],
      },
    ]);
  });

  test("resolvePullRequest resolves GitHub Enterprise PR URLs by path", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 9,
        url: "https://ghe.example.corp/acme/tools/pull/9",
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        headRefName: "topic",
        headRefOid: "fee1dead",
      }),
      "b".repeat(40),
    );

    const resolved = await resolvePullRequest("/repo", "9", runGhMock);
    expect(resolved.owner).toBe("acme");
    expect(resolved.repo).toBe("tools");
    expect(resolved.number).toBe(9);
    expect(resolved.baseSha).toBe("b".repeat(40));
    expect(resolved.title).toBe("");
    expect(resolved.body).toBe("");
    expect(ghCalls[1]?.args).toEqual([
      "api", "repos/acme/tools/git/ref/heads/main", "--jq", ".object.sha", "--hostname", "ghe.example.corp",
    ]);
  });

  test("resolvePullRequest encodes slashes in the live base branch name", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 13,
        url: "https://github.com/acme/tools/pull/13",
        baseRefName: "release/1",
        headRefName: "feature",
        headRefOid: "head",
      }),
      "d".repeat(40),
    );
    const resolved = await resolvePullRequest("/repo", "13", runGhMock);
    expect(resolved.baseSha).toBe("d".repeat(40));
    expect(ghCalls[1]?.args).toEqual([
      "api", "repos/acme/tools/git/ref/heads/release%2F1", "--jq", ".object.sha", "--hostname", "github.com",
    ]);
  });

  test("resolvePullRequest fails when the live base branch cannot be read", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 14,
        url: "https://github.com/acme/tools/pull/14",
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: "head",
      }),
      new Error("base ref HTTP 503"),
    );
    await expect(resolvePullRequest("/repo", "14", runGhMock)).rejects.toThrow("base ref HTTP 503");
    expect(ghCalls).toHaveLength(2);
  });

  test("resolvePullRequest rejects PR URLs that cannot identify owner and repo", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 12,
        url: "https://example.test/not-a-github-pr",
        baseRefName: "main",
        baseRefOid: "c".repeat(40),
        headRefName: "branch",
        headRefOid: "def456",
      }),
    );

    await expect(resolvePullRequest("/repo", "12", runGhMock)).rejects.toThrow(
      "cannot parse owner/repo from PR url: https://example.test/not-a-github-pr",
    );
  });

  test("listPullRequestFiles maps JSON-lines gh api output to files with commentable lines", async () => {
    ghResponses.push(
      [
        "",
        JSON.stringify({
          filename: "src/index.ts",
          additions: 2,
          deletions: 1,
          patch: "@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more",
        }),
        // Renamed file: previous_filename comes along but is not part of the map key.
        JSON.stringify({
          filename: "src/renamed.ts",
          previous_filename: "src/original.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
          patch: "@@ -1 +1 @@\n same",
        }),
        // Binary file: no patch at all → no commentable lines, stats preserved.
        JSON.stringify({ filename: "assets/logo.png", status: "added", additions: 0, deletions: 0 }),
        "",
      ].join("\n"),
    );

    const files = await listPullRequestFiles("/repo", pr, runGhMock);
    expect([...files.keys()]).toEqual(["src/index.ts", "src/renamed.ts", "assets/logo.png"]);
    expect(files.get("src/index.ts")).toEqual({
      filename: "src/index.ts",
      additions: 2,
      deletions: 1,
      commentableLines: new Set([1, 2, 3]),
    });
    expect(files.get("src/renamed.ts")?.commentableLines).toEqual(new Set([1]));
    const binary = files.get("assets/logo.png") as PullRequestFile;
    expect(binary.additions).toBe(0);
    expect(binary.deletions).toBe(0);
    expect(binary.commentableLines.size).toBe(0);
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: [
          "api",
          "--paginate",
          "repos/smithersai/smithers/pulls/306/files",
          "--jq",
          ".[] | {filename, additions, deletions, patch} | @json",
        ],
      },
    ]);
  });

  test("postPullRequestReview posts the review payload through gh api stdin", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [{ path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." }],
    };
    ghResponses.push(
      JSON.stringify({ html_url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-1" }),
    );

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock)).resolves.toEqual({
      url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-1",
      inline: 1,
    });
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: ["api", "--method", "POST", "repos/smithersai/smithers/pulls/306/reviews", "--input", "-"],
        stdin: JSON.stringify(payload),
      },
    ]);
  });

  test("postPullRequestReview folds inline comments into the body after an inline batch failure", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [
        { path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." },
        { path: "src/range.ts", start_line: 4, line: 9, side: "RIGHT", body: "Range note." },
      ],
    };
    ghResponses.push(new Error("gh api failed: HTTP 422"), JSON.stringify({}));

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock)).resolves.toEqual({
      url: "https://github.com/smithersai/smithers/pull/306",
      inline: 0,
    });

    expect(ghCalls).toHaveLength(2);
    expect(JSON.parse(ghCalls[0].stdin ?? "")).toEqual(payload);
    const fallback = JSON.parse(ghCalls[1].stdin ?? "") as PullRequestReviewPayload;
    expect(fallback.comments).toEqual([]);
    expect(fallback.body).toContain("### Inline findings (could not anchor in the diff)");
    expect(fallback.body).toContain("`src/index.ts:7`");
    expect(fallback.body).toContain("`src/range.ts:4`");
    expect(fallback.body).toContain("Range note.");
  });

  test("postPullRequestReview folds comments up to the size budget, keeping fences intact", async () => {
    const big = "z".repeat(40_000);
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [
        { path: "a.ts", line: 1, side: "RIGHT", body: `\`\`\`suggestion\n${big}\n\`\`\`` },
        { path: "b.ts", line: 2, side: "RIGHT", body: `\`\`\`suggestion\n${big}\n\`\`\`` },
      ],
    };
    ghResponses.push(new Error("gh api failed: HTTP 422"), JSON.stringify({}));

    await postPullRequestReview("/repo", pr, payload, runGhMock);
    const fallback = JSON.parse(ghCalls[1].stdin ?? "") as PullRequestReviewPayload;
    expect(fallback.body.length).toBeLessThanOrEqual(64_000);
    // The first comment fits; the second would blow the budget, so it is
    // summarized rather than sliced mid-code-fence.
    expect(fallback.body).toContain("`a.ts:1`");
    expect(fallback.body).not.toContain("`b.ts:2`");
    expect(fallback.body).toContain("1 more finding; see the full walkthrough.");
    expect(fallback.body).toContain(`\`\`\`suggestion\n${big}\n\`\`\``);
  });

  test("postPullRequestReview rethrows failures when there are no inline comments to fold", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [],
    };
    ghResponses.push(new Error("gh api failed: HTTP 500"));

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock)).rejects.toThrow("gh api failed: HTTP 500");
    expect(ghCalls).toHaveLength(1);
  });
});
