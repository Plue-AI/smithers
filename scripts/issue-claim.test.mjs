import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { claimBody, holder, LABEL, parseRef, releaseBody, run, splitResponse, throttle, TRANSIENT, Transient } from "./issue-claim.mjs"

const T0 = new Date("2026-09-29T00:00:00Z")
const hours = (n) => new Date(T0.getTime() + n * 3600_000)
const HOST = hostname()

// An unthrottled cache dir per fake, so command tests never wait; throttle tests set their own limits.
const cacheEnv = (extra = {}) => ({ ISSUE_CLAIM_CACHE: mkdtempSync(join(tmpdir(), "issue-claim-cache-")),
  ISSUE_CLAIM_SPACING_MS: "0", ISSUE_CLAIM_PER_MINUTE: "100000", ...extra })

// An in-memory GitHub issue behind the `gh api` calls the CLI makes.
const fakeGitHub = (issue = {}) => {
  const state = { labels: [], comments: [], events: [], calls: [], clock: T0, open: true, env: cacheEnv(), ...issue }
  const gh = (args) => {
    state.calls.push(args.join(" "))
    const path = args.find((arg) => arg.startsWith("repos/"))
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
  return run([...argv, "--by", by], { gh: github.gh, now: () => at, env: github.state.env })
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
    assert.ok(github.state.calls.includes(`api --method DELETE repos/smithersai/smithers/issues/7/labels/${LABEL}`))
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
    assert.throws(() => run(["claim", "smithers#7", "--by", "lane-1"],
      { gh: limitedGh, now: () => T0, env: github.state.env }), /Bad Gateway/)
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
    assert.throws(() => run(["claim", "smithers#7", "--by", "lane-1"],
      { gh: ambiguousGh, now: () => T0, env: github.state.env }), /response lost/)
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

describe("issue-claim write throttle", () => {
  // A fake clock the throttle's sleep advances, so minutes of spacing run instantly.
  const clocked = (env) => {
    let t = T0.getTime()
    return { now: () => new Date(t), sleep: (ms) => { if (ms > 0) t += ms }, advance: (ms) => { t += ms },
      throttle: () => throttle({ env, now: () => new Date(t), sleep: (ms) => { if (ms > 0) t += ms } }), get t() { return t } }
  }
  const limitError = (headers = "") => Object.assign(new Error("gh: You have exceeded a secondary rate limit (HTTP 403)"),
    { stderr: "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
      stdout: `HTTP/2.0 403 Forbidden\r\n${headers}Content-Type: application/json\r\n\r\n{"message":"secondary rate limit"}` })

  it("spaces writes 3 s apart and never exceeds 15 in any minute", () => {
    const env = { ISSUE_CLAIM_CACHE: cacheEnv().ISSUE_CLAIM_CACHE, ISSUE_CLAIM_MAX_WAIT_MS: "3600000" }
    const clock = clocked(env)
    const times = []
    const gh = () => { times.push(clock.t); return "{}" }
    for (let i = 0; i < 40; i++) { const writes = clock.throttle(); writes.write(writes.reserve(1)[0], gh, ["api", "x", "-f", "a=b"]) }
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 3000)
    for (let i = 15; i < times.length; i++) assert.ok(times[i] - times[i - 15] >= 60_000, `write ${i} is the 16th within a minute`)
  })

  it("books all slots or none, and defers when the budget is booked past the wait limit", () => {
    const env = { ISSUE_CLAIM_CACHE: cacheEnv().ISSUE_CLAIM_CACHE, ISSUE_CLAIM_PER_MINUTE: "2", ISSUE_CLAIM_MAX_WAIT_MS: "10000" }
    const clock = clocked(env)
    assert.throws(() => clock.throttle().reserve(3), (error) => error instanceof Transient && error.retryAt === T0.getTime() + 60_000)
    assert.deepEqual(clock.throttle().reserve(2), [T0.getTime(), T0.getTime() + 3000], "the failed booking reserved nothing")
  })

  it("blocks every writer for Retry-After, then backs off exponentially from 1 minute, and resets on success", () => {
    const env = { ISSUE_CLAIM_CACHE: cacheEnv().ISSUE_CLAIM_CACHE }
    const clock = clocked(env)
    const fail = (headers) => () => { throw limitError(headers) }
    const writes = clock.throttle()
    assert.throws(() => writes.write(writes.reserve(1)[0], fail("Retry-After: 300\r\n"), ["api", "x"]),
      (error) => error instanceof Transient && error.retryAt === clock.t + 300_000)
    assert.throws(() => clock.throttle().open(), Transient, "a second process sees the block without calling GitHub")
    clock.advance(300_000)
    const again = clock.throttle()
    assert.throws(() => again.write(again.reserve(1)[0], fail(""), ["api", "x"]), (error) => error.retryAt - clock.t === 120_000, "backoff doubled from 60 s")
    clock.advance(120_000)
    const third = clock.throttle()
    assert.throws(() => third.write(third.reserve(1)[0], fail(""), ["api", "x"]), (error) => error.retryAt - clock.t === 240_000)
    clock.advance(240_000)
    const ok = clock.throttle()
    assert.equal(ok.write(ok.reserve(1)[0], () => "HTTP/2.0 201 Created\r\nX-Ratelimit-Remaining: 10\r\n\r\n{\"id\":1}", ["api", "x"]), "{\"id\":1}")
    const after = clock.throttle()
    assert.throws(() => after.write(after.reserve(1)[0], fail(""), ["api", "x"]), (error) => error.retryAt - clock.t === 60_000, "success reset the backoff")
  })

  it("waits for the x-ratelimit reset when the quota is exhausted", () => {
    const env = { ISSUE_CLAIM_CACHE: cacheEnv().ISSUE_CLAIM_CACHE }
    const clock = clocked(env)
    const reset = Math.floor(T0.getTime() / 1000) + 900
    const writes = clock.throttle()
    writes.write(writes.reserve(1)[0], () => `HTTP/2.0 201 Created\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${reset}\n\n{}`, ["api", "x"])
    assert.throws(() => clock.throttle().open(), (error) => error.retryAt === reset * 1000)
  })

  it("treats a plain permission 403 as an error, not a rate limit", () => {
    const writes = clocked({ ISSUE_CLAIM_CACHE: cacheEnv().ISSUE_CLAIM_CACHE }).throttle()
    const denied = Object.assign(new Error("HTTP 403"), { stderr: "gh: Resource not accessible by integration (HTTP 403)" })
    assert.throws(() => writes.write(writes.reserve(1)[0], () => { throw denied }, ["api", "x"]), (error) => error === denied)
  })

  it("splits gh api -i output into headers and body", () => {
    assert.deepEqual(splitResponse("HTTP/2.0 200 OK\r\nRetry-After: 5\r\nX-A: b: c\r\n\r\n[1]"), { headers: { "retry-after": "5", "x-a": "b: c" }, body: "[1]" })
    assert.deepEqual(splitResponse("[1]"), { headers: {}, body: "[1]" })
  })

  it("returns 75 without any GitHub call while writes are blocked, and after a rate-limited claim comment", () => {
    const github = fakeGitHub()
    const gh = github.gh
    github.gh = (args) => {
      if (args.includes("repos/smithersai/smithers/issues/9/comments") && args.includes("-f")) throw limitError("Retry-After: 300\r\n")
      return gh(args)
    }
    const limited = cli(github, ["claim", "smithers#9"])
    assert.deepEqual([limited.code, limited.out.action], [TRANSIENT, "deferred"])
    assert.equal(limited.out.retry_at, "2026-09-29T00:05:00.000Z")
    assert.deepEqual(github.state.labels, [], "the new label is rolled back")
    const calls = github.state.calls.length
    for (const command of ["claim", "release", "comment"]) {
      assert.equal(cli(github, [command, "smithers#10", "--body", "x"], new Date(T0.getTime() + 30_000)).code, TRANSIENT)
    }
    assert.equal(github.state.calls.length, calls)
    assert.equal(cli(github, ["check", "smithers#10"], new Date(T0.getTime() + 30_000)).code, 0, "check only reads")
  })
})

describe("issue-claim executable", () => {
  it("prints one JSON line and exits 2 when the issue is held", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-claim-"))
    try {
      const fake = join(dir, "gh")
      const comment = claimBody({ by: "other", host: "mac", now: new Date(Date.now() - 60_000) })
      writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2)
require("node:fs").appendFileSync(${JSON.stringify(join(dir, "log"))}, args.join(" ") + "\\n")
const path = args.find((a) => a.startsWith("repos/"))
if (path.endsWith("/comments?per_page=100")) console.log(JSON.stringify([[{ body: ${JSON.stringify(comment)}, created_at: new Date().toISOString() }]]))
else console.log(JSON.stringify({ state: "open", labels: [{ name: "in-progress" }] }))
`, { mode: 0o755 })
      const script = new URL("./issue-claim.mjs", import.meta.url).pathname
      let status = 0, stdout = ""
      try { execFileSync(process.execPath, [script, "claim", "plue#9", "--by", "me"], { env: { ...process.env, ISSUE_CLAIM_GH: fake }, encoding: "utf8" }) }
      catch (error) { status = error.status; stdout = error.stdout }
      assert.equal(status, 2)
      assert.equal(JSON.parse(stdout).holder.by, "other")
      assert.doesNotMatch(readFileSync(join(dir, "log"), "utf8"), /-f body=/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  const fakeGhScript = (dir) => {
    const fake = join(dir, "gh")
    writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2)
const fs = require("node:fs")
if (args.includes("-f") || args.includes("--method")) fs.appendFileSync(${JSON.stringify(join(dir, "writes"))}, Date.now() + " " + args.join(" ") + "\\n")
if (process.env.FAKE_LIMIT && args.includes("-f")) { console.error("gh: You have exceeded a secondary rate limit (HTTP 403)"); process.exit(1) }
const path = args.find((a) => a.startsWith("repos/"))
if (path.endsWith("/comments?per_page=100")) console.log(JSON.stringify([[]]))
else if (path.endsWith("/events?per_page=100")) console.log("[[]]")
else console.log(JSON.stringify({ state: "open", labels: [] }))
`, { mode: 0o755 })
    return fake
  }

  it("shares one throttle across concurrent processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-claim-"))
    try {
      const env = { ...process.env, ISSUE_CLAIM_GH: fakeGhScript(dir), ISSUE_CLAIM_CACHE: join(dir, "cache"), ISSUE_CLAIM_SPACING_MS: "250" }
      const script = new URL("./issue-claim.mjs", import.meta.url).pathname
      const { spawn } = await import("node:child_process")
      const codes = await Promise.all([1, 2, 3, 4].map((n) => new Promise((resolve) => {
        spawn(process.execPath, [script, "comment", `plue#${n}`, "--body", `receipt ${n}`], { env, stdio: "ignore" }).on("exit", resolve)
      })))
      assert.deepEqual(codes, [0, 0, 0, 0])
      assert.equal(readFileSync(join(dir, "writes"), "utf8").trim().split("\n").length, 4)
      // Each process books its slot in the shared state; gh start-up jitter makes wall-clock gaps noisier.
      const { slots } = JSON.parse(readFileSync(join(dir, "cache", "throttle.json"), "utf8"))
      assert.equal(slots.length, 4)
      for (let i = 1; i < slots.length; i++) assert.ok(slots[i] - slots[i - 1] >= 250, `slots ${slots[i - 1]} and ${slots[i]} too close`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("exits 75 with retry_at on a secondary rate limit, then defers without calling gh", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-claim-"))
    try {
      const env = { ...process.env, ISSUE_CLAIM_GH: fakeGhScript(dir), ISSUE_CLAIM_CACHE: join(dir, "cache"), ISSUE_CLAIM_SPACING_MS: "0", FAKE_LIMIT: "1" }
      const script = new URL("./issue-claim.mjs", import.meta.url).pathname
      const attempt = () => {
        try { execFileSync(process.execPath, [script, "release", "plue#9", "--by", "me"], { env, encoding: "utf8" }); return { status: 0 } }
        catch (error) { return error }
      }
      execFileSync(process.execPath, [script, "comment", "plue#9", "--body", "x"], { env: { ...env, FAKE_LIMIT: "" }, encoding: "utf8" })
      const writes = readFileSync(join(dir, "writes"), "utf8")
      const limited = (() => { try { execFileSync(process.execPath, [script, "comment", "plue#10", "--body", "y"], { env, encoding: "utf8" }) } catch (error) { return error } })()
      assert.equal(limited.status, 75)
      assert.ok(Date.parse(JSON.parse(limited.stdout).retry_at) >= Date.now() + 50_000)
      const blocked = attempt()
      assert.equal(blocked.status, 75)
      assert.equal(readFileSync(join(dir, "writes"), "utf8").split("\n").length, writes.split("\n").length + 1, "only the limited write reached gh")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
