import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { claimBody, holder, LABEL, parseRef, proxied, releaseBody, run, splitResponse, TRANSIENT } from "./issue-claim.mjs"

import { fixture } from "./fixtures/check-receipts.mjs"

// Close-policy input is literal, local and machine-written. No evidence bypass.
const evidenceFixture = fixture()
for (const [repo, number, tag] of [["smithersai/smithers",5,"A"], ["smithersai/smithers",6,"B"], ["smithersai/smithers",7,"C"], ["smithersai/plue",8,"D"]]) {
  evidenceFixture.put(`.specs/engineering/tickets/T-${tag}-01.md`, `Issue: https://github.com/${repo}/issues/${number}\n## Acceptance\n- C-FIX-01\n- C-FIX-02\n`)
}
evidenceFixture.commit()
const closeReceipts = ["C-FIX-01", "C-FIX-02"].map(evidenceFixture.evidence)
const closeArgs = ["--landed", evidenceFixture.sha, ...closeReceipts.flatMap(path => ["--receipt", path])]
after(evidenceFixture.cleanup)

const T0 = new Date("2026-09-29T00:00:00Z")
const hours = (n) => new Date(T0.getTime() + n * 3600_000)
const HOST = hostname()
// No test may pick up this machine's real GitHub App configuration or reach its real proxy.
const NO_APP = "/nonexistent/issue-claim-app.json"
process.env.ISSUE_CLAIM_APP_CONFIG = NO_APP
const PROXY = "http://proxy.test"

// A label-marker cache dir per fake, and a proxy address no real proxy listens on.
const cacheEnv = (extra = {}) => ({ ISSUE_CLAIM_CACHE: mkdtempSync(join(tmpdir(), "issue-claim-cache-")),
  SMITHERS_GITHUB_PROXY: PROXY, ...extra })

/**
 * The proxy's side of `gh`: answers admission from `state.deferUntil` and hands every other
 * call to `gh` with the proxy origin stripped, so fakes match on GitHub paths.
 */
const viaProxy = (gh, state) => (args) => {
  const admission = args.find((arg) => arg.startsWith(`${PROXY}/_smithers/admission`))
  if (admission) {
    ;(state.admissions ??= []).push(admission)
    const deferred = (state.deferUntil ?? 0) > state.clock.getTime()
    return JSON.stringify({ principal: "gh-user", startsAt: new Date(deferred ? state.deferUntil : state.clock.getTime()).toISOString(), deferred })
  }
  return gh(args.map((arg) => arg.startsWith(`${PROXY}/`) ? arg.slice(PROXY.length + 1) : arg))
}

const runVia = (gh, state, argv, at = T0) => run(argv.includes("--close") ? [...argv, ...closeArgs] : argv, { cwd: evidenceFixture.root, gh: viaProxy(gh, state), ghBytes: viaProxy(gh, state), now: () => at, env: state.env, ensure: () => {} })

// An in-memory GitHub issue behind the `gh api` calls the CLI makes.
const fakeGitHub = (issue = {}) => {
  const state = { labels: [], comments: [], events: [], calls: [], clock: T0, open: true, env: cacheEnv(), ...issue }
  const gh = (args) => {
    state.calls.push(args.join(" "))
    const path = args.find((arg) => arg.startsWith("repos/"))
    if (path?.includes('/commits/') || path?.includes('/actions/')) {
      const repo = /^repos\/([^/]+\/[^/]+)\//.exec(path)[1]
      const ci = evidenceFixture.ci(repo)
      return path.endsWith('/actions/artifacts/10/zip') ? ci.bytes : JSON.stringify(ci.responses[path])
    }
    const field = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    if (args.includes("PATCH")) {
      state.open = false
      state.closedVia = path
      return "{}"
    }
    if (/\/labels\/in-progress$/.test(path) && !/issues/.test(path)) {
      if (state.labelMissing) throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { stderr: "gh: Not Found (HTTP 404)" })
      return "{}"
    }
    if (args.includes("DELETE")) {
      if (!state.labels.includes(LABEL)) throw new Error("Label does not exist")
      state.labels = state.labels.filter((label) => label !== LABEL)
      return "{}"
    }
    if (/\/labels$/.test(path) && !/issues/.test(path)) {
      state.labelMissing = false
      return "{}"
    }
    if (/issues\/\d+\/labels$/.test(path)) {
      state.labels.push(field("labels[]"))
      state.events.push({ event: "labeled", label: { name: field("labels[]") }, created_at: state.clock.toISOString() })
      return "[]"
    }
    if (/\/comments/.test(path) && args.includes("-f")) {
      state.comments.push({ body: field("body"), created_at: state.clock.toISOString() })
      state.afterComment?.(state)
      return "{}"
    }
    if (/\/comments/.test(path)) return JSON.stringify([state.comments])
    if (/\/events/.test(path)) return JSON.stringify([state.events])
    return JSON.stringify({ state: state.open ? "open" : "closed", labels: state.labels.map((name) => ({ name })) })
  }
  return { state, gh }
}

