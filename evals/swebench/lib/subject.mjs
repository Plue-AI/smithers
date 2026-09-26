/**
 * Fingerprints the subject under test: the exact bytes `flows.sh` will load.
 *
 *   node lib/subject.mjs [--json] [--check] [--expect <file>] [--write <file>]
 *
 * A wave grades a harness. Which harness is a fact about module resolution,
 * not about which commits happen to be in the log, and until this file existed
 * nothing in the rig established it. Two things make it non-obvious:
 *
 *   1. The workspace `exports` map of every `@smthrs/*` package points at
 *      `./src/*.ts`, not at `./dist`. `packages/smithers/dist/esm/bin.js` therefore
 *      resolves `@smthrs/harness/CellTurn` to
 *      `packages/smithers/agent/harness/src/CellTurn.ts` and Node strips its types on load.
 *      The harness under test is the WORKING TREE, at the instant each CLI
 *      process starts. `packages/smithers/agent/harness/dist` is not in the loaded graph at
 *      all, so its mtime proves nothing either way.
 *   2. `packages/smithers` is the one package whose compiled output IS loaded, via
 *      the `bin.js` entry point. That dist can be older than its own source.
 *
 * Every path in the record is repository-relative. The absolute directory the
 * rig happens to sit in is a fact about a machine, not about the bytes under
 * test, and a wave record that carries one describes a checkout nobody else
 * has: `scorecard.json` arrived in this repository naming
 * `/Users/<operator>/flows/flows`, which resolves to nothing here. The gate that
 * keeps it out is `scripts/repo-contract/machine-paths.test.mjs`.
 *
 * So the fingerprint is: for every package in the CLI's `@smthrs/*` dependency
 * closure, where its entry point resolves to (src or dist), and a content hash
 * of the directory that answer selects — plus content hashes of the CLI's dist
 * and of the source that dist was built from. `--check` refuses a subject that
 * cannot be reported honestly.
 *
 * The CLI's source is in the stamp even though the process never loads it,
 * because point 2 above is the one place the loaded bytes and the source can
 * disagree. Every other package moves the stamp the moment a sibling lane edits
 * it, which is what stops a wave mid-flight; `packages/smithers/src` used to move
 * nothing, so the one package whose build can go stale was the one package the
 * pin could not notice going stale. With both hashes in the stamp, a pinned pair
 * asserts that one `preflight.sh` run produced them together, and a CLI source
 * change stops the wave until another one does.
 *
 * What this still cannot see: a `dist/esm` that is complete, hashes cleanly, and
 * was compiled from source that is no longer on disk. Detecting that needs a
 * rebuild, which is what `preflight.sh` performs — it deletes `dist` before it
 * builds — so the pinned pair is only ever produced from a full rebuild.
 *
 * The refusals, and what each one caught:
 *
 *   no-cli-build      `packages/smithers/dist/esm/bin.js` is missing.
 *   partial-cli-build a `src/X.ts` has no `dist/esm/X.js`. `--no-bail` and a
 *                     `...` filter closure both produce this silently.
 *   foreign-subject   a package resolves outside this checkout's `packages/`.
 *   unbuilt-dist      a dependency resolves into `dist/`, which this rig does
 *                     not build; its bytes would be whatever was left there.
 *   dirty-subject     a subject package's `src` differs from `git HEAD`, so no
 *                     report may name a commit as the thing it measured. Set
 *                     SWB_ALLOW_DIRTY_SUBJECT=1 to run anyway; the fingerprint
 *                     records the differing paths either way.
 *
 * @since 0.1.0
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, relative, resolve, sep } from "node:path"

const here = import.meta.dirname
const root = resolve(here, "../../..")
const binary = join(root, "packages/smithers/dist/esm/bin.js")

/** Every file under a directory, as repository-relative paths, sorted. */
const filesUnder = (directory) => {
  if (!existsSync(directory)) return []
  const walk = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name)
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : []
    })
  return walk(directory).map((path) => relative(root, path)).sort()
}

/**
 * A content hash of a set of files: their repository-relative names and their
 * bytes, in sorted order. Names are inside the hash so that adding, removing
 * or renaming a file changes the answer.
 */
const hashFiles = (paths) => {
  const hash = createHash("sha256")
  for (const path of paths) {
    hash.update(path)
    hash.update("\u0000")
    hash.update(readFileSync(join(root, path)))
    hash.update("\u0000")
  }
  return `sha256:${hash.digest("hex")}`
}

