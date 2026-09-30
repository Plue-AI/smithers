import { spawnSync } from "node:child_process"

/**
 * How long a real-provider suite waits for a host CLI to say whether its
 * capability is here. Discovery runs while Vitest imports the suite, before any
 * test or hook deadline exists, so this is the only bound on collection.
 */
export const discoveryDeadlineMs = 20_000

/** What a discovery command said: its exit status (`null` when it could not start) and stdout. */
export interface Answer {
  readonly status: number | null
  readonly stdout: string
}

/**
 * Runs one capability probe with a finite deadline, killing the probe's child
 * when it expires. A command that is absent or exits non-zero is an answer;
 * one that never answers is not, so it throws, and the suite fails to collect
 * with that reason instead of hanging or being mistaken for a missing
 * capability and skipped.
 */
export const discover = (
  command: string,
  args: ReadonlyArray<string>,
  deadlineMs: number = discoveryDeadlineMs
): Answer => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: deadlineMs,
    killSignal: "SIGKILL"
  })
  const error = result.error as NodeJS.ErrnoException | undefined
  if (error?.code === "ETIMEDOUT") {
    throw new Error(
      `capability discovery \`${[command, ...args].join(" ")}\` did not answer within ${deadlineMs} ms, so it`
        + " was killed; a stalled probe is a host failure, not a missing capability"
    )
  }
  // Node reports a command that could not start as status `null`; Bun as
  // `undefined`. Both mean the same absent capability.
  return { status: result.status ?? null, stdout: result.stdout ?? "" }
}
