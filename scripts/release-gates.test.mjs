import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  ciGatesMissingFromInventory,
  commandCovers,
  gateRuns,
  inventoryGatesMissingFromWorkflow,
  parseGateCommand,
  releaseGateArgs,
  releaseGateCommand,
  releaseGateExceptions,
  releaseGateSetForHost,
  releaseGateExclusions,
  releaseGates,
  staleExceptions,
  staleExclusions,
  workflowGateSteps,
  workflowGatesMissingFromInventory,
  workflowJobs
} from "./release-gates.mjs"
import { repoRoot } from "./workspace-packages.mjs"
import { parse, stringify } from "yaml"

const workflow = (name) => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")
const release = workflow("release.yml")
const ci = workflow("ci.yml")
const canonicalExceptions = releaseGateSetForHost({ platform: "linux", arch: "x64" }).exceptions
const mirrored = releaseGates.filter((gate) => gate.flowOnly === undefined)

// Mutate parsed copies only. All three jobs exercise the real parity entry
// points; no workflow file or command outcome is replaced on disk.
const parityJobs = [["publish", release], ["test", ci], ["repository", ci], ["apps-e2e", ci]]
const metadataSteps = parse(release).jobs.publish.steps
  .filter(step => ["Validate release tag", "Compute the publish plan"].includes(step.name))
const withRun = (source, job, name, run) => {
  const copy = parse(source)
  copy.jobs[job].steps.push({ name, run })
  return stringify(copy)
}
// Insert by the parsed step name, then exercise both accepted scalar styles.
// Quoting a generated job id or step name must not make a mutation vacuous.
const withStepBefore = (source, job, anchor, step, style) => {
  const copy = parse(source)
  const steps = copy.jobs[job].steps
  const matches = steps.flatMap((entry, index) => entry.name === anchor ? [index] : [])
  assert.equal(matches.length, 1, job + " mutation anchor exists exactly once")
  steps.splice(matches[0], 0, step)
  return stringify(copy, { defaultKeyType: style, defaultStringType: style })
}
const missingFor = (job, source) => job === "publish"
  ? workflowGatesMissingFromInventory(releaseGates, source)
  : ciGatesMissingFromInventory(releaseGates, source, releaseGateExclusions)
const reported = (job, name, command) => [{ ...(job === "publish" ? {} : { job }), name, command }]

// Direct invocations expose all nine discovery gaps in the old pnpm-prefix
// regex, including whitespace forms its previous pnpm-only tests already saw.
const bypassForms = [
  ["quoted executable", "'smthrs' test '//unlisted:required' --verbose"],
  ["quoted verb", "smthrs 'test' '//unlisted:required' --verbose"],
  ["escaped letters", "sm\\thrs test '//unlisted:required' --verbose"],
  ["tab", "smthrs\ttest '//unlisted:required' --verbose"],
  ["doubled spaces", "smthrs  test '//unlisted:required' --verbose"],
  ["backslash-newline", "sm\\\nthrs test '//unlisted:required' --verbose"],
  ["bash -c", "bash -c \"smthrs test '//unlisted:required' --verbose\""],
  ["env", "env MODE=ci smthrs test '//unlisted:required' --verbose"],
  ["$VAR", "TOOL=smthrs\n\"$TOOL\" test '//unlisted:required' --verbose"]
]

