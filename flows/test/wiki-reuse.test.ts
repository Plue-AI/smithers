import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Capability } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import Wiki from "../wiki/flow.ts"
import { IncrementalWiki, Load, policySources, reuseLayers, Select } from "../wiki/reuse.ts"
import { actionLayers, agentLayers } from "../wiki/runtime.ts"
import { type Input, PageSpec, WikiError } from "../wiki/schema.ts"
import { Collect } from "../wiki/workflow.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

/** One evidence judge dispatches citation and completion questions for this host. */
const citationsSupported = makeHostJudge().layer

/** Exercise main.ts's actual admission rules before any model review is needed. */
test(
  "wiki CLI admits bounded reuse policy reads and retains normal preview containment",
  { timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-cli-policy-")))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, ".smithers"))
    const spec: PageSpec = {
      id: "answer",
      title: "Answer",
      purpose: "Find the answer.",
      kind: "current",
      document: "page.md",
      inputs: ["answer.ts"],
      related: []
    }
    await writeFile(join(root, ".smithers/coding-project.json"), JSON.stringify({ pages: [spec] }))
    await writeFile(join(root, "page.md"), "# Answer\n\nThe answer is 42.\n")
    await writeFile(join(root, "answer.ts"), "export const answer = 42\n")
    const cli = fileURLToPath(new URL("../wiki/main.ts", import.meta.url))
    const invoke = (run: string, reuse = true) => {
      const result = spawnSync("node", [
        cli,
        "--root",
        root,
        "--run",
        run,
        ...(reuse ? ["--verified", "--reuse-run", "wiki-missing-prior"] : [])
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 2_000_000
      })
      assert.equal(result.error, undefined, "CLI must finish through its real host boundary")
      return { ...result, output: `${result.stdout}\n${result.stderr}` }
    }
    // Normal mode needs only declared page evidence, even when reuse policy files
    // do not exist. This does not script an approval or manufacture a verified page.
    const preview = invoke("wiki-cli-preview", false)
    assert.equal(preview.status, 0, preview.output)
    assert.match(preview.stdout, /"verification":\s*"unreviewed"/)
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url))
    for (const file of policySources) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), await readFile(join(sourceRoot, file)))
    }
    const admitted = invoke("wiki-cli-missing-prior")
    assert.equal(admitted.status, 1)
    assert.match(admitted.output, /run wiki-missing-prior was not found/)
    assert.doesNotMatch(admitted.output, /readPermissionDenied|native helper|executable.*not found/i)
    assert.doesNotMatch(admitted.stdout, /"verification":\s*"verified"/)
    // A permitted source still passes deterministic size validation before any
    // prior-run lookup or model review.
    const policy = join(root, policySources[0])
    await writeFile(policy, "x".repeat(512_001))
    const oversized = invoke("wiki-cli-policy-oversized")
    assert.equal(oversized.status, 1)
    assert.match(oversized.output, /Review policy source is too large: flows\/wiki\/flow.ts/)
    assert.doesNotMatch(oversized.output, /wiki-missing-prior was not found|readPermissionDenied/)
    // The exact public source permission must not authorize another target. Both
    // the link and the target are harmless files inside this private fixture.
    await rm(policy)
    await writeFile(join(root, "unlisted-policy.txt"), "private fixture only\n")
    await symlink(join(root, "unlisted-policy.txt"), policy)
    const unrelated = invoke("wiki-cli-policy-unrelated")
    assert.equal(unrelated.status, 1)
    assert.match(unrelated.output, /readPermissionDenied|symlink|symbolic link|ELOOP|Too many levels/i)
    assert.doesNotMatch(unrelated.output, /wiki-missing-prior was not found|Review policy source is too large/)
    assert.doesNotMatch(unrelated.stdout, /"verification":\s*"verified"/)
  }
)

// Simulate a section parser change that preserves ids, source and body hashes.
const SectionsProbe = Flow.make("wiki/test/changed-sections", {
  payload: { spec: PageSpec, priorRunId: Schema.String, reviewer: Schema.String },
  success: Schema.String,
  error: WikiError,
  body: ({ spec, priorRunId, reviewer }) =>
    Node.bindPlanned(
      Load.call({ priorRunId, reviewer }),
      (pool) =>
        Node.bindPlanned(
          Collect.call({ spec }).pipe(Node.map((evidence) => ({
            ...evidence,
            sections: evidence.sections.map((section) => ({ ...section, markdown: "A different review obligation." }))
          }))),
          (evidence) =>
            Select.call({ evidence, pool, reviewer })
              .pipe(Node.map((selection) => selection.reason))
        )
    )
})

