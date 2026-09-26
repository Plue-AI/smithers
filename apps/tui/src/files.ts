import * as Log from "./log.ts"
/**
 * The files `@` offers: tracked and untracked-but-not-ignored files from git,
 * else `rg --files`, which also honors `.gitignore`. Both print raw
 * NUL-terminated paths, so a name with a newline or non-ASCII bytes arrives
 * exactly as it is on disk. Read again at most once every few seconds so a
 * file the agent just wrote shows up.
 */
import { execFile } from "node:child_process"

const maxFiles = 20_000
const freshMs = 5_000

/**
 * NUL-separated paths. A name that is not valid UTF-8 is dropped: its decoded
 * string would name a different file. Unmerged entries repeat in git's list.
 */
export const parse = (stdout: Buffer): Array<string> => {
  const paths = new Set<string>()
  let start = 0
  for (
    let end = stdout.indexOf(0);
    end >= 0 && paths.size < maxFiles;
    start = end + 1, end = stdout.indexOf(0, start)
  ) {
    const bytes = stdout.subarray(start, end)
    const path = bytes.toString("utf8")
    if (path !== "" && Buffer.from(path, "utf8").equals(bytes)) paths.add(path)
  }
  return [...paths]
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeout: number
): Promise<Array<string> | undefined> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, encoding: "buffer", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) Log.write(`files.${command}`, error)
        resolve(error ? undefined : parse(stdout))
      }
    )
  })

export const list = async (cwd: string, timeoutMs = 2_000): Promise<ReadonlyArray<string>> =>
  await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, timeoutMs) ??
    await run("rg", ["--files", "--null"], cwd, timeoutMs) ?? []

/** `list`, cached for a few seconds. */
export const lister = (
  cwd: string,
  now: () => number = Date.now,
  changed: () => void = () => {}
): () => ReadonlyArray<string> => {
  let cached: ReadonlyArray<string> = []
  let readAt = -Infinity
  let loading = false
  return () => {
    if (!loading && now() - readAt > freshMs) {
      loading = true
      void list(cwd).then((files) => {
        cached = files
        readAt = now()
        loading = false
        changed()
      })
    }
    return cached
  }
}
