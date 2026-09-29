import { describe, expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Checks from "../src/Checks.ts"
import * as Detect from "../src/Detect.ts"
import * as Inventory from "../src/Inventory.ts"
import * as Mapping from "../src/Mapping.ts"
import * as RunState from "../src/RunState.ts"
import * as Scan from "../src/Scan.ts"
import * as Units from "../src/Units.ts"
import { copyFixture, fixture, nodeLayer } from "./fixtures/helpers.ts"
import golden from "./fixtures/jsx-single.migrated/flows/simple-workflow/flow.ts"

const emptyCheckpoint: Checks.CheckpointFiles = { sources: new Map(), digests: new Map() }

const unit = (flowsDir = "flows", specifiers: Detect.SpecifierContext = { localFacade: true }): Units.UnitPlan => ({
  id: "workflow:simple-workflow",
  kind: "workflow",
  sources: ["simple-workflow.jsx"],
  targets: [`${flowsDir}/simple-workflow/flow.ts`],
  constructs: [],
  mapping: [],
  hints: { zod: [], prompt: [] },
  unsafe: [],
  notes: [],
  specifiers,
  verification: {
    install: undefined,
    format: undefined,
    typecheck: [],
    test: undefined,
    discovery: { flowsDir },
    notes: []
  }
})

const run = (
  root: string,
  changed: ReadonlyArray<string>,
  checkpoint: Checks.CheckpointFiles = emptyCheckpoint,
  reported: ReadonlyArray<Checks.ReportedEntry> = []
) => Checks.run(root, unit(), changed, checkpoint, reported).pipe(Effect.provide(nodeLayer))

const named = (results: ReadonlyArray<Checks.CheckResult>, name: string): Checks.CheckResult =>
  results.find((result) => result.name === name)!

const writeFlow = (root: string, body: string, file = "flows/simple-workflow/flow.ts"): string => {
  mkdirSync(join(root, ...file.split("/").slice(0, -1)), { recursive: true })
  writeFileSync(join(root, ...file.split("/")), body)
  return file
}

/** Every file under the run-state roots, digested as a checkpoint would. */
const digestsUnder = (root: string, roots: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const digests = new Map<string, string>()
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(join(root, ...directory.split("/")), { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(relative, relative)
      else {
        digests.set(
          relative,
          createHash("sha256").update(readFileSync(join(root, ...relative.split("/")))).digest("hex")
        )
      }
    }
  }
  for (const entry of roots) walk(entry, entry)
  return digests
}

/** The checkpoint a real unit carries: the old sources it is rewriting. */
const checkpointOf = (...files: ReadonlyArray<string>): Checks.CheckpointFiles => ({
  sources: new Map(files.map((file) => [file, readFileSync(join(fixture("jsx-single"), ...file.split("/")), "utf8")])),
  digests: new Map()
})

describe("Checks.run over the migrated fixture", () => {
  it.effect("passes every check", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const results = yield* run(root, ["flows/simple-workflow/flow.ts"], checkpointOf("simple-workflow.jsx"))

      expect(results.filter((result) => !result.ok)).toEqual([])
      expect(Checks.ok(results)).toBe(true)
    }))

  it.effect("fails when a seat names a model the source never named", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = "flows/simple-workflow/flow.ts"
      const target = join(root, ...file.split("/"))
      writeFileSync(target, readFileSync(target, "utf8").replace(/claude-sonnet-5/g, "claude-sonnet-4-5"))
      const results = yield* run(root, [file], checkpointOf("simple-workflow.jsx"))
      const seats = named(results, "every seat comes from the source or from a decision")

      expect(seats.ok).toBe(false)
      expect(seats.findings[0]?.message).toContain("claude-sonnet-4-5")
    }))

  it.effect("does not accept a seat justified only by prose in the old source", () =>
    Effect.gen(function*() {
      // `openai:gpt` is not justified by the word "gpt" in a comment. The model
      // has to be a string the source actually wrote.
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(root, "export const step = { seat: \"openai:gpt\" }\n", "flows/bad/flow.ts")
      const results = yield* run(root, [file], {
        sources: new Map([["old.jsx", "// we talked about gpt and agentgpt in review\n"]]),
        digests: new Map()
      })

      expect(named(results, "every seat comes from the source or from a decision").ok).toBe(false)
    }))

  it.effect("accepts a seat the operator chose in a decision", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = "flows/simple-workflow/flow.ts"
      const target = join(root, ...file.split("/"))
      writeFileSync(target, readFileSync(target, "utf8").replace(/claude-sonnet-5/g, "claude-sonnet-4-5"))
      const results = yield* Checks.run(
        root,
        unit(),
        [file],
        checkpointOf("simple-workflow.jsx"),
        [],
        ["the operator chose anthropic:claude-sonnet-4-5 for both steps"]
      ).pipe(Effect.provide(nodeLayer))

      expect(named(results, "every seat comes from the source or from a decision").ok).toBe(true)
    }))
})

