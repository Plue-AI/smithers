/**
 * Builds the official evaluator's predictions file from collected patches.
 *
 *   node lib/make-preds.mjs <patches-dir> <model-name> <patch-suffix> <instance_id>...
 *
 * `patch-suffix` is appended to the instance id when naming the patch file, so
 * one round of a best-of-n matrix grades as `<id>-r3.patch` while the
 * predictions it produces are still keyed by `<id>` — which is the only key the
 * evaluator has. Pass an empty string for today's `<id>.patch` names.
 *
 * An empty (0-byte) patch file is an empty prediction, which the evaluator
 * grades as `empty patch` — the verdict for an agent that changed nothing.
 *
 * A missing patch file is an error, never an empty prediction. Every writer
 * (`run-instance.sh`, `run-instance-codex.sh`, the full-benchmark archives and
 * `select-candidate.mjs`) writes a patch file, empty or not, once a run
 * finishes, so a missing one is a run that never finished or a patches
 * directory that is not where the run wrote — the 2026-09-26 luna smoke graded
 * a 643-byte patch as empty because `evaluate.sh` read the checkout while the
 * run had written under `SWB_ARTIFACT_ROOT`. This exits 1 naming every missing
 * path and prints no predictions.
 */
import { existsSync, readFileSync } from "node:fs"

const [, , patchesDir, modelName, suffix, ...ids] = process.argv
const preds = {}
const missing = []
for (const id of ids) {
  const path = `${patchesDir}/${id}${suffix ?? ""}.patch`
  if (!existsSync(path)) {
    missing.push(path)
    continue
  }
  preds[id] = {
    instance_id: id,
    model_name_or_path: modelName,
    model_patch: readFileSync(path, "utf8")
  }
}
if (missing.length > 0) {
  for (const path of missing) console.error(`make-preds: no patch file at ${path}`)
  console.error(
    `make-preds: ${missing.length} requested instance(s) have no patch file; a missing patch is never an empty prediction`
  )
  process.exit(1)
}
process.stdout.write(JSON.stringify(preds, null, 2))