const cli = (github, argv, at = T0, by = "lane-1") => {
  github.state.clock = at
  return runVia(github.gh, github.state, [...argv, "--by", by], at)
}

const writesOf = (github) => github.state.calls.filter((call) => / -f |--method/.test(call))

describe("issue-claim references", () => {
  it("defaults the owner to smithersai and rejects malformed references", () => {
    assert.deepEqual(parseRef("plue#12"), { repo: "smithersai/plue", number: 12 })
    assert.deepEqual(parseRef("acme/tool#3"), { repo: "acme/tool", number: 3 })
    for (const bad of ["plue", "#3", "plue#x", "a/b/c#1", undefined]) assert.throws(() => parseRef(bad), /expected/)
  })
})

describe("issue-claim holder", () => {
  const claim = (by, at, host = "mac") => ({ body: claimBody({ by, host, now: at }), created_at: at.toISOString() })

  it("is null for an unlabeled issue without claims, and after a release", () => {
    assert.equal(holder({ labeled: false, comments: [] }), null)
    const released = [claim("a", T0), { body: releaseBody({ by: "a", host: "mac", now: hours(1) }), created_at: hours(1).toISOString() }]
    assert.equal(holder({ labeled: false, comments: released }, hours(2).getTime()), null)
  })

  it("keeps the first live claim when a second agent races it, and lets the holder refresh", () => {
    const comments = [claim("a", T0), claim("b", hours(1)), claim("a", hours(5))]
    const current = holder({ labeled: true, comments }, hours(6).getTime())
    assert.equal(current.by, "a")
    assert.equal(current.expires, hours(11).toISOString())
    assert.equal(current.stale, false)
  })

  it("marks a claim stale at its expiry and lets a later claim replace an expired one", () => {
    assert.equal(holder({ labeled: true, comments: [claim("a", T0)] }, hours(6).getTime()).stale, true)
    assert.equal(holder({ labeled: true, comments: [claim("a", T0)] }, hours(6).getTime() - 1).stale, false)
    assert.equal(holder({ labeled: true, comments: [claim("a", T0), claim("b", hours(7))] }, hours(8).getTime()).by, "b")
  })

  it("treats the same name on another host as a different agent", () => {
    const comments = [claim("a", T0, "mac"), claim("a", hours(1), "cloud")]
    assert.equal(holder({ labeled: true, comments }, hours(2).getTime()).host, "mac")
  })

  it("dates a bare label from its label event, and holds indefinitely when that time is unknown", () => {
    const bare = holder({ labeled: true, comments: [], labeledAt: T0.toISOString() }, hours(7).getTime())
    assert.equal(bare.by, "unknown")
    assert.equal(bare.stale, true)
    assert.equal(holder({ labeled: true, comments: [] }, hours(99).getTime()).stale, false)
  })

  it("reads the Cloud dispatcher's claim format", () => {
    const body = "Claimed by plue-8a (campaign feed9) on mac at 2026-09-29T00:00:00.000Z; expires 2026-09-29T06:00:00.000Z. Cloud run r-1 (#650)."
    const current = holder({ labeled: true, comments: [{ body, created_at: T0.toISOString() }] }, hours(1).getTime())
    assert.equal(current.by, "plue-8a (campaign feed9)")
    assert.equal(current.expires, "2026-09-29T06:00:00.000Z")
  })
})