for (const [job, source] of parityJobs) {
  for (const [form, command] of bypassForms) {
    test(`fail-closed ${job}: ${form} is an unowned gate`, () => {
      const name = "Unlisted required gate"
      const segment = form === "$VAR" ? command.slice(command.indexOf("\n") + 1) : command
      assert.deepEqual(missingFor(job, withRun(source, job, name, command)), reported(job, name, segment))
    })
  }

  test(`fail-closed ${job}: the reviewer's pnpm word quoting and escapes are discovered`, () => {
    for (const prefix of ["pnpm exec 'smthrs'", 'pnpm "exec" smthrs', "pnpm ex\\ec smthrs"]) {
      const command = `${prefix} test '//unlisted:required' --verbose`
      assert.deepEqual(missingFor(job, withRun(source, job, "Unlisted", command)), reported(job, "Unlisted", command))
    }
  })

  test(`fail-closed ${job}: literal tokens, separators and comments preserve canonical coverage`, () => {
    const gate = mirrored.find(gate => gate.name === "UI unit tests")
    for (const command of [
      "'pnpm' \"exec\" 'smthrs' \"test\" \"//apps/app:unitTests\" --verbose",
      "pnpm ex\\ec sm\\thrs te's't '//apps/app:unitTests' --verbose",
      "pnpm\texec  smthrs test //apps/app:unitTests --verbose",
      "pnpm exec \"sm\\\nthrs\" test '//apps/app:unitTests' --verbose",
      "pnpm exec smthrs test '//apps/app:unitTests' \\\n--verbose"
    ]) {
      for (const separator of [" && ", "; ", " | ", "\n"]) {
        const run = `printf '%s' 'a; b && c | # literal'${separator}${command} # ignored smthrs\n# comment`
        const added = withRun(source, job, gate.name, run)
        assert.deepEqual(missingFor(job, added), [], run)
        assert.deepEqual(workflowGateSteps(added, job).at(-1), { name: gate.name, command })
        if (job === "publish") {
          const replaced = parse(source)
          replaced.jobs.publish.steps.find(step => step.name === gate.name).run = run
          assert.deepEqual(inventoryGatesMissingFromWorkflow(releaseGates, stringify(replaced)), [])
        }
      }
    }
  })

  test(`fail-closed ${job}: wrappers and legacy names cannot inherit a canonical gate's ownership`, () => {
    const gate = mirrored.find(gate => gate.name === "UI unit tests")
    const canonical = releaseGateCommand(gate)
    for (const command of [
      ...["env", "time", "nice", "xargs"].map(wrapper => `${wrapper} ${canonical}`),
      `bash -c "${canonical}"`, `sh -c "${canonical}"`,
      canonical.replace("smthrs", '"smithers-build"'),
      canonical.replace("smthrs", "smithers-\\build"),
      `${canonical} --unknown`, `${canonical} ''`, `${canonical} > gate.log`,
      canonical.replace("unitTests", "unitTests; other"),
      canonical.replace("unitTests", "unitTests#other"),
      canonical.replace("unitTests", "unitTests\\\n"),
      canonical.replace("'//apps/app:unitTests'", '"//apps/app:unitTests\\q"'),
      `${canonical}"`, `${canonical}\\`
    ]) assert.deepEqual(missingFor(job, withRun(source, job, gate.name, command)), reported(job, gate.name, command), command)
  })

  test(`fail-closed ${job}: unrelated expansions and eval do not taint literal gates`, () => {
    const gate = mirrored.find(gate => gate.name === "UI unit tests")
    const canonical = releaseGateCommand(gate)
    for (const command of [
      `${canonical}\nprintf '%s' "$VAR"`, `${canonical}\nprintf '%s' "${"${VAR}"}"`,
      `${canonical}\nprintf '%s' "$(printf value)"`, `${canonical}\nprintf '%s' \`printf value\``,
      `${canonical}\neval ':'`, `${canonical}\n'eval' ':'`, `${canonical}\ne\\val ':'`,
      "# smthrs may be invoked dynamically\n$VAR"
    ]) assert.deepEqual(missingFor(job, withRun(source, job, gate.name, command)), [], command)
  })

  test(`fail-closed ${job}: dynamic gate segments and assignment indirection are unowned`, () => {
    for (const command of [
      "pnpm exec smthrs $VERB '//x'", "pnpm exec smthrs ${VERB} '//x'",
      "pnpm exec smthrs $(printf test) '//x'", "pnpm exec smthrs `printf test` '//x'",
      "eval 'smthrs test //unlisted:required'"
    ]) assert.deepEqual(missingFor(job, withRun(source, job, "Dynamic", command)), reported(job, "Dynamic", command))
    for (const [assignment, command] of [
      ["S=smthrs", "pnpm exec $S ci '//x'"],
      ["TOOL='smthrs'", "${TOOL} test '//unlisted:required' --verbose"],
      ["SMTHRS=smthrs", "$SMTHRS ci '//x'"],
      ["export S=smithers-build", "env MODE=ci pnpm exec \"$S\" ci '//x'"],
      ["S='pnpm exec smthrs'", "bash -c \"$S ci '//x'\""],
      ["S=smthrs", "eval '$S ci //x'"]
    ]) {
      const run = `${assignment}; ${command}`
      assert.deepEqual(missingFor(job, withRun(source, job, "Indirect", run)), reported(job, "Indirect", command), run)
    }
    // The specified path regex also matches the complete assignment token.
    // Both that literal candidate and its indirect invocation are unowned.
    const assignment = "SMTHRS=./node_modules/.bin/smthrs"
    const command = "$SMTHRS ci '//x'"
    assert.deepEqual(missingFor(job, withRun(source, job, "Indirect path", `${assignment}; ${command}`)), [
      ...reported(job, "Indirect path", assignment), ...reported(job, "Indirect path", command)
    ])
  })

  test(`fail-closed ${job}: gate paths and recursively quoted wrappers remain candidates`, () => {
    for (const prefix of [
      "./smthrs", "/usr/local/bin/smthrs", "node_modules/.bin/smithers-build",
      "sudo exec env time nice xargs smthrs"
    ]) {
      const command = `${prefix} ci '//x'`
      assert.deepEqual(missingFor(job, withRun(source, job, "Wrapped", command)), reported(job, "Wrapped", command))
    }
    for (const wrapper of ["env", "time", "nice", "xargs", "sudo", "bash", "sh", "zsh", "eval", "exec"]) {
      const command = `${wrapper} -c 'bash -c "pnpm exec smthrs ci //x"'`
      assert.deepEqual(missingFor(job, withRun(source, job, "Nested", command)), reported(job, "Nested", command))
    }
  })

  test(`fail-closed ${job}: longer words, node strings and comments are not candidates`, () => {
    for (const command of [
      "node -p 'pkg.smthrs?.group'", "node -p '\"npm install smthrs\"'",
      "pnpm exec node scripts/example.mjs @smthrs/cli smthrs-extra",
      "# npm install smthrs\nprintf '%s' \"$VERSION\"",
      "VERSION=1 # smthrs $VERB\nprintf '%s' \"$VERSION\"",
      "S=@smthrs/cli; pnpm exec $S ci '//x'",
      "S='pkg.smthrs?.group'; $S", "S=unrelated; $S", "S=smthrs; printf '%s' \"$S\""
    ]) assert.deepEqual(missingFor(job, withRun(source, job, "Metadata", command)), [], command)
  })

  test(`fail-closed ${job}: script runners stay out of scope until they mention a gate`, () => {
    for (const command of ["node scripts/build-release.mjs", "pnpm exec node scripts/build-release.mjs", "pnpm exec scripts/example.mjs"]) {
      assert.deepEqual(missingFor(job, withRun(source, job, "Script runner", command)), [])
      const gateCommand = `${command} smthrs`
      assert.deepEqual(missingFor(job, withRun(source, job, "Script runner", gateCommand)), reported(job, "Script runner", gateCommand))
    }
  })
}

