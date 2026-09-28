import { describe, expect, it } from "@effect/vitest"
import ts from "@typescript/typescript6"
import * as Effect from "effect/Effect"
import * as Constructs from "../src/Constructs.ts"
import * as Detect from "../src/Detect.ts"
import * as Inventory from "../src/Inventory.ts"
import * as Mapping from "../src/Mapping.ts"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

const fixtures = ["jsx-single", "plue-pack", "batch-issues", "mixed-api", "persisted-db"] as const

const hit = (
  construct: string,
  props: ReadonlyArray<string> = [],
  detail?: Record<string, string>
): Inventory.InventoryEntry =>
  detail === undefined
    ? { file: "flow.tsx", line: 1, column: 1, construct, props }
    : { file: "flow.tsx", line: 1, column: 1, construct, props, detail }

/** Whether a whole emitted module parses, `export default` and all. */
const transpilesModule = (source: string): boolean => {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }
  })
  return (result.diagnostics ?? []).length === 0
}

const transpiles = (source: string): boolean => {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }
  })
  return (result.diagnostics ?? []).length === 0
}

const scan = (name: string) =>
  Effect.gen(function*() {
    const detection = yield* Detect.scan(copyFixture(name))
    const hits = yield* Inventory.scan(detection)
    return { detection, hits }
  }).pipe(Effect.provide(nodeLayer))

// Old halves of the verified teaching pairs. `via` says how the tool reaches
// the new API: `snippet` when it writes the code from this source, `rule` when
// the translation needs a human decision and the mapping row names the target.
const auditPairs: ReadonlyArray<{
  readonly title: string
  readonly old: string
  readonly expects: string
  readonly via: "snippet" | "rule"
  readonly construct: string
}> = [
  {
    title: "Typed workflow execution",
    old: [
      "/** @jsxImportSource smthrs */",
      "import { closeSingleRunnerRuntime, createSmithers, runWorkflow } from \"smthrs\"",
      "const { Workflow, Task, smithers, outputs, close } = createSmithers({",
      "  input: z.object({ name: z.string() }),",
      "  result: z.object({ message: z.string() })",
      "}, { dbPath: \":memory:\" })",
      "const workflow = smithers((ctx) => <Workflow name=\"greeting\">",
      "  <Task id=\"greet\" output={outputs.result}>{() => ({ message: \"x\" })}</Task>",
      "</Workflow>)"
    ].join("\n"),
    expects: "Flow.make(\"greeting\"",
    via: "snippet",
    construct: "Workflow"
  },
  {
    title: "Sequence",
    old: [
      "/** @jsxImportSource smthrs */",
      "import { createSmithers, Sequence } from \"smthrs\"",
      "const { Workflow, Task, smithers, outputs } = createSmithers({ value: z.object({ value: z.string() }) })",
      "const workflow = smithers(() => <Workflow name=\"sequence\"><Sequence>",
      "  <Task id=\"first\" output={outputs.value}>{() => ({ value: \"first\" })}</Task>",
      "  <Task id=\"second\" output={outputs.value}>{() => ({ value: \"second\" })}</Task>",
      "</Sequence></Workflow>)"
    ].join("\n"),
    expects: "First.call({}).pipe(Node.bindPlanned((first) => Second.call({})))",
    via: "snippet",
    construct: "Sequence"
  },
  {
    title: "Parallel",
    old: [
      "/** @jsxImportSource smthrs */",
      "import { Parallel, Task } from \"smthrs\"",
      "const graph = await new SmithersRenderer().render(<Parallel>",
      "  <Task id=\"left\" output=\"value\">{() => ({ value: \"left\" })}</Task>",
      "  <Task id=\"right\" output=\"value\">{() => ({ value: \"right\" })}</Task>",
      "</Parallel>)"
    ].join("\n"),
    expects: "Node.all({\n  left: Left.call({}),\n  right: Right.call({})\n})",
    via: "snippet",
    construct: "Parallel"
  },
  {
    title: "Branch",
    old: [
      "/** @jsxImportSource smthrs */",
      "import { Branch, createSmithers } from \"smthrs\"",
      "const { Workflow, Task, smithers, outputs } = createSmithers({ result: z.object({ value: z.string() }) })",
      "const workflow = smithers(() => <Workflow name=\"branch\"><Branch if={true}",
      "  then={<Task id=\"ship\" output={outputs.result}>{() => ({ value: \"ship\" })}</Task>}",
      "  else={<Task id=\"stop\" output={outputs.result}>{() => ({ value: \"stop\" })}</Task>}",
      "/></Workflow>)"
    ].join("\n"),
    expects: "then: () => Ship.call({}),\n  else: () => Stop.call({})",
    via: "snippet",
    construct: "Branch"
  },
  {
    title: "Review loop",
    old: [
      "/** @jsxImportSource smthrs */",
      "import { createSmithers, ReviewLoop } from \"smthrs\"",
      "const { Workflow, smithers, outputs } = createSmithers({ produced: z.object({ draft: z.string() }) })",
      "const workflow = smithers(() => <Workflow name=\"review\"><ReviewLoop id=\"review\"",
      "  producer={producer} reviewer={reviewer} produceOutput={outputs.produced}",
      "  reviewOutput={outputs.review} maxIterations={4}>Write</ReviewLoop></Workflow>)"
    ].join("\n"),
    expects: "ReviewLoop.run",
    via: "rule",
    construct: "ReviewLoop"
  }
]