const hashFile = (path) => `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`

const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : undefined
}

/**
 * The paths under `prefix` whose working-tree content differs from `HEAD`,
 * including files git does not track. Both halves matter: a sibling lane's
 * uncommitted edit and a stray new module are equally able to change what a
 * wave measures.
 *
 * The two halves overlap. A file that is tracked at `HEAD` and staged as
 * deleted, which is the state a shared jj-colocated index leaves behind, is
 * reported by `diff HEAD` and by `ls-files --others` at once. The set is
 * deduplicated so a count of differing paths is a count of files.
 */
const differsFromHead = (prefix) => {
  const tracked = git("diff", "--name-only", "HEAD", "--", prefix) ?? ""
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", prefix) ?? ""
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")])]
    .filter((line) => line.length > 0)
    .sort()
}

/**
 * Walks the `@smthrs/*` dependency closure of `packages/smithers`, resolving each
 * package the way the running process will.
 *
 * Resolution is anchored at the importer, not at the entry point: pnpm links
 * `@smthrs/core` into `packages/smithers/agent/harness/node_modules`, not into
 * `packages/smithers/node_modules`, so asking `bin.js` for it answers "no such
 * module" while the harness loads it fine. Every edge is therefore resolved
 * from the directory of the package that declares the dependency, which is
 * what Node does.
 */
const closure = (refusals) => {
  const byName = new Map()
  // The walk descends: packages nest, and a package that reads one directory
  // level would miss most of the closure and answer with a smaller graph than
  // the binary actually loads.
  const collect = (parent) => {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue
      const directory = `${parent}/${entry.name}`
      const manifest = join(root, directory, "package.json")
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(readFileSync(manifest, "utf8"))
      byName.set(parsed.name, { directory, manifest: parsed })
      collect(directory)
    }
  }
  collect("packages")
  const cli = byName.get("@smthrs/cli")
  // The process enters at the built binary, which is the one compiled artifact
  // in the graph. Everything below it is source, and this walk proves it.
  const found = new Map([["@smthrs/cli", { ...cli, resolved: binary }]])
  const pending = [{ name: "@smthrs/cli", record: cli }]
  while (pending.length > 0) {
    const { name, record } = pending.pop()
    const anchor = createRequire(join(root, record.directory, "package.json"))
    for (const dependency of Object.keys(record.manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@smthrs/") || found.has(dependency)) continue
      const next = byName.get(dependency)
      if (next === undefined) {
        refusals.push({
          code: "foreign-subject",
          message: `${name} depends on ${dependency}, which is not a package in this checkout`
        })
        continue
      }
      let resolved
      try {
        resolved = anchor.resolve(dependency)
      } catch (error) {
        refusals.push({
          code: "unresolvable",
          message: `${name} cannot resolve its dependency ${dependency}: ${error.message.split("\n")[0]}`
        })
        continue
      }
      found.set(dependency, { ...next, resolved })
      pending.push({ name: dependency, record: next })
    }
  }
  return found
}

/**
 * The one-line stamp a wave pins itself to, from the parts of a fingerprint
 * that describe content rather than circumstance.
 *
 * Deliberately excluded: `head`, `node`, `platform`, and every `dirty` list.
 * The stamp answers "are these the same bytes", so a wave does not stop
 * because a sibling lane committed something that changed no file the CLI
 * loads, and does not continue because two different trees happen to sit on
 * one commit. Deliberately included: `cliSrc`, which the process never loads —
 * see the note where it is built.
 *
 * Exported so a test can hold the stamp against a changed input and see it
 * move, without editing a shared working tree to find out.
 */
export const stampOf = (record) =>
  `sha256:${
    createHash("sha256").update(JSON.stringify({
      marker: record.marker,
      cliDist: { hash: record.cliDist.hash, files: record.cliDist.files },
      cliSrc: { hash: record.cliSrc.hash, files: record.cliSrc.files },
      packages: Object.fromEntries(
        Object.entries(record.packages).map(([name, value]) => [name, {
          hash: value.hash,
          loadsFrom: value.loadsFrom
        }])
      )
    })).digest("hex")
  }`

/**
 * Builds the fingerprint. Never throws on a bad subject: the problems are
 * returned as `refusals` so `--json` can report a subject that `--check`
 * rejects.
 */
