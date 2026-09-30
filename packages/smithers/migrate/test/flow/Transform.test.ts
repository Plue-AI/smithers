/** Guarded migration editing and mapping, through the agent's public catalog. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as Contract from "@smthrs/migrate/flow/Contract"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import type * as Options from "@smthrs/migrate/flow/Options"
import * as Transform from "@smthrs/migrate/flow/Transform"
import * as Mapping from "@smthrs/migrate/Mapping"
import * as Scan from "@smthrs/migrate/Scan"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture } from "../fixtures/helpers.ts"

const call = (flowName: string, input: Schema.Json): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none<Descriptor.Placement>(),
    identity: new Cell.CallIdentity({
      session: "migrate-test",
      frame: 0,
      cell: "cell",
      ordinal: 0,
      declaration: "declaration",
      layers: []
    })
  })

/** Runs one bound flow the way a cell's `ctx.call` reaches it. */
const ask = (root: string, flowName: string, input: Schema.Json) =>
  Effect.gen(function*() {
    const source = yield* Transform.bindings()
    const bindings: ReadonlyArray<FlowBinding.Binding> = yield* source.bindings()
    const binding = bindings.find((entry) => entry.descriptor.name === flowName)
    if (binding === undefined) throw new Error(`no binding named ${flowName}`)
    return yield* binding.run(call(flowName, input))
  }).pipe(Effect.provide(NodeServices.layer))

describe("Transform.bindings", () => {
  it.effect("publishes guarded editing tools without shell or verification", () =>
    Effect.gen(function*() {
      const host = yield* AgentAction.Host
      const bindings = yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())
      const names = bindings.flat().map((binding) => binding.descriptor.name)
      expect(names).toContain("write")
      expect(names).toContain("migrate/mapping")
      expect(names).not.toContain("bash")
      expect(names).not.toContain("migrate/verify")
      expect(host.supervisor?.stance).toBe("paranoid")
    }).pipe(Effect.provide(
      Transform.hostLayer({ environment: { SMITHERS_SUPERVISOR_STANCE: "paranoid" } })
        .pipe(Layer.provide([NodeServices.layer, ScriptedJudge.layerAll]))
    )))
  it.effect("offers mapping without agent verification", () =>
    Effect.gen(function*() {
      const source = yield* Transform.bindings()
      const bindings = yield* source.bindings()
      expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["migrate/mapping"])
      expect(Transform.envelope()).not.toContain("proc:spawn:*")
      expect(Transform.envelope()).toContain("model:call:typesafe-ai/jev")
    }))
})

describe("Transform.bindings: migrate/mapping", () => {
  it.effect("answers with the mapping row for a construct", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const result = yield* ask(root, "migrate/mapping", { construct: "Sequence" })

      expect(result.outcome).toBe("success")
      expect((result.value as { construct: string }).construct).toBe("Sequence")
      expect((result.value as { target: string | null }).target).not.toBe(null)
    }))

  it.effect("says so rather than guessing when there is no row", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const result = yield* ask(root, "migrate/mapping", { construct: "NotAConstruct" })

      expect((result.value as { rule: string }).rule).toBe("no mapping row")
      expect((result.value as { class: string }).class).toBe("unsafe")
    }))
})

describe("Transform.approvedPackages", () => {
  it("approves every package the target model tells the agent to import", () => {
    // The prompt names each module a migrated unit reaches for. Every one of
    // them has to be installable, or the contract forbids the import it
    // requires: `@smthrs/core` declares the body-less signature a bound tool
    // flow is.
    const named = [...new Set(Contract.targetModel.match(/@smthrs\/[a-z-]+/g) ?? [])].sort()
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) expect(Transform.approvedPackages).toContain(name)
    expect(Transform.approvedPackages).toContain("@smthrs/core")
    expect(Transform.approvedPackages).toContain("effect")
    // And every package a mapping row points the agent at, however the row
    // spells it: a guided rewrite of `smthrs/memory` is told to use
    // `@smthrs/memory`, so `@smthrs/memory` has to be installable.
    for (const row of Mapping.rows) {
      for (const name of `${row.target ?? ""} ${row.targetModule ?? ""}`.match(/@smthrs\/[a-z-]+/g) ?? []) {
        expect([row.construct, name, Transform.approvedPackages.includes(name)]).toEqual([row.construct, name, true])
      }
    }
    expect(Transform.approvedPackages).toContain("@smthrs/memory")
    expect(Transform.approvedPackages).toEqual([...Transform.approvedPackages].sort())
  })
})

