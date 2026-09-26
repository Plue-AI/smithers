/**
 * Pins the one-screen status against the budgets the driver actually accepts.
 *
 *   node fixtures/check-fullbench-status.mjs
 *
 * `fullbench-status.sh` is read against a live benchmark, so a ledger it cannot
 * render is a benchmark an operator cannot look at. The figure most likely to
 * be typed by hand is the budget, and `fullbench.sh` accepts more spellings of
 * it than JSON does: `.50` passes its guard, and `lib/fullbench-row.mjs` only
 * numbers a value with a digit before the decimal point, so that budget reaches
 * `fullbench/manifest.jsonl` as the string `.50`.
 *
 * So this runs the real script over synthesised ledgers carrying a string
 * budget, no budget and a budget that is not a number, and asserts the screen
 * and the checkpoint report print the same figure for each. Spends nothing,
 * needs no docker and no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { renderReport, summarise } from "../fullbench-report.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-status-"))

/** A stable clock, so the ledger's span is a pinned string rather than today's. */
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)

/** Writes a ledger whose header carries `budget`, and returns its path. */
const ledger = (name, budget) => {
  const path = join(temporary, `${name}.jsonl`)
  const header = { kind: "header", at: NOW, subject: "sha256:aaa", subjectSource: "preflight", jobs: 2 }
  if (budget !== undefined) header.budgetUsd = budget
  writeFileSync(
    path,
    `${
      [
        JSON.stringify(header),
        JSON.stringify({
          kind: "instance",
          id: "a__1",
          state: "ran",
          at: NOW + 1,
          wallSeconds: 900,
          cost: { usd: 1.5 }
        }),
        JSON.stringify({ kind: "instance", id: "a__1", state: "graded", at: NOW + 2, verdict: "resolved" })
      ].join("\n")
    }\n`
  )
  return path
}

/** The screen the operator sees, by running the script the entry point runs. */
const screen = (path) => {
  const out = spawnSync(
    "node",
    [join(root, "lib", "fullbench-status.mjs"), path, join(temporary, "no-dataset.json"), "stopped", "4096"],
    { encoding: "utf8" }
  )
  assert.equal(out.status, 0, `fullbench-status.mjs exited ${out.status}: ${out.stderr}`)
  return out.stdout
}

/** The budget as the checkpoint report spells it, over the same ledger. */
const reported = (path) =>
  renderReport(summarise({ manifest: path, now: NOW + 3600_000, total: 1 })).match(/\| cost budget \| (.+) \|/)[1]

try {
  // -----------------------------------------------------------------------
  // The driver accepts `.50`, and the ledger keeps it as text
  // -----------------------------------------------------------------------
  // Read out of `fullbench.sh` rather than restated, so a guard that tightens
  // retires this case instead of leaving it asserting a rule nobody enforces.
  const guard = readFileSync(join(root, "fullbench.sh"), "utf8").match(/case "\$BUDGET_USD" in[\s\S]*?\nesac/)[0]
  const accepts = (value) =>
    spawnSync("bash", ["-c", `set -u\nBUDGET_USD='${value}'\n${guard}\nexit 0`], { encoding: "utf8" }).status === 0
  assert.ok(accepts(".50"), "fullbench.sh accepts a leading-dot budget")
  assert.ok(!accepts("half"), "fullbench.sh rejects a budget that is not a number")

  const row = spawnSync(
    "node",
    [join(root, "lib", "fullbench-row.mjs"), "--kind", "header", "--budgetUsd", ".50"],
    { encoding: "utf8" }
  )
  assert.deepEqual(
    JSON.parse(row.stdout),
    { kind: "header", budgetUsd: ".50" },
    "a leading-dot budget reaches the ledger as text, which is why the screen must coerce"
  )

  // -----------------------------------------------------------------------
  // The screen renders every budget the report renders
  // -----------------------------------------------------------------------
  const stringBudget = ledger("string-budget", ".50")
  assert.match(screen(stringBudget), /spent {6}\$1\.50 of \$0\.50/, "a string budget renders instead of crashing")
  assert.equal(reported(stringBudget), "$0.50", "the report reads the same ledger the same way")

  const decimalString = ledger("decimal-string", "0.50")
  assert.match(screen(decimalString), /of \$0\.50/)

  const missingBudget = ledger("missing-budget", undefined)
  assert.match(screen(missingBudget), /of —/, "a header with no budget prints an absent figure")
  assert.equal(reported(missingBudget), "—")

  const invalidBudget = ledger("invalid-budget", "half a dollar")
  assert.match(screen(invalidBudget), /of —/, "a budget that is not a number prints as absent, not as NaN")
  assert.equal(reported(invalidBudget), "—")

  const numberBudget = ledger("number-budget", 600)
  assert.match(screen(numberBudget), /of \$600\.00/, "the ordinary numeric budget is unchanged")
  assert.equal(reported(numberBudget), "$600.00")

  console.log("check-fullbench-status.mjs: the status screen renders every budget the driver accepts.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