describe("issue-claim commands", () => {
  it("claims a free issue with the label and the exact claim comment", () => {
    const github = fakeGitHub()
    const { code, out } = cli(github, ["claim", "smithers#7"])
    assert.equal(code, 0)
    assert.equal(out.action, "claimed")
    assert.deepEqual(github.state.labels, [LABEL])
    assert.equal(github.state.comments[0].body, `Claimed by lane-1 on ${HOST} at 2026-09-29T00:00:00.000Z; expires 2026-09-29T06:00:00.000Z`)
    assert.ok(github.state.calls.includes("api repos/smithersai/smithers/labels/in-progress"), "reads the label, creates nothing")
    assert.deepEqual(writesOf(github).length, 2, "one label write and one comment")
  })

  it("creates a missing repository label once per machine", () => {
    const github = fakeGitHub({ labelMissing: true })
    cli(github, ["claim", "smithers#7"])
    cli(github, ["claim", "smithers#8"])
    const creates = github.state.calls.filter((call) => call.startsWith("api -i repos/smithersai/smithers/labels -f name=in-progress -f color=fbca04"))
    assert.equal(creates.length, 1)
    assert.equal(github.state.calls.filter((call) => call === "api repos/smithersai/smithers/labels/in-progress").length, 1)
  })

  it("rolls back a newly added label and propagates a failed claim comment", () => {
    const github = fakeGitHub()
    const error = new Error("HTTP 502: Bad Gateway")
    const gh = github.gh
    github.gh = (args) => {
      if (args.includes("repos/smithersai/smithers/issues/7/comments") && args.includes("-f")) throw error
      return gh(args)
    }
    assert.throws(() => cli(github, ["claim", "smithers#7"]), (caught) => caught === error)
    assert.deepEqual(github.state.labels, [])
    assert.ok(github.state.calls.includes(`api -i --method DELETE repos/smithersai/smithers/issues/7/labels/${LABEL}`))
    assert.deepEqual(github.state.comments, [])
    github.gh = gh
    assert.equal(cli(github, ["claim", "smithers#7"]).code, 0)
  })

  it("keeps a rival's label if their claim lands before a rejected comment", () => {
    const github = fakeGitHub()
    const gh = github.gh
    const limitedGh = (args) => {
      if (args.includes("repos/smithersai/smithers/issues/7/comments") && args.includes("-f")) {
        github.state.comments.push({ body: claimBody({ by: "rival", host: "cloud", now: T0 }), created_at: T0.toISOString() })
        throw new Error("HTTP 502: Bad Gateway")
      }
      return gh(args)
    }
    assert.throws(() => runVia(limitedGh, github.state, ["claim", "smithers#7", "--by", "lane-1"]), /Bad Gateway/)
    assert.deepEqual(github.state.labels, [LABEL])
    assert.equal(cli(github, ["check", "smithers#7"], T0, "lane-1").out.holder.by, "rival")
  })

  it("keeps its label when a successful comment receives an ambiguous error", () => {
    const github = fakeGitHub()
    const gh = github.gh
    const ambiguousGh = (args) => {
      if (args.includes("repos/smithersai/smithers/issues/7/comments") && args.includes("-f")) {
        gh(args)
        throw new Error("response lost")
      }
      return gh(args)
    }
    assert.throws(() => runVia(ambiguousGh, github.state, ["claim", "smithers#7", "--by", "lane-1"]), /response lost/)
    assert.deepEqual(github.state.labels, [LABEL])
    assert.equal(cli(github, ["check", "smithers#7"], T0, "lane-1").out.mine, true)
  })

  it("keeps an existing label when its holder's refresh comment fails", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "smithers#7"])
    const error = new Error("HTTP 502: Bad Gateway")
    const gh = github.gh
    github.gh = (args) => {
      if (args.includes("repos/smithersai/smithers/issues/7/comments") && args.includes("-f")) throw error
      return gh(args)
    }
    assert.throws(() => cli(github, ["claim", "smithers#7"], hours(1)), (caught) => caught === error)
    assert.ok(github.state.labels.includes(LABEL))
    assert.ok(!github.state.calls.some((call) => call.includes("DELETE")))
    assert.equal(github.state.comments.length, 1)
  })

  it("refuses another agent's live claim without writing, and check reports it", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "plue#7"], T0, "lane-1")
    const writes = github.state.comments.length
    const refused = cli(github, ["claim", "plue#7"], hours(1), "lane-2")
    assert.equal(refused.code, 2)
    assert.equal(refused.out.holder.by, "lane-1")
    assert.equal(github.state.comments.length, writes)
    assert.equal(cli(github, ["check", "plue#7"], hours(1), "lane-2").code, 2)
    assert.deepEqual(cli(github, ["check", "plue#7"], hours(1), "lane-1").out.mine, true)
    assert.equal(cli(github, ["release", "plue#7"], hours(1), "lane-2").code, 2)
  })

  it("refreshes its own claim and takes over a stale one with a comment", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "plue#7"], T0, "lane-1")
    assert.equal(cli(github, ["claim", "plue#7"], hours(3), "lane-1").out.action, "refreshed")
    assert.equal(cli(github, ["claim", "plue#7"], hours(8), "lane-2").code, 2, "the refresh moved the expiry to 09:00")
    const taken = cli(github, ["claim", "plue#7", "--note", "resuming"], hours(9), "lane-2")
    assert.equal(taken.out.action, "took-over")
    assert.match(github.state.comments.at(-1).body, /^Claimed by lane-2 .*\nTook over a stale claim: Claimed by lane-1 .*\nresuming$/)
  })

  it("takes over a bare label once it is six hours old", () => {
    const github = fakeGitHub({ labels: [LABEL], events: [{ event: "labeled", label: { name: LABEL }, created_at: T0.toISOString() }] })
    assert.equal(cli(github, ["check", "smithers#1"], hours(5)).code, 2)
    assert.equal(cli(github, ["claim", "smithers#1"], hours(6)).out.action, "took-over")
  })

  it("reports a lost race when another claim lands first", () => {
    const github = fakeGitHub()
    github.state.afterComment = (state) => {
      state.afterComment = null
      state.comments.unshift({ body: claimBody({ by: "rival", host: "cloud", now: T0 }), created_at: T0.toISOString() })
    }
    const { code, out } = cli(github, ["claim", "smithers#2"])
    assert.equal(code, 2)
    assert.equal(out.action, "lost-race")
    assert.equal(out.holder.by, "rival")
  })

  it("releases with a reason, tolerating an already removed label; --force releases another's claim", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "smithers#3"], T0, "lane-1")
    const released = cli(github, ["release", "smithers#3", "--note", "landed abc123"], hours(1), "lane-1")
    assert.equal(released.code, 0)
    assert.deepEqual(github.state.labels, [])
    assert.equal(github.state.comments.at(-1).body, `Released by lane-1 on ${HOST} at 2026-09-29T01:00:00.000Z: landed abc123`)
    assert.equal(cli(github, ["check", "smithers#3"], hours(1), "lane-2").out.free, true)
    const writes = writesOf(github).length
    assert.equal(cli(github, ["release", "smithers#3"], hours(1), "lane-1").out.action, "already-released")
    assert.equal(writesOf(github).length, writes, "a repeated release writes nothing")
    cli(github, ["claim", "smithers#3"], hours(2), "lane-1")
    assert.equal(cli(github, ["release", "smithers#3", "--force"], hours(2), "lane-2").code, 0)
  })

  it("rejects unknown commands", () => {
    assert.throws(() => cli(fakeGitHub(), ["take", "smithers#1"]), /usage/)
  })
})

