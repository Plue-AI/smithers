/**
 * Test helpers: a real Node filesystem layer, and a fixture copied into a
 * temporary directory so a scanner runs against real files it may not disturb.
 *
 * @since 0.1.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { buildSync } from "esbuild"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Layer from "effect/Layer"

/** The real Node filesystem and path services every scanner test runs on. */
export const platform: Layer.Layer<never> = Layer.merge(NodeFileSystem.layer, NodePath.layer) as never as Layer.Layer<
  never
>

/** The layer scanners take: a real filesystem and a real path service. */
export const nodeLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** The absolute path of one committed fixture. */
export const fixture = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url))

/**
 * Whether the native `smithers-jj-export` helper is where the kernel-guarded
 * filesystem looks for it: `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`, the
 * platform-node package's own `bin/`, a source checkout's `target/release` or
 * `target/debug`, or `/usr/local/bin`. Without it every guarded filesystem
 * request fails closed as `PermissionDenied`, so a journey whose agent writes
 * through the `write` flow cannot migrate anything. CI builds it; a fresh
 * checkout or worktree has it only after
 * `cargo build --locked --release -p smithers-ffi --bin smithers-jj-export`.
 */
export const nativeHelperAvailable: boolean = (() => {
  const name = process.platform === "win32" ? "smithers-jj-export.exe" : "smithers-jj-export"
  const checkout = fileURLToPath(new URL("../../../../../", import.meta.url))
  const platformNode = dirname(createRequire(import.meta.url).resolve("@smthrs/platform-node/package.json"))
  return [
    process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
    join(platformNode, "bin", `${process.platform}-${process.arch}`, name),
    join(checkout, "target", "release", name),
    join(checkout, "target", "debug", name),
    "/usr/local/bin/smithers-jj-export"
  ].some((path) => path !== undefined && path !== "" && existsSync(path))
})()

const temporaries: Array<string> = []

/**
 * Copies a fixture into a fresh temporary directory and returns its path. The
 * copy is removed when the process exits, so a failing test leaves nothing
 * behind and a passing one never mutates the committed fixture.
 */
export const copyFixture = (name: string): string => {
  const target = mkdtempSync(join(tmpdir(), `migrate-${name.replace(/[^a-z0-9]+/gi, "-")}-`))
  cpSync(fixture(name), target, { recursive: true })
  temporaries.push(target)
  return target
}

process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

/**
 * The sha256 of every file under `root`, keyed by its relative path.
 *
 * A listing is a snapshot and the entries are read afterwards, so a name can
 * be gone by the time it is reached. The fixtures carry a real `.git`, and
 * git's background maintenance creates and removes `.git/objects/maintenance.lock`
 * on its own schedule, which made two of these tests fail on CI and pass on a
 * developer's machine for no reason either could see. A vanished name is
 * treated as absent, which is what it is: the walk runs after the migration
 * has finished, so nothing it wrote can disappear underneath it, and every
 * path that stays put is compared exactly as before.
 */