describe("Checks.run finds each defect on its own", () => {
  it.effect("fails when an old import survives", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "import { Task } from \"smithers-orchestrator\"\nexport const description = \"x\"\n",
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, "no old import remains").ok).toBe(false)
      expect(named(results, "no old import remains").findings[0]?.message).toContain("smithers-orchestrator")
    }))

  it.effect("finds an old package in every form a module can name one", () =>
    Effect.gen(function*() {
      // A regular expression over `from "..."` sees two of these six.
      const forms: ReadonlyArray<readonly [string, string]> = [
        ["side effect", "import \"smthrs/tools\"\n"],
        ["require", "const smithers = require(\"smithers-orchestrator\")\n"],
        ["dynamic import", "export const load = async () => await import(\"smthrs\")\n"],
        ["export from", "export { Task } from \"smthrs\"\n"],
        ["deleted scoped package", "import { Task } from \"@smthrs/components\"\n"],
        ["deleted agents package", "import { CodexAgent } from \"@smthrs/agents\"\n"]
      ]
      const root = copyFixture("jsx-single.migrated")

      for (const [title, text] of forms) {
        const file = writeFlow(root, text, "flows/bad/flow.ts")
        const results = yield* run(root, [file])

        expect(named(results, "no old import remains").ok, title).toBe(false)
      }
    }))

  it.effect("calls a name that exists in both trees old only when a manifest pinned it below 1.0", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "import { run } from \"@smthrs/engine\"\nexport const go = run\n",
        "flows/bad/flow.ts"
      )

      const current = yield* Checks.run(root, unit("flows", { localFacade: false }), [file], emptyCheckpoint).pipe(
        Effect.provide(nodeLayer)
      )
      expect(named(current, "no old import remains").ok).toBe(true)

      const old = yield* Checks.run(
        root,
        unit("flows", { localFacade: false, oldScoped: ["engine"] }),
        [file],
        emptyCheckpoint
      ).pipe(Effect.provide(nodeLayer))
      expect(named(old, "no old import remains").ok).toBe(false)
    }))

  it.effect("fails when a JSX pragma survives", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "/** @jsxImportSource smthrs */\nexport const description = \"x\"\n",
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, "no JSX pragma remains").ok).toBe(false)
    }))

  it.effect("fails when a flow imports react", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "import { useState } from \"react\"\nconst description = \"x\"\n",
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, "no react import under the flows directory").ok).toBe(false)
    }))

  it.effect("fails when an escape hatch is introduced but not when it was already there", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const before = "const a = value as any\n"
      const after = "const a = value as any\nconst b = other as unknown as string\n"
      const file = writeFlow(root, after, "flows/bad/flow.ts")

      const introduced = yield* run(root, [file])
      expect(named(introduced, "no escape hatch introduced").ok).toBe(false)

      const preexisting = yield* run(root, [file], { sources: new Map([[file, after]]), digests: new Map() })
      expect(named(preexisting, "no escape hatch introduced").ok).toBe(true)

      const partly = yield* run(root, [file], { sources: new Map([[file, before]]), digests: new Map() })
      expect(named(partly, "no escape hatch introduced").findings).toHaveLength(1)
    }))

  it.effect("fails when one escape hatch is swapped for another", () =>
    Effect.gen(function*() {
      // The aggregate count is unchanged, and the contract is still broken.
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(root, "// @ts-ignore\nconst a = value\n", "flows/bad/flow.ts")
      const results = yield* run(root, [file], {
        sources: new Map([[file, "const a = value as any\n"]]),
        digests: new Map()
      })

      expect(named(results, "no escape hatch introduced").ok).toBe(false)
      expect(named(results, "no escape hatch introduced").findings[0]?.message).toContain("@ts-ignore")
    }))

  it.effect("fails when a flow runs its own scheduler loop", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "const description = \"x\"\nsetInterval(() => poll(), 1000)\nwhile (true) { await status() }\n",
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, "no scheduler loop under the flows directory").findings).toHaveLength(2)
    }))

  it.effect("fails when a flow opens a database", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "import { DatabaseSync } from \"node:sqlite\"\nconst db = new Database(\"smithers.db\")\nconst description = \"x\"\n",
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, "no direct database access under the flows directory").findings).toHaveLength(2)
    }))

  it.effect("fails when a flow module has no description", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(root, "export default {}\n", "flows/bad/flow.ts")
      const results = yield* run(root, [file])

      expect(named(results, "every flow module declares a description").ok).toBe(false)
    }))

  it.effect("is not satisfied by a description in a comment or on another binding", () =>
    Effect.gen(function*() {
      // The registry evaluates nothing and reads the default export. A check
      // that a comment passes says nothing about whether the flow is listable.
      const root = copyFixture("jsx-single.migrated")
      const bodies: ReadonlyArray<readonly [string, string]> = [
        ["a comment", "// description: \"x\"\nexport default {}\n"],
        ["another binding", "const description = \"x\"\nexport default Flow.make({ input: 1 })\n"],
        ["an empty string", "export default Flow.make({ description: \"\" })\n"],
        ["a computed value", "export default Flow.make({ description: name })\n"],
        // Discovery tokenizes `export default Flow.make(` literally (registry
        // `internal/ModuleMetadata.ts`), so a description on any other
        // constructor is a description the registry never reads.
        ["another constructor", "export default Widget.make({ description: \"Real.\" })\n"],
        ["a bare make", "export default make({ description: \"Real.\" })\n"],
        ["a namespaced alias", "export default DurableFlow.make({ description: \"Real.\" })\n"],
        ["Flow.agent", "export default Flow.agent({ description: \"Real.\" })\n"]
      ]

      for (const [title, body] of bodies) {
        const file = writeFlow(root, body, "flows/bad/flow.ts")
        const results = yield* run(root, [file])

        expect(named(results, "every flow module declares a description").ok, title).toBe(false)
      }

      const good = writeFlow(root, "export default Flow.make({ description: \"Real.\" })\n", "flows/bad/flow.ts")
      expect(named(yield* run(root, [good]), "every flow module declares a description").ok).toBe(true)
    }))

  it.effect("fails on a TODO marker the report does not name, and passes on one it does", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        `const description = "x"\n// ${Checks.marker}: Worktree\n`,
        "flows/bad/flow.ts"
      )

      const unreported = yield* run(root, [file])
      expect(named(unreported, "every TODO marker is reported").ok).toBe(false)
      expect(named(unreported, "every TODO marker is reported").findings[0]?.message).toContain("Worktree")

      const reported = yield* run(root, [file], emptyCheckpoint, [{ construct: "Worktree", file }])
      expect(named(reported, "every TODO marker is reported").ok).toBe(true)
    }))

  it.effect("fails when run state changed or was removed", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const target = join(root, ".smithers", "executions", "run-1783757199651", "stdout.log")
      const original = readFileSync(target)
      const digests = new Map([[
        ".smithers/executions/run-1783757199651/stdout.log",
        createHash("sha256").update(original).digest("hex")
      ]])

      const unchanged = yield* run(root, [], { sources: new Map(), digests })
      expect(named(unchanged, "run state is byte-identical").ok).toBe(true)

      writeFileSync(target, "tampered\n")
      const changed = yield* run(root, [], { sources: new Map(), digests })
      expect(named(changed, "run state is byte-identical").findings[0]?.message).toContain("must never write")
    }))

  it.effect("fails when a file appears under a run-state root the checkpoint did not hold", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const existing = ".smithers/executions/run-1783757199651/stdout.log"
      const digests = new Map([[
        existing,
        createHash("sha256").update(readFileSync(join(root, ...existing.split("/")))).digest("hex")
      ]])
      const checkpoint: Checks.CheckpointFiles = {
        sources: new Map(),
        digests,
        runStateRoots: [".smithers/executions"]
      }

      const clean = yield* run(root, [], checkpoint)
      expect(named(clean, "run state is byte-identical").ok).toBe(true)

      mkdirSync(join(root, ".smithers", "executions", "run-9999"), { recursive: true })
      writeFileSync(join(root, ".smithers", "executions", "run-9999", "stdout.log"), "new\n")
      writeFileSync(join(root, ".smithers", "executions", "run-1783757199651", "evil.json"), "{}\n")
      const added = yield* run(root, [], checkpoint)

      expect(named(added, "run state is byte-identical").findings.map((finding) => finding.file)).toEqual([
        ".smithers/executions/run-1783757199651/evil.json",
        ".smithers/executions/run-9999/stdout.log"
      ])
      expect(named(added, "run state is byte-identical").findings[0]?.message).toContain("run state was added")
    }))

  it.effect("reads absolute run-state paths where they are, not under the project", () =>
    Effect.gen(function*() {
      // Gateway state is the one run state that lives outside the project.
      // Joined under the root, the check would read a path that holds nothing
      // and call the real file byte-identical whatever happened to it.
      const root = copyFixture("persisted-db")
      const gateway = mkdtempSync(join(tmpdir(), "migrate-gateway-"))
      try {
        const file = join(gateway, "workspace.json")
        writeFileSync(file, "gateway state\n")
        const digests = new Map([[file, createHash("sha256").update(readFileSync(file)).digest("hex")]])

        const unchanged = yield* run(root, [], { sources: new Map(), digests })
        expect(named(unchanged, "run state is byte-identical").ok).toBe(true)

        writeFileSync(file, "tampered\n")
        const changed = yield* run(root, [], { sources: new Map(), digests })
        expect(named(changed, "run state is byte-identical").findings[0]?.message).toContain("must never write")

        rmSync(file)
        const removed = yield* run(root, [], { sources: new Map(), digests })
        expect(named(removed, "run state is byte-identical").findings[0]?.message).toContain("must never touch")
      } finally {
        rmSync(gateway, { recursive: true, force: true })
      }
    }))

  it.effect("fails when a file appears under an absolute run-state root the checkpoint did not hold", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const gateway = mkdtempSync(join(tmpdir(), "migrate-gateway-"))
      try {
        const file = join(gateway, "workspace.json")
        writeFileSync(file, "gateway state\n")
        const digests = new Map([[file, createHash("sha256").update(readFileSync(file)).digest("hex")]])
        const checkpoint: Checks.CheckpointFiles = {
          sources: new Map(),
          digests,
          runStateRoots: [gateway]
        }

        const clean = yield* run(root, [], checkpoint)
        expect(named(clean, "run state is byte-identical").ok).toBe(true)

        writeFileSync(join(gateway, "new.json"), "{}\n")
        const added = yield* run(root, [], checkpoint)
        expect(named(added, "run state is byte-identical").findings.map((finding) => finding.file)).toEqual([
          join(gateway, "new.json")
        ])
      } finally {
        rmSync(gateway, { recursive: true, force: true })
      }
    }))

  it.effect("takes the run-state roots from the scan that found them", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const result = yield* Scan.scan(root).pipe(Effect.provide(nodeLayer))

      expect(RunState.roots(result.runState)).toContain(".smithers")
    }))

  it.effect("fails when a run log appears beside the loose one the scan found", () =>
    Effect.gen(function*() {
      // The loose `run-*.log` 0.x writes under `.smithers/workflows` is a file,
      // not a directory. A checkpoint that walked the file itself would see the
      // sibling this test writes as nothing at all.
      const root = copyFixture("persisted-db")
      const scanned = yield* Scan.scan(root).pipe(Effect.provide(nodeLayer))
      const runStateRoots = RunState.roots(scanned.runState)
      const checkpoint: Checks.CheckpointFiles = {
        sources: new Map(),
        digests: digestsUnder(root, runStateRoots),
        runStateRoots
      }

      const clean = yield* run(root, [], checkpoint)
      expect(named(clean, "run state is byte-identical").findings).toEqual([])

      writeFileSync(join(root, ".smithers", "workflows", "run-1799999999999.log"), "new\n")
      const added = yield* run(root, [], checkpoint)

      expect(named(added, "run state is byte-identical").findings.map((finding) => finding.file)).toEqual([
        ".smithers/workflows/run-1799999999999.log"
      ])
    }))
})