describe("issue-claim idempotency and folded release", () => {
  it("never re-posts a claim within an hour, and refreshes it after", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "smithers#4"])
    const again = cli(github, ["claim", "smithers#4"], new Date(T0.getTime() + 59 * 60_000))
    assert.deepEqual([again.code, again.out.action], [0, "held"])
    assert.equal(github.state.comments.length, 1)
    assert.equal(cli(github, ["claim", "smithers#4"], hours(1)).out.action, "refreshed")
    assert.equal(github.state.comments.length, 2)
  })

  it("folds the release into one closing receipt and frees the issue", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "smithers#5"])
    const writes = writesOf(github).length
    const { code, out } = cli(github, ["comment", "smithers#5", "--body", "Landed smithers#5 on main.\n\nCommits:\n- abc", "--close", "--release", "--note", "landed abc"], hours(1))
    assert.deepEqual([code, out.action, out.released], [0, "commented", true])
    assert.equal(github.state.comments.length, 2, "claim + receipt; no separate release comment")
    assert.equal(github.state.comments[1].body, `Landed smithers#5 on main.\n\nCommits:\n- abc\n\nReleased by lane-1 on ${HOST} at 2026-09-29T01:00:00.000Z: landed abc`)
    assert.deepEqual(github.state.labels, [])
    assert.equal(github.state.open, false)
    assert.equal(github.state.closedVia, "repos/smithersai/smithers/issues/5")
    assert.equal(writesOf(github).length - writes, 3, "unlabel, one comment, close")
    assert.equal(cli(github, ["check", "smithers#5"], hours(1), "lane-2").out.free, true)
  })

  it("does not re-post a receipt or re-close on retry, and still finishes the release", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "smithers#6"])
    const gh = github.gh
    github.gh = (args) => {
      if (args.includes("PATCH")) throw Object.assign(new Error("HTTP 403"), { stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)" })
      return gh(args)
    }
    const argv = ["comment", "smithers#6", "--body", "Receipt body", "--close", "--release"]
    assert.equal(cli(github, argv, hours(1)).code, TRANSIENT)
    github.gh = gh
    github.state.env.ISSUE_CLAIM_CACHE = cacheEnv().ISSUE_CLAIM_CACHE
    const retried = cli(github, argv, hours(2))
    assert.deepEqual([retried.code, retried.out.action], [0, "already-commented"])
    assert.equal(github.state.comments.filter((comment) => comment.body.startsWith("Receipt body")).length, 1)
    assert.equal(github.state.open, false)
    assert.equal(cli(github, argv, hours(2)).out.action, "already-commented")
    assert.equal(github.state.calls.filter((call) => call.includes("PATCH")).length, 1, "the closed issue is not closed again")
  })

  it("posts the receipt but keeps another agent's claim, and closes pull requests through the pulls API", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "plue#8"], T0, "rival")
    const { out } = cli(github, ["comment", "plue#8", "--body", "Landed via queue", "--close", "--pr", "--release"], hours(1))
    assert.equal(out.released, false)
    assert.equal(out.holder.by, "rival")
    assert.deepEqual(github.state.labels, [LABEL])
    assert.equal(github.state.comments.at(-1).body, "Landed via queue")
    assert.equal(github.state.closedVia, "repos/smithersai/plue/pulls/8")
  })

  it("reads a release line anywhere in a comment", () => {
    const claim = { body: claimBody({ by: "a", host: "mac", now: T0 }), created_at: T0.toISOString() }
    const receipt = { body: `Landed x.\n\n${releaseBody({ by: "a", host: "mac", now: hours(1), note: "landed" })}`, created_at: hours(1).toISOString() }
    assert.equal(holder({ labeled: false, comments: [claim, receipt] }, hours(1).getTime()), null)
  })

  it("rejects a comment without a body", () => {
    assert.throws(() => cli(fakeGitHub(), ["comment", "smithers#1"]), /--body/)
  })
})

