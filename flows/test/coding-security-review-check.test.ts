import { NodeServices } from "@effect/platform-node"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Target from "@smthrs/targets/Target"
import { Effect, FileSystem, Layer, Stream } from "effect"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import type { Check, Implementation, Receipt, Revision } from "../coding/schema.ts"
import {
  emptyChange,
  reviewBase,
  ReviewSecurity,
  reviewSecurity,
  securityReviewCheckDelegate,
  securityReviewCheckLayers,
  type SecurityReviewEvidence,
  subscriptionSeat
} from "../coding/security-review-check.ts"

const temporary = await mkdtemp(join(tmpdir(), "security-review-check-"))
after(() => rm(temporary, { recursive: true, force: true }))
const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))

const policy = JSON.stringify(
  Target.metadata(LlmLint.LlmLint({
    changes: Input.gitDiff("HEAD"),
    include: [Input.glob("//src/**")],
    deps: [],
    prompt: "Inspect the selected source for security flaws.",
    rubric: "Report exploitable flaws.",
    model: "claude-opus-5-5",
    batchSize: 4,
    securityChecks: ["general"]
  })).attrs
)
const index = JSON.stringify([{
  label: "//:security",
  package: "",
  name: "security",
  rule: "LlmLint",
  reviewPolicy: policy,
  kinds: ["review"],
  cacheable: false,
  inputs: [],
  outputs: [],
  dependencies: [],
  source: { file: "PACKAGE.ts" }
}])
const baseFiles: Record<string, string> = {
  ".smithers/target-index.json": index,
  "src/auth.ts": "export const allowed = (user: string) => user === 'admin'\n",
  "src/login.ts": "import { allowed } from \"./auth.ts\"\nexport const login = allowed\n",
  "docs/readme.md": "Security notes.\n",
  "docs/notes.md": "symlink:readme.md"
}

let fixtures = 0
/** A fake native exporter over fixture trees: `<exporter> <repo> <commit> <dir>` copies the commit's files. */
const fixture = async (trees: Record<string, Record<string, string>>) => {
  const root = join(temporary, `fixture-${++fixtures}`)
  const revisions: Record<string, Revision> = {}
  for (const [name, files] of Object.entries(trees)) {
    const commitId = name.repeat(40).slice(0, 40)
    revisions[name] = {
      changeId: "k".repeat(32),
      commitId,
      treeId: `${name}0`.repeat(20),
      operationId: "o".repeat(64),
      parentCommitIds: []
    }
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, "trees", commitId, path)), { recursive: true })
      // A `symlink:` entry is a committed symbolic link to the named relative target.
      if (contents.startsWith("symlink:")) await symlink(contents.slice(8), join(root, "trees", commitId, path))
      else await writeFile(join(root, "trees", commitId, path), contents)
    }
    await writeFile(join(root, `${commitId}.json`), JSON.stringify(revisions[name]))
  }
  const exporter = join(root, "exporter.mjs")
  await writeFile(
    exporter,
    `#!/usr/bin/env node
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
const [, , , commit, directory] = process.argv
const revision = JSON.parse(readFileSync(join(${JSON.stringify(root)}, commit + ".json"), "utf8"))
cpSync(join(${
      JSON.stringify(root)
    }, "trees", commit), join(directory, "tree"), { recursive: true, verbatimSymlinks: true })
process.stdout.write(JSON.stringify({ commitId: revision.commitId, changeId: revision.changeId, treeId: revision.treeId, path: join(directory, "tree"), fileCount: 1 }))
`
  )
  await chmod(exporter, 0o755)
  const store = join(root, "store")
  const repository = join(root, "repository")
  await mkdir(repository)
  return {
    revisions,
    store,
    options: { repositoryPath: repository, fs, exporterPath: exporter, environment: { PATH: process.env.PATH! }, store }
  }
}

const check: Check = {
  id: "security",
  target: ".",
  flow: "checks/security",
  flowDigest: "sha256:security",
  tier: "slow",
  required: false
}
/** A stack candidate: parent and head are the one retained commit, rebased onto `base`. */
const candidate = (head: Revision, base: Revision): Implementation => {
  const rebased = { ...head, parentCommitIds: [base.commitId] }
  return { change: "mythical-candidate", parent: rebased, atoms: [rebased], head: rebased, reads: [], writes: [] }
}
const invocation = (implementation: Implementation, body: unknown = { patterns: ["//...:security"] }) => ({
  flow: "checks/security",
  input: { implementation, check } as never,
  prompt: `${JSON.stringify(body)}\n\nresource trailer`,
  model: null,
  placement: null,
  placementOptions: null,
  capabilities: ["fs:read:**"],
  flows: ["coding/SecurityReviewCheck"]
})

const completion = (findings: ReadonlyArray<unknown> = []) =>
  JSON.stringify({
    status: "completed",
    coverage: [{ checkId: "general", status: "completed", evidence: "Inspected src/auth.ts." }],
    missingContext: [],
    findings
  })