export const hashTree = (root: string): ReadonlyMap<string, string> => {
  const hashes = new Map<string, string>()
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry)
      const key = prefix === "" ? entry : `${prefix}/${entry}`
      try {
        if (statSync(absolute).isDirectory()) visit(absolute, key)
        else hashes.set(key, createHash("sha256").update(readFileSync(absolute)).digest("hex"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }
  visit(root, "")
  return hashes
}

/** The sha256 of a set of files, over their paths and their contents together. */
const keyOf = (paths: ReadonlyArray<string>): string => {
  const hash = createHash("sha256")
  for (const path of [...paths].sort()) {
    hash.update(path)
    hash.update("\u0000")
    try {
      hash.update(readFileSync(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // A deleted input is a change like any other, not an input that is still
      // whatever it last was.
      hash.update("absent")
    }
    hash.update("\u0000")
  }
  return hash.digest("hex").slice(0, 16)
}

const inputRecord = (directory: string): string => join(directory, "inputs.json")

/**
 * The files the bundle in `directory` was last built from, as its build
 * recorded them, or nothing if no build has written there yet.
 */
export const bundleInputs = (directory: string): ReadonlyArray<string> => {
  try {
    return JSON.parse(readFileSync(inputRecord(directory), "utf8")) as ReadonlyArray<string>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return []
  }
}

/**
 * Bundles `entryPoint` into `directory` and returns the bundle's path.
 *
 * The name carries the sha256 of every file the bundle was built from: the
 * entry, every module esbuild reached through it, and anything named in
 * `keyedOn`. Judging freshness by the entry package's own sources would reuse
 * a bundle built before a change to anything else it inlines, and the CLI
 * bundle inlines far more than it owns: `src/flow/bin.ts` reaches 512 files,
 * of which 40 are this package's. A registry, kernel or harness edit would
 * otherwise leave the spawned-process tests running the previous
 * implementation while the tests beside them import the current tree.
 *
 * Keying the name rather than a fixed file also gives every distinct set of
 * inputs its own path, so vitest workers building concurrently cannot
 * overwrite each other's bundle, and the build lands by `rename`, which is
 * atomic, so no worker ever spawns a half-written file.
 */
export const bundleOnce = (options: {
  readonly entryPoint: string
  readonly directory: string
  readonly external?: ReadonlyArray<string>
  readonly keyedOn?: ReadonlyArray<string>
}): string => {
  const recorded = bundleInputs(options.directory)
  if (recorded.length > 0) {
    const cached = join(options.directory, `bundle-${keyOf(recorded)}.mjs`)
    if (existsSync(cached)) return cached
  }
  mkdirSync(options.directory, { recursive: true })
  const scratch = join(options.directory, `.building-${randomUUID()}.mjs`)
  // esbuild reports its inputs relative to this directory, so name it rather
  // than reading `process.cwd()` twice and hoping it did not move.
  const workingDirectory = process.cwd()
  const built = buildSync({
    entryPoints: [options.entryPoint],
    absWorkingDir: workingDirectory,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    outfile: scratch,
    metafile: true,
    external: [...options.external ?? []],
    // A bundled CommonJS dependency still calls `require`, and an ES module has
    // none until one is made.
    banner: { js: "import { createRequire as ___cr } from 'node:module'; const require = ___cr(import.meta.url);" }
  })
  const inputs = [
    ...Object.keys(built.metafile.inputs).map((input) => resolve(workingDirectory, input)),
    ...options.keyedOn ?? []
  ]
  const bundle = join(options.directory, `bundle-${keyOf(inputs)}.mjs`)
  renameSync(scratch, bundle)
  const record = join(options.directory, `.inputs-${randomUUID()}.json`)
  writeFileSync(record, JSON.stringify(inputs))
  renameSync(record, inputRecord(options.directory))
  return bundle
}

let bin: string | undefined

/**
 * Builds the `smithers-migrate` bin as one file a process can run, and returns
 * its path.
 *
 * A test that only calls `Command.run` proves the composition and not the
 * executable: the flag parsing, the exit codes, and the rendering an operator
 * actually sees all live in `bin.ts`, and none of them run in process. The
 * bundle is what makes spawning it possible at all — the package's sources are
 * TypeScript, and Node will not strip types out of `node_modules`, which is
 * where every `@smthrs/*` import resolves to.
 *
 * It is written under `node_modules` so that `effect` and `@effect/platform-node`,
 * which stay external because they ship their own builds, resolve from the
 * package the way they do for a published install.
 *
 * The manifest is keyed on beside the sources because it is what sends those
 * imports at a source file rather than a published build; every other
 * resolution shows up in {@link bundleOnce}'s inputs as the file it resolved
 * to. One run measures one tree, so the answer is computed once per process.
 */
export const buildBin = (): string => {
  bin ??= bundleOnce({
    entryPoint: fileURLToPath(new URL("../../src/flow/bin.ts", import.meta.url)),
    directory: fileURLToPath(new URL("../../node_modules/.migrate-bin/", import.meta.url)),
    external: ["effect", "@effect/*", "typescript"],
    keyedOn: [fileURLToPath(new URL("../../package.json", import.meta.url))]
  })
  return bin
}

/**
 * Node's own warnings, which are not the program's output.
 *
 * Node may print an `ExperimentalWarning` for a feature the binary uses, for
 * example `node:sqlite` on Node 22, followed by the `--trace-warnings` hint.
 * Whether it does depends on the host's Node release, so an assertion that the
 * program said nothing would depend on the machine. Dropping the runtime's own
 * lines keeps the assertion about the program.
 */
const nodeWarning = /^(?:\(node:\d+\) \w*Warning:|\(Use `node --trace-warnings).*$\n?/gm

/** Runs the built bin and returns its exit code and both streams. */
export const runBin = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env
): { readonly status: number; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync(process.execPath, [buildBin(), ...args], {
    encoding: "utf8",
    env: environment as Record<string, string>
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").replace(nodeWarning, "")
  }
}
