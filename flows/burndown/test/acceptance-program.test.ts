import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { bundle } from "../../coding/build.mjs"
import { acceptanceReviewPrelude, pushedReceiptProgram, verifiedReceiptProgram } from "../acceptance-program.ts"
import { buildReviewInput, ReviewInputIncomplete } from "../review-input.ts"

const revision = "a".repeat(40)
const original = "b".repeat(40)
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

const sourcePrograms = { acceptanceReviewPrelude, pushedReceiptProgram, verifiedReceiptProgram }

test("assembled review preserves all required bytes at its UTF-8 boundary and refuses one byte more", () => {
  const parts = { revision, base: original, diff: "DIFF_REQUIRED", context: "", comments: [], notes: "" }
  const empty = buildReviewInput(parts)
  const length = 1_048_576 - 4096 - empty.receipt.requiredBytes
  const exact = buildReviewInput({ ...parts, context: "é".repeat(Math.floor(length / 2)) + "x".repeat(length % 2) })
  assert.equal(exact.receipt.requiredBytes + 4096, 1_048_576)
  assert.ok(exact.receipt.inputBytes <= 1_048_576)
  assert.ok(exact.input.includes("DIFF_REQUIRED"))
  assert.throws(
    () => buildReviewInput({ ...parts, context: "é".repeat(Math.floor(length / 2)) + "x".repeat(length % 2 + 1) }),
    (error) => {
      assert.ok(error instanceof ReviewInputIncomplete)
      assert.equal(error._tag, "ReviewInputIncomplete")
      assert.equal(error.disposition, "park")
      assert.equal(error.requiredBytes, 1_048_577)
      return true
    }
  )
})

test("optional fields obey individual and remaining aggregate budgets with exact omission hashes", () => {
  const parts = {
    revision,
    base: original,
    diff: "REQUIRED_DIFF",
    context: { acceptance: "WHOLE_ACCEPTANCE" },
    comments: [],
    notes: ""
  }
  const notes = "n".repeat(20_000)
  const comments = [{ issue: 1, comments: [{ body: "c".repeat(40_000) }] }]
  const omitted = buildReviewInput({ ...parts, notes, comments })
  for (const [index, value] of [comments, notes].entries()) {
    const receipt = omitted.receipt.optional[index]!
    assert.equal(receipt.omission, "optional_input_limit")
    assert.equal(receipt.includedBytes, 0)
    assert.equal(receipt.providedBytes, Buffer.byteLength(JSON.stringify(value)))
    assert.equal(receipt.digest, createHash("sha256").update(JSON.stringify(value)).digest("hex"))
  }
  assert.ok(omitted.input.includes("WHOLE_ACCEPTANCE"))
  const baseline = buildReviewInput({ ...parts, context: "" })
  const requiredLength = 1_048_576 - 8192 - baseline.receipt.requiredBytes
  const combined = buildReviewInput({
    ...parts,
    context: "a".repeat(requiredLength),
    comments: [{ issue: 1, comments: [{ body: "c".repeat(20_000) }] }],
    notes: "n".repeat(10_000)
  })
  assert.ok(combined.receipt.inputBytes <= 1_048_576)
  assert.ok(combined.receipt.optional.every((item) => item.omission === "aggregate_input_limit"))
  assert.ok(combined.input.includes("a".repeat(requiredLength)))
  assert.match(combined.input, /historical superset/)
})

async function fixture(t: test.TestContext, programs = sourcePrograms) {
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
  const memberPath = join(root, "member.json")
  await writeFile(pre, check)
  await writeFile(post, check)
  const program = `import { execFileSync } from 'node:child_process';
const remaining = () => 60_000;
const sha = ${JSON.stringify(revision)};
${programs.acceptanceReviewPrelude()}
process.stdout.write(acceptancePrompt);
saveAcceptance(process.env.REPORT);
if (process.env.FAIL_AFTER_SAVE) throw new Error('later provider failure');
`
  return {
    path,
    pushed(
      extra: Record<string, string> = {},
      issues = [{ issue: 3098, commit: original }],
      cold = false,
      target = `${path}.pushed`
    ) {
      writeFileSync(memberPath, JSON.stringify({ key: "retained", repo: complete.repo, commits: issues }), {
        mode: 0o600
      })
      return spawnSync(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        programs.pushedReceiptProgram(),
        target,
        cold ? "-" : path,
        memberPath,
        revision,
        "change-one"
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra }
      })
    },
    probe() {
      writeFileSync(
        memberPath,
        JSON.stringify({ key: "retained", repo: complete.repo, commits: [{ issue: 3098, commit: original }] }),
        { mode: 0o600 }
      )
      return spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        programs.verifiedReceiptProgram(),
        `${path}.pushed`,
        memberPath
      ], { encoding: "utf8", timeout: 10_000 })
    },
    pre,
    post,
    run(report = `ACCEPTANCE ${JSON.stringify(complete)}\nVERDICT: PASS`, extra: Record<string, string> = {}) {
      writeFileSync(
        memberPath,
        JSON.stringify({
          repo: complete.repo,
          commits: [{ issue: 3098, commit: original }],
          notes: "READY claimed fixed"
        }),
        { mode: 0o600 }
      )
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
          BURNDOWN_ACCEPTANCE_MEMBER_PATH: memberPath,
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
  assert.equal(durable.version, 2)
  assert.equal(durable.phase, "verified")
  assert.deepEqual(durable.landed, [{ issue: 3098, sha: revision }])
  assert.deepEqual(durable.acceptance.receipt, complete)
  await assert.rejects(readFile(`${f.path}.pushed.pending`, "utf8"), /ENOENT/)
})

