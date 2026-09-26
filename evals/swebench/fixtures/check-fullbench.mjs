/**
 * Replays the full benchmark's ledger, queue and report over synthesised rows.
 *
 * The driver itself needs docker, an image and a funded key; the three things
 * that decide whether a two-day benchmark is trustworthy do not:
 *
 * - **the ledger's fold** — the last row per instance is that instance's state,
 *   a fresh attempt replaces a dead one's columns, and a line torn by a kill
 *   does not destroy the rows before it;
 * - **the resume boundary** — `graded` and `cleaned` are skipped, everything
 *   else re-runs, and the order is the seeded draw rather than the dataset's;
 * - **the report** — the scoreboard, the Wilson interval, the per-repo
 *   breakdown, the extrapolation, the pinned-five comparison, the exclusions
 *   `lib/excluded.mjs` names and the two denominators that travel with them,
 *   and the append-only checkpoint log.
 *
 * A copied worker rig also pins atomic archive publication and source recovery
 * with failing copy, link and rename commands, without touching real artifacts.
 * `fullbench-dryrun.sh` proves the other half — real pull, real extract, real
 * delete, real kill — for one 4 MB image. This file spends nothing, needs no
 * docker, and needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { renderCheckpoint, renderReport, summarise, wilson } from "../fullbench-report.mjs"
import { isDone, read } from "../lib/fullbench-manifest.mjs"
import { drawOrder } from "../lib/fullbench-queue.mjs"
import { PINNED } from "../lib/sample.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-fullbench-"))

/** A stable clock, so an ETA is a pinned string rather than today's date. */
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const HOUR = 3600_000

