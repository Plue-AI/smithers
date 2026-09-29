import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Schema } from "effect"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { separateWikiOutput } from "../coding/wiki-output.ts"
import { reviewEvidence } from "../wiki/evidence.ts"
import { CITATION_CONTEXT_LINES, MAX_CLAIM_BYTES, MAX_STATE_BYTES } from "../wiki/jev-citations.ts"
import { operations } from "../wiki/operations.ts"
import { PageSpec, type Review, type ReviewedPage } from "../wiki/schema.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

const fixture = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "page.md"), "# A small page\n\nThe answer is 42.\n")
  await writeFile(join(root, "src/answer.ts"), "export const answer = 42\n")
  const spec: PageSpec = {
    id: "answer",
    title: "Answer",
    purpose: "Find the answer.",
    kind: "current",
    document: "page.md",
    inputs: ["src/answer.ts"],
    related: []
  }
  const output = join(root, "output"), ops = operations({ root, output })
  return { root, output, spec, ops }
}
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    import("effect/FileSystem").FileSystem | import("effect/Path").Path | import("effect/Crypto").Crypto
  >
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const supported = (evidence: ReviewedPage["evidence"]): Review => ({
  sections: evidence.sections.map((section) => ({
    id: section.id,
    verdict: "supported",
    explanation: "The exported constant supports the explanation.",
    citations: [{ path: "src/answer.ts", line: 1, quote: "export const answer = 42" }]
  }))
})

/** One evidence judge dispatches citation and completion questions for this host. */
const citationsSupported = makeHostJudge().layer

test("verified pages publish the assessed citations beside each explained section", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, "page.md"), "# Answer\n\nThe answer is 42.\n\n## Export\n\nThe answer is exported.\n")
  const evidence = await run(f.ops.collect(f.spec))
  await run(f.ops.write([{ evidence, review: supported(evidence), reviewer: "scripted-test" }], "verified"))
  const snapshot = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  const body = snapshot.pages[0].body as string
  const citation = "[src/answer.ts:1](../sources/src/answer.ts#L1)"
  assert.ok(body.indexOf(citation) > body.indexOf("The answer is 42."))
  assert.ok(body.indexOf(citation) < body.indexOf("## Export"))
  assert.ok(body.lastIndexOf(citation) > body.indexOf("The answer is exported."))
  assert.equal((await run(f.ops.check([f.spec], true))).verification, "verified")
})

test("host-owned wiki operations retain their injected filesystem under a different action context", async (t) => {
  const f = await fixture(t), fs = await run(FileSystem.FileSystem)
  const ops = operations({ root: f.root, output: f.output, fs })
  const context = FileSystem.makeNoop({})
  const evidence = await run(ops.collect(f.spec).pipe(Effect.provideService(FileSystem.FileSystem, context)))
  await run(
    ops.write([{ evidence, review: supported(evidence), reviewer: "scripted-host" }], "verified")
      .pipe(Effect.provideService(FileSystem.FileSystem, context))
  )
  assert.equal(
    (await run(ops.check([f.spec], true).pipe(Effect.provideService(FileSystem.FileSystem, context)))).verification,
    "verified"
  )
  await assert.rejects(run(f.ops.collect(f.spec).pipe(Effect.provideService(FileSystem.FileSystem, context))))
  await symlink("/etc/hosts", join(f.root, "outside"))
  await assert.rejects(run(ops.collect({ ...f.spec, inputs: ["outside"] })), /Source escapes/)
})

test("both owning prose and code invalidate a source snapshot; no input is truncated", async (t) => {
  const f = await fixture(t), before = await run(f.ops.collect(f.spec))
  await writeFile(join(f.root, "src/answer.ts"), "export const answer = 43\n")
  const code = await run(f.ops.collect(f.spec))
  assert.notEqual(before.inputDigest, code.inputDigest)
  assert.equal(before.contentDigest, code.contentDigest)
  await writeFile(join(f.root, "page.md"), "# A small page\n\nThe answer changed.\n")
  const prose = await run(f.ops.collect(f.spec))
  assert.notEqual(prose.contentDigest, code.contentDigest)
  assert.equal(prose.sources.find((source) => source.path === "src/answer.ts")?.text, "export const answer = 43\n")
})

