import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { RunView } from "../client.ts"
import { glance } from "./glance.ts"
import { command, policyOf, pruneReceipts, rotateLogs, sweepMachines } from "./hygiene.ts"
import type { Io } from "./settings.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-hygiene-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

test("the policy defaults to 10 MB logs, three copies, and every receipt kept", () => {
  assert.deepEqual(policyOf({}), { logMaxBytes: 10 * 1024 * 1024, logKeep: 3, runsKeepDays: undefined })
  assert.deepEqual(
    policyOf({ SMITHERS_ORG_LOG_MAX_MB: "1", SMITHERS_ORG_LOG_KEEP: "2", SMITHERS_ORG_RUNS_KEEP_DAYS: "30" }),
    {
      logMaxBytes: 1024 * 1024,
      logKeep: 2,
      runsKeepDays: 30
    }
  )
  assert.throws(
    () => policyOf({ SMITHERS_ORG_RUNS_KEEP_DAYS: "0" }),
    /SMITHERS_ORG_RUNS_KEEP_DAYS must be an integer of at least 1/
  )
  assert.throws(() => policyOf({ SMITHERS_ORG_LOG_MAX_MB: "ten" }), /SMITHERS_ORG_LOG_MAX_MB/)
})

test("logs over the cap are copied aside and truncated in place, keeping a bounded number", () => {
  const logs = join(scratch, "logs")
  mkdirSync(logs)
  assert.deepEqual(rotateLogs(join(scratch, "no-logs"), 10, 2), [])
  writeFileSync(join(logs, "small.log"), "ok\n")
  writeFileSync(join(logs, "notes.txt"), "x".repeat(100))
  for (const round of [1, 2, 3]) {
    writeFileSync(join(logs, "host.log"), `round ${round} `.repeat(10))
    assert.deepEqual(rotateLogs(logs, 10, 2), ["host.log"])
    assert.equal(readFileSync(join(logs, "host.log"), "utf8"), "")
  }
  assert.match(readFileSync(join(logs, "host.log.1"), "utf8"), /^round 3/)
  assert.match(readFileSync(join(logs, "host.log.2"), "utf8"), /^round 2/)
  assert.ok(!existsSync(join(logs, "host.log.3")))
  assert.equal(readFileSync(join(logs, "small.log"), "utf8"), "ok\n")
  assert.deepEqual(rotateLogs(logs, 10, 2), [])
})

test("receipts are pruned only when every file in a run is older than the policy", () => {
  const runs = join(scratch, "Org", "Runs")
  const now = Date.parse("2026-09-25T00:00:00Z")
  const age = (path: string, days: number) => {
    const at = new Date(now - days * 86_400_000)
    utimesSync(path, at, at)
  }
  for (const [name, days] of [["old", 40], ["recent", 2], ["mixed", 40]] as const) {
    mkdirSync(join(runs, name), { recursive: true })
    writeFileSync(join(runs, name, "deliver.json"), "{}")
    age(join(runs, name, "deliver.json"), days)
    age(join(runs, name), days)
  }
  writeFileSync(join(runs, "mixed", "progress.json"), "{}")
  age(join(runs, "mixed", "progress.json"), 1)
  writeFileSync(join(runs, "README.md"), "")
  age(join(runs, "README.md"), 400)
  assert.deepEqual(pruneReceipts(join(scratch, "none"), 30, now), [])
  assert.deepEqual(pruneReceipts(runs, 30, now), ["old"])
  assert.ok(existsSync(join(runs, "mixed")) && existsSync(join(runs, "recent")) && existsSync(join(runs, "README.md")))
})

/** An SDK whose machines are listed by labels and removed by `destroy`. */
const fakeSdk = (machines: ReadonlyArray<{ name: string; labels: Record<string, string> }>) => {
  const destroyed: Array<string> = []
  const handles = machines.map(({ name, labels }) => {
    const handle: any = {
      name,
      status: "running",
      configJson: JSON.stringify({ labels }),
      refresh: async () => handle,
      destroy: async () => {
        destroyed.push(name)
      }
    }
    return handle
  })
  const builder: any = { label: () => builder, cursor: () => builder }
  const sdk: any = {
    Sandbox: {
      listWith: async (build: (list: unknown) => unknown) => {
        build(builder)
        return { sandboxes: handles, nextCursor: undefined }
      }
    }
  }
  return { sdk, destroyed }
}

const labels = (workspace: string | undefined, holderLabel: string) => ({
  "smithers.provider": "microsandbox",
  "smithers.owner": "install-1",
  "smithers.holder": holderLabel,
  ...(workspace === undefined ? {} : { "smithers.workspace": workspace })
})