/** Host seats that answer every review request with `answer`, recording each seat they resolve. */
const seats = (answer: string | undefined, resolved: Array<string>) =>
  SeatResolver.layer({
    resolve: (id) => {
      resolved.push(id)
      return answer === undefined
        ? Effect.fail(new Seat.SeatUnresolved({ seat: id, message: "Claude Code is signed out" }))
        : Effect.succeed(Seat.make({
          id,
          modelId: Seat.modelIdOf(id),
          contextWindowTokens: 200_000,
          route: undefined as never,
          model: Model.make({
            stream: () =>
              Stream.fromIterable([
                ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: answer }),
                ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
              ])
          })
        }))
    }
  })

const run = (
  options: Awaited<ReturnType<typeof fixture>>["options"],
  implementation: Implementation,
  answer: string | undefined,
  resolved: Array<string> = [],
  body?: unknown
) =>
  Effect.runPromise(
    Effect.result(reviewSecurity(options, invocation(implementation, body))).pipe(
      Effect.provide(seats(answer, resolved)),
      Effect.provide(NodeServices.layer)
    )
  )

const success = (result: Awaited<ReturnType<typeof run>>): Receipt => {
  assert.equal(result._tag, "Success", result._tag === "Failure" ? result.failure.message : "")
  return (result as { success: Receipt }).success
}
const evidence = (receipt: Receipt) => JSON.parse(receipt.evidence) as SecurityReviewEvidence

test("a reviewed candidate passes on subscription seats with the trusted policy of the commit it applies to", async () => {
  const { revisions, options } = await fixture({
    b: baseFiles,
    d: { ...baseFiles, "src/auth.ts": "export const allowed = (user: string) => user.startsWith('admin')\n" }
  })
  const resolved: Array<string> = []
  const receipt = success(await run(options, candidate(revisions.d!, revisions.b!), completion(), resolved))
  assert.equal(receipt.status, "passed")
  assert.deepEqual(receipt.findings, [])
  assert.equal(receipt.fault, undefined)
  assert.equal(receipt.commitId, revisions.d!.commitId)
  assert.deepEqual(evidence(receipt), {
    kind: "coding/security-review-check/v1",
    policyRevision: revisions.b!.commitId,
    revision: revisions.d!.commitId,
    changed: 1,
    reviews: [{ label: "//:security", status: "completed", findings: [] }]
  })
  // Selected family, the other family, the selected family: each on its subscription CLI.
  assert.deepEqual(resolved, ["claude-code:claude-opus-5-5", "codex:gpt-6-sol", "claude-code:claude-opus-5-5"])
})

test("an empty change fails before any model call", async () => {
  const { revisions, options } = await fixture({ b: baseFiles, d: baseFiles })
  const resolved: Array<string> = []
  const receipt = success(await run(options, candidate(revisions.d!, revisions.b!), completion(), resolved))
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.fault, "factory")
  assert.deepEqual(receipt.findings.map((finding) => finding.message), [emptyChange])
  assert.deepEqual(resolved, [])
})

test("a change to private repository-job paths only is not reviewable and fails as empty", async () => {
  const { revisions, options } = await fixture({
    b: baseFiles,
    d: { ...baseFiles, ".smithers/repository-jobs/job/config.json": "{\"token\":\"never read\"}" }
  })
  const receipt = success(await run(options, candidate(revisions.d!, revisions.b!), completion()))
  assert.equal(receipt.status, "failed")
  assert.equal(evidence(receipt).changed, 0)
})

test("a change no trusted policy governs passes with no review", async () => {
  const { revisions, options } = await fixture({ b: baseFiles, d: { ...baseFiles, "docs/readme.md": "New notes.\n" } })
  const resolved: Array<string> = []
  const receipt = success(await run(options, candidate(revisions.d!, revisions.b!), completion(), resolved))
  assert.equal(receipt.status, "passed")
  assert.deepEqual(evidence(receipt).reviews, [])
  assert.equal(evidence(receipt).changed, 1)
  assert.deepEqual(resolved, [])
})

