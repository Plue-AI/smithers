/**
 * The CI-workflow parser and the gate contract that keeps the generated
 * pipeline from quietly dropping a repository's required gates.
 */
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import {
  independentGateCondition,
  isSupportedInstall,
  maximumWorkflowBytes,
  missingGates,
  missingRequiredJobs,
  parseWorkflow as parseStrictWorkflow,
  performsInstall,
  stripShellComments,
  supportedInstallCommands,
  WorkflowParseError,
  workspaceExec
} from "../src/GithubWorkflow.ts"

/**
 * The Smithers repository's own pipeline, read from disk. It is the workload
 * this reader exists for: jobs, block scalars, `continue-on-error`
 * advisory lanes, `with:` maps, `env:` maps, and heavy comment traffic.
 */
const realWorkflowPath = NodePath.resolve(
  import.meta.dirname,
  // Five levels up: this package nests two deep under `packages/smithers`.
  "../../../../../.github/workflows/ci.yml"
)

/**
 * The real pipeline, or a failure naming the path.
 *
 * It used to swallow the read error and return `undefined`, and every test
 * below opened with `if (source === undefined) return`. The path was one `..`
 * short of the repository root, so it resolved to `packages/.github/workflows/
 * ci.yml`, which has never existed: three tests that claim to hold the
 * repository's own pipeline to its required jobs passed by reading nothing.
 * A missing workflow is now the failure it always was.
 */
const readReal = async (): Promise<string> =>
  Fs.readFile(realWorkflowPath, "utf8").catch((cause: unknown) => {
    throw new Error(`the repository pipeline is missing at ${realWorkflowPath}`, { cause })
  })

/** Most focused fixtures omit trigger prose; supply the smallest real trigger. */
const parseWorkflow = (source: string): ReturnType<typeof parseStrictWorkflow> =>
  parseStrictWorkflow(/^on\s*:/m.test(source) ? source : `on: workflow_dispatch\n${source}`)

