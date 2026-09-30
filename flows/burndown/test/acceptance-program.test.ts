import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { acceptanceReviewPrelude, pushedReceiptProgram } from "../acceptance-program.ts"

const revision = "a".repeat(40)
const check = `CHECK_REVISION ${revision}\nCHECKS_PASSED\nGo prerequisite PASS`
const issue = {
  number: 3098,
  title: "Go prerequisites",
  body: "Go prerequisite passes. Docs depend on #3097.",
  comments: [{ body: "Earlier claimed fixed; not proof." }]
}
const complete = {
  version: 1,
  repo: "smithersai/smithers",
  revision,
  issues: [{
    issue: 3098,
    disposition: "complete",
    criteria: [{ criterion: "Go prerequisite passes.", evidence: ["Go prerequisite PASS"] }],
    remaining: []
  }]
}
const partial = {
  ...complete,
  issues: [{
    ...complete.issues[0]!,
    disposition: "landed",
    remaining: [{ issue: "smithersai/smithers#3097", condition: "Finish documentation acceptance." }]
  }]
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "acceptance-program-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  await mkdir(bin)
  const gh = join(bin, "gh")
  await writeFile(
    gh,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (process.env.GH_FAIL === args[2]) { process.stderr.write('provider unavailable'); process.exit(1); }
const response = args[args.length - 1] === 'number' ? {number:Number(process.env.LINKED_NUMBER)} : JSON.parse(process.env.ISSUE_DATA);
process.stdout.write(JSON.stringify(response));
`
  )
  await chmod(gh, 0o755)
  await writeFile(join(bin, "jj"), `#!${process.execPath}\nconsole.log(process.env.PUSHED_SHA ?? '${revision}');\n`)
  await chmod(join(bin, "jj"), 0o755)
  const pre = join(root, "pre.log")
  const post = join(root, "post.log")
  const path = join(root, "acceptance.json")
  const ghLog = join(root, "gh.log")
  await writeFile(pre, check)
  await writeFile(post, check)
  const program = `import { execFileSync } from 'node:child_process';
const remaining = () => 60_000;
const sha = ${JSON.stringify(revision)};
${acceptanceReviewPrelude()}
process.stdout.write(acceptancePrompt);
saveAcceptance(process.env.REPORT);
if (process.env.FAIL_AFTER_SAVE) throw new Error('later provider failure');
`
  return {
    path,
    pushed(extra: Record<string, string> = {}, issues = [{ issue: 3098 }]) {
      return spawnSync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        pushedReceiptProgram(),
        `${path}.pushed`,
        path,
        JSON.stringify({ key: "retained", repo: complete.repo, commits: issues }),
        revision,
        "change-one"
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra }
      })
    },
    pre,
    post,
    run(report = `ACCEPTANCE ${JSON.stringify(complete)}\nVERDICT: PASS`, extra: Record<string, string> = {}) {
      return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_LOG: ghLog,
          ISSUE_DATA: JSON.stringify(issue),
          LINKED_NUMBER: "3097",
          REPORT: report,
          BURNDOWN_ACCEPTANCE_MEMBER: JSON.stringify({
            repo: complete.repo,
            commits: [{ issue: 3098 }],
            notes: "READY claimed fixed"
          }),
          BURNDOWN_ACCEPTANCE_PATH: path,
          BURNDOWN_PRECHECKS_LOG: pre,
          BURNDOWN_CHECKS_LOG: post,
          ...extra
        }
      })
    },
    async calls(): Promise<Array<Array<string>>> {
      return (await readFile(ghLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    }
  }
}

test("generated reviewer fetches current issue criteria and comments at the CLI boundary", async (t) => {
  const f = await fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.calls(), [[
    "issue",
    "view",
    "3098",
    "--repo",
    "smithersai/smithers",
    "--json",
    "number,title,body,comments"
  ]])
  assert.ok(result.stdout.includes(issue.body))
  assert.ok(result.stdout.includes(issue.comments[0]!.body))
  assert.ok(result.stdout.includes("Missing or contradictory evidence must NEVER produce complete"))
  const record = JSON.parse(await readFile(f.path, "utf8"))
  assert.equal(record.context.revision, revision)
  assert.deepEqual(record.receipt, complete)
})