export const fingerprint = ({ compareToHead = true } = {}) => {
  const refusals = []
  if (!existsSync(binary)) {
    refusals.push({
      code: "no-cli-build",
      message: `${relative(root, binary)} does not exist; run evals/swebench/preflight.sh`
    })
    return { refusals, packages: {}, stamp: undefined }
  }
  const require = createRequire(binary)
  const packages = {}
  for (const [name, record] of [...closure(refusals)].sort(([a], [b]) => a < b ? -1 : 1)) {
    const inside = relative(root, record.resolved)
    if (inside.startsWith("..") || inside.startsWith(sep)) {
      refusals.push({ code: "foreign-subject", message: `${name} resolves outside this checkout, to ${record.resolved}` })
      continue
    }
    const segments = inside.split(sep)
    const kind = segments.includes("dist") ? "dist" : segments.includes("src") ? "src" : "other"
    if (kind === "dist" && name !== "@smthrs/cli") {
      refusals.push({
        code: "unbuilt-dist",
        message:
          `${name} resolves into a build directory (${inside}) that this rig does not build; its bytes are whatever was left there`
      })
    }
    if (kind === "other") {
      refusals.push({ code: "foreign-subject", message: `${name} resolves to ${inside}, which is neither src nor dist` })
    }
    // The CLI is entered through `dist/esm/bin.js`; its `dist/cjs` twin is
    // built and never loaded, so it is not part of the subject.
    const directory = kind === "dist" ? `${record.directory}/dist/esm` : `${record.directory}/src`
    const files = filesUnder(join(root, directory))
    const dirty = compareToHead ? differsFromHead(`${record.directory}/src`) : []
    if (dirty.length > 0) {
      refusals.push({
        code: "dirty-subject",
        message: `${name} does not match git HEAD: ${dirty.length} path(s), first ${dirty[0]}`
      })
    }
    packages[name] = {
      directory: record.directory,
      resolvedEntry: inside,
      loadsFrom: kind,
      hashedDirectory: directory,
      files: files.length,
      hash: hashFiles(files),
      dirty
    }
  }
  // The CLI's own compiled output is the only build artifact in the loaded
  // graph. A `src/X.ts` with no `dist/esm/X.js` is the signature of a build
  // that stopped early, which is exactly what `--no-bail` over a filter
  // closure produces: a dist that exists, imports fine, and is a prefix of the
  // program the report claims to have run.
  const sources = filesUnder(join(root, "packages/smithers/src")).filter((path) => path.endsWith(".ts"))
  const emitted = new Set(filesUnder(join(root, "packages/smithers/dist/esm")).filter((path) => path.endsWith(".js")))
  const missing = sources
    .map((path) => path.replace("packages/smithers/src/", "packages/smithers/dist/esm/").replace(/\.ts$/, ".js"))
    .filter((path) => !emitted.has(path))
  if (missing.length > 0) {
    refusals.push({
      code: "partial-cli-build",
      message: `the built CLI is missing ${missing.length} module(s), first ${missing[0]}`
    })
  }
  const cliDist = {
    directory: "packages/smithers/dist/esm",
    files: emitted.size,
    hash: hashFiles([...emitted].sort()),
    missing
  }
  // The CLI's own source, which is NOT what the process loads — the build is.
  // It is fingerprinted anyway, and folded into the stamp, because `packages/smithers`
  // is the only package where the loaded bytes and the source can drift apart,
  // and nothing else in the rig can see that drift:
  //
  //   - Every other package is loaded from `src`, so a mid-wave edit to it
  //     moves its hash, moves the stamp, and stops the wave at the next
  //     `flows.sh` call. Editing `packages/smithers/src` moved nothing, because only
  //     `dist/esm` was hashed. The one package whose build can go stale was the
  //     one package the pin could not notice going stale.
  //   - `dirty-subject` only asks whether `src` differs from `HEAD`, and
  //     `flows.sh` runs `--expect` without `--check`, which skips that
  //     comparison entirely. It was never the thing stopping a wave.
  //
  // Including it here means a wave stops whenever the CLI's source moves, and
  // the only way to restart is `./preflight.sh`, which rebuilds `dist` from that
  // source and re-pins both hashes together. A pinned pair therefore states that
  // one preflight produced them, which is the claim a stale build breaks.
  const cliSources = filesUnder(join(root, "packages/smithers/src"))
  const cliSrc = {
    directory: "packages/smithers/src",
    files: cliSources.length,
    hash: hashFiles(cliSources)
  }
  // The marker a wave report cites. `CellTurn.ts` is where the read-only cap,
  // the park refusal and the mutation accounting live, so it is the single
  // file that answers "which controls could this wave possibly have run".
  const marker = {
    path: "packages/smithers/agent/harness/src/CellTurn.ts",
    hash: hashFile("packages/smithers/agent/harness/src/CellTurn.ts"),
    resolvedBy: (() => {
      try {
        return relative(root, require.resolve("@smthrs/harness/CellTurn"))
      } catch {
        return undefined
      }
    })()
  }
  const record = {
    head: compareToHead ? git("rev-parse", "HEAD") : undefined,
    headSubject: compareToHead ? git("log", "-1", "--format=%s") : undefined,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    marker,
    cliDist,
    cliSrc,
    packages
  }
  return { refusals, stamp: stampOf(record), ...record }
}

