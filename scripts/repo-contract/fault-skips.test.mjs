/**
 * No fault case may focus, skip, or park itself unnoticed, and none may exist
 * under no gate.
 *
 * Ported from the Smithers 0.x `fault-skip-audit-gate` and `fault-only-todo-audit`
 * suites. Those drove a standalone `check-fault-skips.mjs` against synthetic
 * fixtures; the script is gone, so what survives is the audit itself, run
 * against the real matrix.
 *
 * Process-level scenarios live under the CLI's `test/faults/` tree; component
 * fault cases live with their owning package. Every package carrying cases
 * declares a `faults` target, so `//packages/...:faults` is
 * the whole matrix. That move deleted the manifest the old audit read
 * (`e2e/fault-matrix.json`) along with the runner that read it, so the two jobs
 * the manifest actually did — a case may not exist undeclared, and a case may
 * not skip undeclared — are done here instead, against the filesystem and the
 * package declarations that replaced it.
 *
 * The failure modes are different. A focused test (`.only`) silently drops
 * every other case in its file, and a `.todo` reports as a pass. Both are
 * refused outright, and so is an inverted expectation (`.fails`).
 *
 * `.fails` is refused for a narrow reason, and the reason is not "a matrix may
 * not contain a failing test". The opposite: when the product does not meet a
 * requirement the matrix is required to cover, the sanctioned form is a plain
 * test that fails, kept in the matrix with its owner cited in the case file,
 * and reported as a failure in the gate line. `requiredRedGates` below lists
 * the ones that exist, and this suite asserts they are still there. What
 * `.fails` does is turn exactly that test into a pass: the run goes green, the
 * gate line stops naming the defect, and the requirement is enforced by
 * nothing. So the rule is about the marking, not about the colour — state the
 * requirement as a plain failing test and record the shipped limitation in
 * `fault-gaps.md` beside this file.
 *
 * A required red gate is also a shipped limitation, and a shipped limitation
 * that is only written down in `fault-gaps.md` is written down where no reader
 * of the release looks. Each entry in `requiredRedGates` therefore names the
 * release-notes section that states the limitation, and this suite checks that
 * the fault-gaps row points at it.
 *
 * A conditional skip is legitimate — cases 12 and 21 need the `jj` binary —
 * but every one has to be listed here with the condition it skips on, so "this
 * case has not run in six months" is a fact somebody chose rather than one
 * nobody noticed.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import ts from "typescript"
import { parseWorkflow } from "../release-rehearsal.mjs"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, it } from "node:test"

import { libraryPackages } from "../workspace-packages.mjs"
import { repoRoot as root } from "../workspace-packages.mjs"

const packagesRoot = join(root, "packages")

/**
 * The tests that are required to exist, whatever colour they are.
 *
 * A required parity test is a promise the repository made for the release, and
 * the cheapest way to break one is to delete the test rather than the promise.
 * This map is what stops that: a gate listed here has to be in the
 * matrix, under its own title, or this suite fails and names it.
 */
