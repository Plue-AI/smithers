/**
 * `codex-backfill.sh` evals `codex-backfill-queue.mjs --row <id>`, and two of
 * its lines carry verdict strings read off the flows and codex ledgers. A
 * verdict is data: it must come back out of `eval` byte for byte and run
 * nothing.
 *
 *   node fixtures/check-backfill-row.mjs
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swb-backfill-row-"))
try {
  const marker = join(temporary, "injected")
  const hostile = [
    `x"; touch ${marker}; echo "`,
    `$(touch ${marker})`,
    `\`touch ${marker}\``,
    `\\"; touch ${marker} #`,
    `'; touch ${marker}; '`,
    `a\ntouch ${marker}\n`,
    `$HOME \${IFS} !! *`
  ]
  for (const verdict of hostile) {
    const manifest = join(temporary, "manifest.jsonl")
    const codexManifest = join(temporary, "codex-manifest.jsonl")
    writeFileSync(manifest, `${JSON.stringify({ kind: "instance", id: "acme__x-1", state: "graded", verdict })}\n`)
    writeFileSync(codexManifest, `${JSON.stringify({ kind: "instance", id: "acme__x-1", verdict })}\n`)
    const script = [
      `eval "$(node "$1" "$2" "$3" --row acme__x-1)"`,
      `printf '%s\\0%s\\0%s' "$BACKFILL_STATE" "$FLOWS_VERDICT" "$CODEX_VERDICT"`
    ].join("\n")
    const run = spawnSync(
      "bash",
      ["-c", script, "bash", join(root, "lib", "codex-backfill-queue.mjs"), manifest, codexManifest],
      { encoding: "utf8" }
    )
    assert.equal(run.status, 0, run.stderr)
    assert.ok(!existsSync(marker), `the verdict ${JSON.stringify(verdict)} ran a command`)
    assert.deepEqual(run.stdout.split("\0"), ["done", verdict, verdict], "the verdict survives eval byte for byte")
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-backfill-row.mjs: a hostile ledger verdict survives codex-backfill.sh's eval as data.")