describe("Transform.capture", () => {
  for (const file of [".env", ".env.local", "config/.env.production", ".envrc"]) {
    it.effect(`keeps dotenv credentials out of every capture path for ${file}`, () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        mkdirSync(join(root, "config"), { recursive: true })
        const original = [
          "SMITHERS_HOME=PRIVATE_HOME_VALUE",
          "OTHER_SERVICE_TOKEN=FAKE_SECRET_FOR_REVIEW_ONLY",
          "# PRIVATE_COMMENT",
          "export SMITHERS_TOKEN_2 = 'PRIVATE_SMITHERS_TOKEN' # PRIVATE_INLINE_COMMENT",
          "MULTILINE=\"PRIVATE_MULTILINE_START",
          "PRIVATE_MULTILINE_END\"",
          "SMITHERS_HOME=PRIVATE_DUPLICATE_VALUE",
          ""
        ].join("\n")
        writeFileSync(join(root, file), original, { mode: 0o600 })
        const scanned = yield* Scan.scan(root, { flowsDir: "flows" })
        const outlined = MigrateFlow.outlines(scanned, { root, mode: "apply" })
          .find((entry) => entry.kind === "integration" && entry.sources.includes(file))!
        expect(outlined.sources).toContain(file)
        const checkpoint = yield* Checkpoint.take({
          root,
          unit: outlined.id,
          files: outlined.sources,
          backupDir: join(root, ".smithers-migrate", "backup"),
          allowNoVcs: true,
          treeExclude: [".smithers-migrate"]
        })
        const assertRedacted = (brief: Contract.UnitBrief, expected: string) => {
          expect(brief.sources.find((source) => source.path === file)?.text).toBe(expected)
          // The capture action journals this return value, and the transform
          // action renders that same brief into its model prompt.
          for (const output of [JSON.stringify(brief), Contract.unitPrompt(brief)]) {
            expect(output).not.toContain("FAKE_SECRET_FOR_REVIEW_ONLY")
            expect(output).not.toContain("OTHER_SERVICE_TOKEN")
            expect(output).not.toContain("PRIVATE_")
          }
          expect(Contract.unitPrompt(brief)).toContain("Do not read or rewrite dotenv files")
          expect(Contract.unitPrompt(brief)).toContain("report any required environment migration as unresolved")
        }
        const expected = "SMITHERS_HOME=[REDACTED]\nSMITHERS_TOKEN_2=[REDACTED]"
        assertRedacted(yield* Transform.capture(outlined, checkpoint), expected)
        writeFileSync(join(root, file), "SMITHERS_REPAIR=PRIVATE_REPAIR_VALUE\nTOKEN=PRIVATE_REPAIR_TOKEN\n")
        assertRedacted(yield* Transform.capture(outlined, checkpoint, true), "SMITHERS_REPAIR=[REDACTED]")
        // Initial captures still use the checkpoint after the disk changes.
        assertRedacted(yield* Transform.capture(outlined, checkpoint), expected)
        // Missing repair sources fall back to the checkpoint.
        unlinkSync(join(root, file))
        assertRedacted(yield* Transform.capture(outlined, checkpoint, true), expected)
        yield* Checkpoint.restore(root, checkpoint, [file])
        expect(readFileSync(join(root, file), "utf8")).toBe(original)
        // Sources absent from the checkpoint fall back to disk, even on the
        // first round. No branch may return the raw dotenv bytes.
        assertRedacted(yield* Transform.capture(outlined, { ...checkpoint, entries: [] }), expected)
        writeFileSync(join(root, file), "TOKEN=PRIVATE_ONLY_UNRELATED\n")
        assertRedacted(yield* Transform.capture(outlined, checkpoint, true), "")
      }).pipe(Effect.provide(NodeServices.layer)))
  }

  it.effect("shows the first round the checkpoint's copy and a repair round the disk", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(root, { flowsDir: "flows" })
      const chosen: Options.MigrateOptions = { root, mode: "apply" }
      const outline = MigrateFlow.outlines(scanned, chosen)
        .find((entry) => entry.id === "workflow:simple-workflow")!
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: outline.sources,
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      })
      const original = readFileSync(join(root, "simple-workflow.jsx"), "utf8")

      // What the previous round did to the file the next round is asked about.
      writeFileSync(join(root, "simple-workflow.jsx"), "// the round before edited this\n")

      const first = yield* Transform.capture(outline, checkpoint)
      const repair = yield* Transform.capture(outline, checkpoint, true)

      const sourceOf = (brief: Contract.UnitBrief): string =>
        brief.sources.find((file) => file.path === "simple-workflow.jsx")?.text ?? ""
      expect(sourceOf(first)).toBe(original)
      expect(sourceOf(repair)).toBe("// the round before edited this\n")
    }).pipe(Effect.provide(NodeServices.layer)))
})