describe("Checks.run ties the default export to the flow that runs", () => {
  // A migrated module default-exports the flow itself, body and all, so the
  // contract the control plane admits is the one that runs. Discovery reads
  // the default export and never a named one, so a module that keeps its body
  // in a named declaration the default export does not reach admits one thing
  // and runs another, and that is what this check refuses.
  const CHECK = "every flow module's descriptor describes the flow it declares"
  const declared = [
    "const SimpleExample = Flow.make(\"simple-workflow/SimpleExample\", {",
    "  payload: { topic: Schema.String },",
    "  success: Article,",
    "  body: ({ topic }) => ResearchStep.call({ topic })",
    "})"
  ].join("\n")

  it.effect("passes on the golden, which default-exports the flow it runs", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const results = yield* run(root, ["flows/simple-workflow/flow.ts"], checkpointOf("simple-workflow.jsx"))

      expect(named(results, CHECK).ok).toBe(true)
    }))

  it.effect("fails when the default export admits a contract the module's flow does not declare", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        `${declared}\nexport default Flow.make("bad", { description: "Real.", payload: Schema.Void, success: Schema.Unknown, body: () => Node.succeed(1) })\n`,
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, CHECK).ok).toBe(false)
      expect(named(results, CHECK).findings[0]?.message).toContain("SimpleExample")
    }))

  it.effect("fails when a lone default export carries no behavior at all", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(
        root,
        "export default Flow.make(\"bad\", { description: \"Real.\", payload: {} })\n",
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [file])

      expect(named(results, CHECK).ok).toBe(false)
      expect(named(results, CHECK).findings[0]?.message).toContain("callable `body`")
    }))

  it.effect("accepts a default export whose body reaches the flow beside it", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const delegating = writeFlow(
        root,
        `${declared}\nexport default Flow.make("bad", { description: "Real.", payload: {}, body: (input) => SimpleExample.call(input) })\n`,
        "flows/bad/flow.ts"
      )
      expect(named(yield* run(root, [delegating]), CHECK).ok).toBe(true)

      const elsewhere = writeFlow(
        root,
        `${declared}\nexport default Flow.make("bad", { description: "Real.", payload: {}, body: (input) => Other.call(input) })\n`,
        "flows/bad/flow.ts"
      )
      const results = yield* run(root, [elsewhere], emptyCheckpoint)
      expect(named(results, CHECK).ok).toBe(false)
      expect(named(results, CHECK).findings[0]?.message).toContain("does not call SimpleExample")
    }))

  it.effect("accepts a default export that is the flow, tag and body included", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const bodies = [
        "export default Flow.make(\"bad\", { description: \"Real.\", payload: {}, body: () => Node.succeed(1) })\n",
        "export default Flow.make('bad', { description: 'Real.', payload: {}, body(input) { return Node.succeed(input) } })\n",
        "const payload = {}\nconst body = () => Node.succeed(1)\nexport default Flow.make('bad', { description: 'Real.', payload, body })\n",
        "export default Flow.make('bad', { description: 'Real.', 'payload': {}, \"body\": () => Node.succeed(1) })\n"
      ]

      for (const body of bodies) {
        const file = writeFlow(root, body, "flows/bad/flow.ts")

        expect(named(yield* run(root, [file]), CHECK).ok, body).toBe(true)
      }
    }))

  it.effect("rejects obsolete factories, missing tags, and missing bodies", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        [
          "object-first",
          "export default Flow.make({ description: \"Real.\", body: () => Node.succeed(1) })\n",
          "Flow.make"
        ],
        [
          "model-only",
          "export default Flow.make({ description: \"Real.\", model: \"anthropic:probe\" })\n",
          "Flow.make"
        ],
        [
          "empty tag",
          "export default Flow.make(\"\", { description: \"Real.\", body: () => Node.succeed(1) })\n",
          "Flow.make"
        ],
        [
          "computed tag",
          "export default Flow.make(tag, { description: \"Real.\", body: () => Node.succeed(1) })\n",
          "Flow.make"
        ],
        [
          "extra argument",
          "export default Flow.make(\"bad\", { description: \"Real.\", body: () => Node.succeed(1) }, extra)\n",
          "Flow.make"
        ],
        [
          "tagged without body",
          "export default Flow.make(\"bad\", { description: \"Real.\", payload: {}, model: \"anthropic:probe\" })\n",
          "callable `body`"
        ],
        [
          "tagged without payload",
          "export default Flow.make(\"bad\", { description: \"Real.\", body: () => Node.succeed(1) })\n",
          "payload"
        ],
        [
          "null body",
          "export default Flow.make(\"bad\", { description: \"Real.\", payload: {}, body: null })\n",
          "callable `body`"
        ],
        [
          "undefined body",
          "export default Flow.make(\"bad\", { description: \"Real.\", payload: {}, body: undefined })\n",
          "callable `body`"
        ],
        [
          "number body",
          "export default Flow.make(\"bad\", { description: \"Real.\", payload: {}, body: 1 })\n",
          "callable `body`"
        ],
        [
          "string body",
          "export default Flow.make(\"bad\", { description: \"Real.\", payload: {}, body: \"noop\" })\n",
          "callable `body`"
        ]
      ]

      for (const [title, body, message] of cases) {
        const file = writeFlow(root, body, "flows/bad/flow.ts")
        const result = named(yield* run(root, [file]), CHECK)
        expect(result.ok, title).toBe(false)
        expect(result.findings[0]?.message, title).toContain(message)
      }
    }))
})