describe("issue-claim through the GitHub proxy", () => {
  const refusal = (status, headers, message) => Object.assign(new Error(`gh: ${message} (HTTP ${status})`),
    { stderr: `gh: ${message} (HTTP ${status})`,
      stdout: `HTTP/1.1 ${status} Refused\r\n${headers}Content-Type: application/json\r\n\r\n{"message":"${message}"}` })
  const failingComment = (github, error) => (args) => {
    if (/issues\/\d+\/comments$/.test(args.find((arg) => arg.startsWith("repos/")) ?? "") && args.includes("-f")) throw error
    return github.gh(args)
  }

  it("names every GitHub path by its absolute proxy URL and reads write responses with -i", () => {
    const seen = []
    const github = proxied({ gh: (args) => { seen.push(args); return "HTTP/1.1 201 Created\r\nX-A: b\r\n\r\n{\"id\":1}" }, base: PROXY })
    assert.equal(github.write(["api", "--method", "PATCH", "repos/o/r/issues/1", "-f", "state=closed"]), "{\"id\":1}")
    github.read(["api", "--paginate", "--slurp", "repos/o/r/issues/1/comments?per_page=100"])
    assert.deepEqual(seen, [
      ["api", "-i", "--method", "PATCH", `${PROXY}/repos/o/r/issues/1`, "-f", "state=closed"],
      ["api", "--paginate", "--slurp", `${PROXY}/repos/o/r/issues/1/comments?per_page=100`]
    ])
  })

  it("asks the proxy for all of a command's writes before the first, and reports its principal", () => {
    const github = fakeGitHub()
    assert.equal(cli(github, ["claim", "smithers#7"]).out.identity, "gh-user")
    assert.deepEqual(github.state.admissions.map((url) => new URL(url).searchParams.get("writes")), ["0", "2"])
    const out = cli(github, ["comment", "smithers#7", "--body", "receipt", "--release", "--close"])
    assert.equal(out.out.identity, "gh-user")
    assert.deepEqual(github.state.admissions.slice(2).map((url) => new URL(url).searchParams.get("writes")), ["0", "3"])
  })

  it("exits 75 and writes nothing while the proxy cannot start the writes soon", () => {
    const github = fakeGitHub()
    github.state.deferUntil = T0.getTime() + 120_000
    for (const command of ["check", "claim", "release", "comment"]) {
      const { code, out } = cli(github, [command, "smithers#10", "--body", "x"])
      assert.deepEqual([code, out.action, out.retry_at], [TRANSIENT, "deferred", "2026-09-29T00:02:00.000Z"], command)
    }
    assert.deepEqual(writesOf(github), [])
  })

  it("exits 75 at the proxy's retry instant when it defers a write, and rolls the new label back", () => {
    const github = fakeGitHub()
    const deferred = refusal(429, "Retry-After: 90\r\nX-Smithers-Retry-At: 2026-09-29T00:01:30.000Z\r\n", "API rate limit: deferred")
    const { code, out } = runVia(failingComment(github, deferred), github.state, ["claim", "smithers#9", "--by", "lane-1"])
    assert.deepEqual([code, out.action, out.retry_at], [TRANSIENT, "deferred", "2026-09-29T00:01:30.000Z"])
    assert.deepEqual(github.state.labels, [], "the new label is rolled back")
  })

  it("waits for GitHub's Retry-After, or at least a minute, when GitHub itself refuses", () => {
    for (const [headers, retryAt] of [["Retry-After: 300\r\n", "2026-09-29T00:05:00.000Z"], ["", "2026-09-29T00:01:00.000Z"]]) {
      const github = fakeGitHub()
      const limit = refusal(403, headers, "You have exceeded a secondary rate limit")
      const { code, out } = runVia(failingComment(github, limit), github.state, ["comment", "smithers#9", "--body", "x"])
      assert.deepEqual([code, out.retry_at], [TRANSIENT, retryAt])
    }
  })

  it("exits 75 a minute later when a read is rate limited", () => {
    const github = fakeGitHub()
    const limitedRead = (args) => {
      if (!args.includes("-f") && args.some((arg) => arg.endsWith("/comments?per_page=100"))) throw new Error("gh: API rate limit (HTTP 429)")
      return github.gh(args)
    }
    const { code, out } = runVia(limitedRead, github.state, ["check", "smithers#9"])
    assert.deepEqual([code, out.retry_at], [TRANSIENT, "2026-09-29T00:01:00.000Z"])
  })

  it("treats a plain permission 403 as an error, not a rate limit", () => {
    const github = fakeGitHub()
    const denied = Object.assign(new Error("HTTP 403"), { stderr: "gh: Resource not accessible by integration (HTTP 403)" })
    assert.throws(() => runVia(failingComment(github, denied), github.state, ["comment", "smithers#9", "--body", "x"]), (error) => error === denied)
  })

  it("splits gh api -i output into headers and body", () => {
    assert.deepEqual(splitResponse("HTTP/2.0 200 OK\r\nRetry-After: 5\r\nX-A: b: c\r\n\r\n[1]"), { headers: { "retry-after": "5", "x-a": "b: c" }, body: "[1]" })
    assert.deepEqual(splitResponse("[1]"), { headers: {}, body: "[1]" })
  })
})

