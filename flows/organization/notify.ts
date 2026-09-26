/**
 * Owner notifications without Slack: a host whose Slack app is not
 * configured tells the owner on this Mac when a run parks at a gate or
 * fails, as a macOS notification. On by default; `SMITHERS_ORG_NOTIFY=off`
 * turns it off. With Slack configured the owner is reached there instead.
 *
 * Each gate and each failed run is announced once, across restarts: what was
 * announced is kept in `<state>/notified.json`. A host starting on a state
 * directory it never announced from says nothing about runs that failed
 * before, and announces every gate still waiting.
 */
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunView } from "./client.ts"

/** One thing to tell the owner. */
export interface Notice {
  readonly key: string
  readonly text: string
}

/** The notices `runs` call for: each gate to answer, and each failed run. */
export const notices = (runs: ReadonlyArray<RunView>): ReadonlyArray<Notice> =>
  runs.flatMap((run): ReadonlyArray<Notice> =>
    run.status === "failed"
      ? [{ key: `failed:${run.runId}`, text: `${run.runId} failed` }]
      : run.gates.map((gate) => ({
        key: `gate:${gate.runId}:${gate.subjectDigest}`,
        text: `answer ${gate.gateId}: ${gate.prompt.split("\n")[0]!.slice(0, 160)}`
      }))
  )

/** The `osascript` arguments that show `notice`; the text is passed as data, never as script. */
export const osascript = (notice: Notice): ReadonlyArray<string> => [
  "-e",
  "on run argv",
  "-e",
  "display notification (item 1 of argv) with title \"Smithers\"",
  "-e",
  "end run",
  notice.text
]

/** Shows `notice` in macOS Notification Center. */
export const macNotifier = (notice: Notice): void => {
  const shown = spawnSync("osascript", [...osascript(notice)], { encoding: "utf8", timeout: 10_000 })
  if (shown.status !== 0) {
    throw new Error(`osascript: ${(shown.stderr || shown.error?.message || "failed").trim().split("\n")[0]}`)
  }
}

/** Whether a host notifies on this Mac: not on other systems, not with Slack, and not when turned off. */
export const enabled = (
  environment: Readonly<Record<string, string | undefined>>,
  slack: boolean,
  platform = process.platform
) => platform === "darwin" && !slack && (environment.SMITHERS_ORG_NOTIFY ?? "on").toLowerCase() !== "off"

/** The most announced keys kept; older ones belong to runs long settled. */
const kept = 2_000

/** How often a serving host looks for gates and failures. */
export const interval = "15 seconds"

/** What a watcher needs. */
export interface Options {
  readonly stateDir: string
  /** The runs parked at a gate and the failed ones. */
  readonly runs: () => Promise<ReadonlyArray<RunView>>
  readonly notify: (notice: Notice) => void
  readonly log: (line: string) => void
}

/** One look: announces what is new, and records it. */
export const check = async (options: Options): Promise<ReadonlyArray<Notice>> => {
  const file = join(options.stateDir, "notified.json")
  const first = !existsSync(file)
  const seen: Array<string> = first
    ? []
    : (JSON.parse(readFileSync(file, "utf8")) as { readonly keys: Array<string> }).keys
  const known = new Set(seen)
  const fresh = notices(await options.runs()).filter((notice) => !known.has(notice.key))
  const told = first ? fresh.filter((notice) => notice.key.startsWith("gate:")) : fresh
  for (const notice of told) {
    try {
      options.notify(notice)
    } catch (error) {
      options.log(`notification failed: ${(error as Error).message}`)
    }
  }
  if (fresh.length > 0 || first) {
    const keys = [...seen, ...fresh.map((notice) => notice.key)].slice(-kept)
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ keys })}\n`, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  return told
}

/** The serving host's watcher: looks every {@link interval}; a failed look is logged and retried. */
export const watcher = (options: Options) =>
  Effect.promise(() =>
    check(options).then(
      () => undefined,
      (error: unknown) => options.log(`notifications: ${error instanceof Error ? error.message : String(error)}`)
    )
  ).pipe(Effect.andThen(Effect.sleep(interval)), Effect.forever)
