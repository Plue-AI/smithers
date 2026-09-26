import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { backup, backupCommand, holders, restore, restoreCommand, verify } from "./backup.ts"
import type { Io } from "./settings.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-backup-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

/** A state directory as a host leaves it, with a writer holding the engine database open in WAL mode. */
const stateDirectory = (name: string) => {
  const stateDir = join(scratch, name)
  const wiki = join(scratch, `${name}-wiki`)
  mkdirSync(join(wiki, "Org"), { recursive: true })
  writeFileSync(join(wiki, "Org", "Organization.md"), "# Org\n")
  git(scratch, "init", "-q", wiki)
  git(wiki, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "add", ".")
  git(wiki, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "wiki")
  mkdirSync(join(stateDir, ".flows"), { recursive: true, mode: 0o700 })
  mkdirSync(join(stateDir, "execution", ".jj", "repo"), { recursive: true })
  mkdirSync(join(stateDir, "logs"), { recursive: true })
  writeFileSync(
    join(stateDir, ".env"),
    `SMITHERS_ORG_ROOT=${wiki}\nSMITHERS_ORG_STATE_DIR=${stateDir}\nSECRET=s3cret\n`,
    { mode: 0o600 }
  )
  writeFileSync(join(stateDir, "credential"), "token\n", { mode: 0o600 })
  writeFileSync(join(stateDir, "installation"), "smithers-org-test\n", { mode: 0o600 })
  writeFileSync(join(stateDir, "execution", ".jj", "repo", "op"), "operation\n")
  symlinkSync("repo/op", join(stateDir, "execution", ".jj", "latest"))
  writeFileSync(join(stateDir, "logs", "host.log"), "log\n")
  const engine = new DatabaseSync(join(stateDir, ".flows", "engine.db"))
  engine.exec("PRAGMA journal_mode = WAL; CREATE TABLE runs(id TEXT); INSERT INTO runs VALUES ('run-1')")
  const memory = new DatabaseSync(join(stateDir, "memory.db"))
  memory.exec("CREATE TABLE facts(x); INSERT INTO facts VALUES (1)")
  memory.close()
  return { stateDir, wiki, engine }
}

const capture = (env: Io["env"] = {}) => {
  const out: Array<string> = [], err: Array<string> = []
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env, cwd: scratch },
    out,
    err
  }
}

test("a backup of a running host copies consistent databases, modes, and the wiki revision", async () => {
  const { stateDir, wiki, engine } = stateDirectory("live")
  // Written after the WAL switch and not checkpointed: the copy must still hold it.
  engine.exec("INSERT INTO runs VALUES ('run-2')")
  const dest = join(scratch, "live-backup")
  const manifest = await backup(stateDir, dest, new Date("2026-09-25T00:00:00Z"))
  engine.close()
  assert.equal(manifest.hostRunning, true)
  assert.equal(manifest.installation, "smithers-org-test")
  assert.equal(manifest.wiki?.revision, git(wiki, "rev-parse", "HEAD"))
  assert.equal(manifest.wiki?.dirty, false)
  const paths = manifest.entries.map((entry) => entry.path)
  assert.ok(!paths.some((path) => path.startsWith("logs") || /-(wal|shm)$/.test(path)), paths.join(","))
  assert.deepEqual(paths.slice(-2), ["execution/.jj/latest", "execution/.jj/repo/op"])
  assert.equal(manifest.entries.find((entry) => entry.path === ".flows/engine.db")?.kind, "sqlite")
  const copy = new DatabaseSync(join(dest, "state", ".flows", "engine.db"), { readOnly: true })
  assert.deepEqual(copy.prepare("SELECT id FROM runs ORDER BY id").all().map((row) => row.id), ["run-1", "run-2"])
  copy.close()
  for (const file of [".env", "credential", "installation"]) {
    assert.equal(statSync(join(dest, "state", file)).mode & 0o777, 0o600, file)
  }
  assert.equal(statSync(dest).mode & 0o777, 0o700)
  assert.equal(statSync(join(dest, "manifest.json")).mode & 0o777, 0o600)
  assert.ok(!existsSync(`${dest}.partial`))
  assert.doesNotThrow(() => verify(dest))
  await assert.rejects(backup(stateDir, dest), /already exists/)
  await assert.rejects(backup(join(scratch, "nothing"), join(scratch, "x")), /not a host state directory/)
})

test("a stopped host's backup says so and a dirty wiki is marked", async () => {
  const { stateDir, wiki, engine } = stateDirectory("stopped")
  engine.close()
  writeFileSync(join(wiki, "Org", "Organization.md"), "# Changed\n")
  const run = capture({ SMITHERS_ORG_STATE_DIR: stateDir })
  assert.equal(await backupCommand.run([join(scratch, "stopped-backup")], run.io), 0)
  assert.match(run.out[0]!, /^backup .*stopped-backup: \d+ files, wiki [0-9a-f]{12}\+$/)
  assert.equal(await backupCommand.run([], capture().io), 2)
})

