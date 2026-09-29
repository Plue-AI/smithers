/**
 * Confined publication shared by the native artifact writers.
 * @since 1.0.0
 */

import * as SafeFs from "@smthrs/targets/SafeFs"
import { randomBytes } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

const stat = (path: string) =>
  Fs.lstat(path, { bigint: true }).catch((cause: unknown) => {
    if (SafeFs.errorCode(cause) === "ENOENT") return undefined
    throw cause
  })

/**
 * Produces a private sibling file, then publishes it after rechecking its
 * parent. The producer must create the temporary exclusively and close it
 * before returning. Cleanup never traverses a parent that failed admission.
 *
 * @category execution
 * @since 1.0.0
 */
export const publish = async <A>(
  workspaceRoot: string,
  output: string,
  produce: (temporary: string, checkParent: () => Promise<void>) => Promise<A>,
  signal?: AbortSignal
): Promise<A> => {
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  if (Path.isAbsolute(output) || output.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    throw new Error(`native output must name a file inside the workspace: ${output}`)
  }
  const destination = Path.resolve(root, output)
  if (!SafeFs.inside(root, destination) || destination === root) {
    throw new Error(`native output must name a file inside the workspace: ${output}`)
  }
  const directories: Array<SafeFs.Entry> = []
  const missing: Array<string> = []
  const checkParent = async (cleanup = false): Promise<void> => {
    const activeSignal = cleanup ? undefined : signal
    activeSignal?.throwIfAborted()
    for (const expected of directories) {
      const current = await SafeFs.resolveDirectory(expected.path, {
        root,
        what: "native output parent",
        signal: activeSignal
      })
      if (
        current === undefined || current.stats.dev !== expected.stats.dev || current.stats.ino !== expected.stats.ino
      ) {
        throw new Error(`native output parent changed or is a symbolic link: ${expected.path}`)
      }
    }
  }
  let directory = root
  for (const part of ["", ...Path.relative(root, Path.dirname(destination)).split(Path.sep).filter(Boolean)]) {
    directory = Path.join(directory, part)
    await checkParent()
    const entry = await SafeFs.resolveDirectory(directory, { root, what: "native output parent", signal })
    if (entry === undefined) {
      if (await stat(directory) !== undefined) {
        throw new Error(`native output parent is not a real directory: ${directory}`)
      }
      missing.push(directory)
    } else {
      directories.push(entry)
    }
  }
  // Fetch can reject an HTTP response without creating any directories.
  // Create admitted missing parents only when the producer is ready to write.
  const prepareParent = async (): Promise<void> => {
    await checkParent()
    for (const path of missing) {
      await checkParent()
      await Fs.mkdir(path).catch((cause: unknown) => {
        if (SafeFs.errorCode(cause) !== "EEXIST") throw cause
      })
      const entry = await SafeFs.resolveDirectory(path, { root, what: "native output parent", signal })
      if (entry === undefined) throw new Error(`native output parent could not be created: ${path}`)
      directories.push(entry)
    }
    missing.length = 0
  }
  const checkDestination = async (): Promise<void> => {
    await checkParent()
    await SafeFs.resolveFile(destination, { root, symlinks: "reject", what: "native output", signal })
  }
  await checkDestination()
  const temporary = Path.join(
    Path.dirname(destination),
    `.smthrs-artifact-${process.pid}-${randomBytes(6).toString("hex")}`
  )
  try {
    const result = await produce(temporary, prepareParent)
    await checkDestination()
    await SafeFs.resolveFile(temporary, { root, symlinks: "reject", what: "native output temporary", signal })
    await Fs.rename(temporary, destination)
    return result
  } finally {
    // If a directory was replaced, removing this name could remove someone
    // else's file outside the workspace. Leave the detached temporary alone.
    await (async () => {
      await checkParent(true)
      // A failed download may never have created its admitted parents. Do
      // not follow a new entry that appeared there while the request ran.
      for (const path of missing) {
        if (await stat(path) !== undefined) return
      }
      await Fs.rm(temporary, { force: true })
    })().catch(() => undefined)
  }
}