describe("Mapping.rows", () => {
  // `rows` appends a generated row for every catalog construct the explicit
  // table does not name, so asserting that each construct HAS a row asserts
  // nothing: the set is built from the thing it would be checked against. What
  // can fail is the target and the class each family generates, which is what
  // decides whether the agent rewrites a construct or reports it.
  it("gives each generated construct family the target and class it promises", () => {
    const generated = (name: string): Mapping.MappingRow => Mapping.byConstruct(name)!
    const kinds = new Map(Constructs.constructs.map((construct) => [construct.name, construct.kind]))
    const rowsByKind = (kind: string): ReadonlyArray<Mapping.MappingRow> =>
      Mapping.rows.filter((row) => kinds.get(row.construct) === kind)

    // Run data and the old gateway have no counterpart, so nothing about them
    // may be automatic.
    for (const kind of ["store", "server"]) {
      const family = rowsByKind(kind)
      expect(family.length, kind).toBeGreaterThan(0)
      for (const row of family) {
        expect([row.construct, row.class, row.target], kind).toEqual([row.construct, "unsafe", null])
      }
    }
    // A dependency read is the planned value the previous call returned.
    for (const name of ["ctx.output", "outputs.<key>", "tables.<key>"]) {
      expect([name, generated(name).class, generated(name).targetModule])
        .toEqual([name, "automatic", "@smthrs/plan/Node"])
    }
    // Loop state and worktree lanes are the two `ctx` families that are not.
    expect(generated("ctx.iterationCount").class).toBe("guided")
    expect(generated("ctx.worktreePath").class).toBe("unsafe")
    // The pragma goes away with the JSX; direct store access must not survive.
    expect([generated("@jsxImportSource smthrs").class, generated("db.<member>").class])
      .toEqual(["automatic", "unsafe"])
    // `automatic` is a promise the tool writes the code. The components that
    // claim it are exactly the ones `Mapping.snippet` has a branch for, listed
    // here rather than read back out of the module.
    expect(rowsByKind("component").filter((row) => row.class === "automatic").map((row) => row.construct)).toEqual([
      "Approval",
      "ApprovalGate",
      "Branch",
      "ContentPipeline",
      "Parallel",
      "Runbook",
      "Sequence",
      "Signal",
      "Task",
      "Timer",
      "WaitForEvent",
      "Workflow"
    ])
  })

  it("gives every row a target exactly when it is not unsafe", () => {
    for (const row of Mapping.rows) {
      if (row.class === "unsafe") expect(row.target).toBeNull()
      expect(row.rule.length).toBeGreaterThan(20)
    }
  })

  it("is sorted by construct so a generated document is stable", () => {
    const names = Mapping.rows.map((row) => row.construct)

    expect(names).toEqual([...names].sort())
  })

  it("resolves the facade names the old subpaths export", () => {
    // These are the names real 0.x projects import and that the hand-written
    // catalog missed: the mapping has to reach them, through their own row or
    // through the row for the subpath they come from.
    for (const name of ["approvalDecisionSchema", "monitorPrompt", "createMemoryStore", "runJj", "isSmithersError"]) {
      expect(Mapping.byImport(name), name).toBeDefined()
    }
    for (const name of ["SmithersGatewayClient", "useGatewayRun", "useGatewayApprovals", "ApprovalPanel"]) {
      expect(Mapping.byImport(name)?.construct, name).toMatch(/^smthrs\//)
    }
  })
})

describe("Mapping covers every old import in the fixtures", () => {
  for (const name of fixtures) {
    it.effect(`${name} has a row for every name it imports`, () =>
      Effect.gen(function*() {
        const { detection } = yield* scan(name)
        const imported = detection.imports
          .filter((entry) => entry.kind === "old" && !entry.typeOnly)
          .flatMap((entry) => entry.names.map((binding) => binding.imported))
          .filter((binding) => binding !== "default")

        const missing = [...new Set(imported)].filter((binding) => Mapping.byImport(binding) === undefined).sort()
        // Every name the catalog does not know is reported, never dropped.
        const reported = detection.warnings
          .filter((warning) => warning.code === "uncatalogued-import")
          .map((warning) => warning.message)

        for (const binding of missing) {
          expect(reported.some((message) => message.includes(`"${binding}"`)), binding).toBe(true)
        }
      }))
  }

  it.effect("names the two Plue imports the old facade never exported", () =>
    Effect.gen(function*() {
      const { detection } = yield* scan("batch-issues")
      const uncatalogued = detection.warnings.filter((warning) => warning.code === "uncatalogued-import")

      expect(uncatalogued.map((warning) => warning.message.split("\"")[1])).toEqual(["getLinearClient", "useLinear"])
    }))
})

describe("Mapping.classify", () => {
  it("keeps the table class when no prop raises it", () => {
    const payloads = "{\"one\":{},\"two\":{}}"
    expect(Mapping.classify(hit("Sequence", [], { childConstructs: "Task:one,Task:two", childPayloads: payloads })))
      .toBe("automatic")
    expect(Mapping.classify(hit("Parallel", [], { childConstructs: "Task:one,Task:two", childPayloads: payloads })))
      .toBe("automatic")
    expect(Mapping.classify(hit("Loop", ["until"]))).toBe("guided")
    expect(Mapping.classify(hit("Worktree"))).toBe("unsafe")
  })

  it("raises Parallel to guided when it bounds concurrency", () => {
    const raised = Mapping.classifyWithReason(
      hit("Parallel", ["maxConcurrency"], {
        childConstructs: "Task:one,Task:two",
        childPayloads: "{\"one\":{},\"two\":{}}"
      })
    )

    expect(raised.class).toBe("guided")
    expect(raised.reason).toContain("concurrency")
  })

  it("raises Parallel to guided when it skips the whole group", () => {
    const raised = Mapping.classifyWithReason(
      hit("Parallel", ["skipIf"], {
        skipIf: "done",
        childConstructs: "Task:one,Task:two",
        childPayloads: "{\"one\":{},\"two\":{}}"
      })
    )

    expect(raised.class).toBe("guided")
    expect(raised.reason).toContain("Node.branch")
  })

  it("raises Task to unsafe when it hijacks", () => {
    const raised = Mapping.classifyWithReason(hit("Task", ["id", "hijack"]))

    expect(raised.class).toBe("unsafe")
    expect(raised.reason).toContain("hijack")
  })

  it("raises an unbounded Loop but leaves a bounded one alone", () => {
    const unbounded = Mapping.classifyWithReason(
      hit("Loop", ["maxIterations", "until"], { maxIterations: "Infinity", until: "false" })
    )
    const bounded = Mapping.classifyWithReason(hit("Loop", ["maxIterations"], { maxIterations: "4" }))

    expect(unbounded.reason).toContain("fuel")
    expect(bounded.reason).toBeUndefined()
  })

  it("raises Loop to unsafe when it continues as new", () => {
    expect(Mapping.classify(hit("Loop", ["continueAsNewEvery"]))).toBe("unsafe")
  })

  it("raises a select approval to guided", () => {
    expect(Mapping.classify(hit("Approval", ["request"], { request: "ship it" }))).toBe("automatic")
    expect(Mapping.classify(hit("Approval", ["mode", "options"], { mode: "select" }))).toBe("guided")
  })

  it.each([
    { allowedUsers: "[\"release-manager\"]" },
    { allowedScopes: "[\"production\"]" },
    { allowedUsers: "[\"release-manager\"]", allowedScopes: "[\"production\"]" }
  ])("requires an explicit approval policy for %j", (restrictions) => {
    const props = Object.keys(restrictions)
    // Prop presence must require a decision even without captured values.
    for (const detail of [{ request: "Deploy production", ...restrictions }, { request: "Deploy production" }]) {
      const entry = hit("Approval", ["request", ...props], detail)
      const raised = Mapping.classifyWithReason(entry)

      expect(raised.class).toBe("guided")
      for (const prop of props) expect(raised.reason).toContain(prop)
      expect(raised.reason).toContain("operator")
      expect(raised.reason).toContain("approval flow")
      expect(Mapping.snippet(entry)).toBeUndefined()
    }
  })

  it("guides a component whose rewrite the source does not carry", () => {
    // Amendment 1: `automatic` is a promise the tool writes the code. A
    // `<Sequence>` whose children have no ids gives it nothing to write.
    const bare = Mapping.classifyWithReason(hit("Sequence"))

    expect(bare.class).toBe("guided")
    expect(bare.reason).toContain("not captured")
    expect(Mapping.snippet(hit("Sequence"))).toBeUndefined()
  })

  it("guides every pattern component whose target needs a decision", () => {
    // `ReviewLoop.run` takes effects where the old element took agents. The
    // table has to say guided, not automatic, or the class column is a lie.
    for (const construct of ["ReviewLoop", "Panel", "Debate", "GatherAndSynthesize", "ClassifyAndRoute"]) {
      expect(Mapping.byConstruct(construct)?.class, construct).toBe("guided")
      expect(Mapping.byConstruct(construct)?.target, construct).not.toBeNull()
    }
  })
})

describe("Mapping.snippet keeps the TypeScript it generates valid", () => {
  it("prefixes an id that starts with a digit and quotes a key, a tag, and a seat the source spelled unusually", () => {
    const text = Mapping.snippet(hit("Task", ["id", "agent"], {
      id: "1st \"quoted\" step",
      outputChain: "z.string()",
      payloadFields: JSON.stringify({ "a-b": "z.string().optional()", plain: "z.number().default(2)" }),
      promptText: "do it",
      agentProvider: "anthropic",
      agentModel: "model \"x\""
    }))

    expect(text).toBeDefined()
    expect(text).toContain("export const Step1stQuotedStep = AgentAction.make(\"flow/1st \\\"quoted\\\" step\", {")
    expect(text).toContain("\"a-b\": Schema.optional(Schema.String)")
    expect(text).toContain(
      "plain: Schema.Number.pipe((schema) => Schema.optional(schema).pipe(Schema.decodeTo(schema, { decode: SchemaGetter.withDefault(Effect.succeed(schema.make(2))), encode: SchemaGetter.required() })))"
    )
    expect(text).toContain("seat: \"anthropic:model \\\"x\\\"\",")
    expect(transpiles(`async function wrap() {\n${text}\n}`), text).toBe(true)
  })

  it("refuses a group whose step ids would print as one identifier", () => {
    for (const construct of ["Sequence", "Parallel"]) {
      const text = Mapping.snippet(hit(construct, [], {
        childConstructs: "Task:a-b,Task:a_b",
        childPayloads: JSON.stringify({ "a-b": {}, "a_b": {} })
      }))
      expect([construct, text]).toEqual([construct, undefined])
    }
    expect(Mapping.snippet(hit("Branch", ["if"], {
      if: "true",
      thenConstructs: "Task:go-on",
      thenPayloads: JSON.stringify({ "go-on": {} }),
      elseConstructs: "Task:go_on",
      elsePayloads: JSON.stringify({ "go_on": {} })
    }))).toBeUndefined()
    // Distinct ids that print distinctly are still automatic.
    expect(Mapping.snippet(hit("Sequence", [], {
      childConstructs: "Task:first,Task:second",
      childPayloads: JSON.stringify({ first: {}, second: {} })
    }))).toContain("Second.call")
  })

  it("emits a numeric timer as milliseconds, a duration phrase as a string, and refuses an expression", () => {
    expect(Mapping.snippet(hit("Timer", ["duration"], { duration: "1000" })))
      .toBe("Sleep.action.call({ name: \"wait\", duration: 1000 })")
    expect(Mapping.snippet(hit("Timer", ["duration", "id"], { duration: "1 hour", id: "nap" })))
      .toBe("Sleep.action.call({ name: \"nap\", duration: \"1 hour\" })")
    expect(Mapping.snippet(hit("Timer", ["duration"], { duration: "config.waitMs" }))).toBeUndefined()
    expect(Mapping.snippet(hit("Timer", ["duration"], { duration: "1000 * 60" }))).toBeUndefined()
  })
})

describe("Mapping.snippet", () => {
  it("emits TypeScript that parses for every construct it covers", () => {
    const covered = [
      hit("Workflow", ["name"], {
        name: "greeting",
        payloadChain: "z.object({ name: z.string() })",
        childConstructs: "Task:greet",
        childPayloads: "{\"greet\":{\"name\":\"ctx.input.name\"}}",
        childOutputs: "{\"greet\":\"z.object({ message: z.string() })\"}"
      }),
      hit("Task", ["id", "output"], {
        id: "greet",
        outputChain: "z.object({ message: z.string() })",
        payloadFields: "{}",
        children: "() => ({ message: \"x\" })"
      }),
      hit("Task", ["id", "output", "agent"], {
        id: "research",
        outputChain: "z.object({ summary: z.string() })",
        payloadFields: "{\"topic\":\"z.string()\"}",
        promptText: "Research {props.topic}",
        agentProvider: "anthropic",
        agentModel: "claude-sonnet-5"
      }),
      hit("Task", ["id", "output", "retries"], {
        id: "flaky",
        retries: "2",
        outputChain: "z.object({ ok: z.boolean() })",
        payloadFields: "{}",
        children: "() => ({ ok: true })"
      }),
      hit("Sequence", [], {
        childConstructs: "Task:first,Task:second",
        childPayloads: "{\"first\":{},\"second\":{\"value\":\"deps.first.value\"}}"
      }),
      hit("Parallel", [], {
        childConstructs: "Task:left,Task:right",
        childPayloads: "{\"left\":{},\"right\":{}}"
      }),
      hit("Branch", ["if"], {
        if: "true",
        thenConstructs: "Task:ship",
        thenPayloads: "{\"ship\":{}}",
        elseConstructs: "Task:stop",
        elsePayloads: "{\"stop\":{}}"
      }),
      hit("Timer", ["duration"], { duration: "1 hour" }),
      hit("WaitForEvent", ["event"], { event: "approved" }),
      hit("Approval", ["request"], { request: "ship it" }),
      hit("runWorkflow")
    ]

    for (const entry of covered) {
      const text = Mapping.snippet(entry)
      expect(text, entry.construct).toBeDefined()
      expect(transpiles(`async function wrap() {\n${text}\n}`), `${entry.construct}: ${text}`).toBe(true)
    }
  })

  it("rewrites an old CLI invocation with the same checked command mapper as manifests", () => {
    const text = Mapping.snippet(hit("smithers up", [], { command: "smithers up review.tsx" }))

    expect(text).toBe("smthrs flow start review")
    expect(Mapping.snippet(hit("smithers up", [], { command: "smithers up review.tsx --max-concurrency 8" })))
      .toBeUndefined()
    expect(Mapping.snippet(hit("smithers up"))).toBeUndefined()
  })

  it("claims an automatic CLI rewrite only when the actual invocation can be mapped", () => {
    expect(Mapping.classify(hit("smithers up", [], { command: "smithers up review.tsx --input '{}'" })))
      .toBe("automatic")
    for (
      const entry of [
        hit("smithers up"),
        hit("smithers up", [], { command: "smithers up review.tsx --max-concurrency 8" }),
        hit("smithers workflow", [], { command: "smithers workflow inspect review.tsx" }),
        hit("smithers ps", [], { command: "smithers ps" }),
        hit("smithers cancel", [], { command: "smithers cancel run-1" })
      ]
    ) {
      expect(Mapping.classify(entry), entry.construct).toBe("guided")
      expect(Mapping.snippet(entry), entry.construct).toBeUndefined()
    }
  })

  it("gives no snippet for a construct with no safe translation", () => {
    expect(Mapping.snippet(hit("Worktree"))).toBeUndefined()
    expect(Mapping.snippet(hit("Monitor"))).toBeUndefined()
  })

  it("writes no step it cannot name and no schema it cannot read", () => {
    expect(Mapping.snippet(hit("Task", ["id", "output"], { id: "greet" }))).toBeUndefined()
    expect(Mapping.snippet(hit("Workflow", ["name"], { name: "greeting" }))).toBeUndefined()
    expect(Mapping.snippet(hit("Branch", ["if"], { if: "true" }))).toBeUndefined()
    expect(Mapping.snippet(hit("Parallel", [], { childConstructs: "Sequence:" }))).toBeUndefined()
  })

  it("drops the whole group when one child has no literal id", () => {
    // Plue's `Review.tsx` writes `id={`${idPrefix}:review-claude`}`. Printing
    // the children it can name would silently drop the one it cannot, and
    // naming that one would put an identifier in the output that is in no
    // source file.
    const parallel = hit("Parallel", [], {
      childConstructs: "Task:left,Task:",
      childPayloads: "{\"left\":{}}"
    })

    expect(Mapping.snippet(parallel)).toBeUndefined()
    expect(Mapping.classify(parallel)).toBe("guided")
  })

  it("drops a group whose child payload the inventory could not resolve", () => {
    const sequence = hit("Sequence", [], {
      childConstructs: "Task:first,Task:second",
      childPayloads: "{\"first\":{},\"second\":null}"
    })

    expect(Mapping.snippet(sequence)).toBeUndefined()
    expect(Mapping.classify(sequence)).toBe("guided")
  })

  it("drops a chain whose step reads a value no longer in scope", () => {
    // `Node.bindPlanned` binds one value. A third step that reads the first step's
    // answer cannot see it, so the rewrite that pretended it could would not
    // compile.
    const sequence = hit("Sequence", [], {
      childConstructs: "Task:first,Task:second,Task:third",
      childPayloads: "{\"first\":{},\"second\":{},\"third\":{\"value\":\"deps.first.value\"}}"
    })

    expect(Mapping.snippet(sequence)).toBeUndefined()
  })

  it("names a step after a reserved word without emitting a reserved binding", () => {
    const text = Mapping.snippet(hit("Sequence", [], {
      childConstructs: "Task:break,Task:after",
      childPayloads: "{\"break\":{},\"after\":{}}"
    })) ?? ""

    expect(text).toContain("(breakValue) =>")
    expect(transpiles(`async function wrap() {\n${text}\n}`)).toBe(true)
  })
})

describe("Mapping invents nothing over the real fixtures", () => {
  // Amendment 1. Each pattern below is a name or a value the tool used to emit
  // that came from the tool rather than from the project.
  const invented: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
    { name: "an invented step name", pattern: /\b(First|Second|Left|Right|Then|Else|Match|Fallback)\.call\b/ },
    { name: "an invented identifier", pattern: /\b(?:const|let)\s+(?:First|Second|Left|Right|Then|Else)\b/ },
    { name: "a placeholder body", pattern: /body:\s*\(payload\)\s*=>\s*Node\.succeed\(payload\)/ },
    { name: "a placeholder schema", pattern: /Schema\.Unknown/ },
    { name: "a placeholder layer", pattern: /toLayer\(\(payload\)\s*=>\s*Effect\.succeed\(payload\)\)/ }
  ]

  for (const name of fixtures) {
    it.effect(`${name} snippets carry only what the source carries`, () =>
      Effect.gen(function*() {
        const { detection, hits } = yield* scan(name)
        const sourceText = [...detection.sources.values()].join("\n")
        const snippets = hits.flatMap((entry) => {
          const text = Mapping.snippet(entry)
          return text === undefined ? [] : [{ entry, text }]
        })

        for (const { entry, text } of snippets) {
          for (const { name: what, pattern } of invented) {
            expect(pattern.test(text), `${entry.construct} at ${entry.file}:${entry.line} emitted ${what}: ${text}`)
              .toBe(false)
          }
          // Amendment 5: no default seat. Every seat literal names a model the
          // project's own source names.
          const seat = /seat:\s*"([^"]+)"/.exec(text)
          if (seat !== null) {
            const model = (seat[1] ?? "").split(":").slice(1).join(":")
            expect(sourceText.includes(model), `${entry.file}:${entry.line} invented the model "${model}"`).toBe(true)
          }
        }
      }))
  }

  it.effect("writes the jsx-single agent step the migrated fixture holds", () =>
    Effect.gen(function*() {
      const { hits } = yield* scan("jsx-single")
      const write = hits.find((entry) => entry.construct === "Task" && entry.detail?.["id"] === "write")
      const text = Mapping.snippet(write!) ?? ""

      expect(text).toContain("payload: {\n    summary: Schema.String,\n    keyPoints: Schema.Array(Schema.String)\n  }")
      expect(text).toContain("seat: \"anthropic:claude-sonnet-5\"")
      expect(text).toContain("system: [\"You are a technical writer. Write clear, engaging content.\"]")
      expect(text).toContain("${payload.summary}")
      expect(text).toContain("${JSON.stringify(payload.keyPoints)}")
    }))
})