const requiredGates = new Map([
  [
    "packages/smithers/test/faults/case31-cli-process-containment.test.ts",
    {
      title: [
        "automatically contains a crashed CLI's shell child and retires its durable record on replacement startup",
        "automatically contains a crashed CLI's mcp child and retires its durable record on replacement startup",
        "reaps a crashed CLI's shell group when its supervisor cannot perform automatic cleanup",
        "reaps a crashed CLI's mcp group when its supervisor cannot perform automatic cleanup"
      ],
      why: "The CLI must actually install durable containment under shell and MCP children, "
        + "escalate a shutdown that ignores TERM, refuse to reap children with a live owner, and "
        + "retire records correctly after automatic crash cleanup or actual replacement reaping. "
        + "A host-library test alone does not prove this CLI composition."
    }
  ],
  [
    "packages/smithers/test/faults/case03-cli-durable-recovery.test.ts",
    {
      title: [
        "recovers a real agent approval after the detached CLI process exits",
        "resumes a real agent timer after its deadline passes without a CLI process",
        "reads a pinned working tree through a real agent cell after CLI restart",
        "blocks unrecorded provider requests in the child-process fixture"
      ],
      why: "Real-binary recovery must exercise agent-created waits, a process boundary, and recorded-only "
        + "provider transport. The checkpoint case must read both the saved and changed live tree "
        + "through a resumed agent cell. Directly inserting approval or timer rows does not prove CLI recovery."
    }
  ],
  [
    "packages/smithers/test/faults/engine/case05-concurrent-timer-hosts.test.ts",
    {
      title: "arms two live hosts before one durable deadline and executes its continuation once",
      why: "The two-host timer race must keep both real hosts alive before the persisted deadline, "
        + "verify their re-arm records, and count the post-timer action independently of the journal. "
        + "A single-host restart or a count of deduplicated journal entries does not replace that proof."
    }
  ],
  [
    "packages/smithers/test/faults/engine/case22-secret-never-in-journal.test.ts",
    {
      title: "redacts the credential out of the operator's terminal",
      why: "case 22 must cover the logs as well as the journal. It was red at rc.0 "
        + "and went green when the redaction deliverable landed `@smthrs/journal` "
        + "`RedactedLogger`. It runs the real binary and reads its real stderr, so it is the only thing "
        + "that proves the redacting logger is installed under the durable engine rather than merely "
        + "exported. Deleting it retires the proof, not the requirement."
    }
  ]
])

/**
 * The subset of {@link requiredGates} that are expected to be RED right now.
 *
 * A requirement the product does not meet yet is enforced by a plain failing
 * test, not by prose, and a shipped limitation that is written down only in
 * `fault-gaps.md` is written down where no reader of the release looks. An
 * entry here therefore also has to name its section of the known-limitations
 * page, and the fault-gaps row has to link to it.
 *
 * Empty. Case 22's terminal-log half was the last entry: rc.0 shipped no
 * redacting logger, so the gate was red by design and `e2e-faults` carried
 * `continueOnError` for it. The redaction deliverable landed the
 * logger, the gate went green with no edit to the case, and `e2e-faults` became
 * a required CI job. While this map is empty the matrix is expected to be green
 * end to end; adding an entry back means putting `continueOnError` back on that
 * job in the root `PACKAGE.ts` in the same commit.
 *
 * An entry is keyed like {@link requiredGates} and carries
 * `limitation: { row, anchor }`: `row` is how its fault-gaps row starts
 * (`| 22 |`) and `anchor` is the known-limitations link that row must carry.
 */
const requiredRedGates = new Map([])

const faultGaps = join(root, "scripts", "repo-contract", "fault-gaps.md")

/**
 * What a set of required red gates gets wrong, one message per defect.
 *
 * It reads its arguments rather than the module's maps so the rules can be
 * proven against a fixture while {@link requiredRedGates} is empty. A red gate
 * must also be a required gate, or nothing checks that its test still exists,
 * and its fault-gaps row must link its known-limitations section instead of
 * describing the limitation where no reader of the release looks.
 */
const redGateDefects = (redGates, gates, gaps) => {
  const rows = gaps.split("\n")
  return [...redGates].flatMap(([relative_, gate]) => {
    const defects = []
    if (!gates.has(relative_)) {
      defects.push(
        `${relative_} is listed as red by design and is not in requiredGates, so nothing checks that the test `
          + "still exists. Add it there as well."
      )
    }
    const row = rows.find((line) => line.startsWith(gate.limitation.row))
    if (row === undefined) {
      defects.push(`scripts/repo-contract/fault-gaps.md has no ${gate.limitation.row} row for ${relative_}`)
    } else if (!row.includes(gate.limitation.anchor)) {
      defects.push(
        `the ${gate.limitation.row} row claims the limitation is recorded on the known-limitations page and does `
          + `not link to it. Link ${gate.limitation.anchor}.`
      )
    }
    return defects
  })
}