test("CI requires an explicit canonical command even inside a recursive inventory selection", () => {
  for (const job of ["test", "repository", "apps-e2e", "browser", "rust"]) {
    const command = "pnpm exec smthrs test '//scripts:newRequiredGate' --verbose"
    assert.deepEqual(missingFor(job, withRun(ci, job, "Unlisted", command)), reported(job, "Unlisted", command))
  }
})

test("release metadata and planning blocks contain no gate candidates", () => {
  assert.equal(metadataSteps.length, 2)
  for (const step of metadataSteps) {
    const source = stringify({ jobs: { publish: { steps: [step] } } })
    assert.deepEqual(workflowGateSteps(source, "publish"), [], step.name)
    assert.deepEqual(workflowGatesMissingFromInventory([], source), [], step.name)
  }
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, release), [])
})

test("all nine reviewer cases execute the same Bash argv and fail parity", () => {
  for (const prefix of ["pnpm exec 'smthrs'", 'pnpm "exec" smthrs', "pnpm ex\\ec smthrs"]) {
    const command = `${prefix} test '//unlisted:required' --verbose`
    const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c",
      `pnpm() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; };\n${command}`
    ], { encoding: "utf8" })
    assert.equal(execution.status, 0, execution.stderr)
    assert.deepEqual(JSON.parse(execution.stdout), ["exec", "smthrs", "test", "//unlisted:required", "--verbose"])
    for (const [job, source] of parityJobs) {
      const mutated = withRun(source, job, "Reviewer bypass", command)
      assert.equal(workflowGateSteps(mutated, job).length, workflowGateSteps(source, job).length + 1)
      assert.deepEqual(missingFor(job, mutated), reported(job, "Reviewer bypass", command))
    }
  }
})

test("CI exclusions cannot hide wrappers, expansions or new commands", () => {
  for (const job of ["packages"]) {
    for (const command of [
      "pnpm exec smthrs test '//unlisted:required' --verbose",
      "env pnpm exec smthrs test '//unlisted:required' --verbose",
      "TOOL=smthrs\n$TOOL test '//unlisted:required' --verbose"
    ]) assert.deepEqual(missingFor(job, withRun(ci, job, "Unlisted", command)), reported(job, "Unlisted", command.split("\n").at(-1)))
  }
})

