import { journeyActivate } from "../support/keyboard-journey-input"
import { readFileSync } from "node:fs"
import type { APIRequestContext } from "@playwright/test"
import { test } from "../support"
import { scenario } from "../coverage/types"
import { attachJson, expect, JourneyUnavailable, realApi, required, runSlash, withReference, type Reference } from "../todo/reference"

// C-J10-09 S1 steps 1-5 on the reference host's real microVM install. Every
// expectation below is a committed literal or an independent GitHub/database
// read; nothing is derived from the review implementation or a spec file.
// S2 capacity (step 6) belongs to T-MCH-06 and is not asserted here.

const MEMBER_PR = 50
const OUTSIDER_PR = 51
const BASE_BRANCH = "j10/review-base"
const MEMBER_BRANCH = "alice/cache"
const OUTSIDER_BRANCH = "outsider/cache"
// The seeded off-by-one: src/cache.ts line 20 keeps capacity + 1 entries.
const OFF_BY_ONE = { path: "src/cache.ts", line: 20 }

const lines = (...text: string[]): string => text.join("\n") + "\n"
const README = lines("# C-J10-09 review fixture", "", "A bounded cache reviewed by /review.")
const PACKAGE = lines("{", '  "name": "j10-review-fixture",', '  "private": true,', '  "type": "module",',
  '  "scripts": { "test": "node --experimental-strip-types --test" }', "}")
const cache = (slack: string): string => lines(
  "/** A bounded least-recently-used cache. */",
  "export class Cache<K, V> {",
  "  readonly capacity: number",
  "  readonly #entries = new Map<K, V>()",
  "",
  "  constructor(capacity: number) {",
  '    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer")',
  "    this.capacity = capacity",
  "  }",
  "",
  "  get(key: K): V | undefined {",
  "    const value = this.#entries.get(key)",
  "    if (value !== undefined) this.set(key, value)",
  "    return value",
  "  }",
  "",
  "  /** Drop the least recently used entries until the cache holds at most `capacity`. */",
  "  evict(): void {",
  "    const keys = this.#entries.keys()",
  `    while (this.#entries.size > this.capacity${slack}) {`,
  "      const oldest = keys.next()",
  "      if (oldest.done) return",
  "      this.#entries.delete(oldest.value)",
  "    }",
  "  }",
  "",
  "  set(key: K, value: V): void {",
  "    this.#entries.delete(key)",
  "    this.#entries.set(key, value)",
  "    this.evict()",
  "  }",
  "",
  "  get size(): number {",
  "    return this.#entries.size",
  "  }",
  "}")
// The fixture's own tests pass at the PR head: they never fill the cache.
const TESTS = lines(
  'import assert from "node:assert/strict"',
  'import { test } from "node:test"',
  'import { Cache } from "../src/cache.ts"',
  "",
  'test("a read refreshes recency", () => {',
  "  const cache = new Cache<string, number>(4)",
  '  cache.set("a", 1)',
  '  cache.set("b", 2)',
  '  assert.equal(cache.get("a"), 1)',
  '  assert.equal(cache.get("missing"), undefined)',
  "  assert.equal(cache.size, 2)",
  "})")
const OUTSIDE = lines("// An outside contributor's change. It must never reach a machine.", "export const outsider = true")

type FixtureCommit = {
  readonly files: Readonly<Record<string, string>>
  readonly tree: string
  readonly commit: string
  readonly parents: readonly string[]
  readonly message: string
  readonly who: { readonly name: string; readonly email: string; readonly date: string }
}
// git hash-object/mktree/commit-tree of these exact bytes and identities.
const BASE: FixtureCommit = {
  files: { "README.md": README, "package.json": PACKAGE, "src/cache.ts": cache(""), "test/cache.test.ts": TESTS },
  tree: "58425483e8cc6b1b4122e13b6429d1ccbeec6ed9", commit: "84c0f902f865f47b4c722630b38ad46b0b7b519d", parents: [],
  message: "C-J10-09 review base\n", who: { name: "C-J10-09 Fixture", email: "fixture@example.invalid", date: "2026-10-01T11:00:00Z" }
}
const HEAD: FixtureCommit = {
  files: { ...BASE.files, "src/cache.ts": cache(" + 1") },
  tree: "7c564f232ad0beab7f4df57e4d6334509442122c", commit: "4aec46d617b236e5b430c95a9c12a935ce5389e6", parents: [BASE.commit],
  message: "Keep one more cache entry\n", who: { name: "Alice Fixture", email: "alice@example.invalid", date: "2026-10-01T12:00:00Z" }
}
const OUTSIDER: FixtureCommit = {
  files: { ...BASE.files, "src/outsider.ts": OUTSIDE },
  tree: "3fc5668b1fa11bc98dc87b48f55fe450055972d3", commit: "77bde4b16512b72607625450a9f9891be245585c", parents: [BASE.commit],
  message: "Outside contribution\n", who: { name: "Outsider Fixture", email: "outsider@example.invalid", date: "2026-10-01T13:00:00Z" }
}

