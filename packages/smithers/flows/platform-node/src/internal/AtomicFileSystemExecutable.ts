/**
 * Finds the native filesystem helper embedded in a host, shipped with this package, or built in a
 * source checkout, without accepting an executable from the workspace.
 * @since 1.0.0
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { usableExecutable } from "./AtomicFileSystemTransport.ts"

/* v8 ignore next -- the packed CJS consumer uses its loader's __dirname; source tests use the ESM loader */
const moduleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url))

/**
 * The same source module lives one directory deeper after an npm build.
 * @private
 * @since 1.0.0
 */
export const resolvePackageRoot = (directory: string): string => {
  const sourcePackageRoot = resolve(directory, "../..")
  return existsSync(join(sourcePackageRoot, "package.json"))
    ? sourcePackageRoot
    : resolve(directory, "../../..")
}

/**
 * Finds the installed package even when a host bundles this adapter elsewhere.
 * @private
 * @since 1.0.0
 */
export const installedPackageRoot = (modulePath: string, fallback: string): string => {
  try {
    return dirname(createRequire(modulePath).resolve("@smthrs/platform-node/package.json"))
  } catch {
    // A compiled executable has no installed package; its bootstrap supplies
    // the embedded helper. Source-only fixtures retain the directory fallback.
    return fallback
  }
}

/**
 * Package containing the currently loaded helper adapter.
 * @private
 * @since 1.0.0
 */
export const packageRoot = installedPackageRoot(
  join(moduleDirectory, "resolver.cjs"),
  resolvePackageRoot(moduleDirectory)
)

const staged = new Map<string, string>()
const installHint = "install @smthrs/platform-node with its native helper, " +
  "run cargo build --locked --release -p smithers-ffi --bin smithers-jj-export in a source checkout, " +
  "or set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path"

const helperName = process.platform === "win32" ? "smithers-jj-export.exe" : "smithers-jj-export"
let embeddedHelper: string | undefined

/**
 * Supplies the build's native asset without touching disk during --help.
 * @private
 * @since 1.0.0
 */
export const registerEmbeddedHelper = (source: string): void => {
  embeddedHelper = source
}

/**
 * Pin an install inside the workspace before any flow can modify its bytes.
 * @private
 * @since 1.0.0
 */
export const outsideWorkspace = (
  source: string,
  boundaryRoot: string | undefined,
  bases: ReadonlyArray<string> = [tmpdir(), homedir()]
): string => {
  const cached = staged.get(source)
  if (cached !== undefined) return usableExecutable(cached, boundaryRoot)
  for (const [index, base] of bases.entries()) {
    const directory = mkdtempSync(join(base, ".smthrs-atomic-helper-"))
    const destination = join(directory, helperName)
    try {
      chmodSync(directory, 0o700)
      // readFile also supports assets embedded in a Bun executable; copyfile
      // delegates to the OS, which cannot open its virtual /$bunfs path.
      writeFileSync(destination, readFileSync(source), { flag: "wx", mode: 0o500 })
      chmodSync(destination, 0o500)
      const executable = usableExecutable(destination, boundaryRoot)
      staged.set(source, executable)
      process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
      return executable
    } catch (cause) {
      rmSync(directory, { recursive: true, force: true })
      if (index === bases.length - 1) throw cause
    }
  }
  throw new Error("no staging location for smithers-jj-export")
}

/** The helper an installed package ships for this platform. */
const packagedHelper = (root: string): string => join(root, "bin", `${process.platform}-${process.arch}`, helperName)

/**
 * Stages the packaged helper now, when the host layer is built, so the bytes
 * later requests execute are the ones present before any flow ran. A flow
 * that rewrites a workspace-local install afterwards changes nothing that is
 * executed. A missing or unusable helper is left for the first request to
 * report.
 * @private
 * @since 1.0.0
 */
export const stagePackaged = (root: string): void => {
  const candidate = embeddedHelper ?? packagedHelper(root)
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) outsideWorkspace(candidate, undefined)
  } catch {
    // The request path resolves again and reports the refusal it meets.
  }
}

/**
 * Select only trusted package or checkout locations; never consult PATH or cwd.
 * @private
 * @since 1.0.0
 */
export const resolveDefaultExecutable = (
  root: string,
  boundaryRoot: string | undefined,
  fallback = "/usr/local/bin/smithers-jj-export"
): string => {
  if (embeddedHelper !== undefined) return outsideWorkspace(embeddedHelper, boundaryRoot)
  const candidates = [packagedHelper(root)]
  const checkout = resolve(root, "../../../..")
  if (existsSync(join(checkout, "pnpm-workspace.yaml"))) {
    candidates.push(join(checkout, "target/release", helperName))
    candidates.push(join(checkout, "target/debug", helperName))
  }
  candidates.push(fallback)
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue
    if (index === 0) {
      if (!statSync(candidate).isFile()) throw new Error(`packaged atomic helper is not a regular file: ${candidate}`)
      // npm/pnpm tarballs may store package files without executable bits.
      return outsideWorkspace(candidate, boundaryRoot)
    }
    const executable = usableExecutable(candidate, undefined)
    try {
      return usableExecutable(executable, boundaryRoot)
    } catch (cause) {
      if (
        index === candidates.length - 1 || !(cause instanceof Error) ||
        !cause.message.includes("outside the confined workspace")
      ) throw cause
      return outsideWorkspace(executable, boundaryRoot)
    }
  }
  throw new Error(`smithers-jj-export is missing; ${installHint} (searched ${candidates.join(", ")})`)
}

/**
 * The helper `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` names, refused with the same
 * install hint as a missing one.
 * @private
 * @since 1.0.0
 */
export const resolveConfiguredExecutable = (configured: string, boundaryRoot: string | undefined): string => {
  try {
    return usableExecutable(configured, boundaryRoot)
  } catch (cause) {
    // `usableExecutable` and the node:fs calls it makes throw only Error objects.
    const reason = (cause as Error).message
    throw new Error(
      `smithers-jj-export is unusable at SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${configured}: ${reason}; ${installHint}`
    )
  }
}