// `.smithers/workflows/context-doctor.tsx` from `/Users/williamcory/smithers`
// at `cfb570f193`, cut to the declarations the scanner reads. It is the one
// shape the golden fixture shows: a step whose payload the source threads out
// of the step before it, by field.
const contextDoctor = [
  "/** @jsxImportSource smthrs */",
  "import { createSmithers } from \"smthrs\";",
  "import AdvisePrompt from \"../prompts/context-doctor-advise.mdx\";",
  "const inputSchema = z.object({ contract: z.string() });",
  "const checkSchema = z.object({ issues: z.array(z.string()), summary: z.string(), score: z.number() });",
  "const adviseSchema = z.object({ summary: z.string() });",
  "const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({",
  "  input: inputSchema,",
  "  check: checkSchema,",
  "  advise: adviseSchema",
  "});",
  "export default smithers((ctx) => (",
  "  <Workflow name=\"context-doctor\">",
  "    <Sequence>",
  "      <Task id=\"check\" output={outputs.check}>{() => diagnose(ctx.input.contract)}</Task>",
  "      <Task id=\"advise\" output={outputs.advise} agent={agents.midTier} deps={{ check: outputs.check }}>",
  "        {(deps) => <AdvisePrompt summary={deps.check.summary} score={deps.check.score} issues={deps.check.issues} />}",
  "      </Task>",
  "    </Sequence>",
  "  </Workflow>",
  "));"
].join("\n")