type GitHub = (method: string, path: string, data?: unknown) => Promise<any>
const gitHubAs = (request: APIRequestContext, token: string, repo: string): GitHub => async (method, path, data) => {
  const response = await request.fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(data === undefined ? {} : { data })
  })
  expect(response.ok(), `GitHub ${method} ${repo}${path}: ${response.status()}`).toBe(true)
  return response.status() === 204 ? null : response.json()
}

/** Write one literal commit through the Git Data API and prove GitHub hashed the same bytes. */
const writeCommit = async (github: GitHub, fixture: FixtureCommit): Promise<void> => {
  const tree = []
  for (const [path, content] of Object.entries(fixture.files)) {
    const blob = await github("POST", "/git/blobs", { content, encoding: "utf-8" })
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha })
  }
  expect((await github("POST", "/git/trees", { tree })).sha).toBe(fixture.tree)
  const commit = await github("POST", "/git/commits", { message: fixture.message, tree: fixture.tree, parents: fixture.parents, author: fixture.who, committer: fixture.who })
  expect(commit.sha).toBe(fixture.commit)
}

type ReviewJob = {
  id: string; state: string; request_id: string; created_at: string
  payload: { admission: { number: number; base: string; head: string; url: string; author_id: number; pin: { flow: string; sourceCommit: string; executionDigest: string } } }
}
const reviewJobs = (f: Reference, number: number): ReviewJob[] => f.sql(
  `SELECT id, state, request_id, created_at, payload FROM product_job_requests WHERE operation = 'install.review' AND (payload->'admission'->>'number')::bigint = ${number} ORDER BY created_at`)
const hostBindings = (f: Reference): { binding_id: string; workspace_id: string; source_revision: string; state: string }[] =>
  f.sql("SELECT binding_id, workspace_id, source_revision, state FROM flow_runtime_host_bindings WHERE binding_kind = 'review' ORDER BY created_at")
const count = (f: Reference, query: string): number => Number(f.sql(query)[0]?.n ?? 0)

type AuditRecord = { method: string; path: string; at: string }
/** The install's outbound GitHub recorder (append-only JSONL), never browser traffic. */
const githubWrites = (auditPath: string, repo: string, since: string): AuditRecord[] =>
  readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as AuditRecord)
    .filter(record => record.at >= since && record.method.toUpperCase() !== "GET" && record.method.toUpperCase() !== "HEAD" && record.path.startsWith(`/repos/${repo}`))

