import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PullRequestTarget } from "../../src/github/resolvePullRequest.ts";
import { supersedePriorReviews } from "../../src/github/supersedePriorReviews.ts";

type GhCall = {
  repoDir: string;
  args: string[];
  stdin?: string;
};

const ghCalls: GhCall[] = [];
const ghResponses: Array<string | Error> = [];

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

describe("supersedePriorReviews", () => {
  test("works under an installation token that GET /user refuses", async () => {
    // The action's GITHUB_TOKEN is an installation token: GET /user answers 403
    // "Resource not accessible by integration". Route by endpoint so the fake
    // refuses /user no matter when or whether it is called.
    const routedCalls: GhCall[] = [];
    const routedGh = async (repoDir: string, args: string[], stdin?: string) => {
      routedCalls.push({ repoDir, args, stdin });
      if (args[1] === "user") throw new Error("gh api failed: HTTP 403: Resource not accessible by integration");
      if (args[1] === "--paginate") {
        return [
          JSON.stringify({ id: 1, body: `${MARKER}\nOld review`, login: "github-actions[bot]" }),
          JSON.stringify({ id: 2, body: `${MARKER}\nQuoted by a human`, login: "human" }),
          JSON.stringify({ id: 9, body: `${MARKER}\nJust posted`, login: "github-actions[bot]" }),
        ].join("\n");
      }
      return "{}";
    };

    await expect(supersedePriorReviews("/repo", pr, 9, routedGh)).resolves.toBe(1);

    expect(
      routedCalls.filter((call) => call.args[2] === "PUT").map((call) => call.args[3]),
    ).toEqual(["repos/smithersai/smithers/pulls/306/reviews/1"]);
  });

  test("updates each prior marker-bearing bot review and returns the count", async () => {
    ghResponses.push(
      [
        JSON.stringify({ id: 1, body: `${MARKER}\nOld review one`, login: "smithers-bot" }),
        // Another user's review with the marker: untouched.
        JSON.stringify({ id: 2, body: `${MARKER}\nSomeone else`, login: "human" }),
        // Bot review without the marker: untouched.
        JSON.stringify({ id: 3, body: "LGTM", login: "smithers-bot" }),
        // Already superseded: untouched.
        JSON.stringify({
          id: 4,
          body: `Superseded by a newer smithers review.\n\n${MARKER}\nAncient`,
          login: "smithers-bot",
        }),
        JSON.stringify({ id: 5, body: `${MARKER}\nOld review two`, login: "smithers-bot" }),
        // The replacement itself names the poster.
        JSON.stringify({ id: 999, body: `${MARKER}\nNew review`, login: "smithers-bot" }),
      ].join("\n"),
      "{}",
      "{}",
    );

    await expect(supersedePriorReviews("/repo", pr, 999, runGhMock)).resolves.toBe(2);

    expect(ghCalls).toHaveLength(3);
    expect(ghCalls[0].args).toEqual([
      "api",
      "--paginate",
      "repos/smithersai/smithers/pulls/306/reviews",
      "--jq",
      ".[] | {id, body, login: .user.login} | @json",
    ]);
    const updateCalls = ghCalls.slice(1);
    expect(updateCalls.map((call) => call.args)).toEqual([
      ["api", "--method", "PUT", "repos/smithersai/smithers/pulls/306/reviews/1", "--input", "-"],
      ["api", "--method", "PUT", "repos/smithersai/smithers/pulls/306/reviews/5", "--input", "-"],
    ]);
    expect(JSON.parse(updateCalls[0].stdin ?? "")).toEqual({
      body: `Superseded by a newer smithers review.\n\n${MARKER}\nOld review one`,
    });
  });

  test("a failing review-list call is non-fatal and returns 0", async () => {
    ghResponses.push(new Error("gh api failed: HTTP 502"));
    await expect(supersedePriorReviews("/repo", pr, 999, runGhMock)).resolves.toBe(0);
    expect(ghCalls).toHaveLength(1);
  });

  test("a failing per-review update is skipped; the rest still count", async () => {
    ghResponses.push(
      [
        JSON.stringify({ id: 7, body: `${MARKER}\nFirst`, login: "smithers-bot" }),
        JSON.stringify({ id: 8, body: `${MARKER}\nSecond`, login: "smithers-bot" }),
        JSON.stringify({ id: 999, body: `${MARKER}\nNew`, login: "smithers-bot" }),
      ].join("\n"),
      new Error("gh api failed: HTTP 422"),
      "{}",
    );
    await expect(supersedePriorReviews("/repo", pr, 999, runGhMock)).resolves.toBe(1);
    expect(ghCalls).toHaveLength(3);
  });

  test("a list without the new review supersedes nothing, since its author is unknown", async () => {
    ghResponses.push(JSON.stringify({ id: 7, body: `${MARKER}\nOlder`, login: "smithers-bot" }));
    await expect(supersedePriorReviews("/repo", pr, 999, runGhMock)).resolves.toBe(0);
    expect(ghCalls).toHaveLength(1);
  });

  test("never marks the newly posted review superseded, even though the list contains it", async () => {
    ghResponses.push(
      [
        JSON.stringify({ id: 11, body: `${MARKER}\nOlder`, login: "smithers-bot" }),
        // Read after the POST, so the list carries the replacement itself.
        JSON.stringify({ id: 12, body: `${MARKER}\nJust posted`, login: "smithers-bot" }),
      ].join("\n"),
      "{}",
    );

    await expect(supersedePriorReviews("/repo", pr, 12, runGhMock)).resolves.toBe(1);

    const updateCalls = ghCalls.slice(1);
    expect(updateCalls.map((call) => call.args)).toEqual([
      ["api", "--method", "PUT", "repos/smithersai/smithers/pulls/306/reviews/11", "--input", "-"],
    ]);
  });
});