/**
 * The conditional skips the matrix is allowed to carry, and what each skips on.
 *
 * A file not listed here may contain no skip at all. Adding a row is the review
 * step: it states, in the repository, that a case does not always run.
 */
const allowedSkips = new Map([
  [
    "packages/smithers/test/faults/burndown-infrastructure.test.ts",
    "The bounded Microsandbox guest disk case runs on darwin or linux; other platforms report prerequisites without executing the guest."
  ],
  [
    "packages/smithers/test/faults/time-travel/case12-rewind-reverts-vcs.test.ts",
    "Needs the jj binary to rewind a real workspace. Skips locally without it and throws on CI."
  ],
  [
    "packages/smithers/flows/jj/test/faults/case21-jj-pointer-integrity.test.ts",
    "Needs the jj binary to take and restore real snapshots. Skips locally without it and throws on CI."
  ],
  [
    "packages/smithers/test/faults/burndown-infrastructure.test.ts",
    "The #3367 disk case needs a Microsandbox libkrun guest and the POSIX `msb-nice.sh` wrapper, "
      + "which exist on darwin and linux only. Skips on every other platform; the other cases always run."
  ]
])

/** Every TypeScript file under a package's `test/faults` tree. */
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.isFile() && path.endsWith(".ts") ? [path] : []
  })

/**
 * Every library package, at any depth, that has a `test/faults` tree. Names are
 * paths under `packages/`, which is what reaches them.
 */
const faultPackages = libraryPackages(root)
  .map((entry) => entry.dir.slice("packages/".length))
  .filter((name) => {
    const directory = join(packagesRoot, name, "test", "faults")
    return existsSync(directory) && walk(directory).some((path) => path.endsWith(".test.ts"))
  })
  .sort()

const sources = faultPackages
  .flatMap((name) => walk(join(packagesRoot, name, "test", "faults")))
  .map((path) => ({ relative: relative(root, path), text: readFileSync(path, "utf8") }))
  .sort((left, right) => left.relative.localeCompare(right.relative))