const options = process.argv.slice(2)
const optionValue = (name) => {
  const index = options.indexOf(name)
  return index < 0 ? undefined : options[index + 1]
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  // Comparing every package against HEAD costs two `git` processes per
  // package. A wave re-verifies the stamp on every CLI invocation and the
  // stamp does not depend on that comparison, so `--expect` on its own skips
  // it and stays under 200 ms.
  const subject = fingerprint({
    compareToHead: options.includes("--check") || !options.includes("--expect")
  })
  const expected = optionValue("--expect")
  if (expected !== undefined) {
    if (!existsSync(expected)) {
      console.error(`subject.mjs: no recorded fingerprint at ${expected}; run evals/swebench/preflight.sh`)
      process.exit(3)
    }
    const recorded = JSON.parse(readFileSync(expected, "utf8"))
    if (recorded.stamp !== subject.stamp) {
      console.error(
        `subject.mjs: the subject changed since the preflight recorded it.\n`
          + `  recorded ${recorded.stamp}\n  current  ${subject.stamp}\n`
          + `A sibling lane edited a package the CLI loads, or the CLI was rebuilt.\n`
          + `Re-run evals/swebench/preflight.sh and start the wave over: the frames\n`
          + `already run and the frames still to run would not be the same subject.`
      )
      process.exit(4)
    }
  }
  if (options.includes("--check")) {
    const allowDirty = process.env.SWB_ALLOW_DIRTY_SUBJECT === "1"
    const fatal = subject.refusals.filter((refusal) => !(allowDirty && refusal.code === "dirty-subject"))
    if (fatal.length > 0) {
      console.error("subject.mjs: refusing to run a wave on this subject.")
      for (const refusal of fatal) console.error(`  ${refusal.code}: ${refusal.message}`)
      if (fatal.some((refusal) => refusal.code === "dirty-subject")) {
        console.error("  (set SWB_ALLOW_DIRTY_SUBJECT=1 to measure an uncommitted subject anyway)")
      }
      process.exit(2)
    }
    if (subject.refusals.length > 0) {
      console.error("subject.mjs: measuring an uncommitted subject, by SWB_ALLOW_DIRTY_SUBJECT=1:")
      for (const refusal of subject.refusals) console.error(`  ${refusal.code}: ${refusal.message}`)
    }
  }
  const written = optionValue("--write")
  if (written !== undefined) writeFileSync(written, `${JSON.stringify(subject, undefined, 2)}\n`)
  if (options.includes("--json")) console.log(JSON.stringify(subject, undefined, 2))
  else if (!options.includes("--quiet")) {
    console.log(`subject ${subject.stamp}`)
    console.log(`  HEAD          ${subject.head} ${subject.headSubject ?? ""}`)
    console.log(`  node          ${subject.node} ${subject.platform}`)
    console.log(`  CellTurn.ts   ${subject.marker.hash}`)
    console.log(`                loaded from ${subject.marker.resolvedBy}`)
    console.log(`  cli dist      ${subject.cliDist.hash} (${subject.cliDist.files} modules)`)
    console.log(`  cli src       ${subject.cliSrc.hash} (${subject.cliSrc.files} files, built into the dist above)`)
    for (const [name, value] of Object.entries(subject.packages)) {
      const dirty = value.dirty.length === 0 ? "" : ` DIRTY(${value.dirty.length})`
      console.log(`  ${name.padEnd(24)} ${value.loadsFrom.padEnd(4)} ${value.hash}${dirty}`)
    }
  }
}