test("exception and exclusion drift checks use literal tokens and reject dynamic gates", () => {
  const gate = mirrored.find(gate => gate.name === "UI unit tests")
  const canonical = releaseGateCommand(gate)
  const command = canonical.replace("smthrs", '"smthrs"')
  const source = stringify({ jobs: { publish: { steps: [{ name: gate.name, run: command }] } } })
  const exception = { name: gate.name, command: canonical, reason: "test-only exception" }
  assert.deepEqual(staleExceptions([], source, [exception]), [])
  assert.deepEqual(workflowGatesMissingFromInventory([], source, { exceptions: [exception] }), [])
  assert.deepEqual(staleExclusions([], source, [{ job: "publish", commands: [canonical], reason: "test-only exclusion" }]), [])
  const dynamic = stringify({ jobs: { publish: { steps: [{ name: gate.name, run: `${canonical} $VAR` }] } } })
  assert.equal(staleExceptions([], dynamic, [exception]).length, 1)
  assert.equal(workflowGatesMissingFromInventory([], dynamic, { exceptions: [exception] }).length, 1)
  assert.equal(ciGatesMissingFromInventory([], dynamic, [{ job: "publish", reason: "whole job" }]).length, 1)
})

/** Pin every job so a new one forces a release decision. `on.push` is a trigger, not a job. */
const ciJobs = ["test", "repository", "scripts", "docs", "apps-e2e", "rust", "rust-ffi", "wasm-repro", "e2e-faults", "browser", "packages", "go-backend"]

/** A copy of the release workflow with one more gate step ahead of the build. */
const withUnlistedStep = (source, name, command) => {
  const anchor = "      - name: Build all workspaces from clean artifacts"
  assert.ok(source.includes(anchor))
  return source.replace(anchor, `      - name: ${name}\n        run: ${command}\n${anchor}`)
}

/** A copy of a workflow with one named gate step removed. */
const withoutStep = (source, name) => {
  const pattern = new RegExp(`      - name: "?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\n(?:        if: [^\\n]+\\n)?        run: [^\\n]+\\n(?:        env:\\n(?:          [^\\n]+\\n)*)?`)
  assert.match(source, pattern, `${name} is a step`)
  return source.replace(pattern, "")
}

test("the inventory names the exclusive fault matrix, serial, and the WASM byte-compare", () => {
  // These are the two gates ordinary `ci '//packages/...'` never runs and the
  // root release flow used to omit. Pinning them here means a future edit to
  // the inventory cannot drop them without failing this case.
  assert.deepEqual(releaseGates.filter((gate) => gate.target === "//packages/...:faults").map(releaseGateArgs), [
    ["test", "//packages/...:faults", "--jobs", "1", "--verbose"]
  ])
  assert.deepEqual(releaseGates.filter((gate) => gate.target === "//crates/flows-jj:wasmReproducibility").map(releaseGateArgs), [
    ["test", "//crates/flows-jj:wasmReproducibility", "--verbose"]
  ])
  const names = releaseGates.map((gate) => gate.name)
  assert.deepEqual(names, [...new Set(names)], "gate names are unique")
  const commands = releaseGates.map(releaseGateCommand)
  assert.deepEqual(commands, [...new Set(commands)], "gate commands are unique, so each workflow step maps to one gate")
  for (const gate of releaseGates) assert.ok(["ci", "test", "lint", "build"].includes(gate.verb), `${gate.name} uses a supported verb`)
})

test("the inventory is release.yml's publish job: same gates, same names, same order", () => {
  // release.yml is hand-written and cannot import the inventory, so this reads
  // the workflow and proves the two agree in both directions. The inventory
  // used to hold 12 entries, only 10 of the workflow's 35 gates, and a flow-driven release then
  // approved a candidate with far less evidence than a tag-driven one; the
  // one-directional check of that time could not see it.
  assert.deepEqual(inventoryGatesMissingFromWorkflow(releaseGates, release).map(releaseGateCommand), [], "release.yml lacks these inventory gates")
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, release, { exceptions: canonicalExceptions }), [], "the inventory lacks these release.yml gates")
  assert.deepEqual(staleExceptions(releaseGates, release, canonicalExceptions), [])
  const steps = workflowGateSteps(release, "publish")
    .filter((step) => !canonicalExceptions.some((exception) => exception.name === step.name && exception.command === step.command))
  assert.deepEqual(
    mirrored.map((gate) => [gate.name, releaseGateCommand(gate)]),
    steps.map((step) => [step.name, step.command]),
    "the inventory runs the publish job's gates in the publish job's order"
  )
  assert.ok(steps.length >= 35, `${steps.length} gates is too few to be the publish job`)
  // The gates the review found missing, named so the fix cannot regress quietly.
  for (const target of [
    "//apps/app:check", "//apps/app:unitTests", "//apps/server/...", "//apps/review/...", "//apps/bug-worker/...",
    "//:projectCopy", "//evals/agent:test", "//evals/agent:check", "//evals/authoring:test",
    "//evals/authoring:check", "//evals/swebench:offline", "//evals/swebench:check", "//evals/review-seeded-bugs/...",
    "//evals/review-seeded-bugs:check", "//evals/recommend/...", "//evals/recommend:check", "//:ci", "//:factoryProjection",
    "//:targetIndex", "//packages/smithers/flows/engine-store:disasterRecovery", "//crates/flows-jj:buildScript",
    "//crates/flows-jj:wasmReproducibility", "//scripts/..."
  ]) assert.ok(mirrored.some((gate) => gate.target === target), `${target} is an inventory gate`)
  // Ordering: the fault matrix and the byte-compare both precede the build.
  const build = release.indexOf("scripts/build-release.mjs")
  assert.ok(build > 0)
  for (const target of ["//packages/...:faults", "//crates/flows-jj:wasmReproducibility"]) {
    const at = release.indexOf(`'${target}'`)
    assert.ok(at >= 0 && at < build, `${target} runs before the build in release.yml`)
  }
})