try {
  // Run the real worker in a copied rig so its shared-root paths stay isolated.
  for (
    const mode of [
      "patch-fail",
      "untracked-fail",
      "timings-fail",
      "log-fail",
      "journal-fail",
      "interrupted-copy",
      "corrupt",
      "journal-corrupt",
      "link-fail",
      "publish-fail",
      "success"
    ]
  ) {
    const rig = join(temporary, mode)
    const bin = join(rig, "bin")
    const fb = join(rig, "fullbench")
    const id = "archive__1"
    mkdirSync(bin, { recursive: true })
    cpSync(join(root, "lib"), join(rig, "lib"), { recursive: true })
    const script = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
    script("docker", "exit 0")
    script(
      "run",
      `
S="$RIG"
eval "$("$S/lib/run-paths.sh" flows "$1" "$4")"
mkdir -p "$PATCH_ROOT" "$JOURNAL/nested" "$TIMINGS_ROOT" "$LOG_ROOT"
printf 'paid patch' > "$PATCH"
printf 'untracked' > "$PATCH.untracked"
printf 'paid journal' > "$JOURNAL/engine.db"
printf 'hidden' > "$JOURNAL/.metadata"
printf 'nested' > "$JOURNAL/nested/frame"
printf '{"hostShell":"allowed"}' > "$TIMINGS"
printf 'run log' > "$LOG_PREFIX.run.log"
if [ "$ARCHIVE_MODE" = patch-fail ]; then
  printf '{"kind":"instance","id":"torn' >> "$FB_DIR/manifest.jsonl"
fi
`
    )
    script("grade", "touch \"$RIG/graded\"")
    script(
      "cp",
      `
case "$ARCHIVE_MODE" in
  patch-fail) exit 1 ;;
  interrupted-copy) kill -TERM $$ ;;
  untracked-fail) case "$*" in *.untracked*) exit 1 ;; esac ;;
  timings-fail) case "$*" in *timings/*) exit 1 ;; esac ;;
  log-fail) case "$*" in *.run.log*) exit 1 ;; esac ;;
  journal-fail) case "$*" in *journals/*) exit 1 ;; esac ;;
esac
/bin/cp "$@"
if [ "$ARCHIVE_MODE" = corrupt ]; then
  for last; do :; done
  if [ -f "$last" ]; then printf 'fake patch' > "$last"; fi
fi
if [ "$ARCHIVE_MODE" = journal-corrupt ]; then
  for last; do :; done
  if [ -d "$last" ]; then printf 'fake journal' > "$last/engine.db"; fi
fi
`
    )
    script("ln", "if [ \"$ARCHIVE_MODE\" = link-fail ]; then exit 1; fi\n/bin/ln \"$@\"")
    script(
      "mv",
      `
test ! -e "$FB_DIR/patches/archive__1.patch"
test ! -e "$FB_DIR/journals/archive__1"
test -f "$RIG/patches/archive__1-r90.patch"
test -f "$RIG/journals/archive__1-r90/engine.db"
if [ "$ARCHIVE_MODE" = publish-fail ]; then exit 1; fi
/bin/mv "$@"
`
    )
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RIG: rig,
      ARCHIVE_MODE: mode,
      FB_DIR: fb,
      SWB_RUN_CMD: join(bin, "run"),
      SWB_GRADE_CMD: join(bin, "grade"),
      SWB_DISK_FREE_MIB: "999999",
      SWB_FULLBENCH_INDEX: "r90",
      SWB_FULLBENCH_PINNED: id,
      SWB_EVAL_LOG_ROOT: join(rig, "eval-logs")
    }
    const worker = spawnSync("bash", [join(rig, "lib", "fullbench-instance.sh"), id], {
      env,
      encoding: "utf8",
      timeout: 30_000
    })
    assert.ifError(worker.error)
    const patch = join(rig, "patches", `${id}-r90.patch`)
    const journal = join(rig, "journals", `${id}-r90`)
    const state = read(join(fb, "manifest.jsonl")).states.get(id)
    if (mode === "success") {
      assert.equal(worker.status, 0, worker.stderr)
      assert.equal(existsSync(patch), false)
      assert.equal(existsSync(journal), false)
      assert.equal(readFileSync(join(fb, "patches", `${id}.patch`), "utf8"), "paid patch")
      assert.equal(readFileSync(join(fb, "patches", `${id}.patch.untracked`), "utf8"), "untracked")
      assert.equal(readFileSync(join(fb, "timings", `${id}.json`), "utf8"), "{\"hostShell\":\"allowed\"}")
      assert.equal(readFileSync(join(fb, "logs", `${id}.run.log`), "utf8"), "run log")
      // The host-shell condition travels off the timings into the ledger row,
      // beside testbedNetwork, so a report reads it rather than assumes it.
      const ran = readFileSync(join(fb, "manifest.jsonl"), "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).find((row) => row.kind === "instance" && row.state === "ran")
      assert.equal(ran.hostShell, "allowed", "the ran row records the flows arm's host shell")
      assert.equal(ran.testbedNetwork, "none")
      for (
        const [file, content] of [["engine.db", "paid journal"], [".metadata", "hidden"], ["nested/frame", "nested"]]
      ) {
        assert.equal(readFileSync(join(fb, "journals", id, file), "utf8"), content)
      }
      assert.equal(existsSync(join(rig, "graded")), true)
      assert.equal(state.state, "cleaned")
    } else {
      assert.notEqual(worker.status, 0, `${mode}: archive failure must stop the worker`)
      assert.equal(readFileSync(patch, "utf8"), "paid patch", `${mode}: patch survives`)
      assert.equal(readFileSync(join(journal, "engine.db"), "utf8"), "paid journal", `${mode}: journal survives`)
      assert.equal(readFileSync(`${patch}.untracked`, "utf8"), "untracked")
      assert.equal(readFileSync(join(rig, "timings", `${id}-r90.json`), "utf8"), "{\"hostShell\":\"allowed\"}")
      assert.equal(readFileSync(join(rig, "logs-agent", `${id}-r90.run.log`), "utf8"), "run log")
      assert.equal(existsSync(join(fb, "patches", `${id}.patch`)), false)
      assert.equal(existsSync(join(fb, "journals", id)), false)
      assert.equal(existsSync(join(rig, "graded")), false)
      assert.equal(state.state, "failed")
      assert.equal(state.reason, "archive-failed")
      assert.equal(isDone(state), false, "archive failure remains retryable")
      assert.deepEqual(readdirSync(join(fb, "archives")), [], "no archive or staging directory is left")
      assert.deepEqual(readdirSync(join(fb, "patches")), [], "no dangling patch link is left")
      assert.deepEqual(readdirSync(join(fb, "journals")), [], "no dangling journal link is left")

      if (mode === "patch-fail") {
        assert.equal(
          read(join(fb, "manifest.jsonl")).malformed.length,
          1,
          "the failed row survives appending after a torn tail (fixed before review)"
        )
        // The next attempt must archive these bytes before its purge overwrites
        // them. Different contents distinguish recovery from the fresh attempt.
        writeFileSync(patch, "earlier paid patch")
        writeFileSync(join(journal, "engine.db"), "earlier paid journal")
        const retry = spawnSync("bash", [join(rig, "lib", "fullbench-instance.sh"), id], {
          env: { ...env, ARCHIVE_MODE: "success" },
          encoding: "utf8",
          timeout: 30_000
        })
        assert.ifError(retry.error)
        assert.equal(retry.status, 0, retry.stderr)
        const recovered = readdirSync(join(fb, "archives")).filter((name) => name.startsWith(`${id}.recovered-`))
        assert.equal(recovered.length, 1)
        assert.equal(readFileSync(join(fb, "archives", recovered[0], "patch"), "utf8"), "earlier paid patch")
        assert.equal(
          readFileSync(join(fb, "archives", recovered[0], "journal", "engine.db"), "utf8"),
          "earlier paid journal"
        )
        assert.equal(readFileSync(join(fb, "patches", `${id}.patch`), "utf8"), "paid patch")
      }
    }
  }

  // -----------------------------------------------------------------------
  // The Wilson interval
  // -----------------------------------------------------------------------
  const eight = wilson(8, 25)
  assert.ok(Math.abs(eight.point - 0.32) < 1e-12)
  assert.ok(Math.abs(eight.low - 0.17205190) < 1e-7, `low was ${eight.low}`)
  assert.ok(Math.abs(eight.high - 0.51589731) < 1e-7, `high was ${eight.high}`)

  // The two ends the normal approximation gets wrong, which is why this is
  // Wilson: a zero rate still has an upper bound, and a perfect one still has a
  // lower bound, and neither escapes [0, 1].
  const none = wilson(0, 10)
  assert.equal(none.low, 0)
  assert.ok(none.high > 0.25 && none.high < 0.35, `high was ${none.high}`)
  const all = wilson(10, 10)
  assert.ok(all.high > 0.9999, `high was ${all.high}`)
  assert.ok(all.low > 0.65 && all.low < 0.75, `low was ${all.low}`)
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1, point: 0 })

  // -----------------------------------------------------------------------
  // The ledger's fold
  // -----------------------------------------------------------------------
  const foldPath = join(temporary, "fold.jsonl")
  writeFileSync(
    foldPath,
    [
      JSON.stringify({ kind: "header", at: NOW, subject: "s1", jobs: 2 }),
      // One instance that crashed after `ran`, then re-ran and finished. The
      // dead attempt's patch size and exit status must not survive.
      JSON.stringify({ kind: "instance", id: "a__1", state: "pulled", at: NOW }),
      JSON.stringify({ kind: "instance", id: "a__1", state: "ran", at: NOW + 1, patchBytes: 999, exit: 124 }),
      JSON.stringify({ kind: "instance", id: "a__1", state: "pulled", at: NOW + 2 }),
      JSON.stringify({ kind: "instance", id: "a__1", state: "ran", at: NOW + 3, patchBytes: 40, exit: 0 }),
      JSON.stringify({ kind: "instance", id: "a__1", state: "graded", at: NOW + 4, verdict: "resolved" }),
      JSON.stringify({ kind: "note", at: NOW + 5, note: "head-moved", from: "aaa", to: "bbb" }),
      // A row torn by a kill, mid-write. Everything above it still counts.
      "{\"kind\":\"instance\",\"id\":\"b__2\",\"state\":\"ra"
    ].join("\n")
  )
  const folded = read(foldPath)
  assert.equal(folded.torn, 1, "the torn tail is reported, not thrown")
  assert.equal(folded.malformed.length, 0)
  assert.equal(folded.states.size, 1, "the torn line contributed no instance")
  const a1 = folded.states.get("a__1")
  assert.equal(a1.state, "graded")
  assert.equal(a1.verdict, "resolved")
  assert.equal(a1.patchBytes, 40, "the re-run's patch size, not the attempt that died")
  assert.equal(a1.exit, 0, "the re-run's exit status, not the attempt that died")
  assert.equal(folded.notes.length, 1)
  assert.equal(folded.header.subject, "s1")

  assert.equal(isDone({ state: "graded" }), true)
  assert.equal(isDone({ state: "cleaned" }), true)
  assert.equal(isDone({ state: "ran" }), false)
  assert.equal(isDone({ state: "pulled" }), false)
  assert.equal(isDone({ state: "failed" }), false)
  assert.equal(isDone(undefined), false)

  // A ledger that does not exist yet is an empty one, not an error: that is the
  // first thing a brand new benchmark reads.
  assert.deepEqual(read(join(temporary, "absent.jsonl")).states.size, 0)

  // -----------------------------------------------------------------------
  // Appending after a torn tail
  // -----------------------------------------------------------------------
  // The kill that tore the last line does not end the benchmark; the resumed
  // driver appends to the same file. A row written straight after an
  // unterminated fragment fuses with it into one line that parses as neither,
  // and the row that was just fsynced — a verdict, or an attempt the card was
  // charged for — is the half that disappears from every reader while the
  // fragment survives. The appender closes the fragment first, and the report
  // says the line is there rather than dropping it in silence.
  const appendPath = join(temporary, "append.jsonl")
  const append = (path, row) =>
    spawnSync(
      "node",
      [join(root, "lib", "manifest-append.mjs"), path, JSON.stringify(row)],
      { encoding: "utf8" }
    )
  writeFileSync(
    appendPath,
    [
      JSON.stringify({ kind: "header", at: NOW, subject: "s1", jobs: 2, budgetUsd: 600 }),
      JSON.stringify({ kind: "instance", id: "c__1", state: "ran", at: NOW + 1, cost: { usd: 7 } }),
      // Torn by the kill: the record stops mid-write, with no newline after it.
      "{\"kind\":\"instance\",\"id\":\"d__2\",\"state\":"
    ].join("\n")
  )
  assert.equal(read(appendPath).torn, 1, "the fixture starts from a torn tail")
  const resumed = append(appendPath, { kind: "instance", id: "e__3", state: "ran", at: NOW + 2, cost: { usd: 20 } })
  assert.equal(resumed.status, 0, resumed.stderr)
  const afterTear = read(appendPath)
  assert.ok(afterTear.states.has("e__3"), "the row appended after a torn tail is still a row")
  assert.equal(afterTear.states.get("e__3").cost.usd, 20)
  assert.equal(afterTear.torn, 0, "the fragment is closed, so nothing is torn any more")
  assert.deepEqual(afterTear.malformed.map((entry) => entry.line), [3], "the fragment is reported, not hidden")
  const tornBill = summarise({ manifest: appendPath, now: NOW + 3 * HOUR, total: 3 })
  assert.equal(tornBill.spentUsd, 27, "both paid attempts are on the bill")
  assert.deepEqual(tornBill.malformed.map((entry) => entry.line), [3])
  assert.match(renderReport(tornBill), /\*\*1 manifest line\(s\) could not be parsed\*\*/)

  // A file that already ends in a newline gets no blank line, so no line number
  // shifts under the reader that just reported one.
  const afterNote = append(appendPath, { kind: "note", at: NOW + 4, note: "resumed" })
  assert.equal(afterNote.status, 0, afterNote.stderr)
  const noted = read(appendPath)
  assert.equal(noted.notes.length, 1)
  assert.deepEqual(noted.malformed.map((entry) => entry.line), [3], "no line was inserted or shifted")

  // A ledger that does not exist yet starts with the row, not with a newline.
  const freshPath = join(temporary, "fresh.jsonl")
  const header = { kind: "header", at: NOW, subject: "s1", jobs: 1 }
  const fresh = append(freshPath, header)
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.equal(readFileSync(freshPath, "utf8"), `${JSON.stringify(header)}\n`)

  // -----------------------------------------------------------------------
  // The bill counts attempts; the fold counts instances
  // -----------------------------------------------------------------------
  // The same replacement that keeps a dead attempt's verdict out of the ledger
  // would keep its tokens out of the budget, and the tokens were still spent.
  // A benchmark that crashes and resumes ten times must not be able to spend
  // past its cap because the cap only ever saw the last attempt of each.
  const billPath = join(temporary, "bill.jsonl")
  const usage = { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 1_000, reasoningTokens: 0 }
  writeFileSync(
    billPath,
    `${
      [
        JSON.stringify({ kind: "header", at: NOW, subject: "s1", jobs: 2, budgetUsd: 600 }),
        JSON.stringify({ kind: "instance", id: "a__1", state: "pulled", at: NOW }),
        JSON.stringify({
          kind: "instance",
          id: "a__1",
          state: "ran",
          at: NOW + 1,
          wallSeconds: 900,
          cost: { usd: 1.5, usage }
        }),
        // The crash, and the attempt that replaced it.
        JSON.stringify({ kind: "instance", id: "a__1", state: "pulled", at: NOW + 2 }),
        JSON.stringify({
          kind: "instance",
          id: "a__1",
          state: "ran",
          at: NOW + 3,
          wallSeconds: 900,
          cost: { usd: 2, usage }
        }),
        JSON.stringify({ kind: "instance", id: "a__1", state: "graded", at: NOW + 4, verdict: "resolved" }),
        JSON.stringify({ kind: "instance", id: "a__1", state: "cleaned", at: NOW + 5 })
      ].join("\n")
    }\n`
  )
  const bill = summarise({ manifest: billPath, now: NOW + HOUR, total: 1 })
  assert.equal(bill.graded, 1, "one instance was graded")
  assert.equal(bill.attempts, 2, "two attempts were paid for")
  assert.equal(bill.retried, 1)
  assert.ok(Math.abs(bill.spentUsd - 3.5) < 1e-9, `spent ${bill.spentUsd}`)
  assert.ok(Math.abs(bill.meanUsd - 1.75) < 1e-9, `mean ${bill.meanUsd}`)
  assert.equal(bill.tokens.inputTokens, 200_000, "both attempts' tokens are on the bill")
  assert.match(renderReport(bill), /\| paid attempts \| 2 \(1 re-run after a crash, and still on the bill\) \|/)

  const billCents = spawnSync(
    "node",
    [join(root, "fullbench-report.mjs"), "--spend-cents", "--manifest", billPath],
    { encoding: "utf8" }
  )
  assert.equal(billCents.status, 0, billCents.stderr)
  assert.equal(
    billCents.stdout.trim(),
    "350",
    "the gate the driver reads before every launch sees both attempts"
  )

  // -----------------------------------------------------------------------
  // The scoreboard obeys `lib/excluded.mjs`, and prints both denominators
  // -----------------------------------------------------------------------
  // This report reads the same ledgers `compare-runs.mjs` does, so an instance
  // whose verdict is a statement about the grading environment has to be
  // outside its rate too — and the raw count has to be printed beside the
  // scored one, or a reader has no way to tell which number they were handed.
  const scopedPath = join(temporary, "scoped.jsonl")
  writeFileSync(
    scopedPath,
    `${
      [
        JSON.stringify({ kind: "header", at: NOW, subject: "s1", jobs: 2 }),
        JSON.stringify({ kind: "instance", id: "a__1", state: "graded", at: NOW + 1, verdict: "resolved" }),
        JSON.stringify({ kind: "instance", id: "a__2", state: "graded", at: NOW + 2, verdict: "unresolved" }),
        // The pair the r92 report rules out by name: graded, and graded on the
        // environment rather than on a harness.
        JSON.stringify({
          kind: "instance",
          id: "psf__requests-1766",
          state: "graded",
          at: NOW + 3,
          verdict: "unresolved"
        }),
        JSON.stringify({
          kind: "instance",
          id: "psf__requests-2317",
          state: "graded",
          at: NOW + 4,
          verdict: "unresolved"
        })
      ].join("\n")
    }\n`
  )
  const scoped = summarise({ manifest: scopedPath, now: NOW + HOUR, total: 4 })
  assert.equal(scoped.graded, 4, "every row was graded")
  assert.equal(scoped.scoredGraded, 2, "the two named rows are outside the scored denominator")
  assert.equal(scoped.resolved, 1)
  assert.equal(scoped.scoredResolved, 1, "neither excluded row resolved, so the numerator is unchanged")
  assert.equal(scoped.excluded.length, 2)
  assert.ok(Math.abs(scoped.rate.point - 0.25) < 1e-12, `raw rate was ${scoped.rate.point}`)
  assert.ok(Math.abs(scoped.scoredRate.point - 0.5) < 1e-12, `scored rate was ${scoped.scoredRate.point}`)
  const scopedReport = renderReport(scoped)
  assert.match(scopedReport, /\*\*Resolve rate 50\.0%\*\* over 2 scored of 4 run/, "both denominators, one sentence")
  assert.match(scopedReport, /over all 4 graded, excluded rows included, it is 25\.0%/)
  assert.match(scopedReport, /\| \*\*scored\*\* \| \*\*2\*\* \| of 4 graded \|/)
  assert.match(scopedReport, /## Excluded from the scoreboard, by name/)
  assert.match(scopedReport, /psf__requests-1766/)
  for (const row of scoped.excluded) {
    assert.ok(row.cause.length > 0, `${row.id} carries no cause`)
  }

  // A population that excludes nothing reads exactly as it did before: same
  // sentence, one denominator, no section.
  const plain = summarise({ manifest: billPath, now: NOW + HOUR, total: 1 })
  assert.equal(plain.excluded.length, 0)
  assert.equal(plain.scoredGraded, plain.graded)
  assert.match(renderReport(plain), /\*\*Resolve rate 100\.0%\*\* \(95% Wilson/)
  assert.ok(
    !renderReport(plain).includes("Excluded from the scoreboard"),
    "nothing excluded means no section"
  )

  // -----------------------------------------------------------------------
  // `--unclean`: the instances whose images nothing will ever revisit
  // -----------------------------------------------------------------------
  const uncleanDataset = join(temporary, "unclean-dataset.json")
  writeFileSync(
    uncleanDataset,
    JSON.stringify([{ instance_id: "u__1" }, { instance_id: "u__2" }, { instance_id: "u__3" }])
  )
  const uncleanPath = join(temporary, "unclean.jsonl")
  writeFileSync(
    uncleanPath,
    `${
      [
        // Killed between the verdict and the `docker rmi`: done as far as
        // resume is concerned, so nothing ever looks at its image again.
        JSON.stringify({
          kind: "instance",
          id: "u__1",
          state: "graded",
          at: NOW,
          verdict: "resolved",
          image: "img/u1:latest"
        }),
        JSON.stringify({
          kind: "instance",
          id: "u__2",
          state: "cleaned",
          at: NOW,
          verdict: "unresolved",
          image: "img/u2:latest"
        }),
        // Interrupted before its verdict: the queue re-runs it, so its own
        // purge deals with the image and this sweep must leave it alone.
        JSON.stringify({ kind: "instance", id: "u__3", state: "ran", at: NOW, image: "img/u3:latest" })
      ].join("\n")
    }\n`
  )
  const unclean = spawnSync(
    "node",
    [join(root, "lib", "fullbench-queue.mjs"), uncleanDataset, uncleanPath, "--unclean"],
    { encoding: "utf8" }
  )
  assert.equal(unclean.status, 0, unclean.stderr)
  assert.equal(unclean.stdout.trim(), "u__1 img/u1:latest")

  // -----------------------------------------------------------------------
  // The queue: seeded draw order, and the resume boundary
  // -----------------------------------------------------------------------
  // A dataset that holds the pinned five but does not draw them first is a
  // dataset revision that moved under the drive, and is refused.
  assert.throws(
    () => drawOrder([...PINNED, "extra__one", "extra__two"].map((id) => ({ instance_id: id }))),
    /did not reproduce the pinned instances/,
    "a dataset that does not draw the pinned head first is refused, not benchmarked"
  )
  // A dataset of any size that does not hold them at all is not the benchmark.
  assert.throws(
    () => drawOrder(["a__1", "b__2", "c__3", "d__4", "e__5", "f__6"].map((id) => ({ instance_id: id }))),
    /is not SWE-bench Verified/,
    "a dataset with none of the pinned instances cannot be the benchmark"
  )
  // The one exception, and it is small enough that nothing real fits through
  // it: the three-instance stub `fullbench-dryrun.sh` builds.
  assert.equal(drawOrder([{ instance_id: "s__a" }, { instance_id: "s__b" }]).length, 2)

  const dataset = join(root, "swb-verified.json")
  if (existsSync(dataset)) {
    const rows = JSON.parse(readFileSync(dataset, "utf8"))
    const order = drawOrder(rows)
    assert.equal(order.length, rows.length, "every instance is queued exactly once")
    assert.equal(new Set(order).size, rows.length)
    assert.deepEqual(order.slice(0, PINNED.length), PINNED, "the pinned five come first")

    const queuePath = join(temporary, "queue.jsonl")
    writeFileSync(
      queuePath,
      [
        JSON.stringify({ kind: "instance", id: order[0], state: "cleaned", at: NOW, verdict: "resolved" }),
        JSON.stringify({ kind: "instance", id: order[1], state: "graded", at: NOW, verdict: "unresolved" }),
        // Interrupted: the driver died between `ran` and `graded`.
        JSON.stringify({ kind: "instance", id: order[2], state: "ran", at: NOW, patchBytes: 12 }),
        JSON.stringify({ kind: "instance", id: order[3], state: "failed", at: NOW, reason: "pull" }),
        ""
      ].join("\n")
    )
    const remaining = spawnSync(
      "node",
      [join(root, "lib", "fullbench-queue.mjs"), dataset, queuePath, "--remaining"],
      { encoding: "utf8" }
    )
    assert.equal(remaining.status, 0, remaining.stderr)
    const left = remaining.stdout.trim().split("\n")
    assert.equal(left.length, rows.length - 2, "only `graded` and `cleaned` are skipped")
    assert.equal(left[0], order[2], "the interrupted instance re-runs, first")
    assert.equal(left[1], order[3], "so does the one that failed")
    assert.ok(!left.includes(order[0]) && !left.includes(order[1]))

    const counts = spawnSync(
      "node",
      [join(root, "lib", "fullbench-queue.mjs"), dataset, queuePath, "--count"],
      { encoding: "utf8" }
    )
    assert.equal(counts.stdout.trim(), `2 ${rows.length - 2} ${rows.length}`)
  }

  // -----------------------------------------------------------------------
  // Two sessions: the subject of record is the first, the settings are the
  // session in effect, and a subject that moved between them is stated
  // -----------------------------------------------------------------------
  const sessionsPath = join(temporary, "sessions.jsonl")
  writeFileSync(
    sessionsPath,
    `${
      [
        JSON.stringify({
          kind: "header",
          at: NOW,
          subject: "sha256:aaa",
          subjectSource: "preflight",
          head: "h1",
          jobs: 2,
          budgetUsd: 600
        }),
        JSON.stringify({
          kind: "header",
          at: NOW + HOUR,
          subject: "sha256:aaa",
          subjectSource: "adopted",
          head: "h2",
          jobs: 3,
          budgetUsd: 900
        })
      ].join("\n")
    }\n`
  )
  const twoSessions = summarise({ manifest: sessionsPath, now: NOW + 2 * HOUR, total: 4 })
  assert.equal(twoSessions.header.subject, "sha256:aaa")
  assert.equal(twoSessions.elapsedSeconds, 2 * 3600, "the ledger spans from the first session, not the latest")
  assert.equal(twoSessions.header.head, "h1", "the subject of record is the first session's")
  assert.equal(twoSessions.header.jobs, 3, "the settings are the session in effect")
  assert.equal(twoSessions.header.budgetUsd, 900)
  assert.equal(twoSessions.subjectAgreement, "one subject")

  writeFileSync(
    sessionsPath,
    `${
      [
        JSON.stringify({ kind: "header", at: NOW, subject: "sha256:aaa", jobs: 2 }),
        JSON.stringify({ kind: "header", at: NOW + HOUR, subject: "sha256:bbb", jobs: 2 })
      ].join("\n")
    }\n`
  )
  // A budget spliced through the shell arrives as text. The report prints it as
  // money rather than stopping the checkpoint that carries the pause notice.
  const rowOut = spawnSync(
    "node",
    [join(root, "lib", "fullbench-row.mjs"), "--kind", "header", "--budgetUsd", "0.50", "--jobs", "2", "--id", "a__1"],
    { encoding: "utf8" }
  )
  assert.deepEqual(JSON.parse(rowOut.stdout), { kind: "header", budgetUsd: 0.5, jobs: 2, id: "a__1" })
  assert.match(
    renderReport({ ...twoSessions, header: { ...twoSessions.header, budgetUsd: "0.50" } }),
    /\| cost budget \| \$0\.50 \|/
  )

  const moved = summarise({ manifest: sessionsPath, now: NOW + 2 * HOUR, total: 4 })
  assert.match(moved.subjectAgreement, /^MISMATCH: 1 of 2 sessions ran a different subject \(sha256:bbb\)/)
  assert.match(renderReport(moved), /\| subject agreement \| MISMATCH:/)

  // -----------------------------------------------------------------------
  // The report, over a synthesised 25-instance checkpoint
  // -----------------------------------------------------------------------
  const out = join(temporary, "fullbench")
  mkdirSync(out, { recursive: true })
  const manifestPath = join(out, "manifest.jsonl")

  // A dataset of exactly the ids the ledger names, so the per-repo breakdown is
  // checkable without the real 8 MB file.
  const repos = ["django/django", "sympy/sympy", "sphinx-doc/sphinx"]
  const ids = []
  const datasetRows = []
  for (let index = 0; index < 30; index++) {
    const repo = repos[index % repos.length]
    const id = `${repo.split("/")[1]}__case-${index}`
    ids.push(id)
    datasetRows.push({ instance_id: id, repo })
  }
  const syntheticDataset = join(temporary, "dataset.json")
  writeFileSync(syntheticDataset, JSON.stringify(datasetRows))

  // 25 graded: 8 resolved, 13 unresolved, 3 empty, 1 eval error. One more
  // failed before a verdict and one is still in flight, so the scoreboard has
  // to keep all four columns apart.
  const verdicts = []
  for (let index = 0; index < 25; index++) {
    verdicts.push(
      index < 8 ? "resolved" : index < 21 ? "unresolved" : index < 24 ? "empty patch" : "eval error"
    )
  }
  const rows = [
    JSON.stringify({
      kind: "header",
      at: NOW,
      runId: "fullbench",
      index: "r90",
      subject: "sha256:deadbeef",
      subjectSource: "adopted",
      head: "abc1234",
      seat: "openai:gpt-5.6-sol",
      jobs: 2,
      instanceBudgetSeconds: 1200,
      budgetUsd: 600,
      minFreeMiB: 8192,
      checkpointEvery: 25,
      pinnedImages: `${ids[0]} ${ids[1]} ${ids[2]} ${ids[3]} ${ids[4]}`,
      dataset: syntheticDataset
    })
  ]
  for (const [index, verdict] of verdicts.entries()) {
    const at = NOW + index * HOUR
    rows.push(JSON.stringify({ kind: "instance", id: ids[index], state: "pulled", at, image: "img" }))
    rows.push(JSON.stringify({
      kind: "instance",
      id: ids[index],
      state: "ran",
      at: at + 60_000,
      patchBytes: verdict === "empty patch" ? 0 : 800,
      exit: 0,
      wallSeconds: 900,
      cost: {
        seat: "openai:gpt-5.6-sol",
        frames: 7,
        modelCalls: 11,
        usage: { inputTokens: 200_000, cachedInputTokens: 100_000, outputTokens: 8_000, reasoningTokens: 4_000 },
        usd: 1.3
      }
    }))
    rows.push(JSON.stringify({ kind: "instance", id: ids[index], state: "graded", at: at + 120_000, verdict }))
    rows.push(JSON.stringify({ kind: "instance", id: ids[index], state: "cleaned", at: at + 130_000 }))
  }
  rows.push(
    JSON.stringify({
      kind: "instance",
      id: ids[25],
      state: "failed",
      at: NOW + 26 * HOUR,
      reason: "docker pull failed"
    })
  )
  rows.push(
    JSON.stringify({
      kind: "instance",
      id: ids[26],
      state: "ran",
      at: NOW + 27 * HOUR,
      patchBytes: 10,
      wallSeconds: 100
    })
  )
  rows.push(JSON.stringify({ kind: "note", at: NOW + 27 * HOUR, note: "head-moved", from: "abc1234", to: "def5678" }))
  writeFileSync(manifestPath, `${rows.join("\n")}\n`)
  writeFileSync(
    join(out, "waits.jsonl"),
    `${
      [
        JSON.stringify({
          kind: "wait",
          id: ids[3],
          phase: "pull",
          at: NOW,
          freeMiB: 5000,
          neededMiB: 8192,
          waitedSeconds: 0
        }),
        JSON.stringify({
          kind: "wait",
          id: ids[3],
          phase: "pull",
          at: NOW + 60_000,
          freeMiB: 6000,
          neededMiB: 8192,
          waitedSeconds: 60
        })
      ].join("\n")
    }\n`
  )

  const summary = summarise({
    manifest: manifestPath,
    dataset: syntheticDataset,
    now: NOW + 28 * HOUR,
    freeMiB: 9001
  })

  assert.equal(summary.total, 30)
  assert.equal(summary.graded, 25)
  assert.equal(summary.resolved, 8)
  assert.equal(summary.unresolved, 13)
  assert.equal(summary.emptyPatch, 3)
  assert.equal(summary.evalErrors, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.inFlight, 1)
  assert.equal(summary.remaining, 5)
  assert.ok(Math.abs(summary.rate.point - 0.32) < 1e-12)
  assert.ok(Math.abs(summary.rate.low - eight.low) < 1e-12)
  // The rig-fault rate excludes only the instance the evaluator could not grade.
  assert.ok(Math.abs(summary.rateExcludingRigFaults.point - 8 / 24) < 1e-12)

  // Cost: 25 priced instances at $1.30 plus one `ran` row with no cost
  // record. Missing accounting makes the total and its projections unknown.
  assert.equal(summary.spentUsd, null)
  assert.equal(summary.unknownAttempts, 1)
  assert.equal(summary.meanUsd, undefined)
  assert.equal(summary.projectedUsd, undefined)
  assert.equal(summary.tokens.inputTokens, 25 * 200_000)
  assert.equal(summary.tokens.outputTokens, 25 * 8_000)
  assert.equal(summary.waits, 2)
  assert.equal(summary.waitSeconds, 60)
  assert.equal(summary.notes.length, 1)
  assert.equal(summary.sessions, 1)

  // Both finish estimates exist, and the observed one is later than the
  // modelled one here because the ledger spans an hour per instance while the
  // agent only ran for 15 minutes of it.
  assert.ok(summary.etaObserved > summary.now)
  assert.ok(summary.etaModelled > summary.now)
  assert.ok(summary.etaObserved > summary.etaModelled)

  const byRepo = new Map(summary.repos.map((entry) => [entry.repo, entry]))
  assert.equal(byRepo.get("django/django").graded, 9)
  assert.equal(byRepo.get("sympy/sympy").graded, 8)
  assert.equal(byRepo.get("sphinx-doc/sphinx").graded, 8)
  assert.equal(
    summary.repos.reduce((sum, entry) => sum + entry.graded, 0),
    25,
    "every graded instance is in exactly one repo row"
  )
  assert.equal(
    summary.repos.reduce((sum, entry) => sum + entry.resolved, 0),
    8
  )

  assert.equal(summary.pinnedRows.length, 5)
  assert.equal(summary.pinnedGraded, 5)
  assert.equal(summary.pinnedResolved, 5, "the first five graded were the resolved ones")

  // -----------------------------------------------------------------------
  // The markdown
  // -----------------------------------------------------------------------
  const report = renderReport(summary)
  assert.match(report, /# SWE-bench Verified — full benchmark/)
  assert.match(report, /\*\*Resolve rate 32\.0%\*\* \(95% Wilson 17\.2%–51\.6%, n=25\)/)
  assert.match(report, /\| resolved \| 8 \| 32\.0% \|/)
  assert.match(report, /\| eval error \| 1 \| 4\.0% \|/)
  assert.match(report, /\| django\/django \| 9 \|/)
  assert.match(report, /\| projected for all 30 \| — \|/)
  assert.match(report, /\| attempts with unknown cost \| 1 \|/)
  assert.match(report, /## Against the pinned five/)
  assert.match(report, /head-moved/, "a driver note reaches the report")
  assert.ok(!report.includes("PAUSED"), "nothing claims a pause that did not happen")

  // Nothing graded is not a rate of zero, and the report says so rather than
  // printing a 0.0% that a reader could quote.
  const nothing = summarise({
    manifest: sessionsPath,
    dataset: syntheticDataset,
    now: NOW + 2 * HOUR,
    total: 30
  })
  assert.equal(nothing.graded, 0)
  assert.match(renderReport(nothing), /\*\*No instance has been graded yet\*\*/)
  assert.ok(!renderReport(nothing).includes("Resolve rate"))

  const paused = renderReport({ ...summary, paused: "cumulative API cost $612.40 reached the $600 budget" })
  assert.match(paused, /> \*\*PAUSED\*\* — cumulative API cost \$612\.40 reached the \$600 budget/)

  const checkpoint = renderCheckpoint(summary)
  assert.match(checkpoint, /\| 25\/30 \| 8 \| 32\.0% \(17\.2%–51\.6%\) \| — \| — \| — \|/)
  assert.match(checkpoint, /9001 MiB \|$/m)

  // The generator run twice over one ledger writes the same report: it holds no
  // state, so a checkpoint is reproducible from the manifest alone.
  const first = renderReport(summary)
  const second = renderReport(summarise({
    manifest: manifestPath,
    dataset: syntheticDataset,
    now: NOW + 28 * HOUR,
    freeMiB: 9001
  }))
  assert.equal(first, second)

  // -----------------------------------------------------------------------
  // The command line: --checkpoint appends, --spend-cents adds up
  // -----------------------------------------------------------------------
  const run = (args) => spawnSync("node", [join(root, "fullbench-report.mjs"), ...args], { encoding: "utf8" })

  const spend = run(["--spend-cents", "--manifest", manifestPath])
  assert.equal(spend.status, 0, spend.stderr)
  assert.equal(spend.stdout.trim(), "unknown", "missing cost must pause the budget gate")

  const args = [
    "--checkpoint",
    "--manifest",
    manifestPath,
    "--dataset",
    syntheticDataset,
    "--out",
    out,
    "--now",
    String(NOW + 28 * HOUR),
    "--free-mib",
    "9001"
  ]
  const once = run(args)
  assert.equal(once.status, 0, once.stderr)
  const twice = run(args)
  assert.equal(twice.status, 0, twice.stderr)

  const progress = readFileSync(join(out, "progress.md"), "utf8")
  const checkpointRows = progress.split("\n").filter((line) => line.startsWith("| 2026-"))
  assert.equal(checkpointRows.length, 2, "progress.md is append-only: two runs, two rows")
  assert.match(progress, /# Full benchmark progress/)
  assert.equal(
    readFileSync(join(out, "report.md"), "utf8"),
    first,
    "the file the driver writes is the report this test pinned"
  )
  const json = JSON.parse(readFileSync(join(out, "report.json"), "utf8"))
  assert.equal(json.graded, 25)
  assert.equal(json.resolved, 8)

  // A PAUSED marker beside the manifest turns up in both outputs.
  writeFileSync(join(out, "PAUSED"), "cumulative API cost $612.40 reached the $600 budget\n")
  const paused3 = run(args)
  assert.equal(paused3.status, 0, paused3.stderr)
  assert.match(readFileSync(join(out, "report.md"), "utf8"), /> \*\*PAUSED\*\* — cumulative API cost/)
  assert.match(readFileSync(join(out, "progress.md"), "utf8"), /> \*\*PAUSED\*\* at 2026-/)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log(
  "check-fullbench.mjs: 11 archive scenarios and retry recovery pass; the ledger folds, the queue resumes, and the report adds up."
)