// Real native engine, journal, attempt store, AgentAction and QuickJS. Only the
// model provider is scripted; every recorded receipt is produced by the flow.
test(
  "incremental wiki reuses exact terminal receipts after restart and reviews changed inputs",
  { timeout: 420_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-reuse-")))
    t.after(() => rm(root, { recursive: true, force: true }))
    execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
    await writeFile(join(root, ".gitignore"), ".flows/\n")
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url))
    for (const file of policySources) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), await readFile(join(sourceRoot, file)))
    }
    await writeFile(join(root, "answer.ts"), "export const answer = 42\n")
    for (const id of ["first", "second", "independent"]) {
      await writeFile(
        join(root, `${id}.md`),
        `# ${id}\n\nThe answer is 42.\n`
      )
    }
    const pages: Input["pages"] = ["first", "second", "independent"].map((id) => ({
      id,
      title: id,
      purpose: "Find the answer.",
      kind: "current",
      document: `${id}.md`,
      inputs: ["answer.ts", ...(id === "independent" ? [] : policySources)],
      related: []
    }))
    const counts: Record<string, number> = {}
    const model = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          const text = [
            ...request.system.map((part) => part.text),
            ...request.messages.flatMap((message) =>
              message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
            )
          ].join("\n")
          const page = ["first", "second", "independent"].find((id) => text.includes(`"document":"${id}.md"`))
          assert.ok(page, "scripted provider must receive one of the fixture's exact evidence snapshots")
          counts[page] = (counts[page] ?? 0) + 1
          const review = {
            sections: [{
              id: "section-1",
              verdict: "supported",
              explanation: "The exported constant supports this explanation.",
              citations: [{
                path: "answer.ts",
                line: page === "first" && counts[page] === 2 ? 999 : 1,
                quote: "export const answer = 42"
              }]
            }]
          }
          return Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "review" }),
            ModelEvent.ModelEvent.TextDelta({
              type: "text-delta",
              id: "review",
              text: `\`\`\`cell\nctx.done(${JSON.stringify(review)})\n\`\`\``
            }),
            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "review" }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
        })
    })
    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: "scripted-wiki-reuse",
            model,
            contextWindowTokens: 200_000,
            route: {
              prepare: () =>
                Effect.succeed({
                  routeId: "wiki-test",
                  protocolId: "wiki-test",
                  method: "POST",
                  url: "https://example.invalid",
                  publicHeaders: {},
                  body: new TextEncoder().encode("{}"),
                  bodyText: "{}"
                })
            }
          })
        )
    })
    const output = join(root, ".flows/wiki")
    const rule = (action: "fs:read" | "fs:write", resource: string) =>
      new Capability.Permission.Rule({
        effect: "allow",
        pattern: new Capability.Capability.CapabilityPattern({ action, resource })
      })
    const runtime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
    const host = () =>
      runtime.layerHost(
        {
          filename: join(root, ".flows/engine.db"),
          workspaceRoot: root,
          owner: { hostId: "wiki-reuse-test" },
          signals: [],
          rules: [[rule("fs:read", root), rule("fs:read", `${root}/**`), rule("fs:write", `${root}/.flows/**`)]]
        },
        Layer.mergeAll(
          actionLayers({ root, output, evaluator: citationsSupported }),
          reuseLayers({ root, output }),
          agentLayers(seats, 60_000, citationsSupported),
          Interpreter.layer(Wiki),
          Interpreter.layer(SectionsProbe)
        ).pipe(Layer.provideMerge(Action.layerImplementations))
      )
    const input: Input = { pages, mode: "verified", reviewer: "scripted-wiki-reuse" }
    const first = await Effect.runPromise(
      Effect.scoped(Wiki.execute(input, { executionId: "wiki-original" }).pipe(Effect.provide(host())))
    )
    assert.equal(first.verification, "verified")
    assert.deepEqual(counts, { first: 1, second: 1, independent: 1 })
    t.diagnostic("Original durable reviews recorded")
    const incremental = (runId: string, priorRunId: string, reviewer = input.reviewer) =>
      Effect.runPromise(Effect.scoped(
        IncrementalWiki.execute({ ...input, mode: "verified", reviewer, priorRunId }, { executionId: runId }).pipe(
          Effect.provide(host())
        )
      ))
    const second = await incremental("wiki-reused", "wiki-original")
    assert.equal(second.verification, "verified")
    t.diagnostic("All exact reviews reused after runtime restart")
    assert.deepEqual(
      counts,
      { first: 1, second: 1, independent: 1 },
      "a fresh runtime scope reuses all durable model reviews"
    )
    let snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
    for (const page of snapshot.pages) {
      assert.equal(page.verification.provenance.originRunId, "wiki-original")
      assert.equal(page.verification.provenance.reusedFrom.runId, "wiki-original")
    }
    const changedSections = await Effect.runPromise(Effect.scoped(
      SectionsProbe.execute({
        spec: pages[0]!,
        priorRunId: "wiki-reused",
        reviewer: input.reviewer
      }, { executionId: "wiki-sections-changed" }).pipe(Effect.provide(host()))
    ))
    assert.equal(changedSections, "review section boundaries changed")
    await writeFile(join(root, "first.md"), "# first\n\nThe answer remains 42.\n")
    await incremental("wiki-one-changed", "wiki-reused")
    t.diagnostic("One changed page reviewed; its neighbor reused")
    assert.deepEqual(
      counts,
      { first: 3, second: 1, independent: 1 },
      "the changed page repairs its citation once without rerunning either unaffected page"
    )
    snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
    assert.equal(snapshot.pages[0].verification.provenance.reusedFrom, null)
    assert.equal(snapshot.pages[1].verification.provenance.originRunId, "wiki-original")
    await incremental("wiki-model-changed", "wiki-one-changed", "another-model")
    t.diagnostic("Changed reviewer invoked for all pages")
    assert.deepEqual(
      counts,
      { first: 4, second: 2, independent: 2 },
      "changing the reviewer cannot borrow a prior model's result"
    )
    snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
    const independentDigest = snapshot.pages.find((page: { id: string }) => page.id === "independent").inputDigest
    await writeFile(
      join(root, policySources[0]),
      (await readFile(join(root, policySources[0]), "utf8")) + "\n// changed review policy\n"
    )
    await incremental("wiki-policy-changed", "wiki-model-changed", "another-model")
    assert.deepEqual(
      counts,
      { first: 5, second: 3, independent: 3 },
      "policy changes invalidate even the page with unchanged source inputs"
    )
    snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
    assert.equal(
      snapshot.pages.find((page: { id: string }) => page.id === "independent").inputDigest,
      independentDigest
    )
  }
)
