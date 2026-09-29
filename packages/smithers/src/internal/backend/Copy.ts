/**
 * Streaming workspace copies with archive containment at the local boundary.
 * @since 1.0.0
 */

import type { Stats } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join, posix, resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import * as tar from "tar"
import { Refused, UsageError } from "../../CliError.ts"
import { str } from "./Client.ts"
import { spawn } from "./Process.ts"
import type { Handler } from "./Resources.ts"
import { quote, sshArgs } from "./SSH.ts"
import { resolveID, workspaceSSH } from "./Workspaces.ts"
/** @private
 * @since 1.0.0
 */
export const copyEndpoint = (raw: string) => {
  const index = raw.indexOf(":")
  if (index < 0 || index === 1 || /^[/.]/.test(raw)) return { remote: false, id: "", path: raw }
  return { remote: true, id: raw.slice(0, index) === "ws" ? "" : raw.slice(0, index), path: raw.slice(index + 1) }
}
const contentsPath = (path: string) =>
  path.length > 2 && path.endsWith("/.") ? { path: path.slice(0, -2), contents: true } : { path, contents: false }
const guard = "command -v tar >/dev/null 2>&1 || { echo 'workspace image has no tar' >&2; exit 43; }; "
/** @private
 * @since 1.0.0
 */
export const copyScript = (upload: boolean, path: string, name: string, contents: boolean) => {
  const clean = posix.normalize(path), parent = posix.dirname(clean)
  if (!upload) {
    return guard +
      `test -e ${quote(clean)} || { echo 'remote path not found' >&2; exit 44; }; tar -cf - -C ${
        quote(contents ? clean : parent)
      } ${quote(contents ? "." : posix.basename(clean))}`
  }
  if (contents || path.endsWith("/")) return guard + `mkdir -p ${quote(clean)} && tar -o -xf - -C ${quote(clean)}`
  return guard +
    `if [ -d ${quote(clean)} ]; then tar -o -xf - -C ${quote(clean)}; else mkdir -p ${quote(parent)} && t=$(mktemp -d ${
      quote(posix.join(parent, ".smithers-cp.XXXXXX"))
    }) && tar -o -xf - -C "$t" && rm -rf ${quote(clean)} && mv "$t/"${quote(name)} ${
      quote(clean)
    }; rc=$?; rm -rf "$t"; exit $rc; fi`
}
/** @private
 * @since 1.0.0
 */
export const archiveFilter = (root: string) => (path: string, entry: tar.ReadEntry | Stats) => {
  if (!("type" in entry)) return true
  const normalized = posix.normalize(path.replaceAll("\\", "/"))
  const within = (name: string) =>
    !posix.isAbsolute(name) && name !== ".." && !name.startsWith("../") &&
    (!root || name === root || name.startsWith(root + "/"))
  if (!within(normalized.replace(/\/$/, ""))) {
    throw new Refused({ fault: "policy", code: "archive_refused", message: "Archive entry escapes the requested path" })
  }
  if (entry.type === "Link" && !within(posix.normalize(entry.linkpath || ""))) {
    throw new Refused({
      fault: "policy",
      code: "archive_refused",
      message: "Archive hard link escapes the requested path"
    })
  }
  return ["File", "Directory", "SymbolicLink", "Link", "OldFile"].includes(entry.type)
}
const symlinkRefused = () =>
  new Refused({ fault: "policy", code: "symlink_refused", message: "Refusing to write through a symlink" })
const exists = async (path: string) => {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  }
}
const merge = async (source: string, destination: string) => {
  const info = await lstat(source), old = await exists(destination)
  if (old?.isSymbolicLink() && !info.isSymbolicLink()) throw symlinkRefused()
  if (info.isDirectory() && old?.isDirectory()) {
    for (const child of await readdir(source)) await merge(join(source, child), join(destination, child))
  } else {
    if (old) await rm(destination, { recursive: true })
    await rename(source, destination)
  }
}
/** @private
 * @since 1.0.0
 */