test("C-J10-09 /review on a teammate's PR", scenario("journey-review-any-pr", {
  capabilities: [],
  coverage: ["action:review", "host:local", "path:success", "path:permission", "door:slash", "door:agent", "surface:confirm", "dimension:background-machine", "dimension:pinned-flow", "evidence:github-write-log"],
  description: "C-J10-09 S1: a member's PR reviewed in an ephemeral machine at its head with the Active review flow, the app agent's Confirm card, and an outsider's PR refused before any machine request."
}), async ({ browser }, info) => {
  test.setTimeout(2_400_000)
  if ((process.env.SMITHERS_JOURNEY_STAGE ?? "S1") !== "S1") throw new JourneyUnavailable("This automation qualifies C-J10-09 S1; T-MCH-06 owns the S2 capacity run")
  const auditPath = required("SMITHERS_JOURNEY_GITHUB_AUDIT_LOG")
  const outsiderToken = required("SMITHERS_JOURNEY_OUTSIDER_GITHUB_TOKEN")
  const outsiderLogin = required("SMITHERS_JOURNEY_OUTSIDER_LOGIN")
  readFileSync(auditPath, "utf8")
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page
    const name = f.repo.split("/")[1]!
    const asBen = gitHubAs(f.members.Ben.context.request, required("SMITHERS_JOURNEY_BEN_GITHUB_TOKEN"), f.repo)
    const asAlice = gitHubAs(f.members.Alice.context.request, required("SMITHERS_JOURNEY_ALICE_GITHUB_TOKEN"), f.repo)
    const asOutsider = gitHubAs(f.members.Will.context.request, outsiderToken, f.repo)
    const asOutsiderFork = gitHubAs(f.members.Will.context.request, outsiderToken, `${outsiderLogin}/${name}`)

    // Setup: a fresh scratch repository receives literal commits, filler issues
    // so the member's PR is #50, Alice's own branch and an outsider's fork PR.
    expect(await asBen("GET", "/issues?state=all")).toEqual([])
    await writeCommit(asBen, BASE)
    await asBen("POST", "/git/refs", { ref: `refs/heads/${BASE_BRANCH}`, sha: BASE.commit })
    await writeCommit(asAlice, HEAD)
    await asAlice("POST", "/git/refs", { ref: `refs/heads/${MEMBER_BRANCH}`, sha: HEAD.commit })
    for (let n = 1; n < MEMBER_PR; n++) {
      expect((await asBen("POST", "/issues", { title: `C-J10-09 filler ${n}`, body: "Scratch fixture" })).number).toBe(n)
    }
    const memberPull = await asAlice("POST", "/pulls", { title: "Keep one more cache entry", head: MEMBER_BRANCH, base: BASE_BRANCH, body: "Cache change for review." })
    expect(memberPull.number).toBe(MEMBER_PR)
    expect(memberPull.head.sha).toBe(HEAD.commit)
    expect(memberPull.base.sha).toBe(BASE.commit)
    await asOutsider("POST", "/forks", { default_branch_only: false })
    await expect.poll(async () => {
      const response = await f.members.Will.context.request.get(`https://api.github.com/repos/${outsiderLogin}/${name}/git/ref/heads/${BASE_BRANCH}`,
        { headers: { Authorization: `Bearer ${outsiderToken}`, Accept: "application/vnd.github+json" } })
      return response.ok() ? (await response.json()).object.sha : response.status()
    }, { timeout: 180_000, intervals: [2_000] }).toBe(BASE.commit)
    await writeCommit(asOutsiderFork, OUTSIDER)
    await asOutsiderFork("POST", "/git/refs", { ref: `refs/heads/${OUTSIDER_BRANCH}`, sha: OUTSIDER.commit })
    const outsiderPull = await asOutsider("POST", "/pulls", { title: "Outside contribution", head: `${outsiderLogin}:${OUTSIDER_BRANCH}`, base: BASE_BRANCH, body: "From a fork." })
    expect(outsiderPull.number).toBe(OUTSIDER_PR)
    expect(outsiderPull.head.sha).toBe(OUTSIDER.commit)
    await attachJson(info, "fixture-pulls", { member: { number: memberPull.number, author: memberPull.user.login, authorId: memberPull.user.id, head: memberPull.head.sha },
      outsider: { number: outsiderPull.number, author: outsiderPull.user.login, authorId: outsiderPull.user.id, head: outsiderPull.head.sha } })
    // The roster is read independently: Alice is a member, the outsider is not.
    expect(count(f, `SELECT count(*) AS n FROM collaborators WHERE github_id = ${Number(memberPull.user.id)} AND suspended_at IS NULL`)).toBeGreaterThan(0)
    expect(count(f, `SELECT count(*) AS n FROM collaborators WHERE github_id = ${Number(outsiderPull.user.id)}`)).toBe(0)

    const flows = await f.read("Ben", "/api/flows") as { name: string; versions: { id: string; state: string }[] }[]
    const activeReview = flows.find(card => card.name === "review")?.versions.find(version => version.state === "active")
    expect(activeReview?.id).toMatch(/^[0-9a-f]{64}$/)
    const todosBefore = await f.read("Ben", "/api/todos")
    const itemsBefore = count(f, "SELECT count(*) AS n FROM mythical_items")
    const branchesBefore = (await asBen("GET", "/branches?per_page=100") as { name: string }[]).map(branch => branch.name).sort()
    const windowStart = new Date().toISOString()

    // Step 1-2: Ben's slash door admits one background review at the PR head.
    await runSlash(ben, `/review #${MEMBER_PR}`)
    await expect.poll(() => reviewJobs(f, MEMBER_PR).length, { timeout: 60_000 }).toBe(1)
    const [job] = reviewJobs(f, MEMBER_PR)
    const admission = job!.payload.admission
    expect(admission.head).toBe(HEAD.commit)
    expect(admission.base).toBe(BASE.commit)
    expect(admission.url).toBe(`https://github.com/${f.repo}/pull/${MEMBER_PR}`)
    expect(admission.pin.flow).toBe("review")
    expect(admission.pin.executionDigest).toBe(activeReview!.id)
    await expect.poll(() => hostBindings(f).filter(binding => binding.binding_id === job!.id).length, { timeout: 600_000, intervals: [1_000] }).toBe(1)
    const machine = hostBindings(f).find(binding => binding.binding_id === job!.id)!
    expect(machine.source_revision).toBe(admission.pin.sourceCommit)
    // Never a TODO's machine.
    expect(count(f, `SELECT count(*) AS n FROM mythical_items WHERE workspace_id = '${machine.workspace_id}'`)).toBe(0)
    await attachJson(info, "step-2-run", { job: { id: job!.id, request: job!.request_id, state: job!.state }, admission, machine })

    // Step 3: the findings card lands in Ben's conversation after the run ends.
    await expect.poll(() => reviewJobs(f, MEMBER_PR)[0]?.state, { timeout: 1_800_000, intervals: [5_000] }).toBe("completed")
    const status = await (await realApi(ben, ben.context().request, "GET", `/api/reviews/${job!.id}`)).json() as {
      state: string; change: { commitId: string; findings: { path: string; line: number; severity: string; summary: string }[] }
    }
    await attachJson(info, "step-3-findings", status)
    expect(status.state).toBe("completed")
    expect(status.change.commitId).toBe(HEAD.commit)
    const finding = status.change.findings.find(each => each.path === OFF_BY_ONE.path && Math.abs(each.line - OFF_BY_ONE.line) <= 2)
    expect(finding, "a finding at src/cache.ts within 2 lines of line 20").toBeDefined()
    expect(["fix", "info"]).toContain(finding!.severity)
    const card = ben.locator('.smithers-card[data-kind="change"]').filter({ hasText: `${OFF_BY_ONE.path}:${finding!.line}` }).last()
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.locator(`a[href="https://github.com/${f.repo}/pull/${MEMBER_PR}"]`)).toBeVisible()
    // The ephemeral machine is gone; no TODO, stack item or branch appeared.
    expect(count(f, `SELECT count(*) AS n FROM workspaces WHERE id::text = '${machine.workspace_id}'`)).toBe(0)
    expect(await f.read("Ben", "/api/todos")).toEqual(todosBefore)
    expect(count(f, "SELECT count(*) AS n FROM mythical_items")).toBe(itemsBefore)
    expect((await asBen("GET", "/branches?per_page=100") as { name: string }[]).map(branch => branch.name).sort()).toEqual(branchesBefore)

    // Step 4: the app agent asks; nothing starts until Ben presses Confirm.
    await runSlash(ben, `review PR ${MEMBER_PR}`)
    const confirm = ben.locator('.smithers-card[data-kind="confirm"]').last()
    await expect(confirm).toBeVisible({ timeout: 180_000 })
    await attachJson(info, "step-4-confirm-before-press", { jobs: reviewJobs(f, MEMBER_PR).map(each => each.id) })
    expect(reviewJobs(f, MEMBER_PR)).toHaveLength(1)
    await journeyActivate(confirm.locator("button[data-primary]"))
    await expect.poll(() => reviewJobs(f, MEMBER_PR).length, { timeout: 60_000 }).toBe(2)
    const confirmed = reviewJobs(f, MEMBER_PR)[1]!
    expect(confirmed.payload.admission.head).toBe(HEAD.commit)
    await expect.poll(() => reviewJobs(f, MEMBER_PR)[1]?.state, { timeout: 1_800_000, intervals: [5_000] }).toBe("completed")

    // Step 5: an outsider's PR is refused with class permission before any machine request.
    const bindingsBefore = hostBindings(f).length
    const machinesBefore = count(f, "SELECT count(*) AS n FROM workspaces")
    await runSlash(ben, `/review #${OUTSIDER_PR}`)
    await expect(ben.getByText(/PR author is not a member/).last()).toBeVisible({ timeout: 60_000 })
    expect(reviewJobs(f, OUTSIDER_PR)).toEqual([])
    expect(hostBindings(f)).toHaveLength(bindingsBefore)
    expect(count(f, "SELECT count(*) AS n FROM workspaces")).toBe(machinesBefore)

    // No review, comment, label or status reached GitHub from any review run.
    const writes = githubWrites(auditPath, f.repo, windowStart)
    await attachJson(info, "github-write-log", writes)
    expect(writes).toEqual([])
  })
})