test("source identity survives schema decoding and JSON property order changes", async (t) => {
  const f = await fixture(t)
  const catalog = {
    related: [],
    inputs: ["src/answer.ts"],
    document: "page.md",
    kind: "current" as const,
    purpose: f.spec.purpose,
    title: f.spec.title,
    id: f.spec.id
  }
  const decoded = Schema.decodeUnknownSync(PageSpec)(catalog)
  assert.notEqual(
    JSON.stringify(catalog),
    JSON.stringify(decoded),
    "fixture must exercise durable schema field ordering"
  )
  const before = await run(f.ops.collect(catalog)), after = await run(f.ops.collect(decoded))
  assert.equal(before.inputDigest, after.inputDigest)
  await run(f.ops.write([{ evidence: after, review: null, reviewer: null }], "preview"))
  assert.equal((await run(f.ops.check([catalog]))).verification, "unreviewed")
})

test("outside-root and private paths cannot become generation input, including symlinks", async (t) => {
  const f = await fixture(t)
  await symlink("/etc/hosts", join(f.root, "outside"))
  for (const input of ["../secret", "/etc/hosts", ".env", ".flows/state", "Smithers-Ops/strategy.md", "outside"]) {
    await assert.rejects(
      run(f.ops.collect({ ...f.spec, inputs: [input] })),
      /WikiError|outside|escape|private|relative|Private|Source/
    )
  }
})

test("private files are refused at any depth, in any case and behind an in-root symlink", async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.root, "pkg/.git"), { recursive: true })
  await mkdir(join(f.root, "keys"))
  const secrets = [
    "config/prod.env",
    "docker/app.env",
    ".smithers/prompts/leak.env",
    "auth.token",
    "secrets.json",
    "config/secrets.yaml",
    "deploy/secret.prod.yml",
    ".ENV",
    "a/.Env.local",
    ".envrc",
    ".npmrc",
    ".dev.vars",
    "pkg/.git/config",
    "pkg/.JJ/repo",
    "keys/server.pem",
    "keys/id_rsa",
    "keys/id_ed25519.pub",
    "home/.ssh/config",
    ".env-local",
    ".env_prod",
    "home/.docker/config.json",
    "home/.kube/config",
    "infra/.terraform/providers.json",
    "infra/terraform.tfstate",
    "infra/terraform.tfstate.backup",
    "web/.htpasswd",
    "android/release.jks",
    "keys/deploy.ppk",
    "android/app.keystore",
    ".yarnrc.yaml",
    ".smithers/executions/x.json",
    ".smithers/runs/x/journal.json",
    ".smithers/cache/x.json",
    ".smithers/smithers.db",
    "pkg/.smithers/runs/x.json",
    ".alchemy/app/prod/worker.json",
    ".wrangler/state/x.json",
    ".claude/settings.local.json",
    ".github/.env",
    ".GITHUB/workflows/ci.yml",
    "infra/terraform.tfvars",
    "infra/secrets.auto.tfvars",
    "keys/app.p8",
    "keys/private.asc",
    "keys/private.gpg",
    "credentials.json",
    "service-account.json"
  ]
  for (const input of secrets) {
    await mkdir(join(f.root, input, ".."), { recursive: true })
    await writeFile(join(f.root, input), "SECRET=1\n")
    await assert.rejects(run(f.ops.collect({ ...f.spec, inputs: [input] })), /Private\/runtime path/, input)
  }
  await symlink(join(f.root, ".npmrc"), join(f.root, "docs.md"))
  await assert.rejects(run(f.ops.collect({ ...f.spec, inputs: ["docs.md"] })), /Private\/runtime path/)
  // Committed public declarations stay readable.
  const publicInputs = [
    ".github/workflows/ci.yml",
    ".agents/skills/x/SKILL.md",
    ".smithers/WORKSPACE.ts",
    ".smithers/workflows/ci.tsx",
    "pkg/.smithers/agents.ts",
    "pkg/.gitignore"
  ]
  for (const input of publicInputs) {
    await mkdir(join(f.root, input, ".."), { recursive: true })
    await writeFile(join(f.root, input), "export const x = 1\n")
  }
  await run(f.ops.collect({ ...f.spec, inputs: publicInputs }))
})

