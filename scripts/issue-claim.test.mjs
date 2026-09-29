import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { claimBody, holder, LABEL, parseRef, releaseBody, run } from "./issue-claim.mjs"

const T0 = new Date("2026-09-29T00:00:00Z")
const hours = (n) => new Date(T0.getTime() + n * 3600_000)
const HOST = hostname()

// An in-memory GitHub issue behind the `gh api` calls the CLI makes.
const fakeGitHub = (issue = {}) => {
  const state = { labels: [], comments: [], events: [], calls: [], clock: T0, ...issue }
  const gh = (args) => {
    state.calls.push(args.join(" "))
    const path = args.find((arg) => arg.startsWith("repos/"))
    const field = (name) => args[args.indexOf("-f", args.indexOf(`${name}=`) - 1) + 1]?.slice(name.length + 1)
    if (args.includes("DELETE")) {
      if (!state.labels.includes(LABEL)) throw new Error("Label does not exist")
      state.labels = state.labels.filter((label) => label !== LABEL)
      return "{}"
    }
    if (/\/labels$/.test(path) && !/issues/.test(path)) throw new Error("already_exists")
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
    return JSON.stringify({ state: "open", labels: state.labels.map((name) => ({ name })) })
  }
  return { state, gh }
}

const cli = (github, argv, at = T0, by = "lane-1") => {
  github.state.clock = at
  return run([...argv, "--by", by], { gh: github.gh, now: () => at, env: {} })
}

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
    assert.ok(github.state.calls.some((call) => call.startsWith("api repos/smithersai/smithers/labels -f name=in-progress -f color=fbca04")))
  })

  it("rolls back a newly added label and propagates a failed claim comment", () => {
    const github = fakeGitHub()
    const error = new Error("secondary rate limit")
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
        throw new Error("secondary rate limit")
      }
      return gh(args)
    }
    assert.throws(() => run(["claim", "smithers#7", "--by", "lane-1"],
      { gh: limitedGh, now: () => T0, env: {} }), /secondary rate limit/)
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
      { gh: ambiguousGh, now: () => T0, env: {} }), /response lost/)
    assert.deepEqual(github.state.labels, [LABEL])
    assert.equal(cli(github, ["check", "smithers#7"], T0, "lane-1").out.mine, true)
  })

  it("keeps an existing label when its holder's refresh comment fails", () => {
    const github = fakeGitHub()
    cli(github, ["claim", "smithers#7"])
    const error = new Error("secondary rate limit")
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
    assert.equal(cli(github, ["release", "smithers#3"], hours(1), "lane-1").code, 0)
    cli(github, ["claim", "smithers#3"], hours(2), "lane-1")
    assert.equal(cli(github, ["release", "smithers#3", "--force"], hours(2), "lane-2").code, 0)
  })

  it("rejects unknown commands", () => {
    assert.throws(() => cli(fakeGitHub(), ["take", "smithers#1"]), /usage/)
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
})
