/**
 * Pins the per-run artifact names, on both harnesses.
 *
 * `lib/run-paths.sh` is the one place that knows where a run's workspace, patch,
 * timings, logs, container and journal go. Two things depend on it being exactly
 * right and neither shows up as a test failure anywhere else: a matrix run of
 * five attempts must name five distinct sets, and a run without an index must
 * name what every existing script already reads — `regen-patch.sh`,
 * `scorecard.ts --work work`, and every wave report that quotes a path.
 *
 * It also pins the symmetry the comparison rests on: the codex side's names are
 * the flows side's names under the codex roots, so a matrix manifest from either
 * harness has the same shape.
 *
 * Spends no tokens, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

const names = [
  "RUN_INDEX",
  "RUN_ID",
  "SUFFIX",
  "WORK_ROOT",
  "WORK",
  "VCS_ROOT",
  "VCS",
  "PATCH_ROOT",
  "PATCH",
  "TIMINGS_ROOT",
  "TIMINGS",
  "LOG_ROOT",
  "LOG_PREFIX",
  "CONTAINER",
  "JOURNAL_ROOT",
  "JOURNAL"
]

const paths = (harness, instance, index, base = root, cwd = root, env = {}) => {
  const result = spawnSync(
    join(base, "lib/run-paths.sh"),
    index === undefined ? [harness, instance] : [harness, instance, index],
    { encoding: "utf8", env: { ...process.env, ...env } }
  )
  assert.equal(result.status, 0, result.stderr)
  // Decode with Bash, as the runners do: %q output is shell syntax, and values
  // may contain quotes, backslashes or newlines in the checkout's path.
  const decoded = spawnSync("bash", [
    "-c",
    "eval \"$1\"; shift; for name in \"$@\"; do printf \"%s\\0\" \"${!name}\"; done",
    "run-paths-fixture",
    result.stdout,
    ...names
  ], { encoding: "utf8", cwd })
  assert.equal(decoded.status, 0, decoded.stderr)
  const values = decoded.stdout.split("\0")
  assert.equal(values.pop(), "")
  assert.equal(values.length, names.length)
  return Object.fromEntries(names.map((name, index) => [name, values[index]]))
}

const refuses = (args, env = {}) => {
  const result = spawnSync(join(root, "lib/run-paths.sh"), args, {
    encoding: "utf8",
    env: { ...process.env, ...env }
  })
  assert.equal(result.status, 2, `expected a refusal for ${args.join(" ")}`)
  // A refusal prints no assignments, so a caller that `eval`s the output of a
  // script it did not check has nothing to evaluate.
  assert.equal(result.stdout, "", `a refusal prints nothing for ${args.join(" ")}`)
  return result.stderr
}

const instance = "django__django-16612"

// ---------------------------------------------------------------------------
// No index: today's names, exactly
// ---------------------------------------------------------------------------
const plain = paths("flows", instance)
assert.equal(plain.WORK, join(root, "work", instance))
assert.equal(plain.PATCH, join(root, "patches", `${instance}.patch`))
assert.equal(plain.TIMINGS, join(root, "timings", `${instance}.json`))
assert.equal(plain.LOG_PREFIX, join(root, "logs-agent", instance))
assert.equal(plain.CONTAINER, "flowsbench-django--django-16612")
assert.equal(plain.SUFFIX, "")
// A run always has an index even when its paths do not carry one, because the
// matrix manifest and the log lines are keyed by it.
assert.equal(plain.RUN_INDEX, "r1")
assert.equal(plain.RUN_ID, `${instance}-r1`)
// The archive carries the patch's suffix, not the run index, so the journal and
// the patch a selection reads always come from one run. An unindexed run whose
// patch is `<id>.patch` must not overwrite the archive that belongs to
// `<id>-r1.patch`.
assert.equal(plain.JOURNAL, join(root, "journals", instance))

assert.notEqual(
  plain.JOURNAL,
  paths("flows", instance, "r1").JOURNAL,
  "a hand run and a matrix r1 archive their journals apart, because their patches are apart"
)

const plainCodex = paths("codex", instance)
assert.equal(plainCodex.WORK, join(root, "work-codex", instance))
assert.equal(plainCodex.PATCH, join(root, "patches-codex", `${instance}.patch`))
assert.equal(plainCodex.TIMINGS, join(root, "timings-codex", `${instance}.json`))
assert.equal(plainCodex.LOG_PREFIX, join(root, "logs-codex", instance))
assert.equal(plainCodex.CONTAINER, "codexbench-django--django-16612")

// ---------------------------------------------------------------------------
// An index: every name carries it, on both sides, and five are five
// ---------------------------------------------------------------------------
const seen = new Set()
for (const round of ["r1", "r2", "r3", "r4", "r5"]) {
  for (const harness of ["flows", "codex"]) {
    const derived = paths(harness, instance, round)
    const root_ = harness === "flows" ? "work" : "work-codex"
    const patches = harness === "flows" ? "patches" : "patches-codex"
    const timings = harness === "flows" ? "timings" : "timings-codex"
    const logs = harness === "flows" ? "logs-agent" : "logs-codex"
    const prefix = harness === "flows" ? "flowsbench" : "codexbench"
    assert.equal(derived.RUN_INDEX, round)
    assert.equal(derived.RUN_ID, `${instance}-${round}`)
    assert.equal(derived.SUFFIX, `-${round}`)
    assert.equal(derived.WORK, join(root, root_, `${instance}-${round}`))
    assert.equal(derived.PATCH, join(root, patches, `${instance}-${round}.patch`))
    assert.equal(derived.TIMINGS, join(root, timings, `${instance}-${round}.json`))
    assert.equal(derived.LOG_PREFIX, join(root, logs, `${instance}-${round}`))
    assert.equal(derived.CONTAINER, `${prefix}-django--django-16612-${round}`)
    assert.equal(derived.JOURNAL, join(root, "journals", `${instance}-${round}`))
    // The journal is written by the flows side only, so it is the one name the
    // two harnesses share for a given round.
    const names = harness === "flows"
      ? ["WORK", "PATCH", "TIMINGS", "LOG_PREFIX", "CONTAINER", "JOURNAL"]
      : ["WORK", "PATCH", "TIMINGS", "LOG_PREFIX", "CONTAINER"]
    for (const name of names) {
      const key = `${name}:${derived[name]}`
      assert.ok(!seen.has(key), `${name} collides across runs: ${derived[name]}`)
      seen.add(key)
    }
  }
}

// ---------------------------------------------------------------------------
// A tagged lane: `r90` is the full benchmark's flows attempt and `r90c` is the
// codex attempt the backfill runs over the same instances. They are two lanes,
// not two rounds, and every artifact of one must sit beside — never on top of —
// the artifact of the other.
// ---------------------------------------------------------------------------
const flowsLane = paths("flows", instance, "r90")
const codexLane = paths("codex", instance, "r90c")
assert.equal(codexLane.RUN_INDEX, "r90c")
assert.equal(codexLane.RUN_ID, `${instance}-r90c`)
assert.equal(codexLane.PATCH, join(root, "patches-codex", `${instance}-r90c.patch`))
assert.equal(codexLane.LOG_PREFIX, join(root, "logs-codex", `${instance}-r90c`))
assert.equal(codexLane.CONTAINER, "codexbench-django--django-16612-r90c")
assert.notEqual(codexLane.WORK, paths("codex", instance, "r90").WORK)
assert.notEqual(flowsLane.PATCH, paths("flows", instance, "r90c").PATCH)

// ---------------------------------------------------------------------------
// An artifact root somewhere else: `SWB_ARTIFACT_ROOT`
//
// The rule is the checkout's, moved. It exists so a test can drive this
// derivation without writing into the wave artifacts of the checkout it runs in
// — `fixtures/check-matrix.mjs` replays the matrix scheduler over fixed stub
// ids, and two of those replays at once would otherwise share one set of files.
// Unset, nothing about a production run changes; that is what every assertion
// above already reads.
// ---------------------------------------------------------------------------
const artifacts = mkdtempSync(join(tmpdir(), "swb-artifact-root-"))
try {
  const rooted = [
    "WORK_ROOT",
    "WORK",
    "VCS_ROOT",
    "VCS",
    "PATCH_ROOT",
    "PATCH",
    "TIMINGS_ROOT",
    "TIMINGS",
    "LOG_ROOT",
    "LOG_PREFIX",
    "JOURNAL_ROOT",
    "JOURNAL"
  ]
  for (const harness of ["flows", "codex"]) {
    for (const index of [undefined, "r3", "r90c"]) {
      const here = paths(harness, instance, index)
      const there = paths(harness, instance, index, root, root, { SWB_ARTIFACT_ROOT: artifacts })
      for (const name of rooted) {
        assert.equal(there[name], here[name].replace(root, artifacts), name)
      }
      // A container name is a docker name, not a path, so it is the same run
      // wherever its artifacts are written; so are the run's own identifiers.
      for (const name of ["RUN_INDEX", "RUN_ID", "SUFFIX", "CONTAINER"]) {
        assert.equal(there[name], here[name], name)
      }
      // Empty is unset: an exported-but-blank variable is the checkout.
      const blank = paths(harness, instance, index, root, root, { SWB_ARTIFACT_ROOT: "" })
      assert.deepEqual(blank, here)
    }
  }

  // Malformed roots stop here, for the same reason a malformed instance id
  // does: the value reaches a shell path and this script's output is `eval`ed.
  assert.match(
    refuses(["flows", instance, "r1"], { SWB_ARTIFACT_ROOT: "relative/artifacts" }),
    /SWB_ARTIFACT_ROOT must be an absolute path/u
  )
  assert.match(
    refuses(["flows", instance, "r1"], { SWB_ARTIFACT_ROOT: join(artifacts, "absent") }),
    /SWB_ARTIFACT_ROOT must be an existing directory/u
  )
  for (const separator of ["\n", "\r", "\r\n"]) {
    assert.match(
      refuses(["codex", instance], { SWB_ARTIFACT_ROOT: `${artifacts}${separator}$(touch marker)` }),
      /SWB_ARTIFACT_ROOT must not contain CR or LF/u
    )
  }
} finally {
  rmSync(artifacts, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// What it refuses, before any of it reaches a path or a container name
// ---------------------------------------------------------------------------
assert.match(refuses(["mystery", instance]), /harness must be flows or codex/u)
assert.match(refuses(["flows", "../escape"]), /instance id must match/u)
assert.match(refuses(["flows", "a__b/c"]), /instance id/u)
assert.match(refuses(["flows", instance, "3"]), /run index must match/u)
assert.match(refuses(["flows", instance, "r3/../.."]), /run index must match/u)
assert.match(refuses(["flows", instance, "r90C"]), /run index must match/u)
assert.match(refuses(["flows", instance, "rc"]), /run index must match/u)

// A matching line must never validate the rest of an argument. Evaluate even
// rejected output to prove neither input can smuggle a command into assignments.
const scratch = mkdtempSync(join(root, ".run-paths-"))
try {
  const probes = []
  for (const harness of ["flows", "codex"]) {
    for (const field of ["instance", "index"]) {
      for (const separator of ["\n", "\r", "\r\n"]) {
        const args = [harness, instance, "r1"]
        args[field === "instance" ? 1 : 2] += `${separator}$(touch marker)`
        const result = spawnSync(join(root, "lib/run-paths.sh"), args, { encoding: "utf8" })
        const evaluated = spawnSync("bash", ["-c", "eval \"$1\"", "run-paths-fixture", result.stdout], {
          encoding: "utf8",
          cwd: scratch
        })
        const executed = existsSync(join(scratch, "marker"))
        rmSync(join(scratch, "marker"), { force: true })
        probes.push({ harness, field, separator, status: result.status, output: result.stdout.length, executed })
        assert.equal(evaluated.error, undefined)
      }
    }
  }
  assert.deepEqual(probes, probes.map((probe) => ({ ...probe, status: 2, output: 0, executed: false })))

  for (const value of ["", "_a__b", "a___", "a__-b", "a__b/c", "a__bé", "a__b\n", "a__b\r"]) {
    refuses(["flows", value])
  }
  for (const value of ["r", "r1a2", "r1_", "r1é", "r1\n", "r1\r"]) {
    refuses(["codex", instance, value])
  }
  assert.equal(paths("flows", "A0._-__B1._-", "r12abc").RUN_ID, "A0._-__B1._--r12abc")

  // The checkout path is not an identifier. Preserve its bytes without running
  // either kind of command substitution or expanding shell metacharacters.
  const unusualRoot = join(scratch, "space ' quote\" $(touch marker) `touch marker` \\ $HOME\n\r")
  mkdirSync(join(unusualRoot, "lib"), { recursive: true })
  copyFileSync(join(root, "lib/run-paths.sh"), join(unusualRoot, "lib/run-paths.sh"))
  for (const harness of ["flows", "codex"]) {
    for (const index of [undefined, "r90c"]) {
      const expected = paths(harness, instance, index)
      const actual = paths(harness, instance, index, unusualRoot, scratch)
      assert.equal(existsSync(join(scratch, "marker")), false, "evaluating paths must not execute commands")
      for (const name of names) {
        assert.equal(actual[name], expected[name].replace(root, unusualRoot), name)
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// The run scripts derive their names from it rather than spelling them again
// ---------------------------------------------------------------------------
for (const script of ["run-instance.sh", "run-instance-codex.sh", "run-matrix.sh"]) {
  const source = readFileSync(join(root, script), "utf8")
  assert.match(source, /lib\/run-paths\.sh/u, `${script} derives its names from run-paths.sh`)
}

console.log("check-run-paths.mjs: per-run names are symmetric, distinct, and backwards compatible.")