describe("the fault-suite skip audit", () => {
  it("has sources to audit", () => {
    assert.ok(faultPackages.includes("smithers"), "the CLI must carry the process-level fault scenarios")
    assert.ok(sources.length > 15, `expected the matrix to be populated, found ${sources.length} files`)
  })

  it("refuses a focused test, which silently drops every other case in its file", () => {
    for (const source of sources) {
      const focused = [...source.text.matchAll(/\b(?:it|test|describe)\.only\b/g)]
      assert.equal(focused.length, 0, `${source.relative} contains ${focused.length} focused test(s)`)
    }
  })

  it("refuses a parked test, which reports as a pass", () => {
    for (const source of sources) {
      const parked = [...source.text.matchAll(/\b(?:it|test|describe)\.todo\b/g)]
      assert.equal(parked.length, 0, `${source.relative} contains ${parked.length} todo test(s)`)
    }
  })

  it("allows a conditional skip only where one is declared", () => {
    for (const source of sources) {
      const skips = [...source.text.matchAll(/\b(?:it|test|describe)\.(?:skip|skipIf|runIf)\b/g)]
      if (skips.length === 0) continue
      assert.ok(
        allowedSkips.has(source.relative),
        `${source.relative} skips conditionally without a row in allowedSkips. Add one with the condition it `
          + "skips on, or make the case unconditional."
      )
    }
  })

  it("refuses an inverted expectation, which reports green over a known defect", () => {
    for (const source of sources) {
      const inverted = [...source.text.matchAll(/\b(?:it|test)\.fails\b/g)]
      assert.equal(
        inverted.length,
        0,
        `${source.relative} pins a defect with .fails, which turns a failing required gate into a pass. `
          + "State the requirement as a plain test that fails, cite its owner in the case file, and record "
          + "the shipped limitation in scripts/repo-contract/fault-gaps.md."
      )
    }
  })

  it("keeps every required gate in the matrix, including the ones that are red", () => {
    const byRelative = new Map(sources.map((source) => [source.relative, source.text]))
    for (const [relative_, gate] of requiredGates) {
      const text = byRelative.get(relative_)
      assert.ok(text !== undefined, `${relative_} is a required gate and is not in the matrix any more. ${gate.why}`)
      for (const title of Array.isArray(gate.title) ? gate.title : [gate.title]) {
        assert.ok(
          text.includes(title),
          `${relative_} no longer contains the required test "${title}". ${gate.why}`
        )
      }
    }
  })

  it("keeps every red gate required and its fault-gaps row pointed at its limitation", () => {
    assert.deepEqual(redGateDefects(requiredRedGates, requiredGates, readFileSync(faultGaps, "utf8")), [])
  })

  it("refuses a red gate that is not required, has no fault-gaps row, or does not link its limitation", () => {
    const anchor = "docs/pages/release/known-limitations.md#credential-redaction-in-logs"
    const red = (row) => ({ limitation: { row, anchor } })
    const gates = new Map([["linked.test.ts", {}], ["unlinked.test.ts", {}], ["missing.test.ts", {}]])
    const gaps = [
      "| Case | What is covered | What is not | Cost |",
      `| 22 | The journal. | The terminal, stated in \`${anchor}\`. | M |`,
      "| 25 | Refusals. | The terminal, described here instead. | M |"
    ].join("\n")

    assert.deepEqual(redGateDefects(new Map([["linked.test.ts", red("| 22 |")]]), gates, gaps), [])
    assert.deepEqual(redGateDefects(new Map([["unrequired.test.ts", red("| 22 |")]]), gates, gaps), [
      "unrequired.test.ts is listed as red by design and is not in requiredGates, so nothing checks that the test "
        + "still exists. Add it there as well."
    ])
    assert.deepEqual(redGateDefects(new Map([["missing.test.ts", red("| 99 |")]]), gates, gaps), [
      "scripts/repo-contract/fault-gaps.md has no | 99 | row for missing.test.ts"
    ])
    assert.deepEqual(redGateDefects(new Map([["unlinked.test.ts", red("| 25 |")]]), gates, gaps), [
      "the | 25 | row claims the limitation is recorded on the known-limitations page and does not link to it. "
        + `Link ${anchor}.`
    ])
  })

  it("keeps the fault job's CI status in step with the required-red set", () => {
    // The comment over `requiredRedGates` states this rule; without a case it
    // is enforced by nothing. A red gate the matrix is required to carry means
    // `e2e-faults` cannot fail the pipeline, and an empty map means it must.
    const build = readFileSync(join(root, "PACKAGE.ts"), "utf8")
    const faultsJob = build.slice(build.indexOf("id: \"e2e-faults\""))
    const jobBody = faultsJob.slice(0, faultsJob.indexOf("\n    }"))
    const advisory = /continueOnError:\s*true/.test(jobBody)
    const required = /requiredJobs:[^\]]*"e2e-faults"/.test(build)
    if (requiredRedGates.size === 0) {
      assert.ok(!advisory, "requiredRedGates is empty, so e2e-faults must not carry continueOnError")
      assert.ok(required, "requiredRedGates is empty, so e2e-faults belongs in requiredJobs")
    } else {
      assert.ok(advisory, "a required red gate is listed, so e2e-faults must carry continueOnError")
      assert.ok(!required, "a required red gate is listed, so e2e-faults must not be in requiredJobs")
    }
  })

  it("keeps the skip allow-list pointed at files that exist", () => {
    const present = new Set(sources.map((source) => source.relative))
    for (const relative_ of allowedSkips.keys()) {
      assert.ok(present.has(relative_), `the allow-list names ${relative_}, which is not in the matrix any more`)
    }
  })
})

