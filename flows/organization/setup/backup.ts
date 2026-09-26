/**
 * `backup <dest>` / `restore <src>`: snapshots of a host's state directory.
 *
 * A backup is a directory holding `state/` and `manifest.json`. Every SQLite
 * database (`*.db`: the engine and control databases, memory) is copied with
 * `VACUUM INTO`, one read transaction, so each copy is consistent while a
 * host writes to it; the execution jj repository is copied after the databases, so it
 * holds every snapshot they name; everything else (`.env`, the credential,
 * the installation id, the catalog) is copied with its mode. `logs/` and
 * SQLite's `-wal`/`-shm`/`-journal` files are left out. The manifest records
 * each file's size, mode and SHA-256, whether a host held the state, and the
 * organization wiki's git revision.
 *
 * Restoring verifies every file against the manifest, refuses a target a
 * running process holds open, refuses a non-empty target unless `--replace`
 * (which moves it aside), and rewrites `SMITHERS_ORG_STATE_DIR` in the
 * restored `.env` to the target. The host's flow identities include the
 * state directory's path, so parked runs resume only when the state is
 * restored at the path it was backed up from; another path is refused unless
 * `--relocate`, and there those runs fail rather than resume.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import * as Wiki from "../wiki.ts"
import { absolute, type Command, type Io, nonEmpty, stateDirOf, withEnvFile } from "./settings.ts"

/** The manifest's format version. */
export const format = 1

export interface Entry {
  readonly path: string
  readonly kind: "file" | "sqlite" | "symlink"
  readonly mode: number
  readonly bytes: number
  readonly sha256: string
}

export interface Manifest {
  readonly format: number
  readonly createdAt: string
  readonly source: string
  readonly installation: string | undefined
  /** Whether a process held the state's databases open while it was copied. */
  readonly hostRunning: boolean
  readonly wiki: { readonly root: string; readonly revision: string | undefined; readonly dirty: boolean } | undefined
  readonly entries: ReadonlyArray<Entry>
}

const skipped = (path: string) => path === "logs" || path.startsWith("logs/") || /-(wal|shm|journal)$/.test(path)

const isDatabase = (path: string) => path.endsWith(".db")

/** Every path under `root`, relative, directories before their contents; `execution/` last. */
const walk = (root: string): Array<string> => {
  const found: Array<string> = []
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const rel = relative(root, path)
      if (skipped(rel)) continue
      found.push(rel)
      const stat = lstatSync(path)
      if (stat.isDirectory()) visit(path)
    }
  }
  visit(root)
  const execution = (path: string) => path === "execution" || path.startsWith("execution/")
  return [...found.filter((path) => !execution(path)), ...found.filter(execution)]
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

/** The processes (by pid) holding any of `files` open, via `lsof`. */
export const holders = (files: ReadonlyArray<string>): Array<number> => {
  const present = files.filter((file) => existsSync(file))
  if (present.length === 0) return []
  const result = spawnSync("lsof", ["-t", "--", ...present], { encoding: "utf8" })
  if (result.error !== undefined) {
    throw new Error(`lsof could not run, so whether a host holds the state is unknown: ${result.error.message}`)
  }
  return [...new Set(result.stdout.split("\n").filter((line) => /^\d+$/.test(line)).map(Number))]
}

/** The SQLite databases under a state directory. */
const databases = (stateDir: string) =>
  existsSync(stateDir)
    ? walk(stateDir).filter((path) => isDatabase(path) && lstatSync(join(stateDir, path)).isFile()).map((path) =>
      join(stateDir, path)
    )
    : []

/**
 * The git revision of the wiki root and whether its tree has changes. With
 * `wiki.commit`, what the host wrote is committed first, so the revision
 * holds every receipt and hire the backed-up state cites.
 */
const wikiOf = (root: string | undefined): Manifest["wiki"] => {
  if (root === undefined) return undefined
  const paths = Wiki.committedPaths(root)
  if (paths !== undefined) Wiki.commit(root, paths)
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
  if (head.status !== 0) return { root, revision: undefined, dirty: false }
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })
  return { root, revision: head.stdout.trim(), dirty: status.stdout.trim() !== "" }
}