test("pushed receipt refuses changed revision or attached issues without replacing durable receipt", async (t) => {
  const f = await fixture(t)
  assert.equal(f.run().status, 0)
  assert.equal(f.pushed().status, 0)
  const before = await readFile(`${f.path}.pushed`, "utf8")
  for (const result of [f.pushed({ PUSHED_SHA: "b".repeat(40) }), f.pushed({}, [{ issue: 1871, commit: original }])]) {
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

test("cold confirmation persists one landed receipt then upgrades it with exact acceptance", async (t) => {
  const f = await fixture(t)
  const confirmed = f.pushed({}, undefined, true)
  assert.equal(confirmed.status, 0, confirmed.stderr)
  const fact = JSON.parse(await readFile(`${f.path}.pushed`, "utf8"))
  assert.equal(fact.version, 2)
  assert.equal(fact.phase, "landed")
  assert.equal(fact.acceptance, undefined)
  assert.deepEqual(fact.commits, [{ issue: 3098, commit: original }])
  assert.match(confirmed.stdout, /^LANDING_CONFIRMED /)
  assert.equal(f.run().status, 0)
  assert.equal(f.pushed().status, 0)
  const verified = JSON.parse(await readFile(`${f.path}.pushed`, "utf8"))
  assert.equal(verified.phase, "verified")
  assert.deepEqual(verified.landed, fact.landed)
  assert.deepEqual(verified.acceptance.context.commits, fact.commits)
})

test("atomic writer failure still emits independently bound remote confirmation", async (t) => {
  const f = await fixture(t)
  const result = f.pushed({}, undefined, true, join(f.path, "missing", "pushed.json"))
  assert.notEqual(result.status, 0)
  const line = result.stdout.trim()
  assert.ok(line.startsWith("LANDING_CONFIRMED "), result.stderr)
  const fact = JSON.parse(line.slice("LANDING_CONFIRMED ".length))
  assert.equal(fact.phase, "landed")
  assert.equal(fact.key, "retained")
  assert.deepEqual(fact.commits, [{ issue: 3098, commit: original }])
  assert.deepEqual(fact.landed, [{ issue: 3098, sha: revision }])
})

test("warm embedded verified probe survives standalone loss and refuses unverified or malformed facts", async (t) => {
  const f = await fixture(t)
  assert.equal(f.probe().status, 1)
  assert.equal(f.pushed({}, undefined, true).status, 0)
  assert.equal(f.probe().status, 1)
  assert.equal(f.run().status, 0)
  assert.equal(f.pushed().status, 0)
  await rm(f.path)
  assert.equal(f.probe().status, 0)
  await writeFile(`${f.path}.pushed`, "{}")
  assert.equal(f.probe().status, 1)
})

test("shipped host bundler preserves generated acceptance and landing validation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-transform-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, "entry.ts")
  const output = join(root, "compiled.mjs")
  const source = fileURLToPath(new URL("../acceptance-program.ts", import.meta.url))
  await writeFile(
    entry,
    `export { acceptanceReviewPrelude, pushedReceiptProgram, verifiedReceiptProgram } from ${JSON.stringify(source)};`
  )
  // Execute the deployment build itself, including its aliases and exact
  // esbuild settings. A hand-written approximation does not qualify this gate.
  await bundle(entry, output)
  const programs: typeof sourcePrograms = await import(pathToFileURL(output).href)
  // Include the actual deployment host graph without executing its entry. This
  // detects helper renaming caused by binding collisions elsewhere in the host.
  const host = fileURLToPath(new URL("../../coding/serve.ts", import.meta.url))
  const hostEntry = join(root, "host-entry.ts")
  const hostOutput = join(root, "host-compiled.mjs")
  await writeFile(hostEntry, `import ${JSON.stringify(host)}; export * from ${JSON.stringify(source)};`)
  await bundle(hostEntry, hostOutput)
  const hostText = await readFile(hostOutput, "utf8")
  for (
    const name of ["validateAcceptance", "parseAcceptanceReview", "validateMemberAcceptance", "validateLandingReceipt"]
  ) {
    assert.match(hostText, new RegExp(`function ${name}\\(`))
    assert.ok(hostText.includes("${" + name + ".toString()}"), `serialized helper binding changed: ${name}`)
  }
  assert.match(hostText, /(?:var|let|const) ReviewInputIncomplete = class/)
  assert.match(hostText, /function buildReviewInput\(/)
  for (const name of ["ReviewInputIncomplete", "buildReviewInput"]) {
    assert.ok(hostText.includes(name + ".toString()"), `serialized review input binding changed: ${name}`)
  }
  // Evaluate only the compiled declarations from the actual host graph. The
  // deployed host entry itself has startup effects and must never be launched.
  const moduleBytes = (path: string) => {
    const marker = `// ${path}\n`
    const start = hostText.indexOf(marker)
    assert.notEqual(start, -1)
    const next = hostText.indexOf("\n// ", start + marker.length)
    const end = next === -1 ? hostText.indexOf("\nexport {", start + marker.length) : next
    assert.notEqual(end, -1)
    return hostText.slice(start + marker.length, end)
  }
  const actualHelpers = new Function(
    "Buffer",
    "process",
    moduleBytes("flows/burndown/review-input.ts") +
      "; return {ReviewInputIncomplete,buildReviewInput};"
  )(Buffer, process)
  const acceptance = await import("../acceptance.ts")
  const landing = await import("../landing-receipt.ts")
  const actualPrograms: typeof sourcePrograms = new Function(
    "validateAcceptance",
    "parseAcceptanceReview",
    "validateMemberAcceptance",
    "validateLandingReceipt",
    "ReviewInputIncomplete",
    "buildReviewInput",
    moduleBytes("flows/burndown/acceptance-program.ts") +
      ";return {acceptanceReviewPrelude,pushedReceiptProgram,verifiedReceiptProgram};"
  )(
    acceptance.validateAcceptance,
    acceptance.parseAcceptanceReview,
    landing.validateMemberAcceptance,
    landing.validateLandingReceipt,
    actualHelpers.ReviewInputIncomplete,
    actualHelpers.buildReviewInput
  )
  console.log(JSON.stringify({
    qualification: "burndown-shipped-validator-transform",
    runtime: process.version,
    validatorBundleSha256: createHash("sha256").update(await readFile(output)).digest("hex"),
    actualHostGraphSha256: createHash("sha256").update(hostText).digest("hex"),
    actualHostGraphBytes: Buffer.byteLength(hostText),
    actualHostLaunched: false
  }))
  const f = await fixture(t, programs)
  const valid = f.run()
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(f.pushed().status, 0)
  assert.equal(f.probe().status, 0)
  await writeFile(f.post, "x".repeat(1_048_577))
  const tooLarge = f.run()
  assert.notEqual(tooLarge.status, 0)
  assert.match(tooLarge.stderr, /ReviewInputIncomplete: REVIEW_INPUT_INCOMPLETE checks_input_limit/)
  await writeFile(f.post, check)
  const actual = await fixture(t, actualPrograms)
  assert.equal(actual.run().status, 0)
  await writeFile(actual.post, "x".repeat(1_048_577))
  const actualIncomplete = actual.run()
  assert.notEqual(actualIncomplete.status, 0)
  assert.match(actualIncomplete.stderr, /ReviewInputIncomplete: REVIEW_INPUT_INCOMPLETE checks_input_limit/)
  const retained = await readFile(`${f.path}.pushed`, "utf8")
  for (
    const report of [
      "ACCEPTANCE {bad JSON}\nVERDICT: PASS",
      `ACCEPTANCE ${JSON.stringify({ ...complete, revision: original })}\nVERDICT: PASS`,
      `ACCEPTANCE ${JSON.stringify(complete)}\nVERDICT: FAIL`
    ]
  ) {
    const malformed = f.run(report)
    assert.notEqual(malformed.status, 0)
    assert.match(malformed.stderr, /ACCEPTANCE_REVIEW_INVALID|ACCEPTANCE_INVALID|ACCEPTANCE_REVIEW_REJECTED/)
    assert.equal(await readFile(`${f.path}.pushed`, "utf8"), retained)
  }
  const changed = f.pushed({ PUSHED_SHA: original })
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /PUSHED_RECEIPT_INVALID/)
  assert.equal(await readFile(`${f.path}.pushed`, "utf8"), retained)
  await writeFile(`${f.path}.pushed`, JSON.stringify({ ...JSON.parse(retained), repo: "wrong/repository" }))
  assert.equal(f.probe().status, 1)
})