test("removing one required gate from the inventory is reported, and only a declared exception excuses it", () => {
  // The regression the review asked for: delete one entry from a copy of the
  // inventory and the parity function names it. An exception for that exact
  // step is the only thing that silences the report, and the exception is
  // then visible in the flow's evidence rather than passed off as a run.
  const step = { name: "Disaster-recovery script test", command: "pnpm exec smthrs test '//packages/smithers/flows/engine-store:disasterRecovery' --verbose" }
  const mutated = releaseGates.filter((gate) => gate.name !== step.name)
  assert.equal(mutated.length, releaseGates.length - 1, "the gate was in the inventory")
  assert.deepEqual(workflowGatesMissingFromInventory(mutated, release, { exceptions: canonicalExceptions }), [step])
  const exception = { ...step, reason: "test-only exception" }
  assert.deepEqual(workflowGatesMissingFromInventory(mutated, release, { exceptions: [...canonicalExceptions, exception] }), [])
  assert.deepEqual(staleExceptions(mutated, release, [exception]), [])
  // The same exception against the full inventory is stale: the gate would count as both ran and skipped.
  assert.deepEqual(staleExceptions(releaseGates, release, [exception]), [`"${step.name}" is both an inventory gate and an exception`])
  // A gate renamed in the inventory is a gap in both directions, since names key the evidence.
  const renamed = releaseGates.map((gate) => gate.name === step.name ? { ...gate, name: "Disaster recovery" } : gate)
  assert.deepEqual(workflowGatesMissingFromInventory(renamed, release), [step])
  assert.deepEqual(inventoryGatesMissingFromWorkflow(renamed, release).map((gate) => gate.name), ["Disaster recovery"])
})

test("a gate added to release.yml without an inventory entry is reported, as is one removed from release.yml", () => {
  const command = "pnpm exec smthrs test '//scripts:unlisted' --verbose"
  const added = withUnlistedStep(release, "Unlisted gate", command)
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, added, { exceptions: canonicalExceptions }), [{ name: "Unlisted gate", command }])
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, added, { exceptions: [{ name: "Unlisted gate", command, reason: "declared" }] }), [])
  const removed = withoutStep(release, "Exclusive fault matrix")
  assert.deepEqual(inventoryGatesMissingFromWorkflow(releaseGates, removed).map((gate) => gate.name), ["Exclusive fault matrix"])
  assert.deepEqual(inventoryGatesMissingFromWorkflow(releaseGates, release), [])
  // A step with the right command under another name is a gap too.
  const misnamed = release.replace("      - name: Exclusive fault matrix", "      - name: Fault matrix")
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, misnamed).map((step) => step.name), ["Fault matrix"])
})

test("parity detects unlisted commands in block runs and unnamed steps", () => {
  const command = "pnpm exec smthrs test '//scripts:unlisted' --verbose"
  const anchor = "      - name: Build all workspaces from clean artifacts"
  for (const step of [
    `      - run: ${command}\n`,
    `      - name: Unlisted gate\n        run: |\n          ${command}\n`,
    `      - run: |\n          ${command}\n`,
    `      - name: Unlisted gate\n        run: >-\n          pnpm exec smthrs test\n          '//scripts:unlisted' --verbose\n`
  ]) {
    const added = release.replace(anchor, step + anchor)
    assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, added), [
      { name: step.includes("name:") ? "Unlisted gate" : "", command }
    ])
  }
})

test("each release command has exactly one owner, including exceptions", () => {
  const gate = mirrored[0]
  const step = { name: gate.name, command: releaseGateCommand(gate) }
  assert.deepEqual(workflowGatesMissingFromInventory([...releaseGates, gate], release), [step])
  const inventory = releaseGates.filter((entry) => entry !== gate)
  const exception = { ...step, reason: "test-only platform exception" }
  assert.deepEqual(workflowGatesMissingFromInventory(inventory, release, { exceptions: [exception, exception] }), [step])
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, release, { exceptions: [exception] }), [step])
})

