/**
 * Proves the dry runs kill only processes they started, with real processes.
 *
 *   node fixtures/check-dryrun-ownership.mjs           # offline, no docker
 *   node fixtures/check-dryrun-ownership.mjs --full    # also both whole dry runs (docker)
 *
 * Every dry run uses the same instance ids and rig scripts, so the command-line
 * patterns their cleanup used to `pkill -9 -f` also selected another
 * invocation's workers. Here live canaries carry exactly those command lines,
 * beside a control that matches nothing:
 *
 * - `lib/owned-processes.sh` kills an invocation's launched pids, the pids its
 *   drivers, workers and claims recorded under its temporary directory, and
 *   processes naming that directory — each with its descendants — and nothing
 *   another invocation owns, nor a recorded pid since recycled by an unrelated
 *   process;
 * - both dry runs, failing at startup before they start anything (no docker on
 *   PATH), kill no preexisting process;
 * - with `--full`, both whole dry runs — their crash phases, their normal
 *   completion and their exit cleanup — run beside the canaries, and every
 *   canary survives.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swebench-dryrun-ownership-"))
const started = []

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A live process whose command line starts with `argv0`. Double-forked, so it
// is not this process's child: a child killed here would linger as a zombie
// that `kill -0` still reports alive.
const canary = (argv0) => {
  const launched = spawnSync("bash", ["-c", `(exec -a "${argv0}" sleep 600) >/dev/null 2>&1 & echo $!`], {
    encoding: "utf8"
  })
  const pid = Number(launched.stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 0, launched.stderr)
  started.push(pid)
  return pid
}

const settle = () => spawnSync("sleep", ["0.3"])

// Command lines the old cleanup patterns matched, from another invocation.
const foreign = [
  "codex-backfill.sh --one stubcodex__unrelated",
  "codex-dryrun-run.sh stubcodex__unrelated",
  "fullbench-instance.sh stubfull__unrelated",
  "fullbench-instance.sh stubcrash__unrelated",
  "dryrun-run.sh stubfull__unrelated"
]

const canaries = () => {
  const pids = [...foreign, "unrelated-control"].map((argv0) => ({ argv0, pid: canary(argv0) }))
  settle()
  for (const { argv0, pid } of pids) assert.ok(alive(pid), `canary ${argv0} did not start`)
  return pids
}

const survived = (pids, context) => {
  for (const { argv0, pid } of pids) assert.ok(alive(pid), `${context} killed ${argv0}, which it never started`)
}

try {
  // -------------------------------------------------------------------------
  // The helper, over real process trees.
  // -------------------------------------------------------------------------
  const pids = canaries()
  const mine = join(temporary, "mine")
  const theirs = join(temporary, "theirs")
  for (const directory of [mine, theirs]) mkdirSync(join(directory, "claims", "x"), { recursive: true })
  const script = [
    `S=${JSON.stringify(root)}`,
    `. "$S/lib/owned-processes.sh"`,
    // A launched invocation with a grandchild, as `codex-backfill.sh &` has.
    `bash -c 'sleep 600 & wait' & LAUNCHED=$!`,
    // A worker recorded in a claim, naming this invocation's directory.
    `(exec -a "${mine}/stub-worker" sleep 600) & echo $! > "${mine}/claims/x/pid"`,
    // A stub nobody recorded, whose arguments name this invocation's directory.
    `(exec -a "${mine}/dryrun-run.sh stubfull__one" sleep 600) & STUB=$!`,
    // A pid file whose pid now belongs to an unrelated process.
    `echo ${pids.at(-1).pid} > "${mine}/driver.pid"`,
    // Another invocation, alive beside this one.
    `(exec -a "${theirs}/dryrun-run.sh stubfull__one" sleep 600) & echo $! > "${theirs}/driver.pid"`,
    `THEIRS=$(cat "${theirs}/driver.pid")`,
    "sleep 0.3",
    `GRANDCHILD=$(pgrep -P "$LAUNCHED")`,
    `WORKER=$(cat "${mine}/claims/x/pid")`,
    `kill_owned "${mine}" "$LAUNCHED"`,
    "sleep 0.3",
    `for P in $LAUNCHED $GRANDCHILD $WORKER $STUB; do kill -0 "$P" 2>/dev/null && echo "alive $P"; done`,
    `kill -0 "$THEIRS" 2>/dev/null || echo "killed theirs"`,
    `kill -9 "$THEIRS"`,
    `[ -n "$GRANDCHILD" ] || echo "no grandchild"`,
    // Nothing recorded and nothing launched: nothing to kill, and no error.
    `kill_owned "${join(temporary, "absent")}" || echo "failed on an absent directory"`,
    "echo done"
  ].join("\n")
  // Run from a file: an argument naming the directory would make this shell one
  // of the processes the helper is asked to find.
  const scriptPath = join(temporary, "helper.sh")
  writeFileSync(scriptPath, script)
  const helper = spawnSync("bash", [scriptPath], { encoding: "utf8", timeout: 30_000 })
  assert.equal(helper.status, 0, helper.stderr)
  assert.equal(helper.stdout.trim(), "done", `kill_owned left or took the wrong processes:\n${helper.stdout}`)
  survived(pids, "kill_owned")

  // -------------------------------------------------------------------------
  // Both dry runs, failing at startup: they own nothing and kill nothing.
  // -------------------------------------------------------------------------
  const bin = join(temporary, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "docker"), "#!/bin/bash\nexit 1\n")
  chmodSync(join(bin, "docker"), 0o755)
  for (const dryRun of ["codex-backfill-dryrun.sh", "fullbench-dryrun.sh"]) {
    const result = spawnSync(join(root, dryRun), [], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary }
    })
    assert.equal(result.status, 1, `${dryRun}: ${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /dryrun: could not pull alpine/)
    settle()
    survived(pids, `${dryRun}'s startup failure`)
  }

  // -------------------------------------------------------------------------
  // The whole dry runs, beside a concurrent unrelated invocation's processes.
  // -------------------------------------------------------------------------
  if (process.argv.includes("--full")) {
    for (const dryRun of ["codex-backfill-dryrun.sh", "fullbench-dryrun.sh"]) {
      const result = spawnSync(join(root, dryRun), [], { encoding: "utf8", timeout: 1_200_000 })
      assert.equal(result.status, 0, `${dryRun}: ${result.stdout}${result.stderr}`)
      survived(pids, `${dryRun}, run to completion`)
    }
  }

  console.log(
    "check-dryrun-ownership: the dry runs kill what they started and their descendants, and nothing another invocation owns."
  )
} finally {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(temporary, { recursive: true, force: true })
}
