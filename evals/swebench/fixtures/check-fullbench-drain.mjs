/** Offline drain regressions: no docker, dataset, model access or real worker. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { read } from "../lib/fullbench-manifest.mjs"

const root = resolve(import.meta.dirname, "..")
const driver = readFileSync(join(root, "fullbench.sh"), "utf8")
const between = (from, to) => {
  const start = driver.indexOf(from)
  const end = driver.indexOf(to, start)
  assert.ok(start !== -1 && end > start, `fullbench.sh no longer contains ${from} .. ${to}`)
  return driver.slice(start, end)
}

// The driver's own source, run here rather than restated: helpers, both
// reapers, the shared poll, and the final drain loop verbatim.
const helpers = between("now_ms() {", "# Locks and claims")
const reapers = between("# Reaps every worker", "checkpoint() {")
const drain = between("log \"draining", "log \"final checkpoint\"")

const temporary = mkdtempSync(join(tmpdir(), "swebench-drain-"))
// A rig root of its own, so a reconcile the driver logs can never touch the
// locks the real rig's waves share.
const rig = join(temporary, "rig")
mkdirSync(rig)
symlinkSync(join(root, "lib"), join(rig, "lib"))

/**
 * Runs the extracted drain over one worker described by `worker`, with `sleep`
 * stubbed to count polls and to abort once `bound` of them have passed without
 * the drain ending. Every run gets its own ledger.
 */
const runDrain = ({ bound = 40, ledger = [], unreadable = false, worker }, source = drain) => {
  const fb = mkdtempSync(join(temporary, "fb-"))
  mkdirSync(join(fb, "workers"))
  const manifest = join(fb, "manifest.jsonl")
  if (unreadable) mkdirSync(manifest)
  else if (ledger.length > 0) writeFileSync(manifest, `${ledger.map((row) => JSON.stringify(row)).join("\n")}\n`)
  const result = spawnSync("bash", [
    "-c",
    [
      helpers,
      reapers,
      "TICKS=0",
      `sleep() { TICKS=$((TICKS + 1)); if [ "$TICKS" -gt ${bound} ]; then printf 'STALLED\\n'; exit 9; fi; }`,
      `FB=${fb}; MANIFEST=$FB/manifest.jsonl; S=${rig}`,
      "POLL_SECONDS=0; POLL_LIMIT=3; JOBS=1; STOPPING=0",
      worker,
      source,
      "printf \"RUNNING=%s POLLS=%s TICKS=%s\\n\" \"$RUNNING\" \"$POLLS\" \"$TICKS\""
    ].join("\n")
  ], { encoding: "utf8", timeout: 60_000 })
  return { ...result, manifest, out: `${result.stdout}${result.stderr}` }
}

// A wrapper that exits without writing its `.done` marker, tracked exactly as
// the scheduling loop tracks one. The spin waits until the shell has reaped the
// child, which is what makes `kill -0` report it dead rather than a zombie.
const diedWithoutMarker = [
  "( exit 0 ) & PID=$!",
  "PIDS=(\"$PID\"); NAMES=(\"astropy__astropy-12907\"); RUNNING=1",
  "SPIN=0; while kill -0 \"$PID\" 2>/dev/null && [ \"$SPIN\" -lt 200000 ]; do SPIN=$((SPIN + 1)); done"
].join("\n")