describe("the module the emitter writes passes these checks", () => {
  // The tool's own output is held to the tool's own contract: one default
  // export the registry can list and the engine can run.
  const greeting = [
    "/** @jsxImportSource smthrs */",
    "import { createSmithers } from \"smthrs\";",
    "const { Workflow, Task, smithers, outputs } = createSmithers({",
    "  input: z.object({ name: z.string() }),",
    "  result: z.object({ message: z.string() })",
    "});",
    "export default smithers((ctx) => (",
    "  <Workflow name=\"greeting\">",
    "    <Task id=\"greet\" output={outputs.result}>{() => ({ message: \"hi\" })}</Task>",
    "  </Workflow>",
    "));"
  ].join("\n")

  const emitted = (): string => {
    const factories = Inventory.factoryNames(new Map([["greeting.tsx", greeting]]))
    const hits = Inventory.scanFile("greeting.tsx", greeting, { factories })
    const workflow = hits.find((entry) => entry.construct === "Workflow")
    return Mapping.snippet(workflow!) ?? ""
  }

  const module = (body: string): string =>
    [
      "import { Flow } from \"@smthrs/flow\"",
      "import * as Schema from \"effect/Schema\"",
      "import { Greet } from \"./steps.ts\"",
      "",
      body,
      ""
    ].join("\n")

  it.effect("passes every check, description and binding included", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const file = writeFlow(root, module(emitted()), "flows/greeting/flow.ts")
      const results = yield* run(root, [file], { sources: new Map([["greeting.tsx", greeting]]), digests: new Map() })

      expect(results.filter((result) => !result.ok)).toEqual([])
    }))

  it.effect("fails once the flow stops being the default export, and again once a descriptor drifts", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const checkpoint = { sources: new Map([["greeting.tsx", greeting]]), digests: new Map() }
      // The same declaration as a named export. The registry reads the default
      // export and never a named one, so this is a flow nobody can list.
      const named_ = emitted().replace("export default Flow.make(", "export const Greeting = Flow.make(")

      const dropped = yield* run(root, [writeFlow(root, module(named_), "flows/greeting/flow.ts")], checkpoint)
      expect(named(dropped, "every flow module declares a description").ok).toBe(false)
      // The descriptor check stays quiet here on purpose: a module with no
      // default export is already named once, and saying it twice hides which
      // contract broke.
      expect(named(dropped, "every flow module's descriptor describes the flow it declares").ok).toBe(true)

      // A body-less descriptor beside the flow, admitting something else.
      const drifted =
        `${named_}\nexport default Flow.make("greeting", { description: "Greets.", payload: Schema.Void })\n`
      const results = yield* run(root, [writeFlow(root, module(drifted), "flows/greeting/flow.ts")], checkpoint)
      expect(named(results, "every flow module declares a description").ok).toBe(true)
      expect(named(results, "every flow module's descriptor describes the flow it declares").ok).toBe(false)
    }))

  it.effect("is discovered by the registry the CLI runs", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      writeFlow(root, module(emitted()), "flows/greeting/flow.ts")
      const result = yield* Checks.discovery(root, "flows").pipe(Effect.provide(nodeLayer))

      expect(result.findings).toEqual([])
      expect(result.ok).toBe(true)
    }))
})