test("curated review excerpts retain full-file invalidation and enforce shown citation lines", async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.root, "src/answer.ts"),
    "// not sent to the reviewer\n  export const answer = 42\n// still a dependency\n"
  )
  const spec = { ...f.spec, excerpts: { "src/answer.ts": [{ start: 2, end: 2 }] } }
  const evidence = await run(f.ops.collect(spec))
  const view = reviewEvidence(evidence).sources.find((source) => source.path === "src/answer.ts")!
  assert.equal(view.lines, "2 |   export const answer = 42")
  assert.equal(view.complete, false)
  assert.equal("text" in view, false, "full source must not leak into the reviewer view")
  const page = {
    evidence,
    reviewer: "scripted-test",
    review: {
      sections: supported(evidence).sections.map((section) => ({
        ...section,
        citations: [{ path: "src/answer.ts", line: 2, quote: "export const answer = 42" }]
      }))
    }
  }
  await run(f.ops.assess(page)) // Exact quote begins after indentation.
  for (
    const citation of [
      { path: "src/answer.ts", line: 1, quote: "export const answer = 42" },
      { path: "src/answer.ts", line: 1, quote: "// not sent to the reviewer" },
      { path: "src/answer.ts", line: 2, quote: "export const answer = 42\n// still a dependency" }
    ]
  ) {
    await assert.rejects(
      run(
        f.ops.assess({
          ...page,
          review: { sections: page.review.sections.map((section) => ({ ...section, citations: [citation] })) }
        })
      ),
      /exact source/
    )
  }
  await writeFile(
    join(f.root, "src/answer.ts"),
    "// changed outside excerpt\n  export const answer = 42\n// still a dependency\n"
  )
  assert.notEqual((await run(f.ops.collect(spec))).inputDigest, evidence.inputDigest)
  for (
    const excerpts of [{ "src/answer.ts": [{ start: 0, end: 1 }] }, { "src/answer.ts": [{ start: 2, end: 200 }] }, {
      missing: [{ start: 1, end: 1 }]
    }]
  ) {
    await assert.rejects(run(f.ops.collect({ ...spec, excerpts })), /Invalid review excerpt/)
  }
})

test("semantic gate requires complete exact citations and refuses false freshness", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const page: ReviewedPage = { evidence, review: supported(evidence), reviewer: "scripted-test" }
  await assert.rejects(run(f.ops.assess({ ...page, review: { sections: [] } })), /every section/)
  const bad = supported(evidence)
  await assert.rejects(
    run(
      f.ops.assess({
        ...page,
        review: {
          sections: bad.sections.map((section) => ({
            ...section,
            citations: [{ path: "src/answer.ts", line: 2, quote: "export const answer = 42" }]
          }))
        }
      })
    ),
    /exact source/
  )
  await writeFile(join(f.root, "src/answer.ts"), "export const answer = 43\n")
  await assert.rejects(run(f.ops.write([page], "verified")), /Source changed during review/)
})

test("invalid citation diagnostics stay bounded without accepting omitted failures", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const review = {
    sections: supported(evidence).sections.map((section) => ({
      ...section,
      citations: Array.from(
        { length: 30 },
        (_, index) => ({ path: "src/answer.ts", line: index + 100, quote: "x".repeat(1000) })
      )
    }))
  }
  await assert.rejects(run(f.ops.assess({ evidence, review, reviewer: "scripted-test" })), (error: Error) => {
    const report = JSON.parse(error.message.slice(error.message.indexOf("; ") + 2))
    assert.equal(report.invalidCitationCount, 30)
    assert.equal(report.citations.length, 24)
    assert.ok(report.citations.every((citation: { quote: string }) => citation.quote.length === 320))
    return true
  })
})