// These shell spellings must remain visible even when they are not canonical
// inventory commands. Use a target outside recursive inventory selections so
// CI must report the unlisted gate even if command parsing later normalizes it.
for (const [spelling, prefix] of [
  ["double spaces", "pnpm  exec smthrs"],
  ["tabs", "pnpm\texec\tsmthrs"],
  ["continued before exec", "pnpm " + "\\" + "\n  exec smthrs"],
  ["continued before smthrs", "pnpm exec " + "\\" + "\n  smthrs"],
  ["continued command word", "pnpm exec sm" + "\\" + "\nthrs"],
  ["legacy executable whitespace", "pnpm  exec smithers-build"]
]) {
  for (const [job, source, anchor] of [
    ["publish", release, "Build all workspaces from clean artifacts"],
    ["repository", ci, "Target index drift"],
    ["apps-e2e", ci, "UI unit tests"]
  ]) {
    test(`${job} parity reports an unlisted gate with ${spelling}`, () => {
      const command = `${prefix} test '//unlisted:required' --verbose`
      const name = "Unlisted required gate"
      for (const style of ["PLAIN", "QUOTE_DOUBLE"]) {
        const added = withStepBefore(source, job, anchor, { name, run: command }, style)
        const steps = workflowGateSteps(added, job)
        assert.equal(steps.length, workflowGateSteps(source, job).length + 1, "every added command is discovered")
        const missing = job === "publish"
          ? workflowGatesMissingFromInventory(releaseGates, added)
          : ciGatesMissingFromInventory(releaseGates, added, releaseGateExclusions)
        assert.deepEqual(missing, [{ ...(job === "publish" ? {} : { job }), name, command }],
          style + ": the unlisted command fails parity closed with its full spelling")
      }
    })
  }
}

test("continued commands retain quoted whitespace and comments cannot hide the next gate", () => {
  const command = "pnpm exec smthrs test '//unlisted:" + "\\" + "\nrequired' --verbose"
  const source = `jobs:\n  publish:\n    steps:\n      - name: Quoted continuation\n        run: |\n${command.split("\n").map(line => `          ${line}`).join("\n")}\n`
  assert.deepEqual(workflowGateSteps(source, "publish"), [{ name: "Quoted continuation", command }])
  assert.deepEqual(workflowGatesMissingFromInventory([{ name: "Quoted continuation", verb: "test", target: "//unlisted:required" }], source), [{ name: "Quoted continuation", command }])
  const gate = mirrored[0]
  const commented = withUnlistedStep(release, "After comment", `|\n          # a comment ending in ${"\\"}\n          ${releaseGateCommand(gate)}`)
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, commented), [{ name: "After comment", command: releaseGateCommand(gate) }])
})

test("flow-only gates are the root flows' own targets, which no CI job runs", () => {
  // The flow gates its own sources. If ci.yml ever gains a flows job, the
  // release should mirror it and these entries should lose their exemption.
  const flowOnly = releaseGates.filter((gate) => gate.flowOnly !== undefined).map((gate) => gate.target)
  assert.deepEqual(flowOnly, ["//flows:check", "//flows:suite"])
  for (const target of flowOnly) assert.equal(ci.includes(`'${target}'`), false, `${target} is now a CI gate; drop its flowOnly exemption`)
})

test("the release proves every CI gate the exclusions do not name, and every exclusion still describes ci.yml", () => {
  // Release is a superset of CI: each ci.yml job is mirrored gate by gate,
  // covered by a recursive inventory selection, or named in the exclusions
  // with a reason. `browser` needs no entry: its gate is a `//scripts/...` member.
  assert.deepEqual(workflowJobs(ci), ciJobs)
  assert.deepEqual(ciGatesMissingFromInventory(releaseGates, ci, releaseGateExclusions), [], "these CI gates run in neither the release nor the exclusions")
  assert.deepEqual(staleExclusions(releaseGates, ci, releaseGateExclusions), [])
  assert.deepEqual(releaseGateExclusions.map((exclusion) => exclusion.job), ["apps-e2e", "rust", "packages"])
  for (const exclusion of releaseGateExclusions) assert.ok(exclusion.reason.length > 40, `${exclusion.job} carries a reason`)
  // Partial exclusions name only what the release omits: the rest of the job is mirrored.
  assert.deepEqual(releaseGateExclusions.find((exclusion) => exclusion.job === "apps-e2e").commands, ["pnpm exec smthrs test '//apps/app:browserE2e' --verbose"])
  assert.deepEqual(releaseGateExclusions.find((exclusion) => exclusion.job === "rust").commands, [
    "pnpm exec smthrs lint '//crates/flows-jj/...' --verbose",
    "pnpm exec smthrs test '//crates/flows-jj:cargoTest' --verbose"
  ])
  for (const job of ["test", "repository", "scripts", "docs", "e2e-faults", "wasm-repro"]) {
    for (const step of workflowGateSteps(ci, job)) {
      assert.ok(mirrored.some((gate) => gate.name === step.name && releaseGateCommand(gate) === step.command), `${job}: ${step.name} is an inventory gate by name and command`)
    }
  }
})