describe("the golden's execution plan", () => {
  it("is two ordered agent calls answering with the Article schema", () => {
    // The default export is the flow the engine runs. Building it here is the
    // execution half of the same claim the shape check makes statically.
    const graph = Graph.build(golden, { topic: "effect" })
    const nodes = Graph.nodes(graph)

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(nodes.filter((node) => node.kind === "ActionCall").map((node) => node.id)).toEqual([
      "root.flow.andThen",
      "root.flow.then"
    ])
    expect(nodes[1]?.dependencies).toEqual(["root.flow.andThen"])
    expect(Object.keys(golden.successSchema.fields)).toEqual(["article", "wordCount"])
  })
})

describe("Checks.discovery", () => {
  it.effect("lists the migrated flow with no warnings", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      const result = yield* Checks.discovery(root, "flows").pipe(Effect.provide(nodeLayer))

      expect(result.findings).toEqual([])
      expect(result.ok).toBe(true)
    }))

  it.effect("fails when a flow module carries no description", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single.migrated")
      writeFlow(root, "export default Flow.make({\n  input: Schema.String\n})\n", "flows/nameless/flow.ts")
      const result = yield* Checks.discovery(root, "flows").pipe(Effect.provide(nodeLayer))

      expect(result.ok).toBe(false)
      expect(result.findings.some((finding) => finding.message.startsWith("missing_description"))).toBe(true)
    }))

  it.effect("fails when the flows directory does not exist", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const result = yield* Checks.discovery(root, "flows").pipe(Effect.provide(nodeLayer))

      expect(result.ok).toBe(false)
      expect(result.findings[0]?.message).toContain("does not exist")
    }))
})

describe("Checks over a project the migration has not touched", () => {
  it.effect("finds the old imports and the pragma the 0.x fixture still has", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* Detect.scan(root).pipe(Effect.provide(nodeLayer))
      const changed = detection.workflowFiles.map((workflow) => workflow.path)
      const results = yield* run(root, changed)

      expect(named(results, "no old import remains").ok).toBe(false)
      expect(named(results, "no JSX pragma remains").ok).toBe(false)
    }))
})