test("citation boundary padding does not alter raw receipts or loosen source matching", async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.root, "src/answer.ts"),
    "// hidden evidence\n   * The answer is 42.\n// unrelated visible evidence\n"
  )
  const spec = { ...f.spec, excerpts: { "src/answer.ts": [{ start: 2, end: 3 }] } }
  const evidence = await run(f.ops.collect(spec))
  const quote = "\t     * The answer is 42. \t"
  const review = {
    sections: supported(evidence).sections.map((section) => ({
      ...section,
      citations: [{ path: "src/answer.ts", line: 2, quote }]
    }))
  }
  const page = { evidence, review, reviewer: "scripted-test" }
  assert.equal(await run(f.ops.assess(page)), page, "assessment must preserve the original model object")
  for (
    const citation of [
      { path: "src/answer.ts", line: 3, quote },
      { path: "src/answer.ts", line: 1, quote: " // hidden evidence " },
      { path: "src/missing.ts", line: 2, quote },
      { path: "src/answer.ts", line: 2, quote: "* The  answer is 42." },
      { path: "src/answer.ts", line: 2, quote: "* The answer is 43." },
      { path: "src/answer.ts", line: 2, quote: "\u00a0* The answer is 42." },
      { path: "src/answer.ts", line: 2, quote: "\t " },
      { path: "src/answer.ts", line: 2, quote: "* The answer is 42.\n" },
      { path: "src/answer.ts", line: 2, quote: "\r* The answer is 42." }
    ]
  ) {
    await assert.rejects(
      run(
        f.ops.assess({
          ...page,
          review: { sections: review.sections.map((section) => ({ ...section, citations: [citation] })) }
        })
      ),
      /exact source/
    )
  }
  await run(f.ops.write([page], "verified"))
  const snapshot = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  assert.equal(snapshot.assessmentPolicy, "exact-single-line-ascii-boundary-trim-v1")
  assert.equal(snapshot.pages[0].verification.review.sections[0].citations[0].quote, quote)
  assert.equal(
    await readFile(join(f.output, snapshot.directory, "sources/src/answer.ts"), "utf8"),
    "// hidden evidence\n   * The answer is 42.\n// unrelated visible evidence\n"
  )
  assert.equal((await run(f.ops.check([spec], true))).verification, "verified")
})

test("uncertain review persists an honest preview and cannot succeed as verified", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const review = {
    sections: supported(evidence).sections.map((section) => ({ ...section, verdict: "uncertain" as const }))
  }
  await assert.rejects(
    run(f.ops.write([{ evidence, review, reviewer: "scripted-test" }], "verified")),
    /Semantic review did not pass/
  )
  const current = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  assert.equal(current.verification, "needs-changes")
  assert.equal(current.pages[0].verification.status, "needs-changes")
})

test("snapshot installation preserves human intent, records all sources and detects edited artifacts", async (t) => {
  const f = await fixture(t)
  await mkdir(f.output)
  await writeFile(join(f.output, "human-intent.md"), "Keep my future plans.\n")
  const evidence = await run(f.ops.collect(f.spec))
  const page: ReviewedPage = { evidence, review: supported(evidence), reviewer: "scripted-test" }
  const receipt = await run(f.ops.write([page], "verified"))
  assert.equal(receipt.verification, "verified")
  assert.equal(await readFile(join(f.output, "human-intent.md"), "utf8"), "Keep my future plans.\n")
  const current = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  assert.equal(current.pages[0].slug, "generated-answer")
  assert.deepEqual(
    current.pages[0].spec,
    f.spec,
    "the snapshot must retain the specification needed to reproduce its input digest"
  )
  assert.equal(
    await readFile(join(f.output, current.directory, "sources/src/answer.ts"), "utf8"),
    "export const answer = 42\n"
  )
  await run(f.ops.write([page], "verified"))
  await writeFile(join(f.output, current.directory, "pages/answer.md"), "A human correction.\n")
  await assert.rejects(run(f.ops.write([page], "verified")), /Immutable snapshot was edited/)
})