test("a CI gate added outside the exclusions is reported, and an exclusion that names a mirrored gate or a missing job is stale", () => {
  const command = "pnpm exec smthrs test '//evals/new:suite' --verbose"
  for (const style of ["PLAIN", "QUOTE_DOUBLE"]) {
    const added = withStepBefore(ci, "repository", "Target index drift", { name: "New eval suite", run: command }, style)
    assert.equal(workflowGateSteps(added, "repository").length, workflowGateSteps(ci, "repository").length + 1)
    assert.deepEqual(ciGatesMissingFromInventory(releaseGates, added, releaseGateExclusions),
      [{ job: "repository", name: "New eval suite", command }], style + ": an unlisted gate must fail parity")
    assert.deepEqual(ciGatesMissingFromInventory(releaseGates, added,
      [...releaseGateExclusions, { job: "repository", commands: [command], reason: "declared" }]), [])
  }
  // Dropping an inventory gate a mirrored CI job carries is a CI gap too.
  const mutated = releaseGates.filter((gate) => gate.target !== "//crates/flows-jj:buildScript")
  assert.deepEqual(ciGatesMissingFromInventory(mutated, ci, releaseGateExclusions).map((step) => step.command), ["pnpm exec smthrs test '//crates/flows-jj:buildScript' --verbose"])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "test", commands: ["pnpm exec smthrs ci '//packages/...' --jobs 2 --verbose"], reason: "stale" }]), [
    "test excludes pnpm exec smthrs ci '//packages/...' --jobs 2 --verbose, which the inventory runs"
  ])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "rust", reason: "whole job" }]), [
    "rust excludes pnpm exec smthrs test '//scripts:thirdPartyNotices' --verbose, which the inventory runs"
  ])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "gone", reason: "stale" }]), ["gone is not a ci.yml job"])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "rust", commands: [command], reason: "stale" }]), [`rust does not run ${command}`])
})

test("workflowGateSteps reads names and commands, quoted names included, and skips non-gate steps", () => {
  const source = [
    "name: x", "on: push", "jobs:", "  publish:", "    steps:",
    "      - uses: actions/checkout@sha",
    "      - name: Install", "        run: pnpm install",
    "      # a comment", "",
    "      - name: \"Agent eval suite (offline, baseline-gated)\"", "        run: pnpm exec smthrs test '//evals/agent:test' --verbose",
    "        env:", "          SMITHERS_CACHE_URL: x",
    "      - name: Build", "        run: node scripts/build-release.mjs",
    "      - name: Serial", "        run: pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose",
    "  other:", "    steps:", "      - name: Elsewhere", "        run: pnpm exec smthrs lint '//:ci' --verbose", ""
  ].join("\n")
  assert.deepEqual(workflowJobs(source), ["publish", "other"])
  assert.deepEqual(workflowGateSteps(source, "publish"), [
    { name: "Agent eval suite (offline, baseline-gated)", command: "pnpm exec smthrs test '//evals/agent:test' --verbose" },
    { name: "Serial", command: "pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose" }
  ])
  assert.deepEqual(workflowGateSteps(source, "other"), [{ name: "Elsewhere", command: "pnpm exec smthrs lint '//:ci' --verbose" }])
  assert.throws(() => workflowGateSteps(source, "missing"), /missing is not a job/)
  assert.deepEqual(parseGateCommand("pnpm exec smthrs build '//apps/app:check' --verbose"), { verb: "build", target: "//apps/app:check" })
  assert.deepEqual(parseGateCommand("pnpm exec smthrs ci '//packages/...' --jobs 2 --verbose"), { verb: "ci", target: "//packages/...", jobs: 2 })
  assert.equal(parseGateCommand("pnpm exec smthrs ci //packages/... --verbose"), undefined)
  // The known-red list changes which red targets fail a step, not which run.
  assert.deepEqual(
    parseGateCommand("pnpm exec smthrs ci '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose"),
    { verb: "ci", target: "//packages/...", jobs: 2 }
  )
})

