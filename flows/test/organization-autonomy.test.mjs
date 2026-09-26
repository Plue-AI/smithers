/**
 * The organization's own work on the host, end to end with scripted seats,
 * a fake GitHub API (`testing/github-fixture.mjs`), a local bare remote, and
 * real microVM workspaces:
 *
 * - Issue intake: the issues are synchronized; an assigned issue, one another
 *   role claimed, and one an open pull request closes are left alone; the
 *   triage role takes one (claimed with `org:lead` and one comment, delivered
 *   under the lead, pushed, opened as a pull request whose lost answer is
 *   reconciled rather than repeated, and linked from the claim comment), skips
 *   one, asks the owner about one (a request the digest lists), and one the
 *   coding factory works on its branch is refused at the claim. A second
 *   intake decides nothing twice.
 * - A pull request GitHub refuses fails the delivery and releases the claim.
 * - A host killed in the middle of an issue's build resumes it: one branch,
 *   one pull request, one claim comment.
 * - Routines: the onboarding fires from the schedule once, survives a restart
 *   in the middle, and writes each role's onboarding page and proposal, the
 *   review comments and requests, and the priorities; the accepted proposal
 *   becomes work; a cron routine writes its report; the digest lists the
 *   pull request and what needs the owner.
 *
 * Run: node --test --test-concurrency=1 flows/test/organization-autonomy.test.mjs
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, describe, it } from "node:test"
import { startGitHubFixture } from "../organization/testing/github-fixture.mjs"
import { cleanup, git, host, line, organization, pause, repository, settled, unbootable } from "../organization/testing/harness.mjs"

const missing = unbootable()
const fixtures = []
const scratch = []
after(async () => {
  await cleanup()
  for (const fixture of fixtures) await fixture.close()
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

/** The fixture repository with `origin` a local bare remote holding `main`. */
const withRemote = () => {
  const repo = repository()
  const bare = mkdtempSync(join(tmpdir(), "organization-autonomy-remote-"))
  scratch.push(bare)
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  git(repo, "remote", "add", "origin", bare)
  git(repo, "push", "-q", "origin", "main")
  return { repo, bare }
}

/** The example organization with pull request landing, issue intake, the autonomy section, and `routines`. */
const autonomous = (routines = "[]", extra = "") =>
  organization((org) => {
    const page = join(org, "Organization.md")
    writeFileSync(page, readFileSync(page, "utf8").replace(/^wiki:$/m, [
      "routinesFile: Org/Routines.md",
      "repositories:",
      "  example/demo:",
      "    landing: pr",
      "    issues: {}",
      "autonomy:",
      "  triage: lead",
      "  maxConcurrent: 4",
      extra,
      "wiki:"
    ].filter((entry) => entry !== "").join("\n")))
    writeFileSync(join(org, "Routines.md"), `---\nroutines: ${routines}\n---\n\n# Routines\n`)
  })

const githubEnvironment = (fixture) => ({
  SMITHERS_GITHUB_API_BASE_URL: fixture.apiBaseUrl,
  SMITHERS_GITHUB_TOKEN: "fixture-token",
  SMITHERS_ORG_GITHUB_GH: "off"
})

const ledger = (handle) => JSON.parse(readFileSync(join(handle.stateDir, "autonomy.json"), "utf8"))
const start = async (handle, flow, input, key, timeoutMs) => {
  const started = await handle.ops.start(`organization/${flow}`, input, key)
  return settled(handle, started.runId, undefined, timeoutMs)
}
const itemReceipt = (root, key) => JSON.parse(readFileSync(join(root, "Org/Runs", key, "work-item.json"), "utf8")).report
const remoteBranches = (bare) =>
  git(bare, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/organization/").split("\n").filter(Boolean)
const commentsOn = (fixture, number) => fixture.state.comments.filter((comment) => comment.issue === number)

const waitFor = async (check, what, timeoutMs = 300_000, handle) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = check()
    if (found) return found
    await pause(500)
  }
  throw new Error(`timed out waiting for ${what}: ${handle?.output() ?? ""}`)
}

