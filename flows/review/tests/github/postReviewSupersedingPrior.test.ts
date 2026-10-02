import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PullRequestReviewPayload } from "../../src/github/buildPullRequestReview.ts";
import { postReviewSupersedingPrior } from "../../src/github/postReviewSupersedingPrior.ts";
import type { PullRequestTarget } from "../../src/github/resolvePullRequest.ts";

type GhCall = { repoDir: string; args: string[]; stdin?: string | undefined };

const ghCalls: GhCall[] = [];
const ghResponses: Array<string | Error> = [];

// Injected directly (the helpers accept runGh as a parameter) rather than
// through `mock.module`, which is process-global in bun and leaks across files.
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

const MARKER = "<!-- smithers-review -->";

function payloadWith(comments: PullRequestReviewPayload["comments"]): PullRequestReviewPayload {
  return { commit_id: "abc123", event: "COMMENT", body: `${MARKER}\nReview body`, comments };
}

/** `PUT …/reviews/{id}` is the only call that rewrites an existing review body. */
function supersededIds(): number[] {
  return ghCalls
    .filter((call) => call.args[1]! === "--method" && call.args[2]! === "PUT")
    .map((call) => Number(call.args[3]!.split("/").pop()));
}

describe("postReviewSupersedingPrior", () => {
  test("posts the replacement before marking older reviews superseded", async () => {
    ghResponses.push(
      // 1. create the new review
      JSON.stringify({ id: 99, html_url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-99" }),
      // 2. supersede: list (which carries the new review and its author), then one update
      [
        JSON.stringify({ id: 1, body: `${MARKER}\nOld review`, login: "smithers-bot" }),
        JSON.stringify({ id: 99, body: `${MARKER}\nReview body`, login: "smithers-bot" }),
      ].join("\n"),
      "{}",
    );

    const result = await postReviewSupersedingPrior("/repo", pr, payloadWith([]), runGhMock);

    expect(result).toEqual({
      url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-99",
      inline: 0,
      superseded: 1,
    });
    // The replacement exists before any predecessor is annotated.
    expect(ghCalls[0]!.args).toEqual([
      "api",
      "--method",
      "POST",
      "repos/smithersai/smithers/pulls/306/reviews",
      "--input",
      "-",
    ]);
    expect(supersededIds()).toEqual([1]!);
  });

  test("a post that fails outright leaves every prior review untouched", async () => {
    // No inline comments, so postPullRequestReview has no fallback and rethrows.
    ghResponses.push(new Error("gh api failed: HTTP 500"));

    await expect(postReviewSupersedingPrior("/repo", pr, payloadWith([]), runGhMock)).rejects.toThrow(
      "gh api failed: HTTP 500",
    );

    // Nothing beyond the create attempt ran: no review was marked superseded
    // while no replacement exists.
    expect(supersededIds()).toEqual([]);
    expect(ghCalls).toHaveLength(1);
  });

  test("a post whose inline batch and fallback both fail leaves prior reviews untouched", async () => {
    ghResponses.push(new Error("gh api failed: HTTP 422"), new Error("gh api failed: HTTP 502"));

    await expect(
      postReviewSupersedingPrior(
        "/repo",
        pr,
        payloadWith([{ path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." }]),
        runGhMock,
      ),
    ).rejects.toThrow("gh api failed: HTTP 502");

    expect(supersededIds()).toEqual([]);
    expect(ghCalls).toHaveLength(2);
  });

  test("the review it just posted is never marked superseded by itself", async () => {
    ghResponses.push(
      JSON.stringify({ id: 42, html_url: "https://github.com/smithersai/smithers/pull/306#new" }),
      [
        JSON.stringify({ id: 7, body: `${MARKER}\nOlder`, login: "smithers-bot" }),
        // The list is read after the POST, so it contains the new review too.
        JSON.stringify({ id: 42, body: `${MARKER}\nReview body`, login: "smithers-bot" }),
      ].join("\n"),
      "{}",
    );

    const result = await postReviewSupersedingPrior("/repo", pr, payloadWith([]), runGhMock);

    expect(result.superseded).toBe(1);
    expect(supersededIds()).toEqual([7]!);
  });

  test("a superseding failure never fails a review that posted", async () => {
    ghResponses.push(
      JSON.stringify({ id: 5, html_url: "https://github.com/smithersai/smithers/pull/306#new" }),
      new Error("gh api failed: HTTP 403"),
    );

    const result = await postReviewSupersedingPrior("/repo", pr, payloadWith([]), runGhMock);

    expect(result.url).toBe("https://github.com/smithersai/smithers/pull/306#new");
    expect(result.superseded).toBe(0);
  });
});