describe("parseWorkflow", () => {
  it("refuses a document that is not a runnable workflow", () => {
    const job = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
    expect(() => parseStrictWorkflow(job)).toThrow(/missing the required top-level `on`/)
    expect(() => parseStrictWorkflow("on: push\n")).toThrow(/missing the required top-level `jobs`/)
    expect(() => parseStrictWorkflow("on: {}\njobs:\n")).toThrow(/declares no trigger/)
    expect(() => parseStrictWorkflow("on: push\njobs:\n")).toThrow(/declares no jobs/)
    expect(() => parseStrictWorkflow("on: push\njobs: not-a-mapping\n")).toThrow(/inline `jobs` mappings/)
    // A more-indented plain line under `on:` is that key's scalar value, so
    // it is refused as an event name rather than as a stray structural line.
    expect(() => parseStrictWorkflow("on:\n  not-a-mapping\njobs:\n"))
      .toThrow(/"not-a-mapping" is not a supported workflow event name shape/)
  })

  /**
   * A trigger block whose lines do not line up is the defect this parser has
   * to name rather than guess at: YAML would read the outdented key as a
   * sibling of `on`, so a workflow that looks like it runs on two events runs
   * on one and silently gains a top-level key nothing checks.
   */
  it("refuses a trigger block whose events do not share one indentation", () => {
    const job = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
    expect(() => parseStrictWorkflow(`on:\n    push:\n  pull_request:\n${job}`))
      .toThrow(/line 2: invalid YAML: All mapping items must start at the same column/)
    // The same events at one indentation are the accepted form.
    expect(parseStrictWorkflow(`on:\n  push:\n  pull_request:\n${job}`).jobs).toHaveLength(1)
  })

  it("accepts scalar, sequence, and block-mapping trigger forms", () => {
    const job = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
    for (const trigger of ["on: push", "on: [push, pull_request]", "on:\n  push:\n  workflow_dispatch:"]) {
      expect(parseStrictWorkflow(`${trigger}\n${job}`).jobs).toHaveLength(1)
    }
  })

  it("refuses jobs and steps GitHub cannot execute", () => {
    expect(() => parseWorkflow("jobs: {}\n"))
      .toThrow(/workflow declares no jobs/)
    expect(() => parseWorkflow("jobs:\n  test:\n    steps:\n      - run: pnpm run check\n"))
      .toThrow(/declares no runner/)
    expect(() => parseWorkflow("jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n"))
      .toThrow(/declares no steps/)
    expect(() => parseWorkflow("jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: {}\n"))
      .toThrow(/`steps` must be a block sequence/)
    expect(() => parseWorkflow("jobs:\n  test: inline\n"))
      .toThrow(/must be a block mapping/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: inert\n"
      )
    ).toThrow(/exactly one of `uses` or `run`/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        run: echo shadow\n"
      )
    ).toThrow(/exactly one of `uses` or `run`/)
  })

  it.each([
    ["- run: ''", "empty run value"],
    ["- uses: ''", "empty uses value"],
    ["- run: echo ready\n        shell: ''", "empty shell"]
  ])("refuses a step with %s", (step, reason) => {
    expect(() =>
      parseWorkflow(
        `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      ${step}\n`
      )
    ).toThrow(reason)
  })

  it("refuses a reusable job with no target or with a runner", () => {
    expect(() => parseWorkflow("jobs:\n  test:\n    uses: ''\n")).toThrow(/reusable job "test" has an empty uses value/)
    expect(() =>
      parseWorkflow("jobs:\n  test:\n    uses: org/repo/.github/workflows/test.yml@main\n    runs-on: ubuntu-latest\n")
    )
      .toThrow(/reusable job "test" cannot also declare runs-on or steps/)
    expect(() => parseWorkflow("jobs:\n  test:\n    uses: org/repo/.github/workflows/test.yml@main\n    steps:\n"))
      .toThrow(/reusable job "test" cannot also declare runs-on or steps/)
  })

  /**
   * A step's fields are a mapping. A `-` at that same indent starts a second
   * sequence item in YAML, so the fields that follow belong to no step: the
   * reader stops folding fields into the current step and refuses the line
   * rather than silently attributing it, which is how a gate could be read as
   * present while GitHub runs a different step.
   */
  it("refuses a sequence item where a step's own fields belong", () => {
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        - one\n"
      )
    ).toThrow(/line 7: invalid YAML: A block sequence may not be used as an implicit map key/)
    // A sequence nested *below* the field indent is a field's own value and is
    // skipped with the rest of that field's block.
    expect(
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n" +
          "        with:\n          args:\n            - one\n      - run: echo\n"
      ).jobs[0]?.steps
    ).toEqual([{ uses: "actions/checkout@v4" }, { run: "echo" }])
  })

  it("refuses sequence items and invalid identifiers where mappings are required", () => {
    expect(() => parseWorkflow("jobs: []\n"))
      .toThrow(/expected a job mapping entry, not a sequence item/)
    expect(() => parseWorkflow("jobs:\n  - test:\n      runs-on: ubuntu-latest\n"))
      .toThrow(/expected a job mapping entry, not a sequence item/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  bad.id:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
      )
    ).toThrow(/not a valid GitHub Actions job id/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    - runs-on: ubuntu-latest\n"
      )
    ).toThrow(/expected a mapping entry in job "test", not a sequence item/)
    expect(() => parseWorkflow("jobs:\n  test: []\n"))
      .toThrow(/expected a mapping entry in job "test", not a sequence item/)
  })

  it("refuses a structured YAML key rather than treating it as an executable job", () => {
    expect(() =>
      parseWorkflow(
        "jobs:\n  ? [test]\n  :\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
      )
    ).toThrow(/mapping key that is not a scalar is not supported by the gate scanner/)
  })

  it("skips deeper unknown step metadata without losing the executable field", () => {
    const workflow = parseWorkflow(
      "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ready\n        with:\n          nested: ignored\n"
    )

    expect(workflow.jobs[0]?.steps[0]?.run).toBe("echo ready")
    // The same metadata indented past its own key is not a nested block, it is
    // a broken document. The hand-written scanner skipped it and kept reading;
    // YAML refuses it, which is the safer answer for a gate contract.
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ready\n          nested: ignored\n"
      )
    ).toThrow(/line 6: invalid YAML: Nested mappings are not allowed in compact mappings/)
  })

  it("accepts an unconditional reusable-workflow job as executable", () => {
    const workflow = parseWorkflow("jobs:\n  delegated:\n    uses: owner/repo/.github/workflows/ci.yml@main\n")
    expect(workflow.jobs[0]).toMatchObject({
      id: "delegated",
      uses: "owner/repo/.github/workflows/ci.yml@main",
      runsOn: undefined,
      steps: []
    })
    expect(missingRequiredJobs(workflow, ["delegated"])).toEqual([])
  })

  it("refuses ambiguous block scalar indentation and reads an explicit indentation indicator", () => {
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo safe\n         pnpm run check\n"
      )
    ).toThrow(/line 8: invalid YAML: All mapping items must start at the same column/)
    // `|2` sets the block's indentation explicitly. The hand-written scanner
    // did not implement it and refused every workflow that used it; the YAML
    // parser reads it, so the gate in that script is now visible.
    const explicit = parseWorkflow(
      "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |2\n          pnpm run check\n"
    )
    expect(explicit.jobs[0]!.steps[0]!.run).toBe("pnpm run check")
    expect(missingGates(explicit, [{ name: "typecheck", command: "pnpm run check" }])).toEqual([])
  })

  it("does not reinterpret scalar-looking shell text as nested YAML", () => {
    const workflow = parseWorkflow(
      "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo safe\n          example: |2\n"
    )
    expect(workflow.jobs[0]!.steps[0]!.run).toContain("example: |2")
  })

  it("refuses YAML merges and inherited shell defaults it cannot verify", () => {
    expect(() =>
      parseWorkflow(
        "defaults:\n  run:\n    shell: python\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
      )
    ).toThrow(/top-level "defaults" is not supported/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    <<: '*conditional'\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
      )
    ).toThrow(/"<<" in job/)
    expect(() =>
      parseWorkflow(
        "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - <<: '*conditional'\n        run: pnpm run check\n"
      )
    ).toThrow(/YAML merge in a step/)
  })

  it("bounds direct parser input as well as filesystem reads", () => {
    expect(() => parseStrictWorkflow(`on: push\n#${"x".repeat(maximumWorkflowBytes)}\njobs:\n`))
      .toThrow(/larger than/)
  })

  it("reads jobs, names, runners, and step commands", () => {
    const workflow = parseWorkflow(
      [
        "name: CI",
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  test:",
        "    name: check + test",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 26.4.0",
        "      - name: Typecheck",
        "        run: pnpm run check",
        ""
      ].join("\n")
    )
    expect(workflow.name).toBe("CI")
    expect(workflow.jobs).toHaveLength(1)
    expect(workflow.jobs[0]!.id).toBe("test")
    expect(workflow.jobs[0]!.name).toBe("check + test")
    expect(workflow.jobs[0]!.runsOn).toBe("ubuntu-latest")
    expect(workflow.jobs[0]!.steps.map((step) => step.uses ?? step.run)).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "pnpm run check"
    ])
  })

  it("reads a block scalar as the step's whole script", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  pack:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Pack",
        "        env:",
        "          PACK_DIR: /tmp/packs",
        "        run: |",
        "          node scripts/pack-release.mjs \"$PACK_DIR\"",
        "",
        "          node scripts/smoke-release.mjs \"$PACK_DIR\"",
        ""
      ].join("\n")
    )
    const run = workflow.jobs[0]!.steps[0]!.run
    expect(run).toContain("node scripts/pack-release.mjs")
    expect(run).toContain("node scripts/smoke-release.mjs")
    // Indentation comes off the first content line, so the script is not
    // silently shifted by the depth its step happens to sit at.
    expect(run!.split("\n")[0]).toBe("node scripts/pack-release.mjs \"$PACK_DIR\"")
  })

  it("does not invent command boundaries while reading a folded block scalar", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: >",
        "          echo harmless",
        "          pnpm run check",
        "      - run: >",
        "          pnpm run lint",
        "          --silent",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]!.steps[0]!.run).toBe("echo harmless pnpm run check")
    expect(missingGates(workflow, [{ name: "typecheck", command: "pnpm run check" }]).map((gate) => gate.name))
      .toEqual(["typecheck"])
    expect(missingGates(workflow, [{ name: "lint", command: "pnpm run lint" }])).toEqual([])
  })

  it("decodes quoted YAML before scanning its shell command boundaries", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: \"echo \\u0022; pnpm run check\\u0022\"",
        "      - run: 'echo ''; pnpm run lint'''",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]!.steps.map((step) => step.run)).toEqual([
      "echo \"; pnpm run check\"",
      "echo '; pnpm run lint'"
    ])
    expect(
      missingGates(workflow, [
        { name: "typecheck", command: "pnpm run check" },
        { name: "lint", command: "pnpm run lint" }
      ]).map((gate) => gate.name)
    ).toEqual(["typecheck", "lint"])
    // `\\x22` is a YAML escape with no JSON spelling. The hand-written decoder
    // refused it; the YAML parser decodes it to the same double quote `\\u0022`
    // gives, so the gate hidden behind it is scanned rather than skipped.
    const hex = parseWorkflow(
      "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: \"echo \\x22; pnpm run check\\x22\"\n"
    )
    expect(hex.jobs[0]!.steps[0]!.run).toBe("echo \"; pnpm run check\"")
    expect(missingGates(hex, [{ name: "typecheck", command: "pnpm run check" }]).map((gate) => gate.name))
      .toEqual(["typecheck"])
  })

  it("keeps a `#` that is not a comment and drops one that is", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      # a whole-line comment",
        "      - run: echo \"a#b\" # trailing comment",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]!.steps[0]!.run).toBe("echo \"a#b\"")
  })

  it("reads a block sequence written at its key's own indentation", () => {
    // YAML allows a sequence to sit at the indentation of the key that owns
    // it, which is how `needs:` and `steps:` are most often written. Reading
    // it by indentation alone left `steps` empty (every gate in the job then
    // reported missing) and refused a `needs:` list outright.
    const workflow = parseWorkflow(
      [
        "name: CI",
        "on:",
        "  push:",
        "    branches:",
        "    - main",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "    - uses: actions/checkout@v4",
        "    - name: Typecheck",
        "      run: pnpm run check",
        "  gate:",
        "    runs-on: ubuntu-latest",
        "    needs:",
        "    - build",
        "    steps:",
        "    - run: cargo test --locked",
        ""
      ].join("\n")
    )
    expect(workflow.name).toBe("CI")
    expect(workflow.jobs.map((job) => job.id)).toEqual(["build", "gate"])
    expect(workflow.jobs[0]!.steps.map((step) => step.uses ?? step.run)).toEqual([
      "actions/checkout@v4",
      "pnpm run check"
    ])
    expect(workflow.jobs[1]!.steps.map((step) => step.run)).toEqual(["cargo test --locked"])
    expect(missingGates(workflow, [
      { name: "typecheck", command: "pnpm run check", job: "build" },
      { name: "rust", command: "cargo test --locked", job: "gate" }
    ])).toEqual([])
  })

  it("refuses tab indentation instead of guessing at the structure", () => {
    expect(() => parseWorkflow("jobs:\n\ta:\n")).toThrow(WorkflowParseError)
  })

  it("refuses duplicate job ids instead of reporting a job GitHub will not run", () => {
    // YAML keeps the last duplicate key, so the first `a` never runs. A gate
    // pinned to `a` would otherwise match the shadowed steps.
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo skipped",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate job id "a"/)
  })

  it("refuses a duplicate top-level key, which shadows a whole jobs mapping", () => {
    // The second `jobs:` is the one GitHub runs, so a gate matched against
    // `a` would report present while nothing ran it.
    expect(() =>
      parseWorkflow(
        [
          "name: CI",
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "jobs:",
          "  b:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate top-level key "jobs"/)
  })

  it("refuses a duplicate key inside one job", () => {
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "    steps:",
          "      - run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate key "steps" in job "a"/)
  })

  it("refuses a duplicate key inside one step", () => {
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: s",
          "        run: pnpm run check",
          "        run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate key "run" in a step of job "a"/)
  })

  /**
   * `"test":` and `test:` are the same YAML key. Reading the quoted spelling
   * literally invented a job id nothing could match, so a gate and a required
   * job pinned to `test` both reported missing against a workflow that runs
   * them — and the duplicate-key check no longer saw the two spellings as one
   * key. Quoting is also how the renderer keeps an id such as `no` a string.
   */
  it("reads a quoted job id and a quoted step key as the key they are", () => {
    const quoted = parseWorkflow(
      [
        "jobs:",
        "  \"no\":",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - \"name\": Typecheck",
        "        \"run\": pnpm run check",
        ""
      ].join("\n")
    )
    expect(quoted.jobs.map((job) => job.id)).toEqual(["no"])
    expect(quoted.jobs[0]!.steps[0]!.name).toBe("Typecheck")
    expect(missingGates(quoted, [{ name: "typecheck", command: "pnpm run check", job: "no" }])).toEqual([])
    expect(missingRequiredJobs(quoted, ["no"])).toEqual([])
  })

  it("refuses a job id repeated in its other spelling", () => {
    expect(() =>
      parseWorkflow(
        [
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm run check",
          "  \"test\":",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo only-this-runs",
          ""
        ].join("\n")
      )
    ).toThrow(/duplicate job id "test"/)
  })

  it("refuses a line that is not a mapping entry", () => {
    expect(() => parseWorkflow("jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - bare\n"))
      .toThrow(WorkflowParseError)
  })

  it("refuses quoted scalars and keys it cannot close", () => {
    const job = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
    expect(() => parseStrictWorkflow(`name: \"unterminated\n${job}`))
      .toThrow(/invalid YAML: Missing closing "quote/)
    expect(() => parseStrictWorkflow(`name: 'can'not'\n${job}`))
      .toThrow(/line 1: invalid YAML: Unexpected scalar at node end/)
    expect(() =>
      parseStrictWorkflow(
        "on: push\njobs:\n  \"test:\n    runs-on: ubuntu-latest\n"
      )
    ).toThrow(/line 5: invalid YAML: Missing closing "quote/)

    const escaped = parseStrictWorkflow(
      "on: push\njobs:\n  \"te\\u0073t\":\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
    )
    expect(escaped.jobs.map((entry) => entry.id)).toEqual(["test"])
    expect(() =>
      parseStrictWorkflow(
        "on: push\njobs:\n  'te''st':\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
      )
    ).toThrow(/"te'st" is not a valid GitHub Actions job id/)
  })

  it("refuses ambiguous or empty workflow trigger forms", () => {
    const jobs = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
    const cases: ReadonlyArray<readonly [string, RegExp]> = [
      [` on: push\n${jobs}`, /line 2: invalid YAML: Unexpected scalar at node end/],
      [`- on: push\n${jobs}`, /line 2: invalid YAML: Unexpected scalar at node end/],
      [`on: push-event\n${jobs}`, /not a supported workflow event name shape/],
      [`on: push\n  pull_request:\n${jobs}`, /invalid YAML: Nested mappings are not allowed in compact mappings/],
      [`on:\n  push:\n  push:\n${jobs}`, /duplicate workflow event "push"/],
      [`on: [push\n${jobs}`, /invalid YAML: Flow sequence in block collection must be sufficiently indented/],
      [`on: [push, push]\n${jobs}`, /contains a duplicate event/],
      [`on: {}\n${jobs}`, /declares no trigger/],
      [`on: []\n${jobs}`, /declares no trigger/],
      [`on:\n${jobs}`, /declares no trigger/]
    ]
    for (const [source, message] of cases) expect(() => parseStrictWorkflow(source)).toThrow(message)
  })

  /**
   * Three trigger spellings the hand-written scanner refused because it did
   * not implement them, not because GitHub rejects them: a flow mapping, a
   * trailing comma in a flow sequence, and an event whose value is a block
   * sequence. Each is ordinary YAML, so each is now read as the trigger it is.
   */
  it("reads flow and block trigger spellings the hand scanner could not", () => {
    const jobs = "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run check\n"
    for (
      const trigger of [
        "on: {push: {}}",
        "on: [push, ]",
        "on:\n  push:\n  - pull_request"
      ]
    ) {
      const workflow = parseStrictWorkflow(`${trigger}\n${jobs}`)
      expect(workflow.jobs.map((job) => job.id)).toEqual(["test"])
      expect(missingGates(workflow, [{ name: "typecheck", command: "pnpm run check" }])).toEqual([])
    }
  })

  /**
   * An alias resolves to a node written somewhere else, so a gate could match
   * a script the job it is pinned to never spells out. The reader refuses one
   * rather than following it.
   */
  it("refuses a YAML alias, which would lend a gate a script from another node", () => {
    expect(() =>
      parseStrictWorkflow(
        "on: push\njobs:\n  a:\n    runs-on: &runner ubuntu-latest\n    steps:\n      - run: pnpm run check\n" +
          "  b:\n    runs-on: *runner\n    steps:\n      - run: echo b\n"
      )
    ).toThrow(/line 8: a YAML alias is not supported by the gate scanner/)
  })

  it("carries an empty block condition and a step advisory value without losing later fields", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    if:",
        "      expression: ignored",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm test",
        "        continue-on-error: true",
        ""
      ].join("\n")
    )
    expect(workflow.jobs[0]).toMatchObject({ condition: "", runsOn: "ubuntu-latest" })
    expect(workflow.jobs[0]?.steps[0]).toMatchObject({ run: "pnpm test", continueOnError: "true" })
    expect(missingRequiredJobs(workflow, ["test"])).toEqual(["test (conditional)"])
  })

  it("parses the Smithers repository's own pipeline", async () => {
    const source = await readReal()
    const workflow = parseWorkflow(source)
    expect(workflow.name).toBe("CI")
    expect(workflow.jobs.map((job) => job.id)).toEqual([
      "cache-publish",
      "test",
      "scripts",
      "docs",
      "apps-e2e",
      "rust",
      "rust-ffi",
      "wasm-repro",
      "e2e-faults",
      "browser",
      "packages",
      "go-backend",
      // Advisory, and not in `requiredJobs`: it runs the model reviews, which
      // need a full-history checkout and a model CLI the runner does not ship.
      "review-lints"
    ])
    // The platform matrix parses as ONE job whose runner is the matrix
    // expression, not as three copy-pasted jobs.
    const matrix = workflow.jobs.find((job) => job.id === "packages")!
    expect(matrix.runsOn).toBe("${{ matrix.os }}")
    expect(matrix.continueOnError).toBe("${{ matrix.advisory }}")
    // Every job has at least a checkout, so no job parsed as empty.
    for (const job of workflow.jobs) expect(job.steps.length).toBeGreaterThan(0)
  })

  /**
   * The real contract, and the proof that it is not vacuously green: the same
   * file with one required job made conditional IN MEMORY is reported broken.
   * Nothing is written.
   */
  it("holds the flows pipeline's required jobs to running unconditionally", async () => {
    const source = await readReal()
    const required = ["test", "scripts", "docs", "apps-e2e", "rust", "wasm-repro", "browser", "packages"]
    expect(missingRequiredJobs(parseWorkflow(source), required)).toEqual([])
    const skipped = source.replace(/^ {2}"browser":$/m, "  \"browser\":\n    if: false")
    expect(skipped).not.toBe(source)
    expect(missingRequiredJobs(parseWorkflow(skipped), required)).toEqual(["browser (conditional)"])
    // The gate pinned to that job goes with it.
    expect(
      missingGates(parseWorkflow(skipped), [
        {
          name: "browser contract",
          command: "pnpm exec smithers-build test '//scripts:browserContract'",
          job: "browser"
        }
      ]).map((gate) => gate.name)
    ).toEqual(["browser contract"])
  })

  /**
   * A gate contract proves a COMMAND STRING is still in the pipeline. It
   * cannot prove the command still exists, so a renamed script leaves a green
   * contract in front of a red pipeline. This closes that gap for the real
   * repository: every `pnpm run <script>` a step invokes must be a script in
   * the root manifest, and every `node <file>` must be a file on disk.
   *
   * The generated pipeline invokes NEITHER. `GithubCiGen` renders a target
   * invocation, an install, or a declared toolchain command and nothing else,
   * so both sets are empty and the gap this test guards is closed by
   * construction. The emptiness is asserted rather than assumed: a run line
   * that names a script or a file again is a step that left the target graph,
   * and the existence checks below engage the moment one appears.
   */
  it("runs only scripts and files the Smithers repository actually has", async () => {
    const source = await readReal()
    const manifest = JSON.parse(
      await Fs.readFile(NodePath.resolve(realWorkflowPath, "../../../package.json"), "utf8")
    ) as { readonly scripts?: Readonly<Record<string, string>> }
    const scripts = new Set(Object.keys(manifest.scripts ?? {}))
    const commands = parseWorkflow(source).jobs
      .flatMap((job) => job.steps)
      .flatMap((step) => step.run === undefined ? [] : [step.run])
      .join("\n")

    // `pnpm --recursive run build` runs a PACKAGE script, so it is satisfied
    // by any workspace member; a bare `pnpm run check` needs the root one.
    const workspaceScripts = new Set<string>()
    const root = NodePath.resolve(realWorkflowPath, "../../..")
    for (const entry of await Fs.readdir(NodePath.join(root, "packages"))) {
      const manifestPath = NodePath.join(root, "packages", entry, "package.json")
      const text = await Fs.readFile(manifestPath, "utf8").catch(() => undefined)
      if (text === undefined) continue
      const parsed = JSON.parse(text) as { readonly scripts?: Readonly<Record<string, string>> }
      for (const script of Object.keys(parsed.scripts ?? {})) workspaceScripts.add(script)
    }

    const invocations = [
      ...commands.matchAll(/\bpnpm ([^\n]*?)run ([\w:-]+)/g),
      ...commands.matchAll(/\bpnpm (--recursive |)(test)\b/g)
    ].map((match) => ({ recursive: /(^|\s)(-r|--recursive|--filter)(\s|=|$)/.test(match[1]!), script: match[2]! }))
    expect(
      invocations
        .filter(({ recursive, script }) => !(recursive ? workspaceScripts : scripts).has(script))
        .map(({ script }) => script)
    ).toEqual([])
    // The generated pipeline runs no pnpm script at all, and the root manifest
    // still has the scripts this check would resolve against, so an empty set
    // here is the pipeline's shape rather than a manifest that failed to load.
    expect(invocations).toEqual([])
    expect(scripts.size).toBeGreaterThan(0)
    expect(workspaceScripts.size).toBeGreaterThan(0)

    const invokedFiles = [...commands.matchAll(/\bnode (?:--test )?([\w./-]+\.(?:mjs|js|cjs))/g)]
      .map((match) => match[1]!)
    expect(invokedFiles).toEqual([])
    // The run lines the pipeline DOES carry, so the two empty sets above are
    // read against a workflow that was parsed, not an empty string.
    expect(commands).toContain("pnpm exec smthrs test '//packages/...'")
    const missing: Array<string> = []
    for (const file of [...new Set(invokedFiles)]) {
      const absolute = NodePath.resolve(realWorkflowPath, "../../..", file)
      const present = await Fs.stat(absolute).then(() => true, () => false)
      if (!present) missing.push(file)
    }
    expect(missing).toEqual([])
  })
})