test("commandCovers matches exact targets, recursive selections and job bounds only", () => {
  const gate = { name: "x", verb: "test", target: "//scripts:releaseCut" }
  assert.equal(commandCovers("pnpm exec smthrs test '//scripts:releaseCut' --verbose", gate), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//scripts/...' --verbose", gate), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//script/...' --verbose", gate), false)
  assert.equal(commandCovers("pnpm exec smthrs ci '//scripts/...' --verbose", gate), false)
  const serial = { name: "y", verb: "test", target: "//packages/...:faults", jobs: 1 }
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose", serial), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --verbose", serial), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --jobs 2 --verbose", serial), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...' --jobs 1 --verbose", serial), false)
  const lint = { name: "z", verb: "lint", target: "//:ci" }
  assert.equal(commandCovers("pnpm exec smthrs lint '//:ci' --verbose", lint), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//:ci' --verbose", lint), false)
  const typecheck = { name: "w", verb: "build", target: "//evals/agent:check" }
  assert.equal(commandCovers("pnpm exec smthrs build '//evals/agent:check' --verbose", typecheck), true)
  assert.equal(commandCovers("pnpm exec smthrs build '//evals/...' --verbose", typecheck), true)
  // A bounded command covers no unbounded gate: the bound is a different claim.
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...' --jobs 2 --verbose", { name: "v", verb: "test", target: "//packages/smithers:test" }), false)
  // gateRuns is the same relation read from the inventory side.
  const scripts = { name: "Script gates", verb: "test", target: "//scripts/..." }
  assert.equal(gateRuns(scripts, "pnpm exec smthrs test '//scripts:webBundleContract' --verbose"), true)
  assert.equal(gateRuns(scripts, "pnpm exec smthrs lint '//scripts:lint' --verbose"), false)
  assert.equal(gateRuns(scripts, "not a gate"), false)
})

test("publish parity detects commands in YAML block scalars and unnamed run steps", () => {
  const command = "pnpm exec smthrs test '//scripts:unlisted' --verbose"
  for (const run of [`|\n          ${command}`, `>\n          pnpm exec smthrs test\n          '//scripts:unlisted' --verbose`]) {
    const mutated = withUnlistedStep(release, "Unlisted gate", run)
    assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, mutated), [{ name: "Unlisted gate", command }])
  }
  const unnamed = `jobs:\n  publish:\n    steps:\n      - run: ${command}\n`
  assert.deepEqual(workflowGatesMissingFromInventory([], unnamed), [{ name: "", command }])
})

test("no inventory with the review's 12-entry shape can cover all 35 publish steps", () => {
  // The supplied workspace already contained an expanded patch. Model the old
  // shape without claiming that these are the exact historical ten commands.
  const legacy = [...mirrored.slice(0, 10), ...releaseGates.filter((gate) => gate.flowOnly)]
  assert.equal(legacy.length, 12)
  const missing = workflowGatesMissingFromInventory(legacy, release)
  assert.equal(missing.length, workflowGateSteps(release, "publish").length - 10)
  assert.ok(missing.some((step) => step.name === "UI typecheck"))
  assert.ok(missing.some((step) => step.name === "Disaster-recovery script test"))
})

test("each host partitions every publish gate into exactly one run or justified exception", () => {
  const canonical = releaseGateSetForHost({ platform: "linux", arch: "x64" })
  assert.deepEqual(canonical.inventory, releaseGates)
  assert.deepEqual(canonical.exceptions, [])
  for (const host of [{ platform: "darwin", arch: "arm64" }, { platform: "linux", arch: "arm64" }, { platform: "win32", arch: "x64" }]) {
    const local = releaseGateSetForHost(host)
    assert.equal(local.inventory.length, releaseGates.length - 1)
    assert.deepEqual(local.exceptions, releaseGateExceptions)
    assert.equal(local.exceptions[0].name, "Rebuild and byte-compare flows_jj.wasm")
    assert.match(local.exceptions[0].reason, /x86_64-unknown-linux-gnu/)
    assert.deepEqual(workflowGatesMissingFromInventory(local.inventory, release, { exceptions: local.exceptions }), [])
    assert.deepEqual(staleExceptions(local.inventory, release, local.exceptions), [])
    assert.deepEqual(inventoryGatesMissingFromWorkflow(local.inventory, release), [])
  }
  const step = workflowGateSteps(release, "publish")[0]
  assert.deepEqual(workflowGatesMissingFromInventory([...releaseGates, releaseGates[0]], release), [step])
  const exception = { ...step, reason: "duplicate owner" }
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates, release, { exceptions: [exception] }), [step])
  assert.deepEqual(workflowGatesMissingFromInventory(releaseGates.slice(1), release, { exceptions: [exception, exception] }), [step])
})