describe("the fault matrix is wired to a gate", () => {
  // release gate B6: `pnpm exec smithers-build test '//e2e:faults'` failed in
  // 262 ms with `Command "vitest" not found`, because the directory that owned
  // every case was not a pnpm workspace member and so had no vitest binary.
  // Eighteen cases existed and had never run under any gate. The cases live in
  // real workspace packages now, which removes that failure mode, but the one
  // it belongs to is a new one: a package can grow a `test/faults` tree and
  // never declare the target that runs it.

  it("declares a faults target in every package that carries fault cases", () => {
    for (const name of faultPackages) {
      const declaration = join(packagesRoot, name, "PACKAGE.ts")
      assert.ok(
        existsSync(declaration),
        `packages/${name} has a test/faults tree and no PACKAGE.ts, so nothing runs its cases`
      )
      const text = readFileSync(declaration, "utf8")
      assert.match(
        text,
        /const faults = Smithers\.FaultSuite\(/,
        `packages/${name} carries fault cases and declares no Smithers.FaultSuite target, so //packages/...:faults `
          + "does not reach them"
      )
      assert.match(
        text,
        /targets: \{[^}]*\bfaults\b/,
        `packages/${name} builds a FaultSuite target and does not export it under the conventional \`faults\` key`
      )
    }
  })

  it("gives every fault package its own serial, coverage-free vitest config", () => {
    for (const name of faultPackages) {
      const config = join(packagesRoot, name, "vitest.faults.config.ts")
      assert.ok(existsSync(config), `packages/${name} declares a faults target and has no vitest.faults.config.ts`)
      const text = readFileSync(config, "utf8")
      assert.match(
        text,
        /fileParallelism: false/,
        `packages/${name}'s fault config runs its cases in parallel; they kill process groups and bind ports`
      )
      assert.match(
        text,
        /include: \["test\/faults\/\*\*\/\*\.test\.ts"\]/,
        `packages/${name}'s fault config does not select test/faults`
      )
    }
  })

  it("keeps the fault cases out of the package's ordinary suite", () => {
    // The two tiers cannot share a machine: a unit suite running beside a case
    // that reaps process groups is racing a reaper it never declared. The
    // ordinary config excludes the tree the fault config selects.
    for (const name of faultPackages) {
      const text = readFileSync(join(packagesRoot, name, "vitest.config.ts"), "utf8")
      assert.match(
        text,
        /exclude: \[\.\.\.configDefaults\.exclude, "test\/faults\/\*\*"\]/,
        `packages/${name}'s ordinary vitest config would also select its fault cases`
      )
    }
  })

  it("selects the whole matrix from the generated CI workflow", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")
    const workflow = parseWorkflow(ci)
    const runs = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).flatMap((step) => step.run ? [step.run] : [])
    assert.equal(runs.filter((run) => /^pnpm exec smthrs test '\/\/packages\/\.\.\.:faults' --jobs 1(?: --known-red '\.github\/ci-known-red\.json')?(?: --verbose)?$/.test(run)).length, 1,
      "the generated workflow must run the fault matrix once, serially over every package that declares one")
  })

  it("keeps every fault tree inside a package the workspace typechecks", () => {
    // `//e2e:check` typechecked the old directory against its own tsconfig. The
    // replacement is each package's own `check`, whose test tsconfig covers
    // `test/**` — including `test/faults`. A tree outside `test/` would fall
    // out of that.
    for (const name of faultPackages) {
      const testTsconfig = join(packagesRoot, name, "tsconfig.test.json")
      assert.ok(existsSync(testTsconfig), `packages/${name} has no tsconfig.test.json to typecheck its cases`)
      const parsed = ts.parseConfigFileTextToJson(testTsconfig, readFileSync(testTsconfig, "utf8"))
      assert.equal(parsed.error, undefined, testTsconfig)
      const config = parsed.config
      assert.ok(
        config.include.some((pattern) => pattern === "test/**/*" || pattern === "test/**/*.ts"),
        `packages/${name}'s test tsconfig does not include test/**, so its fault cases are never typechecked`
      )
      assert.ok(statSync(join(packagesRoot, name, "test", "faults")).isDirectory())
    }
  })
})