test("unowned or symlink current pointers are never overwritten", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  await mkdir(f.output)
  await writeFile(join(f.output, "current.json"), "{\"my\":\"notes\"}")
  const page = { evidence, review: null, reviewer: null }
  await assert.rejects(run(f.ops.write([page], "preview")), /unowned current pointer/)
  await rm(join(f.output, "current.json"))
  await symlink(join(f.root, "page.md"), join(f.output, "current.json"))
  await assert.rejects(run(f.ops.write([page], "preview")), /cannot be a symlink/)
  assert.equal(await readFile(join(f.root, "page.md"), "utf8"), "# A small page\n\nThe answer is 42.\n")
})

test("verification accepts an aliased parent but refuses linked output or immutable files", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  await symlink(f.root, join(f.root, "logical-root"), "dir")
  const logical = operations({ root: f.root, output: join(f.root, "logical-root", "output") })
  await run(logical.write([{ evidence, review: supported(evidence), reviewer: "scripted-test" }], "verified"))
  assert.equal((await run(logical.check([f.spec], true))).verification, "verified")
  await symlink(f.output, join(f.root, "linked-output"), "dir")
  await assert.rejects(
    run(operations({ root: f.root, output: join(f.root, "linked-output") }).check([f.spec], true)),
    /real, dedicated directory/
  )
  const current = JSON.parse(await readFile(join(f.output, "current.json"), "utf8"))
  const page = join(f.output, current.directory, "pages", "answer.md")
  await writeFile(join(f.root, "copied-page.md"), await readFile(page))
  await rm(page)
  await symlink(join(f.root, "copied-page.md"), page)
  await assert.rejects(run(logical.check([f.spec], true)), /cannot be symlinks/)
})

test("real AgentAction review and flow replay use the existing engine", { timeout: 90_000 }, async (t) => {
  const { Action, Interpreter } = await import("@smthrs/flow")
  const { FlowEngine } = await import("@smthrs/engine")
  const { Layer, Stream } = await import("effect")
  const Model = await import("@smthrs/model/Model")
  const ModelEvent = await import("@smthrs/model/ModelEvent")
  const Seat = await import("@smthrs/agent/Seat")
  const SeatResolver = await import("@smthrs/agent/SeatResolver")
  const { default: Wiki } = await import("../wiki/flow.ts")
  const { agentLayers } = await import("../wiki/runtime.ts")
  const { actionLayers } = await import("../wiki/runtime.ts")
  const EventSink = await import("@smthrs/agent/EventSink")
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  let calls = 0
  const requests: Array<string> = []
  const armed: Array<unknown> = []
  const sink = Layer.succeed(EventSink.EventSink)(EventSink.make({
    emit: (event) => Effect.sync(() => event._tag === "discipline-armed" && armed.push(event.judged))
  }))
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        calls++
        requests.push(request.system.map((part) => part.text).join("\n"))
        const review = {
          sections: supported(evidence).sections.map((section) => ({
            ...section,
            citations: section.citations.map((citation) =>
              calls === 1 ?
                { ...citation, quote: `${citation.quote}\ninvalid second line` }
                : calls === 2
                ? { ...citation, line: 999 }
                : citation
            )
          }))
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
          modelId: "scripted-wiki",
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
  const layer = Layer.mergeAll(
    actionLayers({ root: f.root, output: f.output, evaluator: citationsSupported }),
    agentLayers(seats, 10_000, citationsSupported),
    Interpreter.layer(Wiki)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(sink)
  )
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const input = { pages: [f.spec], mode: "verified" as const, reviewer: "scripted-test" }
      const first = yield* Wiki.execute(input, { executionId: "wiki-replay-test" })
      assert.equal(first.verification, "verified")
      const second = yield* Wiki.execute(input, { executionId: "wiki-replay-test" })
      assert.deepEqual(second, first)
    }).pipe(Effect.provide(layer))
  ))
  assert.equal(calls, 3, "schema correction and exact repair each consume one call; replay consumes none")
  const view = JSON.stringify(reviewEvidence(evidence))
  for (const request of requests) {
    assert.match(request, /each citation on any verdict independently against the whole section Markdown/)
    assert.ok(request.includes(`clipped at ${MAX_CLAIM_BYTES} UTF-8 bytes`))
    assert.ok(request.includes(`visible local window of up to ${CITATION_CONTEXT_LINES} lines`))
    assert.ok(request.includes(`${MAX_STATE_BYTES}-byte state`))
    assert.match(request, /no other citations, full file, or reviewer explanation/)
    assert.match(request, /auxiliary references cannot rescue an unrelated citation/)
    assert.match(request, /mark the section uncertain.*instead of inventing evidence or omitting claims/)
    assert.match(request, /owning explanation is evidence\.spec\.document/)
    assert.ok(request.includes("Owning explanation path: \"page.md\""))
    assert.ok(request.includes(view), "initial and repair requests use the same captured source")
  }
  assert.doesNotMatch(requests[0]!, /The prior review failed exact validation/)
  assert.match(requests[1]!, /Your previous answer did not validate/)
  assert.match(requests[2]!, /The prior review failed exact validation/)
  assert.match(requests[2]!, /Review citation is not exact source evidence: answer\//)
  assert.match(requests[2]!, /invalidCitationCount/)
  assert.match(requests[2]!, /"line":999/)
  assert.deepEqual(armed, [true, true, true], "every review request arms judged discipline")
})

