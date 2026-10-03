import { describe, expect, test } from "bun:test"
import type { PullRequestReviewPayload } from "../../src/github/buildPullRequestReview.ts"
import { postReviewSupersedingPrior } from "../../src/github/postReviewSupersedingPrior.ts"
import type { PullRequestTarget } from "../../src/github/resolvePullRequest.ts"

const MARKER = "<!-- smithers-review -->"
const PREFIX = "Superseded by a newer smithers review."

const pr: PullRequestTarget = {
  owner: "smithersai",
  repo: "smithers",
  number: 306,
  url: "https://github.com/smithersai/smithers/pull/306",
  baseRefName: "main",
  baseSha: "a".repeat(40),
  headRefName: "feature",
  headSha: "abc123",
  title: "Feature",
  body: ""
}
const payload = (label: string): PullRequestReviewPayload => ({
  commit_id: "abc123",
  event: "COMMENT",
  body: `${MARKER}\n${label}`,
  comments: []
})

/**
 * A GitHub-compatible review store behind the `runGh` seam: POST creates a
 * review with the next id, the paginated list answers the `--jq` projection,
 * PUT rewrites a body. `holdList` parks list reads until released.
 */
function fakeGitHub() {
  const reviews: Array<{ id: number; body: string; login: string }> = [
    { id: 8, body: "Human review", login: "someone" },
    { id: 9, body: `${MARKER}\nCurrent`, login: "smithers-bot" },
    { id: 10, body: `${MARKER}\nQuoted by a human`, login: "someone" },
    { id: 11, body: "Plain bot comment", login: "smithers-bot" }
  ]
  const held: Array<() => void> = []
  let holdNextList = false
  const runGh = async (_repoDir: string, args: string[], stdin?: string) => {
    if (args[1]! === "--method" && args[2]! === "POST") {
      const id = Math.max(...reviews.map((r) => r.id)) + 1
      reviews.push({ id, body: JSON.parse(stdin!).body, login: "smithers-bot" })
      return JSON.stringify({ id, html_url: `${pr.url}#pullrequestreview-${id}` })
    }
    if (args[1]! === "--method" && args[2]! === "PUT") {
      const id = Number(args[3]!.split("/").pop())
      reviews.find((r) => r.id === id)!.body = JSON.parse(stdin!).body
      return "{}"
    }
    if (args[1]! === "--paginate") {
      if (holdNextList) {
        holdNextList = false
        // The snapshot is read later, when the held request "returns".
        await new Promise<void>((resolve) => held.push(resolve))
      }
      return reviews.map(({ id, body, login }) => JSON.stringify({ id, body, login })).join("\n")
    }
    throw new Error(`unexpected gh ${args.join(" ")}`)
  }
  return {
    runGh,
    reviews,
    holdNextList: () => {
      holdNextList = true
    },
    releaseList: () => held.shift()!(),
    current: () =>
      reviews.filter((r) => r.login === "smithers-bot" && r.body.includes(MARKER) && !r.body.startsWith(PREFIX))
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("overlapping review publications", () => {
  test("an older sweep that finishes last never supersedes the newer review", async () => {
    const github = fakeGitHub()
    github.holdNextList()
    const older = postReviewSupersedingPrior("/repo", pr, payload("Older run"), github.runGh)
    await tick()
    const newer = await postReviewSupersedingPrior("/repo", pr, payload("Newer run"), github.runGh)
    expect(newer.superseded).toBe(2)
    github.releaseList()
    expect((await older).superseded).toBe(0)

    expect(github.current().map((r) => r.id)).toEqual([13]!)
    expect(github.reviews.find((r) => r.id === 12)!.body.startsWith(PREFIX)).toBe(true)
    expect(github.reviews.find((r) => r.id === 9)!.body.startsWith(PREFIX)).toBe(true)
    // Other authors and unmarked bot reviews are never touched.
    expect(github.reviews.filter((r) => [8, 10, 11].includes(r.id)).every((r) => !r.body.startsWith(PREFIX))).toBe(
      true
    )
  })

  test("sequential publications leave only the newest current", async () => {
    const github = fakeGitHub()
    expect((await postReviewSupersedingPrior("/repo", pr, payload("First"), github.runGh)).superseded).toBe(1)
    expect((await postReviewSupersedingPrior("/repo", pr, payload("Second"), github.runGh)).superseded).toBe(1)
    expect(github.current().map((r) => r.id)).toEqual([13]!)
    expect(github.reviews.filter((r) => r.body.startsWith(PREFIX)).map((r) => r.id)).toEqual([9, 12])
  })
})