describe("missingGates", () => {
  const workflow = parseWorkflow(
    [
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm run check",
      "      - run: pnpm run lint",
      "  rust:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: cargo test --locked",
      ""
    ].join("\n")
  )

  it("reports nothing when every gate is present", () => {
    expect(missingGates(workflow, [
      { name: "typecheck", command: "pnpm run check" },
      { name: "rust test", command: "cargo test --locked", job: "rust" }
    ])).toEqual([])
  })

  it("reports a gate that no step runs", () => {
    expect(
      missingGates(workflow, [{ name: "circular", command: "pnpm run circular" }])
        .map((gate) => gate.name)
    ).toEqual(["circular"])
  })

  it("reports a gate whose only occurrence is commented out", () => {
    // The step still exists and the text is still in the file, but nothing
    // runs the command, so the contract must fail rather than pass on prose.
    const commented = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          # pnpm run circular is disabled while the graph is fixed",
        "          echo skipped",
        ""
      ].join("\n")
    )
    expect(commented.jobs[0]!.steps[0]!.run).toContain("# pnpm run circular")
    expect(
      missingGates(commented, [{ name: "circular", command: "pnpm run circular" }]).map((gate) => gate.name)
    ).toEqual(["circular"])
  })

  it("keeps matching a real command in a multiline script that also has comments", () => {
    const script = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          # the guard below is required",
        "          pnpm run circular",
        "          echo \"done # not a comment\"",
        ""
      ].join("\n")
    )
    expect(missingGates(script, [{ name: "circular", command: "pnpm run circular" }])).toEqual([])
    // A `#` inside a quoted word is not a comment, so the echo argument
    // survives the comment strip — but it is DATA, not a command, so it does
    // not satisfy a gate. Only the `echo` that runs it would.
    expect(script.jobs[0]!.steps[0]!.run).toContain("done # not a comment")
    expect(missingGates(script, [{ name: "echo", command: "done # not a comment" }]).map((gate) => gate.name))
      .toEqual(["echo"])
    expect(missingGates(script, [{ name: "echo", command: "echo" }])).toEqual([])
  })

  it("still matches a `uses` gate, which has no shell comments to strip", () => {
    const actions = parseWorkflow(
      ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", ""]
        .join("\n")
    )
    expect(missingGates(actions, [{ name: "checkout", command: "actions/checkout@v4" }])).toEqual([])
  })

  it("does not count command text assigned to a non-shell or dynamic shell", () => {
    const workflow = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm run check",
        "        shell: python",
        "      - run: pnpm run lint",
        "        shell: ${{ matrix.shell }}",
        "      - run: pnpm run circular",
        "        shell: bash",
        ""
      ].join("\n")
    )
    expect(
      missingGates(workflow, [
        { name: "typecheck", command: "pnpm run check" },
        { name: "lint", command: "pnpm run lint" },
        { name: "circular", command: "pnpm run circular" }
      ]).map((gate) => gate.name)
    ).toEqual(["typecheck", "lint"])
  })

  it("reports a gate that runs in the wrong job", () => {
    // `pnpm run check` exists, but not in the `rust` job, which is what a
    // platform-pinned gate (macOS, Windows, Bun) has to assert.
    expect(
      missingGates(workflow, [{ name: "typecheck on rust", command: "pnpm run check", job: "rust" }])
        .map((gate) => gate.name)
    ).toEqual(["typecheck on rust"])
  })

  /**
   * A gate proves a command RUNS. Substring matching proved only that the text
   * was somewhere in a script, so every script below satisfied a
   * `pnpm run check` gate while running no typecheck at all.
   */
  it("refuses text that is not a command the shell would run", () => {
    const gate = [{ name: "typecheck", command: "pnpm run check" }]
    const scripts = [
      // The command is an ARGUMENT, so the shell prints it and runs nothing.
      "echo pnpm run check",
      "printf '%s\\n' \"pnpm run check\"",
      // Quoted data, including data that carries its own separators.
      "echo \"first; pnpm run check\"",
      "echo 'pnpm run check && pnpm run lint'",
      // A longer command name that merely starts with the gate.
      "pnpm run checkall",
      // A longer command name that merely ends with it.
      "xpnpm run check",
      // The gate as the tail of a flag value.
      "pnpm run build --script=pnpm run check",
      // A here-doc body is data, not commands.
      "cat <<'EOF'\npnpm run check\nEOF",
      // A function declaration defers its body; declaring it runs nothing.
      "check() { pnpm run check; }",
      "function check { pnpm run check; }",
      "check() { echo deferred; }pnpm run check",
      // An escaped separator is an argument, so it opens no second command.
      "echo \\; pnpm run check",
      "echo a\\;pnpm run check"
    ]
    for (const script of scripts) {
      const parsed = parseWorkflow(
        ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |"]
          .concat(script.split("\n").map((line) => `          ${line}`))
          .concat("")
          .join("\n")
      )
      expect(parsed.jobs[0]!.steps[0]!.run).toContain("pnpm run check")
      expect({ script, missing: missingGates(parsed, gate).map((entry) => entry.name) })
        .toEqual({ script, missing: ["typecheck"] })
    }
  })

  it("matches a real command wherever the shell would start one", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // The plain case, and the same command carrying extra flags.
      ["pnpm run check", "pnpm run check"],
      ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --frozen-lockfile"],
      // After `if`, after `!`, and with a trailing `;` — the shape the flows
      // pipeline's wasm byte-comparison uses.
      ["if ! cmp \"$A\" b; then\n  exit 1\nfi", "cmp"],
      // After `&&`, inside a subshell, inside a loop body.
      ["for pkg in a b; do\n  (cd \"packages/$pkg\" && bun x.mjs run --coverage.enabled=false)\ndone", "bun x.mjs run"],
      // After `;`, after `|`, and on a later line of a multiline script.
      ["true; pnpm run lint", "pnpm run lint"],
      ["check() { echo deferred; }\npnpm run check", "pnpm run check"],
      ["cat log | pnpm run lint", "pnpm run lint"],
      [
        "find . -name dist -exec rm -rf {} +\npnpm --recursive --if-present run build",
        "pnpm --recursive --if-present run build"
      ],
      // A `NAME=value` prefix still leaves a command behind it.
      ["CI=1 pnpm test", "pnpm test"],
      // A redirection ends the command word.
      ["pnpm run check >log 2>&1", "pnpm run check"]
    ]
    for (const [script, command] of cases) {
      const parsed = parseWorkflow(
        ["jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |"]
          .concat(script.split("\n").map((line) => `          ${line}`))
          .concat("")
          .join("\n")
      )
      expect({ script, missing: missingGates(parsed, [{ name: command, command }]).map((gate) => gate.name) })
        .toEqual({ script, missing: [] })
    }
  })

  it("refuses a `uses` value that merely contains the action a gate names", () => {
    const actions = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: evil-org/actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        ""
      ].join("\n")
    )
    // A different action whose name ends with the gate's is not the gate's.
    expect(missingGates(actions, [{ name: "checkout", command: "actions/checkout@v4" }]).map((gate) => gate.name))
      .toEqual(["checkout"])
    // Nor is a prefix of a pinned reference.
    expect(missingGates(actions, [{ name: "node", command: "actions/setup-node@v" }]).map((gate) => gate.name))
      .toEqual(["node"])
    // An unversioned gate matches the same action at any version.
    expect(missingGates(actions, [{ name: "node", command: "actions/setup-node" }])).toEqual([])
  })

  /**
   * A conditional job or step is one GitHub may skip. Reading `if:` at all is
   * new: the scanner used to drop it, so `if: false` satisfied a required job
   * and a required gate while the pipeline ran neither.
   */
  it("refuses a conditional job or step as proof of an unconditional gate", () => {
    const conditional = parseWorkflow(
      [
        "jobs:",
        "  skipped:",
        "    runs-on: ubuntu-latest",
        "    if: false",
        "    steps:",
        "      - run: pnpm run check",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Lint",
        "        if: ${{ github.event_name == 'push' }}",
        "        run: pnpm run lint",
        "      - name: Circular",
        "        if: true",
        "        run: pnpm run circular",
        ""
      ].join("\n")
    )
    expect(conditional.jobs[0]!.condition).toBe("false")
    expect(conditional.jobs[1]!.steps[0]!.condition).toBe("${{ github.event_name == 'push' }}")
    expect(
      missingGates(conditional, [
        { name: "typecheck", command: "pnpm run check" },
        { name: "lint", command: "pnpm run lint", job: "test" }
      ]).map((gate) => gate.name)
    ).toEqual(["typecheck", "lint"])
    // The one narrowly provable literal still counts.
    expect(missingGates(conditional, [{ name: "circular", command: "pnpm run circular", job: "test" }])).toEqual([])
  })

  /**
   * `!cancelled() && steps.setup.conclusion == 'success'` runs a gate whenever
   * the implicit `success()` would, and also after an earlier gate went red,
   * provided `setup` is an earlier unconditional step. Generated CI puts it on
   * every gate of a multi-gate job (#2071). `!cancelled()` alone also runs
   * after a failed install, so it proves nothing.
   */
  it("accepts a setup-gated step as proof of an unconditional gate only after the setup step", () => {
    const gated = (setup: ReadonlyArray<string>, condition: string): ReturnType<typeof parseWorkflow> =>
      parseWorkflow(
        [
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          ...setup,
          `      - if: ${condition}`,
          "        run: pnpm run check",
          ""
        ].join("\n")
      )
    const setup = ["      - id: setup", "        run: pnpm install"]
    const condition = "${{ !cancelled() && steps.setup.conclusion == 'success' }}"
    const typecheck = [{ name: "typecheck", command: "pnpm run check" }]
    expect(gated(setup, condition).jobs[0]!.steps[0]!.id).toBe("setup")
    expect(missingGates(gated(setup, condition), typecheck)).toEqual([])
    expect(missingGates(gated(setup, `"${independentGateCondition}"`), typecheck)).toEqual([])
    const refused = [
      gated([], condition),
      gated(["      - id: setup", "        if: false", "        run: pnpm install"], condition),
      gated(setup, "${{ !cancelled() }}"),
      gated(setup, "${{ !cancelled() && steps.setup.conclusion == 'success' && false }}")
    ]
    for (const workflow of refused) {
      expect(missingGates(workflow, typecheck).map((gate) => gate.name)).toEqual(["typecheck"])
    }
  })

  /**
   * A backslash-newline is a line continuation: the shell joins the two lines
   * and reads the words after `&& \` as a command. Treating it as an ordinary
   * escape cancelled the pending command position, so this ordinary
   * multiline-script shape reported a gate the pipeline does run as missing.
   */
  it("follows a backslash line continuation to the command it starts", () => {
    const continued = parseWorkflow(
      [
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          corepack enable && \\",
        "            pnpm run check",
        "      - run: |",
        "          echo skipping \\",
        "            pnpm run lint",
        ""
      ].join("\n")
    )
    expect(missingGates(continued, [{ name: "typecheck", command: "pnpm run check" }])).toEqual([])
    // A continuation does not INVENT a command: the second script's words are
    // arguments to `echo`, so they still prove nothing runs.
    expect(missingGates(continued, [{ name: "lint", command: "pnpm run lint" }]).map((gate) => gate.name))
      .toEqual(["lint"])
  })

  it("keeps `continue-on-error` advisory, which the real pipeline's platform lanes rely on", () => {
    // A gate asserts that a command still RUNS, not that its failure blocks a
    // merge. Reading the value keeps it available without changing that.
    const advisory = parseWorkflow(
      [
        "jobs:",
        "  node-macos:",
        "    runs-on: macos-latest",
        "    continue-on-error: true",
        "    steps:",
        "      - run: pnpm test",
        ""
      ].join("\n")
    )
    expect(advisory.jobs[0]!.continueOnError).toBe("true")
    expect(missingGates(advisory, [{ name: "macOS node suite", command: "pnpm test", job: "node-macos" }]))
      .toEqual([])
  })
})