test("independent page reviews finish before exact citation assessment can fail", async (t) => {
  const { Action, Interpreter } = await import("@smthrs/flow")
  const { FlowEngine } = await import("@smthrs/engine")
  const { Layer } = await import("effect")
  const { default: Wiki } = await import("../wiki/flow.ts")
  const { ReviewPage } = await import("../wiki/workflow.ts")
  const { actionLayers } = await import("../wiki/runtime.ts")
  const f = await fixture(t), completed: string[] = []
  const layer = Layer.mergeAll(
    actionLayers({ root: f.root, output: f.output, evaluator: citationsSupported }),
    Interpreter.layer(Wiki),
    ReviewPage.toLayer(({ evidence }) =>
      Effect.gen(function*() {
        if (evidence.spec.id === "second") yield* Effect.sleep(20)
        const review = {
          sections: supported(evidence).sections.map((section) => ({
            ...section,
            citations: section.citations.map((citation) =>
              evidence.spec.id === "first" ? { ...citation, line: 999 } : citation
            )
          }))
        }
        completed.push(evidence.spec.id)
        return review
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeServices.layer)
  )
  await assert.rejects(
    Effect.runPromise(
      Effect.scoped(
        Wiki.execute({
          pages: [{ ...f.spec, id: "first" }, { ...f.spec, id: "second" }],
          mode: "verified",
          reviewer: "scripted-test"
        }, { executionId: "wiki-assessment-barrier" }).pipe(Effect.provide(layer))
      )
    ),
    /exact source evidence/
  )
  assert.deepEqual(completed.slice(0, 2).sort(), ["first", "second"])
  assert.deepEqual(
    completed.toSorted(),
    ["first", "first", "second"],
    "one repair is bounded and does not rerun the independent page"
  )
})

test("one citation repair receives every bad citation and the same evidence, then replays without another model call", async (t) => {
  const { Action, Interpreter } = await import("@smthrs/flow")
  const { FlowEngine } = await import("@smthrs/engine")
  const { Layer } = await import("effect")
  const { default: Wiki } = await import("../wiki/flow.ts")
  const { ReviewPage } = await import("../wiki/workflow.ts")
  const { actionLayers } = await import("../wiki/runtime.ts")
  const f = await fixture(t), calls: string[] = []
  let initial: ReviewedPage["evidence"] | undefined
  const layer = Layer.mergeAll(
    actionLayers({ root: f.root, output: f.output, evaluator: citationsSupported }),
    Interpreter.layer(Wiki),
    ReviewPage.toLayer(({ evidence, priorReview, correction }) =>
      Effect.sync(() => {
        calls.push(evidence.spec.id)
        if (evidence.spec.id === "second") {
          assert.equal(correction, undefined)
          return supported(evidence)
        }
        if (correction === undefined) {
          initial = evidence
          return {
            sections: supported(evidence).sections.map((section) => ({
              ...section,
              citations: [{ path: "src/answer.ts", line: 999, quote: "export const answer = 42" }, {
                path: "src/answer.ts",
                line: 1000,
                quote: "answer = 42"
              }]
            }))
          }
        }
        assert.deepEqual(evidence, initial, "repair cannot recapture moving source")
        assert.match(correction, /exact source evidence.*first\/section-1/)
        assert.match(correction, /"line":999/)
        assert.match(correction, /"line":1000/, "one repair needs every invalid citation, not only the first")
        assert.equal(priorReview?.sections[0]?.citations[0]?.line, 999)
        return supported(evidence)
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeServices.layer)
  )
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const input = {
        pages: [{ ...f.spec, id: "first" }, { ...f.spec, id: "second" }],
        mode: "verified" as const,
        reviewer: "scripted-test"
      }
      const first = yield* Wiki.execute(input, { executionId: "wiki-citation-repair" })
      assert.equal(first.verification, "verified")
      assert.deepEqual(yield* Wiki.execute(input, { executionId: "wiki-citation-repair" }), first)
    }).pipe(Effect.provide(layer))
  ))
  assert.deepEqual(calls.toSorted(), ["first", "first", "second"])
})