test("restore verifies the manifest, refuses a held or occupied target, repoints .env, and keeps modes", async () => {
  const { stateDir, engine } = stateDirectory("source")
  engine.close()
  const dest = join(scratch, "source-backup")
  await backup(stateDir, dest)

  const target = join(scratch, "restored")
  assert.throws(() => restore(dest, target), /parked runs resume only there\. Pass --relocate/)
  assert.ok(!existsSync(target))
  const { manifest, replaced } = restore(dest, target, { relocate: true })
  assert.equal(replaced, undefined)
  assert.equal(manifest.source, stateDir)
  assert.match(readFileSync(join(target, ".env"), "utf8"), new RegExp(`^SMITHERS_ORG_STATE_DIR=${target}$`, "m"))
  assert.match(readFileSync(join(target, ".env"), "utf8"), /^SECRET=s3cret$/m)
  for (const file of [".env", "credential", "installation"]) {
    assert.equal(statSync(join(target, file)).mode & 0o777, 0o600, file)
  }
  const db = new DatabaseSync(join(target, ".flows", "engine.db"))
  assert.equal(db.prepare("SELECT count(*) AS n FROM runs").get()?.n, 1)

  // A process (this one) holds the target's database: refused, even with --replace.
  assert.deepEqual(holders([join(target, ".flows", "engine.db")]), [process.pid])
  assert.throws(
    () => restore(dest, target, { replace: true, relocate: true }),
    new RegExp(`pid ${process.pid}.*stop the host first`)
  )
  db.close()
  assert.throws(() => restore(dest, target, { relocate: true }), /not empty; pass --replace/)
  const second = restore(dest, target, { replace: true, relocate: true, now: new Date("2026-09-25T01:02:03Z") })
  assert.equal(second.replaced, `${target}.replaced-2026-09-25T01-02-03-000Z`)
  assert.ok(existsSync(join(second.replaced!, "credential")))
  assert.ok(!existsSync(`${target}.restoring`))

  // An empty target directory is used as it is.
  const empty = join(scratch, "empty-target")
  mkdirSync(empty)
  assert.equal(restore(dest, empty, { relocate: true }).replaced, undefined)
  assert.ok(existsSync(join(empty, "installation")))

  // A tampered or incomplete backup is refused before anything is written.
  writeFileSync(join(dest, "state", "credential"), "forged\n", { mode: 0o600 })
  const refusedTarget = join(scratch, "never")
  assert.throws(() => restore(dest, refusedTarget, { relocate: true }), /credential does not match the manifest/)
  assert.ok(!existsSync(refusedTarget))
  rmSync(join(dest, "state", "credential"))
  assert.throws(() => verify(dest), /credential is missing/)
  assert.throws(() => verify(scratch), /holds no manifest.json/)
})

test("restore refuses a mode change and another manifest format; the command prints the wiki revision", async () => {
  const { stateDir, engine } = stateDirectory("cmd")
  engine.close()
  const dest = join(scratch, "cmd-backup")
  await backup(stateDir, dest)
  const target = join(scratch, "cmd-restored")
  const run = capture({ SMITHERS_ORG_STATE_DIR: target })
  await assert.rejects(restoreCommand.run([dest], run.io), /--relocate/)
  assert.equal(await restoreCommand.run([dest, "--relocate"], run.io), 0)
  const written = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"))
  assert.equal(
    run.out[0],
    `restored ${target} from ${written.createdAt}: ${written.entries.length} files match their manifest SHA-256`
  )
  assert.match(run.out[1]!, /^wiki [0-9a-f]{40}$/)
  const again = capture({ SMITHERS_ORG_STATE_DIR: target })
  assert.equal(await restoreCommand.run([dest, "--replace", "--relocate"], again.io), 0)
  // Lost and restored where it was: no flag needed.
  rmSync(stateDir, { recursive: true })
  const home = capture({ SMITHERS_ORG_STATE_DIR: stateDir })
  assert.equal(await restoreCommand.run([dest], home.io), 0)
  assert.equal(readFileSync(join(stateDir, "credential"), "utf8"), "token\n")
  assert.match(again.out[1]!, /^previous .*cmd-restored\.replaced-/)
  assert.equal(await restoreCommand.run([], capture().io), 2)

  execFileSync("chmod", ["644", join(dest, "state", ".env")])
  assert.throws(() => verify(dest), /\.env has mode 644, not 600/)
  const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"))
  writeFileSync(join(dest, "manifest.json"), JSON.stringify({ ...manifest, format: 99 }))
  assert.throws(() => verify(dest), /format 99 is not 1/)
  assert.ok(readdirSync(scratch).length > 0)
})