/** Copies a state directory to `dest` (created; must not exist) and writes its manifest. */
export const backup = async (stateDir: string, dest: string, now = new Date()): Promise<Manifest> => {
  if (!existsSync(join(stateDir, "installation")) && !existsSync(join(stateDir, ".env"))) {
    throw new Error(`${stateDir} is not a host state directory (no installation, no .env)`)
  }
  if (existsSync(dest)) throw new Error(`${dest} already exists`)
  const partial = `${dest}.partial`
  rmSync(partial, { recursive: true, force: true })
  const target = join(partial, "state")
  mkdirSync(target, { recursive: true, mode: 0o700 })
  chmodSync(partial, 0o700)
  const hostRunning = holders(databases(stateDir)).length > 0
  const entries: Array<Entry> = []
  for (const path of walk(stateDir)) {
    const from = join(stateDir, path), to = join(target, path)
    const stat = lstatSync(from)
    const mode = stat.mode & 0o7777
    if (stat.isDirectory()) {
      mkdirSync(to, { mode })
      chmodSync(to, mode)
      continue
    }
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(from)
      symlinkSync(link, to)
      entries.push({ path, kind: "symlink", mode, bytes: 0, sha256: createHash("sha256").update(link).digest("hex") })
      continue
    }
    if (isDatabase(path)) {
      const db = new DatabaseSync(from)
      try {
        // One read transaction: a consistent snapshot while a host writes.
        db.prepare("VACUUM INTO ?").run(to)
      } finally {
        db.close()
      }
      // A copy is a single file: it needs no write-ahead log beside it.
      const copy = new DatabaseSync(to)
      try {
        copy.exec("PRAGMA journal_mode = DELETE")
        const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined
        if (check?.integrity_check !== "ok") throw new Error(`${path}: the copy fails its integrity check`)
      } finally {
        copy.close()
      }
    } else {
      copyFileSync(from, to)
    }
    chmodSync(to, mode)
    entries.push({
      path,
      kind: isDatabase(path) ? "sqlite" : "file",
      mode,
      bytes: lstatSync(to).size,
      sha256: sha256(to)
    })
  }
  const env = withEnvFile({}, join(stateDir, ".env"))
  const installationFile = join(stateDir, "installation")
  const manifest: Manifest = {
    format,
    createdAt: now.toISOString(),
    source: stateDir,
    installation: existsSync(installationFile) ? readFileSync(installationFile, "utf8").trim() : undefined,
    hostRunning,
    wiki: wikiOf(nonEmpty(env.SMITHERS_ORG_ROOT)),
    entries
  }
  writeFileSync(join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(partial, dest)
  return manifest
}

/** The manifest at `src`, with every entry checked against the files beside it. Throws on the first mismatch. */
export const verify = (src: string): Manifest => {
  const file = join(src, "manifest.json")
  if (!existsSync(file)) throw new Error(`${src} holds no manifest.json`)
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest
  if (manifest.format !== format) throw new Error(`${file}: format ${manifest.format} is not ${format}`)
  for (const entry of manifest.entries) {
    const path = join(src, "state", entry.path)
    if (!existsSync(path) && !(entry.kind === "symlink")) throw new Error(`${entry.path} is missing from the backup`)
    const stat = lstatSync(path)
    const digest = entry.kind === "symlink"
      ? createHash("sha256").update(readlinkSync(path)).digest("hex")
      : sha256(path)
    if (digest !== entry.sha256) throw new Error(`${entry.path} does not match the manifest`)
    if ((stat.mode & 0o7777) !== entry.mode && entry.kind !== "symlink") {
      throw new Error(
        `${entry.path} has mode ${(stat.mode & 0o777).toString(8)}, not ${(entry.mode & 0o777).toString(8)}`
      )
    }
  }
  return manifest
}

/** Points a restored `.env`'s `SMITHERS_ORG_STATE_DIR` at the directory it now lives in. */
const repoint = (stateDir: string) => {
  const file = join(stateDir, ".env")
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
  const next = text.replace(/^SMITHERS_ORG_STATE_DIR=.*$/m, `SMITHERS_ORG_STATE_DIR=${stateDir}`)
  if (next !== text) writeFileSync(file, next)
}