test("freshness and verified checks detect stale inputs and altered verification metadata", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  await run(f.ops.write([{ evidence, review: null, reviewer: null }], "preview"))
  assert.equal((await run(f.ops.check([f.spec]))).verification, "unreviewed")
  await assert.rejects(run(f.ops.check([f.spec], true)), /has not passed semantic review/)
  const location = join(f.output, "current.json"), current = JSON.parse(await readFile(location, "utf8"))
  await writeFile(location, JSON.stringify({ ...current, verification: "verified" }))
  await assert.rejects(run(f.ops.check([f.spec], true)), /differs from its immutable snapshot/)
  await writeFile(location, JSON.stringify(current))
  await writeFile(join(f.root, "src/answer.ts"), "export const answer = 43\n")
  await assert.rejects(run(f.ops.check([f.spec])), /Stale wiki page/)
})

test("a verified snapshot minted without this host's seal key is refused", async (t) => {
  const f = await fixture(t), evidence = await run(f.ops.collect(f.spec))
  const page = { evidence, review: supported(evidence), reviewer: "scripted-test" }
  // Another writer produces a self-consistent verified output under its own key.
  const foreign = join(f.root, "foreign", "output")
  await mkdir(join(f.root, "foreign"))
  await run(operations({ root: f.root, output: foreign }).write([page], "verified"))
  await cp(foreign, f.output, { recursive: true })
  await assert.rejects(run(f.ops.check([f.spec], true)), /no seal key on this host/)
  // Once this host has its own key, the copied output still fails its seal.
  await rm(f.output, { recursive: true })
  await run(f.ops.write([page], "verified"))
  assert.equal((await run(f.ops.check([f.spec], true))).verification, "verified")
  await rm(f.output, { recursive: true })
  await cp(foreign, f.output, { recursive: true })
  await assert.rejects(run(f.ops.check([f.spec], true)), /not sealed by this host/)
  await assert.rejects(run(f.ops.check([f.spec])), /not sealed by this host/)
  // A pointer with its seal removed is refused too.
  await rm(f.output, { recursive: true })
  await run(f.ops.write([page], "verified"))
  const location = join(f.output, "current.json"), current = JSON.parse(await readFile(location, "utf8"))
  assert.match(current.seal, /^[a-f0-9]{64}$/)
  assert.equal(
    current.seal,
    createHmac("sha256", Buffer.from((await readFile(join(f.root, ".output.seal-key"), "utf8")).trim(), "hex")).update(
      `smithers-wiki-verified-v1\n${current.artifactDigest}`
    ).digest("hex")
  )
  delete current.seal
  await writeFile(location, JSON.stringify(current))
  await assert.rejects(run(f.ops.check([f.spec], true)), /not sealed by this host/)
})

