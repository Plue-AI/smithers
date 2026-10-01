import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { claimTool, decide, parkedFor, releasesClaim } from "../flow.ts"

const claim = (host: string, expires: string) =>
  `Claimed by codex-root-3276 on ${host} at 2026-09-30T23:28:42.882Z; expires ${expires}`
const expires = "2026-10-01T05:28:42.882Z"
const at = Date.parse(expires)

test("an issue with no claim comment is ours", () => {
  assert.equal(decide(undefined, at), "ours")
})

test("a comment that is not a claim is ours", () => {
  assert.equal(decide("Claimed it, will look tomorrow", at), "ours")
})

test("a live Mac mini claim is skipped up to the millisecond before it expires", () => {
  assert.equal(decide(claim("Williams-Mac-mini.local", expires), at - 1), "skip")
})

test("a Mac mini claim is ours from the moment it expires", () => {
  assert.equal(decide(claim("Williams-Mac-mini.local", expires), at), "ours")
  assert.equal(decide(claim("Williams-Mac-mini.local", expires), at + 1), "ours")
})

test("a live claim from any other machine is ours", () => {
  assert.equal(decide(claim("Williams-MacBook-Pro-3.local", expires), at - 1), "ours")
})

test("a claim line ending in a period still parses", () => {
  assert.equal(decide(`${claim("Williams-Mac-mini.local", expires)}.`, at - 1), "skip")
})

test("an unparseable expiry is treated as expired", () => {
  assert.equal(decide(claim("Williams-Mac-mini.local", "soon"), at), "ours")
})

// A peer's half-made edit to the shared checkout's issue-claim.mjs failed every claim of a running sweep.
test("the claim tool is the copy in this flow's own checkout", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  assert.equal(claimTool, `${root}scripts/issue-claim.mjs`)
})

// run-4: a requeued row's release removed the workspaces its resumed children landed from.
test("a requeued row keeps its claim and workspace; every final row releases them", () => {
  assert.equal(releasesClaim("requeued"), false)
  for (const status of ["landed", "held", "failed", "skipped"] as const) assert.equal(releasesClaim(status), true)
})

// run-4: agents spent their run on #2845 (blocked-on-will) and #3165/#3166 ("Deferred past 1.0").
test("issues for the maintainer or deferred by title are not dispatched", () => {
  assert.equal(parkedFor({ title: "Release: publish installers", labels: ["blocked-on-will"] }), "blocked on the maintainer")
  assert.equal(parkedFor({ title: "Deferred past 1.0: Npm.Downstream build target", labels: [] }), "deferred")
  assert.equal(parkedFor({ title: "  deferred: x", labels: ["bug"] }), "deferred")
  assert.equal(parkedFor({ title: "Defer the cache flush until close", labels: [] }), undefined)
  assert.equal(parkedFor({ title: "Retire the legacy Workers", labels: ["bug", "in-progress"] }), undefined)
})