describe("supported lockfile installs", () => {
  it("accepts every documented lockfile install", () => {
    for (const command of supportedInstallCommands) expect(isSupportedInstall(command)).toBe(true)
  })

  it("accepts extra flags on a supported install", () => {
    expect(isSupportedInstall("pnpm install --frozen-lockfile --ignore-scripts")).toBe(true)
  })

  it("refuses installs that do not respect a lockfile", () => {
    expect(isSupportedInstall("pnpm install")).toBe(false)
    expect(isSupportedInstall("npm install")).toBe(false)
    // The shape the old generator emitted as its entire pipeline.
    expect(isSupportedInstall("pnpm dlx @smthrs/build-cli ci //...")).toBe(false)
    expect(isSupportedInstall("pnpm install --frozen-lockfile-ish")).toBe(false)
    expect(isSupportedInstall("pnpm install --frozen-lockfile && curl example.test")).toBe(false)
  })

  /**
   * Every command below is syntactically a lockfile install, and every one of
   * them leaves the workspace without the dev dependency the pinned smithers-build CLI
   * lives in. They used to pass, so the install gate was satisfied by a job
   * whose next step could only fail.
   */
  it("refuses a flag that can omit the dependencies the lockfile pins", () => {
    for (
      const command of [
        // Writes a lockfile and installs nothing at all.
        "pnpm install --frozen-lockfile --lockfile-only",
        // Drop the dev dependencies, four spellings.
        "pnpm install --frozen-lockfile --prod",
        "pnpm install --frozen-lockfile --production",
        "npm ci --omit=dev",
        "bun install --frozen-lockfile --production",
        // Install a slice of the workspace instead of the workspace.
        "pnpm install --frozen-lockfile --filter=@scope/app",
        "npm ci --workspace=packages/app",
        "yarn install --immutable --mode=update-lockfile",
        // Skip optional dependencies a pinned tool may need.
        "pnpm install --frozen-lockfile --no-optional",
        // An unknown flag is refused rather than guessed at.
        "pnpm install --frozen-lockfile --some-future-flag"
      ]
    ) {
      expect({ command, supported: isSupportedInstall(command) }).toEqual({ command, supported: false })
    }
    // The flags the real pipeline uses, and their neighbours, still pass.
    for (
      const command of [
        "pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile --ignore-scripts --prefer-offline",
        "pnpm install --frozen-lockfile --reporter=silent",
        "npm ci --ignore-scripts --no-audit --no-fund",
        "yarn install --immutable --immutable-cache",
        "bun install --frozen-lockfile --ignore-scripts"
      ]
    ) {
      expect({ command, supported: isSupportedInstall(command) }).toEqual({ command, supported: true })
    }
  })

  it("binds every supported install to a workspace-binary runner", () => {
    expect(workspaceExec("pnpm install --frozen-lockfile --ignore-scripts")).toBe("pnpm exec")
    expect(workspaceExec("npm ci")).toBe("npm exec --no-install --")
    expect(workspaceExec("yarn install --immutable")).toBe("yarn run")
    expect(workspaceExec("bun install --frozen-lockfile")).toBe("bun run")
    // None of them may fetch from a registry.
    for (const command of supportedInstallCommands) {
      expect(workspaceExec(command)).toBeDefined()
      expect(workspaceExec(command)).not.toMatch(/dlx|npx|bunx/)
    }
    expect(workspaceExec("pnpm install")).toBeUndefined()
  })
})