// The one shape the Workflow rewrite covers: a workflow whose own children are
// named steps, over a factory that declares an `input` schema. It matches the
// teaching pair the `auditPairs` table above already uses.
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

const workflowHit = (source: string, headers?: ReadonlyMap<string, string>): Inventory.InventoryEntry => {
  const factories = Inventory.factoryNames(new Map([["greeting.tsx", source]]))
  const options = headers === undefined ? { factories } : { factories, headers }
  const hits = Inventory.scanFile("greeting.tsx", source, options)
  return hits.find((entry) => entry.construct === "Workflow")!
}

describe("Mapping writes a flow module the registry can discover", () => {
  it("emits one default-exported flow, the declaration the registry reads and the engine runs", () => {
    const text = Mapping.snippet(workflowHit(greeting)) ?? ""

    // The flow the engine runs is the module's default export: the tag the
    // `name` prop carries, the payload, the success schema the last step
    // declares, and the body.
    expect(text).toContain("export default Flow.make(\"greeting\", {")
    expect(text).toContain("payload: Schema.Struct({\n    name: Schema.String\n  })")
    expect(text).toContain("success: Schema.Struct({\n    message: Schema.String\n  })")
    expect(text).toContain("body: (payload) => Greet.call({})")
    // The declaration data discovery reads out of the options object without
    // evaluating the module.
    expect(text).toContain("description: \"greeting\"")
    expect(text).toContain("capabilities: []")
    expect(text).toContain("effects: { reads: [], writes: [], mode: \"hermetic\"")
    // One declaration, so there is no second one for the two to drift apart.
    expect(text.match(/Flow\.make\(/g)).toHaveLength(1)
    expect(text).not.toContain("DurableFlow")
    expect(transpilesModule(text), text).toBe(true)
  })

  it("takes the description from the workflow header when the file carries one", () => {
    // 0.x writes `// smithers-display-name:` and `// smithers-description:`
    // into the pack files; Plue's `review.tsx` carries the first.
    const described = Mapping.snippet(workflowHit(greeting, new Map([["description", "Greets one person."]]))) ?? ""
    const displayed = Mapping.snippet(workflowHit(greeting, new Map([["display-name", "Greeting"]]))) ?? ""

    expect(described).toContain("description: \"Greets one person.\"")
    expect(displayed).toContain("description: \"Greeting\"")
  })

  it("declares the agent failure only when a step of the flow is an agent step", () => {
    const compute = Mapping.snippet(workflowHit(greeting)) ?? ""
    const agent = Mapping.snippet(workflowHit(greeting.replace("id=\"greet\"", "id=\"greet\" agent={writer}"))) ?? ""

    expect(compute).not.toContain("error:")
    expect(agent).toContain("error: AgentAction.AgentFailure")
  })

  it("writes nothing when the last step declares no output schema", () => {
    // Without the success schema there is no `output` for the descriptor, and a
    // descriptor whose output the tool guessed is worse than a guided rewrite.
    const unresolved = greeting.replace("output={outputs.result}", "output={computeSchema()}")

    expect(Mapping.snippet(workflowHit(unresolved))).toBeUndefined()
    expect(Mapping.classify(workflowHit(unresolved))).toBe("guided")
  })
})

describe("Mapping threads a sequence the way the golden fixture does", () => {
  it("fills each step's declared payload from the step before it", () => {
    const factories = Inventory.factoryNames(new Map([["context-doctor.tsx", contextDoctor]]))
    const hits = Inventory.scanFile("context-doctor.tsx", contextDoctor, { factories })
    const sequence = hits.find((entry) => entry.construct === "Sequence")

    expect(Mapping.classify(sequence!)).toBe("automatic")
    expect(Mapping.snippet(sequence!)).toBe(
      "Check.call({})" +
        ".pipe(Node.bindPlanned((check) => Advise.call({ issues: check.issues, score: check.score, summary: check.summary })))"
    )
  })
})

describe("every automatic snippet names steps the same source declares", () => {
  for (const name of fixtures) {
    it.effect(`${name} threads only ids and payload keys the source wrote`, () =>
      Effect.gen(function*() {
        const { hits } = yield* scan(name)
        // Every step id the fixture declares, and the payload keys it declares
        // for that id. A group's rewrite may name nothing else.
        // Only the steps whose own payload the scanner resolved: a group may
        // not name a step it could not write an action for.
        const declared = new Map<string, ReadonlyArray<string>>()
        for (const entry of hits) {
          const id = entry.detail?.["id"]
          const fields = entry.detail?.["payloadFields"]
          if (id === undefined || fields === undefined) continue
          declared.set(id, Object.keys(JSON.parse(fields) as Record<string, string>))
        }

        for (const entry of hits) {
          if (Mapping.classify(entry) !== "automatic") continue
          const text = Mapping.snippet(entry)
          if (text === undefined) continue
          expect(transpiles(`async function wrap() {\n${text}\n}`), `${entry.file}:${entry.line}: ${text}`).toBe(true)
          const calls = [...text.matchAll(/\b([A-Z][A-Za-z0-9]*)\.call\(\{([^}]*)\}\)/g)]
          for (const call of calls) {
            const step = call[1] ?? ""
            const match = [...declared.keys()].find((id) =>
              id.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").map((part) =>
                part.charAt(0).toUpperCase() + part.slice(1)
              ).join("") === step
            )
            expect(match, `${entry.file}:${entry.line} named a step "${step}" no source declares`).toBeDefined()
            const keys = (call[2] ?? "").split(",").map((pair) => pair.split(":")[0]?.trim() ?? "").filter((key) =>
              key !== ""
            )
            expect([...keys].sort(), `${entry.file}:${entry.line} payload of ${step}`)
              .toEqual([...(declared.get(match!) ?? [])].sort())
          }
        }
      }))
  }

  it.effect("leaves the Plue Parallel with computed ids a guided decision", () =>
    Effect.gen(function*() {
      const { hits } = yield* scan("plue-pack")
      const parallel = hits.find((entry) =>
        entry.construct === "Parallel" && entry.file.endsWith("components/Review.tsx")
      )

      expect(parallel, "the Review.tsx Parallel").toBeDefined()
      expect(Mapping.classify(parallel!)).toBe("guided")
      expect(Mapping.snippet(parallel!)).toBeUndefined()
    }))
})