const hasGh = (() => { try { execFileSync("gh", ["--version"], { stdio: "ignore" }); return true } catch { return false } })()

// The real CLI, the real `gh`, and the real proxy daemon in front of a fake GitHub.
describe("issue-claim, gh and the GitHub proxy end to end", { skip: hasGh ? false : "gh is not installed" }, () => {
  const TOKEN = "ghp_operator_token_for_tests"

  /** A fake GitHub REST API over one issue store, recording every request. */
  const fakeApi = async ({ limitComments = false } = {}) => {
    const issues = new Map()
    const requests = []
    const issueOf = (number) => {
      if (!issues.has(number)) issues.set(number, { state: "open", labels: [], comments: [] })
      return issues.get(number)
    }
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, at: Date.now(), body })
        const reply = (status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)) }
        if (req.url.includes('/commits/') || req.url.includes('/actions/')) {
          const repo = /^\/repos\/([^/]+\/[^/]+)\//.exec(req.url)[1]
          const ci = evidenceFixture.ci(repo)
          if (req.url.endsWith('/actions/artifacts/10/zip')) { res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(ci.bytes) }
          return reply(200, ci.responses[req.url.slice(1)])
        }
        const match = /^\/repos\/[\w.-]+\/[\w.-]+\/(?:issues|pulls)\/(\d+)(\/.*)?$/.exec(req.url.split("?")[0])
        if (/\/labels\/in-progress$/.test(req.url) && !match) return reply(200, { name: LABEL })
        if (!match) return reply(404, { message: "Not Found" })
        const issue = issueOf(Number(match[1]))
        const rest = match[2] ?? ""
        const fields = body ? JSON.parse(body) : {}
        if (rest === "" && req.method === "PATCH") { issue.state = fields.state; return reply(200, {}) }
        if (rest === "") return reply(200, { state: issue.state, labels: issue.labels.map((name) => ({ name })) })
        if (rest === "/labels" && req.method === "POST") { issue.labels.push(...fields.labels); return reply(200, []) }
        if (rest === "/labels/in-progress" && req.method === "DELETE") { issue.labels = issue.labels.filter((l) => l !== LABEL); return reply(200, []) }
        if (rest === "/comments" && req.method === "POST") {
          if (limitComments) return reply(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "300" })
          issue.comments.push({ body: fields.body, created_at: new Date().toISOString() })
          return reply(201, { id: issue.comments.length })
        }
        if (rest === "/comments") return reply(200, issue.comments)
        if (rest === "/events") return reply(200, [])
        reply(404, { message: "Not Found" })
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    return { origin: `http://127.0.0.1:${server.address().port}`, issues, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
  }

  const freePort = async () => {
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const { port } = probe.address()
    await new Promise((resolve) => probe.close(resolve))
    return port
  }

  /** Runs the proxy daemon in front of `api` until `body` settles. */
  const withProxy = async (api, extra, body) => {
    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), "issue-claim-e2e-"))
    const env = { ...process.env, SMITHERS_GITHUB_PROXY: `http://127.0.0.1:${port}`, SMITHERS_GITHUB_PROXY_UPSTREAM: api.origin,
      SMITHERS_GITHUB_TOKEN: TOKEN, ISSUE_CLAIM_APP_CONFIG: NO_APP, ISSUE_CLAIM_CACHE: join(dir, "cache"), ...extra }
    delete env.ISSUE_CLAIM_GH
    const daemon = spawn(process.execPath, [new URL("./github-proxy.mjs", import.meta.url).pathname], { env, stdio: ["ignore", "ignore", "pipe"] })
    let log = ""
    daemon.stderr.on("data", (chunk) => { log += chunk })
    try {
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${env.SMITHERS_GITHUB_PROXY}/_smithers/health`)).ok) break } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      // The CLI's own environment: no GitHub token at all, as in a confined child.
      const cliEnv = { ...env, GH_ENTERPRISE_TOKEN: "unused", GH_CONFIG_DIR: join(dir, "gh") }
      delete cliEnv.SMITHERS_GITHUB_TOKEN
      delete cliEnv.GH_TOKEN
      delete cliEnv.GITHUB_TOKEN
      const cli = (...argv) => new Promise((resolve) => {
        const child = spawn(process.execPath, [new URL("./issue-claim.mjs", import.meta.url).pathname, ...argv, ...(argv.includes("--close") ? closeArgs : [])], { env: cliEnv, cwd: evidenceFixture.root })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => { stdout += chunk })
        child.stderr.on("data", (chunk) => { stderr += chunk })
        child.on("exit", (code) => resolve({ code, out: stdout ? JSON.parse(stdout) : null, stderr }))
      })
      return await body(cli, () => log)
    } finally {
      daemon.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("claims, refuses a rival, and folds the release into a closing receipt", async () => {
    const api = await fakeApi()
    try {
      await withProxy(api, {}, async (cli, log) => {
        const claimed = await cli("claim", "o/r#7", "--by", "agent-a")
        assert.deepEqual([claimed.code, claimed.out.action, claimed.out.identity], [0, "claimed", "gh-user"], claimed.stderr)
        const refused = await cli("claim", "o/r#7", "--by", "agent-b")
        assert.deepEqual([refused.code, refused.out.action, refused.out.holder.by], [2, "refused", "agent-a"])
        const done = await cli("comment", "o/r#7", "--by", "agent-a", "--body", "Landed abc", "--release", "--note", "landed", "--close")
        assert.deepEqual([done.code, done.out.released, done.out.closed], [0, true, true], done.stderr)
        const issue = api.issues.get(7)
        assert.deepEqual([issue.labels, issue.state, issue.comments.length], [[], "closed", 2])
        assert.match(issue.comments[1].body, /^Landed abc\n\nReleased by agent-a on .*: landed$/)
        assert.ok(api.requests.every((request) => request.auth === `Bearer ${TOKEN}`), "the proxy injects the operator's token")
        for (const text of [JSON.stringify([claimed, refused, done]), log()]) assert.ok(!text.includes(TOKEN), "no token in output or log")
      })
    } finally { await api.close() }
  })

  it("spaces the writes of concurrent processes through the one proxy", async () => {
    const api = await fakeApi()
    try {
      await withProxy(api, { SMITHERS_GITHUB_WRITE_SPACING_MS: "250" }, async (cli) => {
        const runs = await Promise.all([1, 2, 3, 4].map((n) => cli("comment", `o/r#${n}`, "--body", `receipt ${n}`)))
        assert.deepEqual(runs.map((run) => run.code), [0, 0, 0, 0], runs.map((run) => run.stderr).join("\n"))
        const writes = api.requests.filter((request) => request.method !== "GET").map((request) => request.at).sort((a, b) => a - b)
        assert.equal(writes.length, 4)
        for (let i = 1; i < writes.length; i++) assert.ok(writes[i] - writes[i - 1] >= 200, `writes ${writes[i - 1]} and ${writes[i]} too close`)
      })
    } finally { await api.close() }
  })

  it("exits 75 on GitHub's secondary limit, then defers every caller without reaching GitHub", async () => {
    const api = await fakeApi({ limitComments: true })
    try {
      await withProxy(api, {}, async (cli) => {
        const limited = await cli("comment", "o/r#9", "--body", "x")
        assert.equal(limited.code, 75, limited.stderr)
        assert.ok(Date.parse(limited.out.retry_at) >= Date.now() + 250_000)
        const seen = api.requests.length
        const blocked = await cli("release", "o/r#10", "--by", "me")
        assert.equal(blocked.code, 75)
        assert.equal(api.requests.length, seen, "the paused proxy sent nothing to GitHub")
      })
    } finally { await api.close() }
  })
})
