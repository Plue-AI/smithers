/** Controlled, single-process rehearsal only. No daemon or isolation qualification.
 * No await separates comparison and publication; scripted journeys have no
 * external writers. Refuse multi-file/deletion operations instead of simulating
 * an atomic transaction with ordered writes. Never linked by the install entry.
 */
import { StdError } from "@smthrs/std/StdError"
import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { MutationProvider } from "../../coding/filesystem.ts"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const refused = () => new StdError({ code: "provider_unavailable", message: "Rehearsal mutation refused" })
export const make = (canonicalRoot: string): MutationProvider => {
  const root = realpathSync(canonicalRoot)
  return {
    commit: (session, changes) => Effect.try({
      try: () => {
        if (!session || changes.length !== 1) throw refused()
        const change = changes[0]!
        if (change.content === null || change.content.byteLength > 1024 * 1024 || isAbsolute(change.path)) throw refused()
        const target = resolve(root, change.path)
        const suffix = relative(root, target)
        if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || suffix.split(sep).some((part) => part === ".jj" || part === ".git")) throw refused()
        // Refuse any symlink component, including a link back into the root.
        let parent = root
        for (const component of suffix.split(sep).slice(0, -1)) {
          parent = join(parent, component)
          try {
            const entry = lstatSync(parent)
            if (entry.isSymbolicLink() || !entry.isDirectory()) throw refused()
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          }
        }
        let current = "absent"
        let mode = 0o600
        try {
          const entry = lstatSync(target)
          if (!entry.isFile() || entry.isSymbolicLink()) throw refused()
          mode = entry.mode & 0o777
          current = digest(readFileSync(target))
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        }
        if (current !== change.base_digest) throw new StdError({
          code: "stale_read", path: target, base_digest: change.base_digest,
          current_digest: current, message: `Re-read ${target}`
        })
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        const temporary = join(dirname(target), `.rehearsal-${randomUUID()}`)
        const fd = openSync(temporary, "wx", mode)
        try {
          try {
            writeFileSync(fd, change.content)
          } finally {
            closeSync(fd)
          }
          renameSync(temporary, target)
        } finally {
          try { unlinkSync(temporary) } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          }
        }
      },
      catch: (error) => error instanceof StdError ? error : refused()
    })
  }
}
