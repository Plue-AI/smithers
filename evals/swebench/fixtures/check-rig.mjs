import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-rig-"))

try {
  const dataset = join(temporary, "dataset.json")
  writeFileSync(
    dataset,
    JSON.stringify([{
      instance_id: "django__django-1",
      repo: "django/django",
      version: "4.1",
      base_commit: "abc123",
      problem_statement: "Fix the redirect."
    }])
  )

  const generated = spawnSync(
    process.execPath,
    [
      join(root, "lib/write-flow.mjs"),
      dataset,
      "django__django-1",
      "openai:test",
      "test-container",
      "./tests/runtests.py --verbosity 2"
    ],
    { encoding: "utf8" }
  )
  assert.equal(generated.status, 0, generated.stderr)
  assert.match(generated.stdout, /\.\/tests\/runtests\.py --verbosity 2/)
  // The task commit is named in the opening sentence; the environment section
  // no longer teaches a diff against it, because the harness's own snapshots
  // are out of this repository and `git diff` reports the agent's edits.
  assert.match(generated.stdout, /at commit abc123\./)
  assert.match(generated.stdout, /Git in this checkout behaves normally/)
  assert.doesNotMatch(generated.stdout, /colocated with Jujutsu/)
  assert.doesNotMatch(generated.stdout, /FAIL_TO_PASS|PASS_TO_PASS/)

  // The preamble names the tools this harness actually ships. Both of these
  // taught the opposite until 2026-08-21, against tools that had already
  // changed underneath them: a whole-file `write` where `edit` anchors byte
  // exactly and answers with its hunk, and a hand-composed `docker exec` line
  // where `bash` takes the container as a field and builds the argv itself.
  // Teaching a tool the harness no longer offers is the same defect as not
  // offering it.
  assert.match(generated.stdout, /container: "test-container", cwd: "\/testbed"/)
  assert.match(generated.stdout, /interpreter: "python3", script:/)
  assert.doesNotMatch(generated.stdout, /docker exec/)
  assert.match(generated.stdout, /use the `edit` flow with an anchor a call just handed you/)
  assert.match(generated.stdout, /answers\n {2}with the hunk it applied/)
  assert.doesNotMatch(generated.stdout, /prefer the `write` flow/)

  const missing = spawnSync(
    process.execPath,
    [join(root, "lib/write-flow.mjs"), dataset, "django__django-1", "openai:test", "test-container"],
    { encoding: "utf8" }
  )
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /no test command given/)

  const valid = spawnSync(process.execPath, [join(root, "lib/validate-instance.mjs"), dataset, "django__django-1"], {
    encoding: "utf8"
  })
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(valid.stdout, "abc123")

  const traversal = spawnSync(join(root, "run-instance.sh"), ["../escape"], {
    encoding: "utf8",
    env: { ...process.env, SWB_DATASET: dataset }
  })
  assert.equal(traversal.status, 2)
  assert.match(traversal.stderr, /instance id must match/)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-rig.mjs: repository test runner and base-diff guidance are pinned.")
