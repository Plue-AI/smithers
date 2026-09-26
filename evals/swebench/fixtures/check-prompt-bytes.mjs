/**
 * Replays `lib/prompt-bytes.sh` over a synthesised wave.
 *
 * The number this script prints goes into a wave report as "what the prompts
 * weighed in the wild", so the two ways it could lie are pinned here: reading
 * the wrong interpreter out of the log, and rendering a prompt for an instance
 * the wave did not run. Both would look like data.
 *
 * What is pinned:
 *
 * - one row per `project interpreter` line, in the log's own order, and none
 *   for the instances that only appear in other lines;
 * - a container that answered nothing usable renders **without** the
 *   interpreter bullet and reports `none`, which is smaller than the same
 *   instance with the bullet — the wave stated no fact, so the report may not
 *   claim one;
 * - the summary line counts and totals exactly the rows above it.
 *
 * Needs the evaluator venv, because the prompt names the repository's own test
 * command and `lib/test-command.py` is the only thing that knows it. Spends no
 * tokens and needs no docker.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
if (!existsSync(join(root, ".venv-swb", "bin", "python"))) {
  console.log("check-prompt-bytes: skipped — no evaluator venv; run ./bootstrap.sh first")
  process.exit(0)
}

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-prompt-bytes-"))

// The repo and version are real, because `lib/test-command.py` resolves the
// runner out of the pinned evaluator's own table and a repository that table
// does not know has no command to render.
const instance = (id) => ({
  instance_id: id,
  repo: "django/django",
  version: "4.2",
  base_commit: "0f1e2d3c4b5a",
  problem_statement: "The reindexer drops the calendar attribute when the axis is empty.",
  FAIL_TO_PASS: ["tests/test_reindex.py::test_empty"],
  PASS_TO_PASS: [],
  patch: "",
  test_patch: ""
})

try {
  const dataset = join(temporary, "dataset.json")
  writeFileSync(
    dataset,
    JSON.stringify([instance("stub__told-1"), instance("stub__untold-2"), instance("stub__absent-3")])
  )

  const log = join(temporary, "driver.log")
  writeFileSync(
    log,
    [
      "2026-08-22T08:05:15Z run-45: 0 of 3 already re-run",
      "[stub__told-1-r92] project interpreter /opt/miniconda3/envs/testbed/bin/python",
      "[stub__untold-2-r92] project interpreter not measurable — the run discovers it",
      "[stub__absent-3-r92] capture base abc123",
      ""
    ].join("\n")
  )

  const run = spawnSync(join(root, "lib", "prompt-bytes.sh"), [log], {
    encoding: "utf8",
    env: { ...process.env, SWB_DATASET: dataset }
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)

  const lines = run.stdout.trim().split("\n")
  assert.equal(lines.length, 3, "one row per stated interpreter, plus the summary")

  const [told, untold, summary] = lines.map((line) => line.split("\t"))
  assert.equal(told[0], "stub__told-1")
  assert.equal(told[2], "/opt/miniconda3/envs/testbed/bin/python")
  assert.equal(untold[0], "stub__untold-2")
  assert.equal(untold[2], "none", "a fact the image would not answer is not reported as one")
  assert.ok(
    Number(told[1]) > Number(untold[1]),
    "the instance that was told the interpreter carries the bullet and is the larger prompt"
  )

  assert.deepEqual(summary.slice(0, 2), ["instances", "2"])
  assert.equal(Number(summary[3]), Number(told[1]) + Number(untold[1]), "the total is the rows above it")
  assert.equal(Number(summary[5]), Math.trunc((Number(told[1]) + Number(untold[1])) / 2))

  // A log from a wave that stated nothing is not a wave whose prompts weighed
  // zero; it is a question this script cannot answer, and it says so.
  const silent = join(temporary, "silent.log")
  writeFileSync(silent, "2026-08-22T08:05:15Z run-45: 0 of 3 already re-run\n")
  const quiet = spawnSync(join(root, "lib", "prompt-bytes.sh"), [silent], {
    encoding: "utf8",
    env: { ...process.env, SWB_DATASET: dataset }
  })
  assert.equal(quiet.status, 1)
  assert.match(quiet.stderr, /records no project interpreter line/)

  console.log(
    "check-prompt-bytes: one row per stated interpreter, an unstated one renders smaller, and the summary adds up."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
