/**
 * A second `smithers` over one project root is told when the run is not its.
 *
 * `scripts/repo-contract/fault-gaps.md` row 06 recorded that every local control plane ran as
 * `{hostId: "local", pid: 0}`, so two processes over one project root were one
 * owner to the fence and the loser silently re-drove work the winner held.
 * `engineDurable` now stamps `hostname()` and `process.pid`, and
 * `test/NodeEngine.test.ts` pins that stamp. What that test cannot show is the
 * consequence: whether a SECOND real process, reading the same
 * `.flows/control.db`, is refused.
 *
 * This case drives that at the process boundary. The winner is a real live
 * process on this host whose pid is written onto the run row, exactly as a
 * peer `smithers` leaves it. The loser is the real executable, spawned as an
 * operator spawns it, asked to resume a run it does not own. The promise is
 * "the loser is told it lost, and the row does not move", which only means
 * anything as an exit status and a structured refusal from the public CLI.
 *
 * The row is written rather than raced for a reason. A race needs the winner
 * to still be holding the run when the loser arrives, and rc.0 ships no flow
 * the CLI can execute for a controlled span without a model provider, so a
 * spawned pair would decide the case by whichever process booted first. The
 * arbitration under test is not the race — the store's compare-and-swap
 * already settles that, and `packages/smithers/control` proves it — but what the second
 * process is told about the outcome, and that is what a written row states
 * exactly.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
// Outside the repository, for the reason `test/Bin.test.ts` states: this
// checkout grows a `.flows/` the moment any command runs in it, and a working
// directory under `packages/` would resolve the repository as the project
// root.
const staged: Array<string> = []
const peers: Array<ChildProcess> = []

afterEach(() => {
  for (const peer of peers.splice(0)) peer.kill("SIGKILL")
  for (const directory of staged.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const project = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-two-process-")))
  staged.push(root)
  return root
}

const smithers = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, HOME: cwd }
  })

/** A process that outlives the case, standing in for the peer that holds the run. */
const livePeer = (): number => {
  const peer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" })
  if (peer.pid === undefined) throw new Error("could not spawn a live peer")
  peers.push(peer)
  return peer.pid
}

interface RunRow {
  readonly status: string
  readonly owner_host_id: string | null
  readonly owner_pid: number | null
}

const controlDatabase = (root: string): string => join(root, ".flows", "control.db")

const readRun = (root: string, runId: string): RunRow => {
  const database = new DatabaseSync(controlDatabase(root), { readOnly: true })
  try {
    return database.prepare(
      "SELECT status, owner_host_id, owner_pid FROM flows_runs WHERE run_id = ?"
    ).get(runId) as unknown as RunRow
  } finally {
    database.close()
  }
}

/** The row a peer process holding a run leaves in the control database. */
const seedRunOwnedBy = (root: string, runId: string, pid: number): void => {
  const database = new DatabaseSync(controlDatabase(root))
  try {
    const now = Date.now()
    database.prepare(
      `INSERT INTO flows_runs (
        run_id, status, created_at_ms, started_at_ms, owner_host_id, owner_pid, owner_nonce,
        heartbeat_at_ms, state_json
      ) VALUES (?, 'running', ?, ?, ?, ?, 'peer-nonce', ?, ?)`
    ).run(
      runId,
      now,
      now,
      hostname(),
      pid,
      // A fresh heartbeat: the lease has not expired, so nothing in this case
      // turns on a sweep and the only question left is ownership.
      now,
      JSON.stringify({ version: 1, flowName: "agent/run", payload: { runId, planId: "plan-1" } })
    )
  } finally {
    database.close()
  }
}

describe("a second smithers process over one project root", { timeout: 240_000 }, () => {
  it("refuses to resume a run a live peer on this host owns, and leaves the row where it was", () => {
    const root = project()
    // A real command first, so the project has the migrated control database a
    // peer would have left behind. Observing verbs open no missing store, so a
    // bulk cancel, which finds nothing to cancel, is the command that migrates it.
    const migrated = smithers(root, ["runs", "cancel-all", "--json"])
    expect(migrated.status).toBe(0)

    const peerPid = livePeer()
    seedRunOwnedBy(root, "peer-owned-run", peerPid)

    const resumed = smithers(root, ["runs", "resume", "peer-owned-run", "--json"])

    // Canonical commands return structured failures. The refusal must still
    // identify the contested run, not just an empty ClaimLost message.
    expect(resumed.status).toBe(1)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ code: "ClaimLost", message: "claim_lost runId=peer-owned-run" })
    expect(resumed.stderr).toBe("")

    // The refused process changed nothing. Before the identity fix both
    // processes presented the same fence, so this row moved under the loser.
    expect(readRun(root, "peer-owned-run")).toMatchObject({
      status: "running",
      owner_host_id: hostname(),
      owner_pid: peerPid
    })
  })
})