describe("Mapping against the feature parity audit", () => {
  for (const pair of auditPairs) {
    it(`turns the ${pair.title} old snippet into the audit's new code`, () => {
      const factories = Inventory.factoryNames(new Map([["pair.tsx", pair.old]]))
      const hits = Inventory.scanFile("pair.tsx", pair.old, { factories })
      const found = hits.filter((entry) => entry.construct === pair.construct)

      expect(found.length, pair.construct).toBeGreaterThan(0)
      if (pair.via === "snippet") {
        expect(found.map((entry) => Mapping.snippet(entry) ?? "").join("\n")).toContain(pair.expects)
      } else {
        // The translation needs a decision, so the tool states the target and
        // classifies the hit guided rather than writing code it cannot derive.
        expect(Mapping.byConstruct(pair.construct)?.target).toContain(pair.expects)
        for (const entry of found) expect(Mapping.classify(entry)).toBe("guided")
      }
    })
  }
})

describe("Mapping over a real fixture", () => {
  it.effect("classifies every plue-pack hit and leaves no construct unmapped", () =>
    Effect.gen(function*() {
      const { hits } = yield* scan("plue-pack")

      for (const entry of hits) {
        expect(Mapping.byConstruct(entry.construct), entry.construct).toBeDefined()
      }
      const ralph = hits.find((entry) => entry.construct === "Loop" && entry.file.endsWith("ralph.tsx"))
      expect(Mapping.classifyWithReason(ralph!).reason).toContain("fuel")
      const ui = hits.find((entry) => entry.construct === "UI")
      expect(Mapping.classify(ui!)).toBe("unsafe")
    }))
})
