/**
 * Asserts the scorecard refuses to average two subjects into one wave.
 *
 *   node fixtures/check-agreement.mjs
 *
 * Run after `make-fixture.mjs` has materialized `fixtures/timings`. It re-scores
 * the same fixture wave three more times over copied timings — one instance
 * stamped with a different subject, one instance stamped with none, and a pin
 * that has moved since the instances ran — and checks the `agreement` line says
 * so each time.
 *
 * This is the assertion that makes the preconditions block worth reading. A
 * block that reports whatever it is handed would have printed a single tidy
 * stamp for wave 6, whose harness source changed three times in the two hours
 * around it.
 *
 * @since 0.1.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const here = import.meta.dirname
const rig = resolve(here, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-agreement-"))

/** Scores the fixture wave with the given timings and pin, and returns the card. */
const score = (timings, subject, out) => {
  const instances = JSON.parse(readFileSync(join(here, "mirror-results.json"), "utf8")).map((row) => row.id)
  const result = spawnSync(process.execPath, [
    join(rig, "scorecard.ts"),
    "--work",
    join(here, "work"),
    "--patches",
    join(here, "patches"),
    "--timings",
    timings,
    "--report",
    join(here, "flows-cell-harness.mirror.json"),
    "--subject",
    subject,
    "--out",
    out,
    "--instances",
    instances.join(",")
  ], { encoding: "utf8", cwd: rig })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(readFileSync(join(out, "scorecard.json"), "utf8"))
}

/** A copy of the fixture timings, with one instance's record rewritten. */
const timingsWith = (name, rewrite) => {
  const directory = join(temporary, name)
  cpSync(join(here, "timings"), directory, { recursive: true })
  const first = readdirSync(directory).sort()[0]
  const record = JSON.parse(readFileSync(join(directory, first), "utf8"))
  writeFileSync(join(directory, first), JSON.stringify(rewrite(record), undefined, 2))
  return directory
}

try {
  const pin = join(here, "subject.json")

  const mixed = score(
    timingsWith("mixed", (record) => ({ ...record, subject: "sha256:deadbeef" })),
    pin,
    temporary
  )
  assert.match(mixed.subject.agreement, /^MISMATCH: this wave ran 2 different subjects/, mixed.subject.agreement)

  const partial = score(
    timingsWith("partial", ({ subject: _dropped, ...record }) => record),
    pin,
    temporary
  )
  assert.match(
    partial.subject.agreement,
    /^partial: 1 of 5 instance\(s\) recorded no subject/,
    partial.subject.agreement
  )

  const moved = join(temporary, "moved-pin.json")
  writeFileSync(moved, JSON.stringify({ ...JSON.parse(readFileSync(pin, "utf8")), stamp: "sha256:moved" }))
  const stale = score(join(here, "timings"), moved, temporary)
  assert.match(stale.subject.agreement, /^MISMATCH: the instances ran /, stale.subject.agreement)

  const unpinned = score(join(here, "timings"), join(temporary, "absent.json"), temporary)
  assert.equal(unpinned.subject.stamp, undefined, "an unpinned wave reports no stamp")
  assert.match(unpinned.subject.agreement, /^one subject/, unpinned.subject.agreement)

  console.log("check-agreement.mjs: the scorecard states when a wave ran more than one subject.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