export const copy: Handler = async (c, a, o) => {
  const from = copyEndpoint(str(a.src)), to = copyEndpoint(str(a.dst))
  if (from.remote === to.remote || !from.path.trim() || !to.path.trim()) {
    throw new UsageError({ message: "Exactly one non-empty src or dst must be remote (<workspace-id>:<path>)" })
  }
  const endpoint = from.remote ? from : to,
    id = await resolveID(c, { id: endpoint.id }, o),
    ssh = await workspaceSSH(c, id, o)
  const upload = !from.remote,
    source = contentsPath(from.path),
    name = source.contents
      ? "."
      : (upload ? basename(resolve(source.path)) : posix.basename(posix.normalize(source.path)))
  const stats = { bytes: 0, files: 0 }
  let scratch: string | undefined
  try {
    let destination = "", renameTo = ""
    if (!upload) {
      const info = await exists(to.path)
      destination = source.contents || to.path.endsWith("/") || info?.isDirectory() ? to.path : dirname(to.path)
      renameTo = source.contents ? "" : info?.isDirectory() || to.path.endsWith("/") ? name : basename(to.path)
      await mkdir(destination, { recursive: true })
      // Extract into a private directory before touching existing user files.
      scratch = await mkdtemp(join(resolve(destination), ".smithers-cp-"))
    }
    const script = copyScript(upload, upload ? to.path : source.path, name, source.contents)
    const child = spawn("ssh", [...await sshArgs(c, ssh), script], {
      env: c.env,
      stdio: "pipe",
      signal: c.runtime.signal
    })
    let stderr = "", expired = false
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8192)
    })
    const exited = child.exited.catch((error: unknown) => {
      if (expired) throw new Refused({ fault: "user", code: "timed_out", message: "Workspace copy timed out" })
      throw error
    })
    // Every path below awaits `exited`; this keeps an early throw from
    // leaving its rejection unhandled.
    exited.catch(() => {})
    const timer = setTimeout(() => {
      expired = true
      child.kill()
    }, (Number(o.timeout) > 0 ? Number(o.timeout) : 600) * 1000)
    try {
      let transferError: unknown
      if (upload) {
        const info = await lstat(source.path)
        if (source.contents && !info.isDirectory()) throw new UsageError({ message: "/. requires a directory" })
        const packed = tar.c({
          cwd: source.contents ? source.path : dirname(resolve(source.path)),
          portable: true,
          noMtime: false,
          filter: (_path, stat) => {
            if ("isFile" in stat && stat.isFile()) {
              stats.files++
              stats.bytes += stat.size
            }
            return true
          }
        }, [name])
        child.stdout!.resume()
        await Promise.all([
          pipeline(packed, child.stdin!).catch((error) => {
            transferError = error
          }),
          exited
        ])
      } else {
        child.stdin!.end()
        let archiveError: unknown
        const validate = archiveFilter(source.contents ? "" : name)
        const unpacked = tar.x({
          cwd: scratch!,
          strict: true,
          preservePaths: false,
          preserveOwner: false,
          filter: (path, entry) => {
            try {
              return validate(path, entry)
            } catch (error) {
              archiveError = error
              return false
            }
          },
          onReadEntry: (entry) => {
            if (["File", "OldFile", "Link"].includes(entry.type)) {
              stats.files++
              stats.bytes += entry.type === "Link" ? 0 : entry.size
            }
          }
        })
        await Promise.all([
          pipeline(child.stdout!, unpacked).catch((error) => {
            transferError = error
          }),
          exited
        ])
        transferError ??= archiveError
      }
      const code = await exited
      if (code) {
        c.runtime.exit?.(code)
        // The remote tool's own words go to stderr, never into the sentence.
        if (code !== 43 && code !== 44 && stderr) c.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`)
        throw code === 43
          ? new Refused({ fault: "dependency", code: "workspace_no_tar", message: "Workspace image has no tar" })
          : code === 44
          ? new Refused({ fault: "user", code: "not_found", message: "Remote path not found" })
          : new Refused({ fault: "dependency", code: "copy_failed", message: `Workspace copy failed (${code})` })
      }
      if (transferError) throw transferError
    } finally {
      clearTimeout(timer)
      child.kill()
    }
    if (scratch) {
      // Refuse symlink parents before merging. Tar never follows archive links.
      let current = resolve(destination)
      for (;;) {
        if ((await lstat(current)).isSymbolicLink()) throw symlinkRefused()
        const parent = dirname(current)
        if (current === parent) break
        current = parent
      }
      if (source.contents) {
        for (const entry of await readdir(scratch)) await merge(join(scratch, entry), join(destination, entry))
      } else await merge(join(scratch, name), join(destination, renameTo))
    }
    return { workspace_id: id, ...stats }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}