const holder = (alive: boolean) => (alive ? "mac:1:live" : "mac:2:dead")

test("finished runs' workspaces go whoever holds them; a dead holder's go unless its run is unfinished", async () => {
  const { sdk, destroyed } = fakeSdk([
    { name: "failed-live", labels: labels("run-failed/example/demo/build", holder(true)) },
    { name: "done-dead", labels: labels("run-done/example/demo/build", holder(false)) },
    { name: "parked-live", labels: labels("run-parked/example/demo/build", holder(true)) },
    { name: "parked-dead", labels: labels("run-parked2/example/demo/build", holder(false)) },
    { name: "unknown-live", labels: labels("run-new/example/demo/build", holder(true)) },
    { name: "unknown-dead", labels: labels("run-gone/example/demo/build", holder(false)) },
    { name: "check-live", labels: labels(undefined, holder(true)) },
    { name: "check-dead", labels: labels(undefined, holder(false)) }
  ])
  const statuses = new Map([
    ["run-failed", "failed"],
    ["run-done", "completed"],
    ["run-parked", "suspended"],
    ["run-parked2", "suspended"]
  ])
  const removed = await sweepMachines({
    sdk,
    installation: "install-1",
    statuses: async () => statuses,
    isAlive: (label) => label === holder(true)
  })
  const expected = ["check-dead", "done-dead", "failed-live", "unknown-dead"]
  assert.deepEqual([...removed].sort(), expected)
  assert.deepEqual(destroyed.sort(), expected)
})

const capture = (env: Io["env"]) => {
  const out: Array<string> = [], err: Array<string> = []
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env, cwd: scratch },
    out,
    err
  }
}

test("clean rotates and prunes by the .env policy", async () => {
  const stateDir = join(scratch, "state"), wiki = join(scratch, "wiki")
  mkdirSync(join(stateDir, "logs"), { recursive: true })
  mkdirSync(join(wiki, "Org", "Runs", "cli-old"), { recursive: true })
  writeFileSync(join(stateDir, "logs", "host.log"), "x".repeat(2 * 1024 * 1024))
  writeFileSync(
    join(stateDir, ".env"),
    `SMITHERS_ORG_LOG_MAX_MB=1\nSMITHERS_ORG_RUNS_KEEP_DAYS=1\nSMITHERS_ORG_ROOT=${wiki}\n`
  )
  const old = new Date(Date.now() - 3 * 86_400_000)
  utimesSync(join(wiki, "Org", "Runs", "cli-old"), old, old)
  // No Organization.md: the policy needs the wiki's configuration to find its receipts.
  const failing = capture({ SMITHERS_ORG_STATE_DIR: stateDir })
  await assert.rejects(command.run([], failing.io))
  const { init } = await import("./init.ts")
  rmSync(wiki, { recursive: true })
  await init({ dir: wiki, stateDir: join(scratch, "init-state"), appName: "Org" })
  mkdirSync(join(wiki, "Org", "Runs", "cli-old"), { recursive: true })
  utimesSync(join(wiki, "Org", "Runs", "cli-old"), old, old)

  writeFileSync(join(stateDir, "logs", "host.log"), "x".repeat(2 * 1024 * 1024))
  const run = capture({ SMITHERS_ORG_STATE_DIR: stateDir })
  assert.equal(await command.run([], run.io), 0)
  assert.match(run.out[0]!, /Z rotated host\.log$/)
  assert.match(run.out[1]!, /Z pruned 1 receipt\(s\)$/)
  assert.equal(run.out.length, 2)
  assert.ok(!existsSync(join(wiki, "Org", "Runs", "cli-old")))
  assert.equal(readFileSync(join(stateDir, "logs", "host.log"), "utf8"), "")
})

const view = (runId: string, status: string, gates: RunView["gates"] = []): RunView => ({
  runId,
  flowId: "organization/intake",
  status,
  gates
})

test("status at a glance: counts, then parked with the answer command, failed, running", () => {
  assert.deepEqual(glance([]), ["no runs"])
  const gate = { runId: "r2", gateId: "land", subjectDigest: "d", prompt: "Land this change?\nfiles", wait: "w" }
  assert.deepEqual(
    glance([
      view("r1", "completed"),
      view("r2", "waiting-approval", [gate]),
      view("r3", "failed"),
      view("r4", "running"),
      view("r5", "cancelled"),
      view("r6", "pending")
    ]),
    [
      "running 2  parked 1  failed 2  done 1",
      "parked  r2  organization/intake",
      "        answer land approve|decline  Land this change?",
      "failed  r3  organization/intake",
      "cancelled r5  organization/intake",
      "running r4  organization/intake",
      "running r6  organization/intake"
    ]
  )
})