test("a blocking finding fails the candidate with only its public summary; the finding stays private", async () => {
  const { revisions, options, store } = await fixture({
    b: baseFiles,
    d: { ...baseFiles, "src/auth.ts": "export const allowed = (_user: string) => true\n" }
  })
  const secret = "any caller is admitted because the check always returns true"
  const answer = completion([{
    file: "src/auth.ts",
    line: 1,
    severity: "error",
    message: secret,
    security: {
      checkId: "general",
      impact: "critical",
      verification: "suspected",
      releaseRecommendation: "block",
      attackerPreconditions: "Any caller.",
      evidence: "The predicate ignores its argument.",
      nextConfirmationStep: "Call allowed with a guest."
    }
  }])
  const receipt = success(await run(options, candidate(revisions.d!, revisions.b!), answer))
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.fault, "factory")
  const stored = await Effect.runPromise(LlmLint.storedFindings(store))
  assert.equal(stored.length, 1)
  assert.equal(stored[0]!.finding.message, secret)
  const reference = `restricted-finding:${stored[0]!.fingerprint}`
  assert.deepEqual(receipt.findings.map((finding) => finding.message), [
    `//:security: ${reference} error general critical`
  ])
  const text = JSON.stringify(receipt)
  for (const hidden of [secret, "src/auth.ts", "The predicate ignores its argument."]) {
    assert.ok(!text.includes(hidden), `the receipt never carries ${hidden}`)
  }
  assert.deepEqual(evidence(receipt).reviews[0]!.findings[0], {
    fingerprint: stored[0]!.fingerprint,
    reference,
    state: "open",
    severity: "error",
    owner: "//:security",
    checkId: "general",
    impact: "critical"
  })
})

test("an unavailable seat fails the review as an outage, never a pass", async () => {
  const { revisions, options } = await fixture({
    b: baseFiles,
    d: { ...baseFiles, "src/auth.ts": "export const allowed = () => false\n" }
  })
  const receipt = success(await run(options, candidate(revisions.d!, revisions.b!), undefined))
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.fault, "infra")
  assert.match(
    receipt.findings[0]!.message,
    /^\/\/:security: the security review did not complete: Review seat unavailable: Claude Code is signed out/
  )
})

test("an implementation reviews its own parent, and a head without one parent is refused", async () => {
  const b = {
    changeId: "k".repeat(32),
    commitId: "b".repeat(40),
    treeId: "t".repeat(40),
    operationId: "o",
    parentCommitIds: []
  }
  const h = { ...b, commitId: "c".repeat(40), parentCommitIds: ["d".repeat(40)] }
  assert.equal(reviewBase({ change: "x", parent: b, atoms: [h], head: h, reads: [], writes: [] }), b.commitId)
  assert.equal(reviewBase({ change: "x", parent: h, atoms: [h], head: h, reads: [], writes: [] }), "d".repeat(40))
  const merge = { ...h, parentCommitIds: ["d".repeat(40), "e".repeat(40)] }
  assert.equal(
    reviewBase({ change: "x", parent: merge, atoms: [merge], head: merge, reads: [], writes: [] }),
    undefined
  )
  const { options } = await fixture({ b: baseFiles })
  const result = await run(
    options,
    { change: "x", parent: merge, atoms: [merge], head: merge, reads: [], writes: [] },
    ""
  )
  assert.equal(result._tag, "Failure")
  assert.match((result as { failure: Error }).failure.message, /one commit the change applies to/)
})

test("a policy commit without a target index cannot run the review", async () => {
  const { ".smithers/target-index.json": _index, ...bare } = baseFiles
  const { revisions, options } = await fixture({ b: bare, d: { ...bare, "src/auth.ts": "changed\n" } })
  const result = await run(options, candidate(revisions.d!, revisions.b!), completion())
  assert.equal(result._tag, "Failure")
  assert.match((result as { failure: Error }).failure.message, /could not read its policy or source: .*no target index/)
})

test("a source that cannot be exported fails the check instead of passing it", async () => {
  const { revisions, options } = await fixture({ b: baseFiles, d: baseFiles })
  const result = await run(
    { ...options, exporterPath: join(temporary, "no-such-exporter") },
    candidate(revisions.d!, revisions.b!),
    completion()
  )
  assert.equal(result._tag, "Failure")
  assert.match((result as { failure: Error }).failure.message, /export/)
})

test("the check body names at least one review label", async () => {
  const { revisions, options } = await fixture({ b: baseFiles, d: baseFiles })
  for (const body of [{ patterns: [] }, { patterns: ["not-a-label"] }, { lenses: [] }]) {
    const result = await run(options, candidate(revisions.d!, revisions.b!), completion(), [], body)
    assert.equal(result._tag, "Failure")
    assert.match((result as { failure: Error }).failure.message, /1 to 16 review target labels/)
  }
})

test("the delegate is the registered coding/SecurityReviewCheck over one durable review action", async () => {
  assert.equal(securityReviewCheckDelegate._tag, "coding/SecurityReviewCheck")
  assert.equal(ReviewSecurity.name, "coding/review-security")
  const { options } = await fixture({ b: baseFiles })
  assert.ok(Layer.isLayer(securityReviewCheckLayers(options)))
})

test("review seats map to the subscription CLIs", () => {
  assert.equal(subscriptionSeat({ engine: "claude", model: "claude-opus-5-5" }), "claude-code:claude-opus-5-5")
  assert.equal(subscriptionSeat({ engine: "codex", model: "gpt-6-sol" }), "codex:gpt-6-sol")
})