describe("the organization's own work", { skip: missing === undefined ? false : `skipped: ${missing}` }, () => {
  it("takes in issues: claims, delivers, opens and links a pull request, and leaves claimed issues alone", { timeout: 600_000 }, async () => {
    const fixture = await startGitHubFixture("example/demo", {
      issues: [
        { number: 1, title: "Say hello in the README", body: "Add the greeting line." },
        { number: 2, title: "Assigned to a person", assignees: ["someone"] },
        { number: 3, title: "Claimed by another role", labels: ["org:docs"] },
        { number: 4, title: "A pull request closes it" },
        { number: 5, title: "The factory works it" },
        { number: 6, title: "Out of scope" },
        { number: 7, title: "Pick the pricing" },
        { number: 8, title: "A duplicate", labels: ["duplicate"] }
      ],
      pulls: [{ number: 40, head: "feature/x", body: "Fixes #4" }],
      branches: ["smithers/issue-5"],
      // The first pull request is opened but its answer is lost: the host must find it, not open a second.
      faults: { "POST /pulls": { status: 502, create: true, times: 1 } }
    })
    fixtures.push(fixture)
    const { repo, bare } = withRemote()
    const root = autonomous()
    const handle = await host(root, repo, {
      ...githubEnvironment(fixture),
      SMITHERS_ORGANIZATION_SCRIPTED_TRIAGE: JSON.stringify({
        "6": { decision: "skip", reason: "Not ours." },
        "7": { decision: "needs-will", reason: "Pricing is the owner's call." }
      })
    })
    await handle.start()

    const first = await start(handle, "work", { max: 4 }, "work-1", 420_000)
    assert.equal(first.status, "completed", handle.output())
    const work = ledger(handle).issues

    // #1: claimed, delivered under the lead, pushed, one pull request, linked from the one claim comment.
    const taken = work["example/demo#1"]
    assert.equal(taken.status, "pull-request", JSON.stringify(work, null, 2))
    const pulls = fixture.state.pulls.filter((pull) => pull.number !== 40)
    assert.equal(pulls.length, 1, JSON.stringify(fixture.state.pulls))
    const [pull] = pulls
    assert.equal(taken.pull, `https://github.com/example/demo/pull/${pull.number}`)
    assert.match(pull.head, /^organization\/issue-example-demo-1-/)
    assert.equal(pull.base, "main")
    assert.match(pull.body, /^Fixes #1\n/)
    assert.match(pull.body, /- pass: readme/)
    assert.match(pull.body, new RegExp(`Receipt: Org/Runs/${taken.key}/deliver.json`))
    assert.deepEqual(pull.labels.sort(), ["org:lead", "organization"])
    assert.deepEqual(fixture.state.issues.get(1).labels, ["org:lead"])
    const claim = commentsOn(fixture, 1)
    assert.equal(claim.length, 1)
    assert.match(claim[0].body, new RegExp(`^Lead opened https://github.com/example/demo/pull/${pull.number}\\n\\n<!-- smithers-org:claim ${taken.key} -->$`))
    const [landed] = remoteBranches(bare)
    assert.equal(landed.split(" ")[0], pull.head)
    assert.equal(git(bare, "show", `${pull.head}:README.md`), `# Demo\n${line}`)
    assert.equal(git(bare, "rev-parse", "main"), git(repo, "rev-parse", "main"))
    const delivered = JSON.parse(readFileSync(join(root, "Org/Runs", taken.key, "deliver.json"), "utf8")).report
    assert.equal(delivered.pull.url, taken.pull)
    // The lost answer was reconciled: one POST, then the pull request found by its head.
    assert.equal(fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls")).length, 1)

    // #5: triaged, but the claim finds the coding factory's branch.
    assert.equal(work["example/demo#5"].status, "held")
    assert.match(work["example/demo#5"].reason, /coding factory works it on smithers\/issue-5/)
    // #6 skipped, #7 asks the owner through a request page.
    assert.equal(work["example/demo#6"].status, "skipped")
    assert.equal(work["example/demo#7"].status, "needs-will")
    const requests = readdirSync(join(root, "Org/Requests"))
    assert.equal(requests.length, 1)
    assert.match(readFileSync(join(root, "Org/Requests", requests[0]), "utf8"), /status: open\nvia: assistant/)
    // #2, #3, #4, #8 were never triaged, and nothing was written to them.
    for (const number of [2, 3, 4, 8]) assert.equal(work[`example/demo#${number}`], undefined, `#${number}`)
    for (const number of [2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(fixture.writes().some((call) => call.path.includes(`/issues/${number}/`)), false, `#${number} was written to`)
    }
    // The team channel has the handoff and the pull request.
    const channel = readFileSync(join(root, "Org/Team/Channel.md"), "utf8")
    assert.match(channel, /· lead · Handoff → lead/)
    assert.match(channel, new RegExp(`PR for #1 Say hello in the README · https://github.com/example/demo/pull/${pull.number}`))

    // A second intake decides nothing twice and writes nothing.
    const writes = fixture.writes().length
    const second = await start(handle, "work", { max: 4 }, "work-2", 120_000)
    assert.equal(second.status, "completed", handle.output())
    assert.equal(fixture.writes().length, writes)
    assert.equal(fixture.state.pulls.length, 2)

    // The digest lists the pull request and what needs the owner.
    assert.equal((await start(handle, "digest", {}, "digest-1", 60_000)).status, "completed", handle.output())
    const digests = readdirSync(join(root, "Org/Runs/digest"))
    const digest = readFileSync(join(root, "Org/Runs/digest", digests[0]), "utf8")
    assert.match(digest, /^Digest \d{4}-\d{2}-\d{2}\n1 landed · 1 PRs · 0 answered · 0 failed · 1 need you\n/)
    assert.match(digest, new RegExp(`PRs\n- https://github.com/example/demo/pull/${pull.number} `))
    assert.match(digest, /Needs you\n- lead: #7 Pick the pricing \(Org\/Requests\/\d{4}-\d{2}-\d{2}-lead-7-pick-the-pricing\.md\)/)

    // The intake is scheduled.
    const database = new DatabaseSync(join(handle.stateDir, "triggers.db"), { readOnly: true })
    const triggers = Object.fromEntries(database.prepare("SELECT trigger_id, flow_id, cron, timezone FROM flows_triggers").all().map((row) => [row.trigger_id, row]))
    database.close()
    assert.equal(triggers["organization-work:intake"].cron, "*/30 * * * *")
    assert.equal(triggers["organization-digest:daily"].timezone, "America/Los_Angeles")
    await handle.stop()
  })

  it("releases the claim when the pull request cannot be opened", { timeout: 420_000 }, async () => {
    const fixture = await startGitHubFixture("example/demo", {
      issues: [{ number: 9, title: "Say hello" }],
      faults: { "POST /pulls": { status: 403, create: false } }
    })
    fixtures.push(fixture)
    const { repo } = withRemote()
    const root = autonomous()
    const handle = await host(root, repo, githubEnvironment(fixture))
    await handle.start()
    assert.equal((await start(handle, "work", { max: 1 }, "work-fail", 300_000)).status, "completed", handle.output())
    const record = ledger(handle).issues["example/demo#9"]
    assert.equal(record.status, "failed", JSON.stringify(record))
    assert.match(record.reason, /GitHub request failed: POST \/repos\/example\/demo\/pulls -> 403/)
    assert.deepEqual(fixture.state.issues.get(9).labels, [])
    const [released] = commentsOn(fixture, 9)
    assert.match(released.body, /^Lead released it: /)
    assert.equal(commentsOn(fixture, 9).length, 1)
    assert.equal(itemReceipt(root, record.key).status, "failed")
    await handle.stop()
  })

  it("resumes an issue's delivery after the host is killed mid-build: one branch, one pull request, one comment", { timeout: 600_000 }, async () => {
    const fixture = await startGitHubFixture("example/demo", { issues: [{ number: 11, title: "Say hello" }] })
    fixtures.push(fixture)
    const { repo, bare } = withRemote()
    const root = autonomous()
    const hold = join(mkdtempSync(join(tmpdir(), "organization-autonomy-hold-")), "hold")
    scratch.push(join(hold, ".."))
    writeFileSync(hold, "")
    const handle = await host(root, repo, { ...githubEnvironment(fixture), SMITHERS_ORGANIZATION_SCRIPTED_HOLD: hold })
    await handle.start()
    const started = await handle.ops.start("organization/work", { max: 1 }, "work-kill")
    await waitFor(() => existsSync(`${hold}.held`), "the builder's held turn", 300_000, handle)
    await handle.stop("SIGKILL")
    rmSync(hold)
    await handle.start()
    assert.equal((await settled(handle, started.runId, undefined, 300_000)).status, "completed", handle.output())
    assert.equal(ledger(handle).issues["example/demo#11"].status, "pull-request")
    assert.equal(fixture.state.pulls.length, 1)
    assert.equal(remoteBranches(bare).length, 1)
    assert.equal(commentsOn(fixture, 11).length, 1)
    assert.equal(fixture.state.issues.get(11).labels.join(), "org:lead")
    await handle.stop()
  })

  it("runs the onboarding once from the schedule, across a restart, and turns the accepted proposal into work", { timeout: 900_000 }, async () => {
    const fixture = await startGitHubFixture("example/demo")
    fixtures.push(fixture)
    const { repo } = withRemote()
    const root = autonomous(
      "[{ id: onboarding, onboarding: true, roles: [lead, builder], enabled: true }, { id: weekly, role: lead, cron: '0 9 * * 1', timezone: America/Los_Angeles, task: Report the week., context: [receipts, channel, proposals], enabled: true }]"
    )
    const handle = await host(root, repo, githubEnvironment(fixture))
    await handle.start()
    const team = join(root, "Org/Team")

    // The schedule fires the onboarding within a minute or two; stop the host once the first page is written.
    await waitFor(() => existsSync(join(team, "lead/Onboarding.md")), "the lead's onboarding page", 240_000, handle)
    await handle.stop()
    await handle.start()
    await waitFor(() => existsSync(join(team, "Priorities.md")), "the priorities", 400_000, handle)
    await waitFor(() => ledger(handle).routines.onboarding?.state === "done", "the onboarding to finish", 60_000, handle)

    // Every role's page and proposal, one review comment and one request each, and the priorities.
    for (const role of ["lead", "builder"]) {
      const page = readFileSync(join(team, role, "Onboarding.md"), "utf8")
      assert.match(page, /## What I own\n\n- /)
      assert.match(page, /### 30 days\n\n- Learn the area\./)
    }
    const proposals = readdirSync(join(root, "Org/Proposals")).sort()
    assert.equal(proposals.length, 2, proposals.join())
    const reviewed = proposals.map((name) => readFileSync(join(root, "Org/Proposals", name), "utf8"))
      .concat(["lead", "builder"].map((role) => readFileSync(join(team, role, "Onboarding.md"), "utf8")))
      .filter((text) => /## Comment · /.test(text))
    assert.equal(reviewed.length, 2)
    assert.equal(readdirSync(join(root, "Org/Requests")).length, 2)
    const priorities = readFileSync(join(team, "Priorities.md"), "utf8")
    assert.match(priorities, /\| accept \| \[/)
    const accepted = proposals.find((name) => /status: accepted/.test(readFileSync(join(root, "Org/Proposals", name), "utf8")))
    assert.ok(accepted, "one proposal is accepted")

    // Exactly once: each assignment ran once, and the channel says each thing once.
    const channel = readFileSync(join(team, "Channel.md"), "utf8")
    for (const role of ["lead", "builder"]) {
      assert.equal(channel.split("\n").filter((entry) => entry.includes(` · ${role} · Onboarding written`)).length, 1, channel)
    }
    const routineRuns = (await handle.ops.runs()).filter((view) => view.flowId === "organization/routine")
    assert.equal(routineRuns.length, 1, JSON.stringify(routineRuns))

    // A restart registers the finished onboarding disabled; nothing runs again.
    await handle.stop()
    await handle.start()
    const database = new DatabaseSync(join(handle.stateDir, "triggers.db"), { readOnly: true })
    const trigger = database.prepare("SELECT enabled FROM flows_triggers WHERE trigger_id = ?").get("organization-routine:onboarding")
    const weekly = database.prepare("SELECT cron, timezone, enabled FROM flows_triggers WHERE trigger_id = ?").get("organization-routine:weekly")
    database.close()
    assert.equal(Number(trigger.enabled), 0)
    assert.deepEqual({ ...weekly, enabled: Number(weekly.enabled) }, { cron: "0 9 * * 1", timezone: "America/Los_Angeles", enabled: 1 })

    // The accepted proposal is work: its owner writes it as a document, and the page says done.
    assert.equal((await start(handle, "work", { max: 2 }, "work-proposals", 240_000)).status, "completed", handle.output())
    const record = ledger(handle).proposals[`Org/Proposals/${accepted}`]
    assert.equal(record.status, "answered", JSON.stringify(ledger(handle).proposals))
    assert.match(readFileSync(join(root, "Org/Proposals", accepted), "utf8"), /status: done/)

    // The cron routine's occurrence writes its report.
    const weeklyRun = await start(handle, "routine", {
      routine: { id: "weekly", role: "lead", cron: "0 9 * * 1", timezone: "America/Los_Angeles", task: "Report the week.", context: ["receipts", "channel", "proposals"], enabled: true },
      roles: [],
      triage: "lead"
    }, "weekly-1", 180_000)
    assert.equal(weeklyRun.status, "completed", handle.output())
    const reports = readdirSync(join(root, "Org/Runs/routines/weekly"))
    assert.equal(reports.length, 1)
    assert.match(readFileSync(join(root, "Org/Runs/routines/weekly", reports[0]), "utf8"), /- lead: nothing new\./)

    // The digest lists the requests the roles filed.
    assert.equal((await start(handle, "digest", {}, "digest-onboarding", 60_000)).status, "completed", handle.output())
    const digest = readFileSync(join(root, "Org/Runs/digest", readdirSync(join(root, "Org/Runs/digest"))[0]), "utf8")
    assert.match(digest, /Needs you\n- (lead|builder): (lead|builder) needs a decision/)
    await handle.stop()
  })
})