test("concurrent writers accept the same complete immutable wiki artifact", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t), fs = await run(FileSystem.FileSystem)
  const evidence = await run(f.ops.collect(f.spec)),
    page = { evidence, review: supported(evidence), reviewer: "same-reviewer" }
  let arrivals = 0, release = () => {}
  const together = new Promise<void>((resolve) => {
    release = resolve
  })
  const racingFs: FileSystem.FileSystem = {
    ...fs,
    rename: (from, to) =>
      Effect.gen(function*() {
        if (/\/snapshots\/[0-9a-f]{64}$/.test(to)) {
          if (++arrivals === 2) release()
          yield* Effect.promise(() => together)
        }
        yield* fs.rename(from, to)
      })
  }
  const ops = operations({ root: f.root, output: f.output, fs: racingFs })
  const results = await Promise.all([run(ops.write([page], "verified")), run(ops.write([page], "verified"))])
  assert.equal(arrivals, 2, "both writers must reach rename after observing no existing version")
  assert.deepEqual(results[0], results[1])
  assert.equal((await run(f.ops.check([f.spec], true))).verification, "verified")
})

test("artifact installation failure without a winning version remains a failure", async (t) => {
  const f = await fixture(t), fs = await run(FileSystem.FileSystem), evidence = await run(f.ops.collect(f.spec))
  const failingFs: FileSystem.FileSystem = {
    ...fs,
    rename: (from, to) => fs.rename(/\/snapshots\/[0-9a-f]{64}$/.test(to) ? `${from}-missing` : from, to)
  }
  const ops = operations({ root: f.root, output: f.output, fs: failingFs })
  await assert.rejects(
    run(ops.write([{ evidence, review: supported(evidence), reviewer: "test" }], "verified")),
    /rename|NotFound/
  )
  assert.equal(await run(fs.exists(join(f.output, "current.json"))), false)
})

test("publication revalidates an output ancestor changed while semantic review was running", async (t) => {
  const f = await fixture(t)
  const outside = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-boundary-")))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const ancestor = join(outside, "destination"), output = join(ancestor, "wiki")
  await mkdir(ancestor)
  const fs = await run(FileSystem.FileSystem)
  const publicationRoot = separateWikiOutput(f.root, output).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  assert.equal(await run(publicationRoot), output)
  const ops = operations({ root: f.root, output, fs, publicationRoot })
  const evidence = await run(ops.collect(f.spec))
  // Model review can outlive host setup. The formerly external ancestor now
  // points inside the source; publication must fail before creating wiki files.
  await rm(ancestor, { recursive: true })
  await symlink(f.root, ancestor, "dir")
  await assert.rejects(
    run(ops.write([{ evidence, review: supported(evidence), reviewer: "scripted" }], "verified")),
    /outside the source workspace/
  )
  await assert.rejects(readFile(join(f.root, "wiki", "current.json")), /ENOENT/)
})

test("the wiki CLI refuses an output or database that a symlinked ancestor routes outside --root", {
  timeout: 60_000
}, async (t) => {
  const f = await fixture(t)
  const outside = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-outside-")))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(f.root, ".smithers"))
  await writeFile(join(f.root, ".smithers/coding-project.json"), JSON.stringify({ pages: [f.spec] }))
  const cli = fileURLToPath(new URL("../wiki/main.ts", import.meta.url))
  const invoke = (...args: Array<string>) =>
    spawnSync("node", [cli, "--root", f.root, ...args], { cwd: f.root, encoding: "utf8", timeout: 25_000 })
  await symlink(outside, join(f.root, ".flows"), "dir")
  const linked = invoke()
  assert.notEqual(linked.status, 0, linked.stdout)
  assert.match(linked.stderr, /inside --root, through no symlink out/)
  await assert.rejects(readFile(join(outside, "wiki", "current.json")), /ENOENT/)
  await rm(join(f.root, ".flows"))
  const database = invoke("--database", join(outside, "engine.db"))
  assert.notEqual(database.status, 0)
  assert.match(database.stderr, /--database must be a file under --root\/\.flows/)
  const contained = invoke("--run", "wiki-contained-preview")
  assert.equal(contained.status, 0, contained.stderr)
  assert.match(contained.stdout, /"verification":\s*"unreviewed"/)
})
