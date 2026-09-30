import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { ISSUE_CLOSED, refuseIfClosed } from "../closed-guard.ts"
import { Ready } from "../schema.ts"
import { Schema } from "effect"

const run = promisify(execFile)
const sha = "a".repeat(40)
const member = (): Ready => ({
  assignment: {
    key: "w1",
    repo: "smithersai/smithers",
    lead: { repo: "smithersai/smithers", n: 7, title: "t" },
    extras: [{ repo: "smithersai/smithers", n: 8, title: "t" }],
    account: "claude-1",
    tool: "claude",
    model: "m",
    attempt: 0,
    placement: "local"
  },
  result: {
    key: "w1",
    status: "ready",
    commits: [{ issue: 7, commit: sha }, { issue: 8, commit: "b".repeat(40) }],
    notes: "",
    agentHours: 0
  }
} as Ready)

// Fake GitHub: a `gh` executable answering `issue view N --json state` from a state file.
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "closed-guard-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "bin"))
  const states = join(root, "states.json")
  await writeFile(states, JSON.stringify({ 7: "OPEN", 8: "OPEN" }))
  await writeFile(
    join(root, "bin/gh"),
    `#!${process.execPath}\nconst s=JSON.parse(require('node:fs').readFileSync(${
      JSON.stringify(states)
    },'utf8'));const n=process.argv[4];if(s[n]===undefined){console.error('gone');process.exit(1)}console.log(s[n]);\n`
  )
  await chmod(join(root, "bin/gh"), 0o755)
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` }
  const released: Array<[number, string, string]> = []
  return {
    root,
    released,
    setState: (value: Record<string, string>) => writeFile(states, JSON.stringify(value)),
    deps: {
      view: (repo: string, n: number) =>
        run("gh", ["issue", "view", String(n), "--repo", repo, "--json", "state", "--jq", ".state"], { env })
          .then(({ stdout }) => stdout),
      release: async (_repo: string, n: number, by: string, note: string) => {
        released.push([n, by, note])
        return true
      },
      receiptsDir: join(root, "landings")
    }
  }
}

test("fixture member is a valid READY bundle", () => {
  assert.ok(Schema.is(Ready)(member()))
})

test("open issues pass: nothing released, no receipt", async (t) => {
  const f = await fixture(t)
  assert.equal(await refuseIfClosed(member(), f.deps), undefined)
  assert.deepEqual(f.released, [])
  await assert.rejects(readFile(join(f.root, "landings/w1.refused.json")), { code: "ENOENT" })
})

test("a closed member refuses, releases every claim as issue_closed, and keeps the commits", async (t) => {
  const f = await fixture(t)
  await f.setState({ 7: "OPEN", 8: "CLOSED" })
  const refusal = await refuseIfClosed(member(), f.deps)
  assert.deepEqual(refusal, { key: "w1", reason: ISSUE_CLOSED, issues: [8] })
  assert.deepEqual(f.released, [[7, "burndown-w1", "issue_closed"], [8, "burndown-w1", "issue_closed"]])
  const receipt = JSON.parse(await readFile(join(f.root, "landings/w1.refused.json"), "utf8"))
  assert.equal(receipt.reason, "issue_closed")
  assert.deepEqual(receipt.closed, [8])
  assert.deepEqual(receipt.commits, member().result.commits)
})

test("the refusal is idempotent on retry", async (t) => {
  const f = await fixture(t)
  await f.setState({ 7: "CLOSED", 8: "CLOSED" })
  const first = await refuseIfClosed(member(), f.deps)
  const path = join(f.root, "landings/w1.refused.json")
  const before = await readFile(path, "utf8")
  await new Promise((resolve) => setTimeout(resolve, 15))
  const second = await refuseIfClosed(member(), f.deps)
  assert.deepEqual(second, first)
  assert.equal(await readFile(path, "utf8"), before)
})

test("an unreadable state is an error, never a permit", async (t) => {
  const f = await fixture(t)
  await f.setState({})
  await assert.rejects(refuseIfClosed(member(), f.deps))
  assert.deepEqual(f.released, [])
})