try {
  // The finding: a worker that dies without its marker used to leave the final
  // drain polling for ever, because the drain reaped markers and nothing else.
  const lost = runDrain({ worker: diedWithoutMarker })
  assert.equal(lost.status, 0, `the drain did not end: ${lost.out}`)
  assert.match(lost.stdout, /RUNNING=0 /, "the drain must end with no worker in flight")
  assert.match(lost.stdout, /left no completion marker — reaping it/)

  // What was lost is recorded. An instance whose worker vanished is failed, not
  // in flight, or the next resume reads the ledger and sees an attempt that
  // never ended.
  const failed = read(lost.manifest).states.get("astropy__astropy-12907")
  assert.equal(failed.state, "failed")
  assert.equal(failed.kind, "instance")
  assert.equal(failed.reason, "the worker died without writing a completion marker")
  assert.equal(typeof failed.at, "number")

  // A marker lost after the work finished is not a failed instance: a `failed`
  // row over `cleaned` would re-run an instance the evaluator already graded.
  const graded = runDrain({
    ledger: [
      { kind: "instance", id: "astropy__astropy-12907", state: "graded", verdict: "resolved" },
      { kind: "instance", id: "astropy__astropy-12907", state: "cleaned" }
    ],
    worker: diedWithoutMarker
  })
  assert.equal(graded.status, 0, `the drain did not end: ${graded.out}`)
  assert.match(graded.stdout, /RUNNING=0 /)
  assert.match(graded.stdout, /the ledger already records it as cleaned/)
  const kept = read(graded.manifest)
  assert.equal(kept.states.get("astropy__astropy-12907").state, "cleaned")
  assert.equal(kept.states.get("astropy__astropy-12907").verdict, "resolved")
  assert.equal(kept.rowCount, 2, "a lost marker must not append a row over a graded instance")

  // The ordinary path is unchanged: a marker is reaped on the first poll, with
  // the exit code it carried, and nothing is recorded as failed.
  const finished = runDrain({
    worker: [
      "( exit 0 ) & PID=$!",
      "PIDS=(\"$PID\"); NAMES=(\"astropy__astropy-12907\"); RUNNING=1",
      "printf \"0\\n\" > \"$FB/workers/astropy__astropy-12907.done\""
    ].join("\n")
  })
  assert.equal(finished.status, 0, finished.out)
  assert.match(finished.stdout, /RUNNING=0 POLLS=0 TICKS=0/, "a marker present at the first poll costs no sleep")
  assert.match(finished.stdout, /finished \(exit 0\)/)
  assert.equal(read(finished.manifest).rowCount, 0)

  // A worker that is merely slow is never reaped, and the drain says so every
  // POLL_LIMIT polls rather than waiting in silence.
  const alive = runDrain({
    bound: 10,
    worker: [
      // `command` because the poll counter above stubbed `sleep` out, and this
      // child has to outlive the polls that report it.
      "( command sleep 30 ) & PID=$!",
      "trap 'kill \"$PID\" 2>/dev/null' EXIT",
      "PIDS=(\"$PID\"); NAMES=(\"astropy__astropy-12907\"); RUNNING=1"
    ].join("\n")
  })
  assert.equal(alive.status, 9, `a live worker must not be reaped: ${alive.out}`)
  const stalled = alive.stdout.match(/has run for over \d+ minutes without finishing/g) ?? []
  assert.ok(stalled.length >= 3, `expected repeated stalled-worker diagnostics, got ${stalled.length}`)
  assert.match(alive.stdout, /no lock at .*extract-lock/, "each diagnostic reconciles the shared locks")
  assert.equal(read(alive.manifest).rowCount, 0, "a live worker is never recorded as failed")

  // A ledger that cannot be read is not a ledger that says "unfinished". The
  // worker is still reaped — the drain has to end — and nothing is claimed
  // about the instance, because a `failed` row guessed here is the same re-run
  // of a graded instance the check above exists to prevent.
  const unreadable = runDrain({ unreadable: true, worker: diedWithoutMarker })
  assert.equal(unreadable.status, 0, `the drain did not end: ${unreadable.out}`)
  assert.match(unreadable.stdout, /RUNNING=0 /)
  assert.match(unreadable.stdout, /the ledger could not be read, so this worker's fate is not recorded/)

  // The reader the driver asks, on its own: done, not done, unreadable, misused.
  const ask = (...argv) =>
    spawnSync(process.execPath, [join(root, "lib", "fullbench-state.mjs"), ...argv], {
      encoding: "utf8",
      timeout: 10_000
    })
  const ledger = join(temporary, "asked.jsonl")
  writeFileSync(
    ledger,
    [
      JSON.stringify({ kind: "instance", id: "astropy__astropy-12907", state: "ran" }),
      JSON.stringify({ kind: "instance", id: "django__django-11039", state: "graded" })
    ].join("\n") + "\n"
  )
  assert.equal(ask(ledger, "django__django-11039").status, 0)
  assert.equal(ask(ledger, "django__django-11039").stdout, "graded")
  assert.equal(ask(ledger, "astropy__astropy-12907").status, 1)
  assert.equal(ask(ledger, "astropy__astropy-12907").stdout, "ran")
  assert.equal(ask(ledger, "psf__requests-2317").status, 1, "an instance with no row is not finished")
  assert.equal(ask(ledger, "psf__requests-2317").stdout, "")
  assert.equal(ask(join(temporary, "absent.jsonl"), "psf__requests-2317").status, 1)
  assert.equal(ask(temporary, "psf__requests-2317").status, 3, "an unreadable ledger is neither")
  assert.equal(ask(ledger).status, 2)

  // The same poll serves the scheduler: a slot opens when a dead worker is
  // reaped, and never by giving up on one that is alive.
  const slot = runDrain({ worker: diedWithoutMarker }, "wait_for_slot")
  assert.equal(slot.status, 0, slot.out)
  assert.match(slot.stdout, /RUNNING=0 /)

  console.log("fullbench drain: ok")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