test("linked remaining issue must exist before partial acceptance is saved", async (t) => {
  const f = await fixture(t)
  const report = `ACCEPTANCE ${JSON.stringify(partial)}\nVERDICT: PASS`
  const result = f.run(report)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual((await f.calls())[1], ["issue", "view", "3097", "--repo", "smithersai/smithers", "--json", "number"])
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).receipt, partial)
  await rm(f.path)
  const invalid = f.run(report, { LINKED_NUMBER: "3096" })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /ACCEPTANCE_REMAINDER_INVALID/)
  await assert.rejects(readFile(f.path, "utf8"), /ENOENT/)
})

test("missing exact checked revision and contradictory completion evidence refuse persistence", async (t) => {
  const f = await fixture(t)
  await writeFile(f.pre, "CHECKS_PASSED")
  await writeFile(f.post, "CHECKS_PASSED")
  assert.match(f.run().stderr, /ACCEPTANCE_CHECKS_MISSING/)
  await assert.rejects(readFile(f.path, "utf8"), /ENOENT/)
  await writeFile(f.pre, check)
  const contradictory = {
    ...complete,
    issues: [{
      ...complete.issues[0]!,
      criteria: [{ criterion: "Go prerequisite passes.", evidence: ["docs noncacheable"] }]
    }]
  }
  await writeFile(f.post, "docs noncacheable")
  assert.match(f.run(`ACCEPTANCE ${JSON.stringify(contradictory)}\nVERDICT: PASS`).stderr, /ACCEPTANCE_INVALID/)
  await assert.rejects(readFile(f.path, "utf8"), /ENOENT/)
})

test("atomic acceptance survives later provider failure and remains usable for replay", async (t) => {
  const f = await fixture(t)
  const result = f.run(undefined, { FAIL_AFTER_SAVE: "1" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /later provider failure/)
  const retained = await readFile(f.path, "utf8")
  assert.deepEqual(JSON.parse(retained).receipt, complete)
  await assert.rejects(readFile(`${f.path}.pending`, "utf8"), /ENOENT/)
  const replay = f.run()
  assert.equal(replay.status, 0, replay.stderr)
  assert.equal(await readFile(f.path, "utf8"), retained)
})

test("confirmed push atomically retains exact issues and acceptance before later receipt writes", async (t) => {
  const f = await fixture(t)
  assert.equal(f.run().status, 0)
  const result = f.pushed()
  assert.equal(result.status, 0, result.stderr)
  const durable = JSON.parse(await readFile(`${f.path}.pushed`, "utf8"))
  assert.equal(durable.key, "retained")
  assert.deepEqual(durable.landed, [{ issue: 3098, sha: revision }])
  assert.deepEqual(durable.acceptance.receipt, complete)
  await assert.rejects(readFile(`${f.path}.pushed.pending`, "utf8"), /ENOENT/)
})

test("pushed receipt refuses changed revision or attached issues without replacing durable receipt", async (t) => {
  const f = await fixture(t)
  assert.equal(f.run().status, 0)
  assert.equal(f.pushed().status, 0)
  const before = await readFile(`${f.path}.pushed`, "utf8")
  for (const result of [f.pushed({ PUSHED_SHA: "b".repeat(40) }), f.pushed({}, [{ issue: 1871 }])]) {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /PUSHED_RECEIPT_INVALID/)
    assert.equal(await readFile(`${f.path}.pushed`, "utf8"), before)
  }
})

test("issue provider and malformed current issue data failures never save acceptance", async (t) => {
  const f = await fixture(t)
  assert.match(f.run(undefined, { GH_FAIL: "3098" }).stderr, /provider unavailable/)
  await assert.rejects(readFile(f.path, "utf8"), /ENOENT/)
  for (const invalid of [{ ...issue, number: 1871 }, { ...issue, body: null }, { ...issue, comments: null }]) {
    assert.match(f.run(undefined, { ISSUE_DATA: JSON.stringify(invalid) }).stderr, /ACCEPTANCE_ISSUE_INVALID/)
    await assert.rejects(readFile(f.path, "utf8"), /ENOENT/)
  }
})
