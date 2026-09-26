/**
 * Pins what the evaluator is handed: which patches directory `evaluate.sh`
 * reads, and what `lib/make-preds.mjs` makes of a missing or an empty patch.
 *
 * The defect this guards: on 2026-09-26 a luna smoke run under
 * `SWB_ARTIFACT_ROOT` wrote a 643-byte patch there, `evaluate.sh` read the
 * checkout's `patches/` instead, and `make-preds.mjs` turned the missing file
 * into an empty prediction, so the run graded as "empty patch" — a rig fault
 * reported as a zero.
 *
 *   - a requested instance with no patch file is a refusal naming the path,
 *     never an empty prediction;
 *   - a 0-byte patch file is an empty prediction (the agent changed nothing);
 *   - `evaluate.sh` finds patches under `SWB_ARTIFACT_ROOT`, on both harnesses,
 *     through `lib/run-paths.sh --roots`, and takes an absolute `SWB_PATCHES`
 *     as well as one relative to the rig.
 *
 * Runs `evaluate.sh` with `SWB_PREDS_ONLY=1`, so it stops once the predictions
 * file is written. Spends no tokens, needs no docker, needs no evaluator venv.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const rig = resolve(import.meta.dirname, "..")
const makePreds = join(rig, "lib/make-preds.mjs")
const evaluate = join(rig, "evaluate.sh")
const scratch = mkdtempSync(join(tmpdir(), "swb-make-preds-"))
const runIds = []

const PATCH = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n"

try {
  // ---------------------------------------------------------------------------
  // make-preds.mjs
  // ---------------------------------------------------------------------------
  const dir = join(scratch, "patches")
  mkdirSync(dir)
  writeFileSync(join(dir, "a__a-1.patch"), PATCH)
  writeFileSync(join(dir, "a__a-2.patch"), "")
  writeFileSync(join(dir, "a__a-3-r2.patch"), PATCH)

  const preds = (args) => spawnSync("node", [makePreds, ...args], { encoding: "utf8" })

  const ok = preds([dir, "m", "", "a__a-1", "a__a-2"])
  assert.equal(ok.status, 0, ok.stderr)
  const parsed = JSON.parse(ok.stdout)
  assert.equal(parsed["a__a-1"].model_patch, PATCH)
  assert.equal(parsed["a__a-1"].model_name_or_path, "m")
  assert.equal(parsed["a__a-2"].model_patch, "", "a 0-byte patch file is an empty prediction")

  const suffixed = preds([dir, "m", "-r2", "a__a-3"])
  assert.equal(suffixed.status, 0, suffixed.stderr)
  assert.equal(JSON.parse(suffixed.stdout)["a__a-3"].model_patch, PATCH)

  const missing = preds([dir, "m", "", "a__a-1", "b__b-1", "c__c-1"])
  assert.equal(missing.status, 1, "a missing patch file is a refusal")
  assert.equal(missing.stdout, "", "a refusal prints no predictions")
  assert.match(missing.stderr, new RegExp(`no patch file at ${dir}/b__b-1\\.patch`, "u"))
  assert.match(missing.stderr, new RegExp(`no patch file at ${dir}/c__c-1\\.patch`, "u"))
  assert.doesNotMatch(missing.stderr, /a__a-1/u, "only the missing paths are named")

  const missingSuffix = preds([dir, "m", "-r2", "a__a-1"])
  assert.equal(missingSuffix.status, 1, "the suffixed name is the one that must exist")
  assert.match(missingSuffix.stderr, /a__a-1-r2\.patch/u)

  // ---------------------------------------------------------------------------
  // evaluate.sh's patches directory
  // ---------------------------------------------------------------------------
  let counter = 0
  const evaluateRun = (ids, env) => {
    const runId = `check-make-preds-${process.pid}-${counter++}`
    runIds.push(runId)
    const result = spawnSync(evaluate, [runId, ...ids], {
      encoding: "utf8",
      env: { ...process.env, SWB_ARTIFACT_ROOT: "", SWB_PATCHES: "", SWB_PATCH_SUFFIX: "", ...env, SWB_PREDS_ONLY: "1" }
    })
    const file = join(rig, `preds-${runId}.json`)
    const written = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
    return { ...result, preds: written }
  }

  // The reproduction: a patch written under SWB_ARTIFACT_ROOT, graded with it set.
  const artifacts = join(scratch, "artifacts")
  mkdirSync(join(artifacts, "patches"), { recursive: true })
  mkdirSync(join(artifacts, "patches-codex"), { recursive: true })
  const id = "stubpreds__stubpreds-16612"
  writeFileSync(join(artifacts, "patches", `${id}.patch`), PATCH)
  writeFileSync(join(artifacts, "patches-codex", `${id}.patch`), "")

  const flows = evaluateRun([id], { SWB_ARTIFACT_ROOT: artifacts })
  assert.equal(flows.status, 0, flows.stdout + flows.stderr)
  assert.equal(flows.preds[id].model_patch, PATCH, "flows patches are read under SWB_ARTIFACT_ROOT")
  assert.equal(flows.preds[id].model_name_or_path, "flows-cell-harness")

  const codex = evaluateRun([id], { SWB_ARTIFACT_ROOT: artifacts, HARNESS: "codex" })
  assert.equal(codex.status, 0, codex.stdout + codex.stderr)
  assert.equal(codex.preds[id].model_patch, "", "codex patches are read under SWB_ARTIFACT_ROOT")
  assert.equal(codex.preds[id].model_name_or_path, "codex-cli")

  // The roots evaluate.sh reads are the roots the run scripts write.
  const roots = spawnSync(join(rig, "lib/run-paths.sh"), ["flows", "--roots"], {
    encoding: "utf8",
    env: { ...process.env, SWB_ARTIFACT_ROOT: artifacts }
  })
  assert.equal(roots.status, 0, roots.stderr)
  assert.match(roots.stdout, new RegExp(`^PATCH_ROOT=${artifacts}/patches$`, "mu"))
  const perRun = spawnSync(join(rig, "lib/run-paths.sh"), ["flows", id], {
    encoding: "utf8",
    env: { ...process.env, SWB_ARTIFACT_ROOT: artifacts }
  })
  assert.match(perRun.stdout, new RegExp(`^PATCH=${artifacts}/patches/${id}\\.patch$`, "mu"))
  assert.equal(
    spawnSync(join(rig, "lib/run-paths.sh"), ["flows", "--roots", "r1"], { encoding: "utf8" }).status,
    2,
    "--roots takes no run index"
  )

  // The same run without SWB_ARTIFACT_ROOT reads the checkout, where the stub
  // id has no patch (and a fresh checkout has no patches/ at all): a refusal
  // naming the checkout path, never an empty grade.
  const unrooted = evaluateRun([id], {})
  assert.equal(unrooted.status, 1, "a patch that is not where evaluate.sh looks is a refusal")
  assert.equal(unrooted.preds, undefined, "a refusal leaves no predictions file")
  assert.match(unrooted.stdout + unrooted.stderr, new RegExp(`${rig}/patches`, "u"))

  // A patches directory that exists but lacks the requested id: the refusal
  // names the exact file and writes no predictions.
  const other = join(scratch, "other")
  mkdirSync(join(other, "patches"), { recursive: true })
  const absent = evaluateRun([id], { SWB_ARTIFACT_ROOT: other })
  assert.equal(absent.status, 1, absent.stdout + absent.stderr)
  assert.equal(absent.preds, undefined, "a refusal leaves no predictions file")
  assert.match(absent.stderr, new RegExp(`no patch file at ${other}/patches/${id}\\.patch`, "u"))

  // An invalid root is refused by the same validation run-paths.sh applies.
  const relative = evaluateRun([id], { SWB_ARTIFACT_ROOT: "relative/root" })
  assert.equal(relative.status, 2)
  assert.match(relative.stderr, /SWB_ARTIFACT_ROOT must be an absolute path/u)

  // SWB_PATCHES: absolute (an FB_DIR outside the rig) and relative to the rig.
  const absolute = evaluateRun([id], { SWB_PATCHES: join(artifacts, "patches") })
  assert.equal(absolute.status, 0, absolute.stdout + absolute.stderr)
  assert.equal(absolute.preds[id].model_patch, PATCH, "an absolute SWB_PATCHES is read as given")

  const relName = `.check-make-preds-${process.pid}`
  mkdirSync(join(rig, relName))
  try {
    writeFileSync(join(rig, relName, `${id}.patch`), PATCH)
    const rel = evaluateRun([id], { SWB_PATCHES: relName, SWB_ARTIFACT_ROOT: artifacts })
    assert.equal(rel.status, 0, rel.stdout + rel.stderr)
    assert.equal(rel.preds[id].model_patch, PATCH, "a relative SWB_PATCHES resolves against the rig")
  } finally {
    rmSync(join(rig, relName), { recursive: true, force: true })
  }

  console.log("check-make-preds: missing patch refused, empty patch empty, SWB_ARTIFACT_ROOT and SWB_PATCHES resolved")
} finally {
  for (const runId of runIds) rmSync(join(rig, `preds-${runId}.json`), { force: true })
  rmSync(scratch, { recursive: true, force: true })
}
