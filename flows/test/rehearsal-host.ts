/** Linux journey fixture. The installed entry remains coding/serve.ts.
 * Its /workspace daemon client requires the guest broker and cannot authorize
 * this trusted-process fixture's temporary checkout. Inject only the std file
 * provider here; routes, journals, models, native source and delivery stay real.
 * This fixture supplies no machining or guest-isolation evidence.
 */
import { StdError } from "@smthrs/std/StdError"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { serve } from "../coding/serve-host.ts"

await serve({
  fileMutationProvider: (root) => ({
    commit: (_session, changes) =>
      Effect.tryPromise({
        try: async () => {
          const checked = []
          for (const change of changes) {
            const path = resolve(root, change.path)
            const suffix = relative(root, path)
            if (!suffix || suffix === ".." || suffix.startsWith(".." + sep) || suffix.startsWith(sep)) {
              throw new StdError({ code: "provider_unavailable", message: "Fixture path escapes its checkout" })
            }
            let current = "absent"
            try {
              current = createHash("sha256").update(await readFile(path)).digest("hex")
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            if (current !== change.base_digest) {
              throw new StdError({
                code: "stale_read",
                path: change.path,
                base_digest: change.base_digest,
                current_digest: current,
                message: "Re-read " + change.path
              })
            }
            checked.push({ ...change, path })
          }
          for (const change of checked) {
            if (change.content === null) {
              await unlink(change.path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error
              })
            } else {
              await mkdir(dirname(change.path), { recursive: true })
              await writeFile(change.path, change.content)
            }
          }
        },
        catch: (error) =>
          error instanceof StdError ?
            error :
            new StdError({ code: "command_failed", message: String(error) })
      })
  })
})