describe("performsInstall", () => {
  it("accepts the install as a command, alone or with extra flags", () => {
    expect(performsInstall("pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile")).toBe(true)
    expect(performsInstall("pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --frozen-lockfile"))
      .toBe(true)
    expect(performsInstall("corepack enable\npnpm install --frozen-lockfile\n", "pnpm install --frozen-lockfile"))
      .toBe(true)
  })

  it("refuses text that never runs the install", () => {
    expect(performsInstall("# pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile")).toBe(false)
    expect(performsInstall("echo pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile")).toBe(false)
    expect(performsInstall("pnpm install", "pnpm install --frozen-lockfile")).toBe(false)
    expect(
      performsInstall("install() { pnpm install --frozen-lockfile; }", "pnpm install --frozen-lockfile")
    ).toBe(false)
  })

  it("holds the actual line to the same flag policy as the declared install", () => {
    // The line starts with the declared install, so a prefix check accepted it,
    // and it installs none of the dev dependencies the pinned CLI lives in.
    expect(performsInstall("pnpm install --frozen-lockfile --prod", "pnpm install --frozen-lockfile")).toBe(false)
    expect(performsInstall("pnpm install --frozen-lockfile --lockfile-only", "pnpm install --frozen-lockfile"))
      .toBe(false)
    expect(performsInstall("npm ci --omit=dev", "npm ci")).toBe(false)
    // A declared install that is itself unsupported is performed by nothing.
    expect(performsInstall("pnpm install --frozen-lockfile --prod", "pnpm install --frozen-lockfile --prod"))
      .toBe(false)
  })

  /**
   * The install has to be a command the shell RUNS, on the same boundary target
   * a gate uses. Every script here has the install on a line of its own and
   * installs nothing: a here-document body and a quoted block are data another
   * command receives. They used to satisfy the install requirement, which is a
   * rendered pipeline whose next step can only fail.
   */
  it("refuses an install that is data rather than a command", () => {
    for (
      const script of [
        "cat <<'EOF' > notes.txt\npnpm install --frozen-lockfile\nEOF",
        "cat <<EOF\npnpm install --frozen-lockfile\nEOF",
        "echo \"\npnpm install --frozen-lockfile\n\"",
        "echo '\npnpm install --frozen-lockfile\n'"
      ]
    ) {
      expect({ script, performs: performsInstall(script, "pnpm install --frozen-lockfile") })
        .toEqual({ script, performs: false })
    }
  })

  it("accepts an install the shell runs beside another command", () => {
    for (
      const script of [
        "corepack enable; pnpm install --frozen-lockfile",
        "corepack enable && pnpm install --frozen-lockfile",
        "corepack enable && \\\n  pnpm install --frozen-lockfile --ignore-scripts",
        "pnpm install --frozen-lockfile && pnpm run check",
        "CI=1 pnpm install --frozen-lockfile",
        // A continuation INSIDE the install: the shell removes it before it
        // reads the words, so the flag policy reads the same words.
        "pnpm install --frozen-lockfile \\\n  --ignore-scripts"
      ]
    ) {
      expect({ script, performs: performsInstall(script, "pnpm install --frozen-lockfile") })
        .toEqual({ script, performs: true })
    }
    // The flag policy still applies to the whole command, wherever it starts
    // and however it is wrapped.
    expect(
      performsInstall("corepack enable && pnpm install --frozen-lockfile --prod", "pnpm install --frozen-lockfile")
    )
      .toBe(false)
    expect(performsInstall("pnpm install --frozen-lockfile \\\n  --prod", "pnpm install --frozen-lockfile"))
      .toBe(false)
  })
})

describe("stripShellComments", () => {
  it("removes comments without touching commands or expressions", () => {
    expect(stripShellComments("pnpm run check # typecheck")).toBe("pnpm run check ")
    expect(stripShellComments("echo \"a # b\"")).toBe("echo \"a # b\"")
    expect(stripShellComments("echo ${{ github.ref }}")).toBe("echo ${{ github.ref }}")
    expect(stripShellComments("echo $#")).toBe("echo $#")
    expect(stripShellComments("echo \"\\\"\" # after an escape")).toBe("echo \"\\\"\" ")
    expect(stripShellComments("a\n# b\nc")).toBe("a\n\nc")
  })
})