/** Restores a verified backup into `stateDir`. Returns where a replaced directory was moved, if any. */
export const restore = (
  src: string,
  stateDir: string,
  options: { readonly replace?: boolean; readonly relocate?: boolean; readonly now?: Date } = {}
): { readonly manifest: Manifest; readonly replaced: string | undefined } => {
  const manifest = verify(src)
  if (manifest.source !== stateDir && options.relocate !== true) {
    throw new Error(
      `the backup is of ${manifest.source}; parked runs resume only there. Pass --relocate to restore to ${stateDir} anyway`
    )
  }
  const held = holders(databases(stateDir))
  if (held.length > 0) {
    throw new Error(`a running process (pid ${held.join(", ")}) holds ${stateDir}; stop the host first`)
  }
  const occupied = existsSync(stateDir) && readdirSync(stateDir).length > 0
  if (occupied && options.replace !== true) throw new Error(`${stateDir} is not empty; pass --replace to move it aside`)
  const staging = `${stateDir}.restoring`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(dirname(stateDir), { recursive: true })
  // Every file, byte for byte and mode for mode; directories as the walk saw them.
  const copy = (from: string, to: string) => {
    const stat = lstatSync(from)
    if (stat.isDirectory()) {
      mkdirSync(to, { mode: stat.mode & 0o7777 })
      chmodSync(to, stat.mode & 0o7777)
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name))
    } else if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to)
    } else {
      copyFileSync(from, to)
      chmodSync(to, stat.mode & 0o7777)
    }
  }
  copy(join(src, "state"), staging)
  let replaced: string | undefined
  if (existsSync(stateDir)) {
    if (occupied) {
      replaced = `${stateDir}.replaced-${(options.now ?? new Date()).toISOString().replaceAll(/[:.]/g, "-")}`
      renameSync(stateDir, replaced)
    } else {
      rmSync(stateDir, { recursive: true })
    }
  }
  renameSync(staging, stateDir)
  repoint(stateDir)
  return { manifest, replaced }
}

const stateDirFlag = (values: { readonly "state-dir"?: string | undefined }, io: Io) =>
  absolute(io.cwd, nonEmpty(values["state-dir"]) ?? stateDirOf(io.env))

export const backupCommand: Command = {
  name: "backup",
  usage: "backup <dest> [--state-dir <dir>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { "state-dir": { type: "string" } }
    })
    if (positionals.length !== 1) {
      io.err(`usage: ${backupCommand.usage}`)
      return 2
    }
    const dest = absolute(io.cwd, positionals[0]!)
    const manifest = await backup(stateDirFlag(values, io), dest)
    io.out(
      `backup ${dest}: ${manifest.entries.length} files${manifest.hostRunning ? ", host running" : ""}${
        manifest.wiki?.revision === undefined
          ? ""
          : `, wiki ${manifest.wiki.revision.slice(0, 12)}${manifest.wiki.dirty ? "+" : ""}`
      }`
    )
    return 0
  }
}

export const restoreCommand: Command = {
  name: "restore",
  usage: "restore <src> [--state-dir <dir>] [--replace] [--relocate]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        "state-dir": { type: "string" },
        replace: { type: "boolean", default: false },
        relocate: { type: "boolean", default: false }
      }
    })
    if (positionals.length !== 1) {
      io.err(`usage: ${restoreCommand.usage}`)
      return 2
    }
    const stateDir = stateDirFlag(values, io)
    const { manifest, replaced } = restore(absolute(io.cwd, positionals[0]!), stateDir, {
      replace: values.replace,
      relocate: values.relocate
    })
    io.out(
      `restored ${stateDir} from ${manifest.createdAt}: ${manifest.entries.length} files match their manifest SHA-256`
    )
    if (replaced !== undefined) io.out(`previous ${replaced}`)
    if (manifest.wiki?.revision !== undefined) {
      io.out(`wiki ${manifest.wiki.revision}${manifest.wiki.dirty ? " (had changes)" : ""}`)
    }
    return 0
  }
}
