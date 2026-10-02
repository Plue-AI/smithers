import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * A person never reads a raw error message, a stack, or `String(error)` in the
 * terminal: a failure reaches the status line, a tab, or stderr through
 * `Failures` (`src/failures.ts`) as one sentence, with the raw text in
 * `tui.log`. The same lexical check as the app's (`RawErrorRender.test.ts`).
 *
 * The allowlist holds the sites that never reach a person, per file and by
 * count: text for the model or a plugin cell, the log itself, and a probe that
 * classifies an error without showing it. A new site fails; a file that drops
 * one fails until its entry shrinks.
 */

const SOURCE = join(import.meta.dir, "..", "src")
const ERROR_NAME = "(?:error|Error|err|cause|reason|failure|Failure|refusal|exception)"
const RAW_ERROR_RENDER = new RegExp(
  [
    `\\b${ERROR_NAME}\\??\\)?\\.message\\b`,
    `\\b${ERROR_NAME}\\??\\)?\\.stack\\b`,
    `\\bString\\(\\s*${ERROR_NAME}\\s*\\)`,
    `\\berrorMessage\\(`
  ].join("|"),
  "g"
)

const ALLOWED: Readonly<Record<string, number>> = {
  // `unreadable`: the model's refusal text for an agent body read.
  "agents.ts": 2,
  // A 401/403 probe that signs the factory out; never shown.
  "app.tsx": 1,
  // The worker's provider error for the model; the person sees `FailureCopy`.
  "box.ts": 2,
  // The refusal text a publishing plugin cell reads.
  "contributions.ts": 2,
  // A plugin manifest's decode problem, for the plugin author.
  "extension.ts": 2,
  // Control-plane text kept on `FlowError.message` for the model and the log.
  "flow-control.ts": 3,
  // A suspended flow's own question, and the run's persisted message field.
  "flows.ts": 2,
  // Cell and model-facing results.
  "host.ts": 4,
  // The log.
  "log.ts": 4,
  // `MonitorError` and `message`: the model's monitor context.
  "monitors.ts": 11,
  // The model's tool errors.
  "runtime.ts": 3,
  // The model's grep tool.
  "search.ts": 2,
  // `SessionWriteFailed.message`, presented through `Failures`.
  "session.ts": 2,
  // The errno code `because` words.
  "undo.ts": 1,
  // The worker record's message, for the model; the tab shows the presented headline.
  "workspace.ts": 5,
  // Codex's own error event, as the wrapped worker's result.
  "wrapped.ts": 1
}

const countSites = (source: string): number => source.match(RAW_ERROR_RENDER)?.length ?? 0

const offenders = (): Record<string, number> =>
  Object.fromEntries(
    readdirSync(SOURCE)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => [name, countSites(readFileSync(join(SOURCE, name), "utf8"))] as const)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  )

describe("TUI files never show a raw error", () => {
  test("the lexical check sees each banned shape", () => {
    for (
      const line of [
        "setStatus(error.message)",
        "`Fork failed: ${String(error)}`",
        "(cause as Error).message",
        "console.error(err.stack)"
      ]
    ) expect(countSites(line)).toBe(1)
    for (const line of ["Failures.line(\"fork\", error)", "failure.sentence", "row.message"]) {
      expect(countSites(line)).toBe(0)
    }
  })

  test("only the allowlisted sites remain, and the list only shrinks", () => {
    expect(offenders()).toEqual(ALLOWED)
  })

  test("the user-facing entry points hold no raw site at all", () => {
    for (
      const file of ["run.tsx", "cli.ts", "shell.ts", "picker.ts", "failures.ts"]
    ) {
      expect(countSites(readFileSync(join(SOURCE, file), "utf8"))).toBe(0)
    }
  })
})
