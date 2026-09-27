/**
 * The scripted fake agent: a deterministic {@link AgentSession.SessionFactory}
 * that replays a JSON script of findings, candidate edits, and failures
 * instead of spawning a real `claude` or `codex` CLI process.
 *
 * The fake exists so every agent-target proof — vacuous green, bounded
 * rounds, write-set escapes, verdict-cache replay — runs without model spend
 * and with exact spawn accounting. Setting `SMTHRS_AGENT_FAKE=<script.json>`
 * selects it through {@link sessionFactoryFromEnvironment}; each session run
 * consumes the next scripted response in order and appends one line to a
 * spawn log next to the script, so an outside observer can prove how many
 * sessions ran (including zero).
 *
 * @since 0.1.0
 */

import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import type { AgentSession, CliSessionOptions, GateRunner, SessionFactory, SessionRequest } from "./AgentSession.ts"
import { makeCliSessionFactory } from "./AgentSession.ts"

/**
 * The environment variable that selects the scripted fake: the path of a
 * script file decoded by {@link FakeScript}.
 *
 * @category constants
 * @since 0.1.0
 */
export const fakeEnvironmentVariable = "SMTHRS_AGENT_FAKE"

/**
 * Environment variable naming the per-session wall-clock ceiling in
 * milliseconds for the real CLI factory. Unset, the factory keeps
 * {@link defaultSessionTimeoutMs}; a lane that rewrites large files with a
 * slow model raises it for one invocation without a declaration change.
 *
 * @category models
 * @since 0.1.0
 */
export const timeoutEnvironmentVariable = "SMTHRS_AGENT_TIMEOUT_MS"

/**
 * Reads the session ceiling from the environment: a positive integer of
 * milliseconds, or `undefined` when unset. Anything else refuses loudly,
 * because a silently ignored ceiling would look like the default.
 *
 * @category accessors
 * @since 0.1.0
 */
export const sessionTimeoutFromEnvironment = (
  env: Readonly<Record<string, string | undefined>>
): number | undefined => {
  const declared = env[timeoutEnvironmentVariable]
  if (declared === undefined || declared === "") return undefined
  if (!/^[1-9][0-9]*$/.test(declared)) {
    throw new Error(
      `${timeoutEnvironmentVariable} must be a positive integer of milliseconds: ${JSON.stringify(declared)}`
    )
  }
  return Number(declared)
}

/**
 * Schema of one scripted session response.
 *
 * A response with `fail` makes the run fail with that message. `purpose`,
 * when present, asserts what the run must have been asked for — a mismatch
 * fails loudly, because a fake that answers the wrong question would fake
 * green. `findings`, `edits`, and `note` mirror the live session envelope.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ScriptedResponse = Schema.Struct({
  purpose: Schema.optional(Schema.Literals(["lint", "fix", "diff"])),
  findings: Schema.optional(
    Schema.Array(AgentTarget.Finding).check(Schema.isMaxLength(AgentTarget.maximumFindings))
  ),
  edits: Schema.optional(
    Schema.Array(AgentTarget.CandidateEdit).check(Schema.isMaxLength(AgentTarget.maximumEdits))
  ),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(16 * 1024))),
  fail: Schema.optional(Schema.NonEmptyString)
})

/**
 * One scripted session response.
 *
 * @category models
 * @since 0.1.0
 */
export type ScriptedResponse = typeof ScriptedResponse.Type

/**
 * Schema of one fake script file.
 *
 * `identity` substitutes for the resolved agent identity in verdict keys, so
 * two scripts with different identities re-key each other's cached verdicts
 * exactly like two different real agent declarations would.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FakeScript = Schema.Struct({
  identity: Schema.optional(Schema.NonEmptyString),
  responses: Schema.Array(ScriptedResponse)
})

/**
 * One fake script.
 *
 * @category models
 * @since 0.1.0
 */
export type FakeScript = typeof FakeScript.Type

const decodeFakeScript = Schema.decodeUnknownSync(FakeScript)

/**
 * Reads and decodes one fake script file; an unreadable or invalid script
 * throws loudly rather than degrading into an empty fake.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadFakeScript = (path: string): FakeScript => {
  const text = NodeFs.readFileSync(path, "utf8")
  return decodeFakeScript(JSON.parse(text))
}

/**
 * A scripted session factory with exact spawn accounting.
 *
 * `opens` counts sessions opened, `spawns` counts session runs (one run is
 * what one CLI subprocess spawn would be), and `requests` preserves every
 * run request in order for prompt-content assertions.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScriptedSessionFactory extends SessionFactory {
  readonly opens: () => number
  readonly spawns: () => number
  readonly requests: () => ReadonlyArray<SessionRequest>
}

/**
 * Options for {@link makeScriptedSessionFactory}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScriptedFactoryOptions {
  /** JSONL file appended with one line per session run, for cross-process spawn proofs. */
  readonly logPath?: string | undefined
}

const scriptedError = (
  phase: (typeof AgentTarget.AgentSessionError)["Type"]["phase"],
  message: string
): AgentTarget.AgentSessionError => new AgentTarget.AgentSessionError({ phase, message })

/**
 * The `--- <path> ---` headers under a prompt's `=== FILES ===` section, for
 * cross-process proofs that a lane rendered its data closure.
 *
 * @category accessors
 * @since 0.1.0
 */
export const promptFilesOf = (prompt: string): ReadonlyArray<string> => {
  const start = prompt.indexOf("\n=== FILES ===\n")
  if (start === -1) return []
  const end = prompt.indexOf("\n=== DIFF SLICE ===\n", start)
  const section = prompt.slice(start, end === -1 ? undefined : end)
  return [...section.matchAll(/^--- (.+) ---$/gm)].map((match) => match[1]!)
}

/**
 * A session factory that replays one {@link FakeScript} deterministically.
 *
 * The response cursor is shared across every session the factory opens: run
 * N answers with response N regardless of session boundaries, so a
 * multi-round loop consumes its rounds in declared order. Running past the
 * end of the script fails loudly — a fake that silently improvises would
 * fake green.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeScriptedSessionFactory = (
  script: FakeScript,
  options?: ScriptedFactoryOptions
): ScriptedSessionFactory => {
  let opened = 0
  let cursor = 0
  const seen: Array<SessionRequest> = []
  const identity = script.identity ?? "scripted-fake"
  const record = (request: SessionRequest): void => {
    seen.push(request)
    if (options?.logPath !== undefined) {
      const line = JSON.stringify({
        seq: seen.length,
        purpose: request.purpose,
        promptDigest: createHash("sha256").update(request.prompt, "utf8").digest("hex"),
        files: promptFilesOf(request.prompt)
      })
      NodeFs.appendFileSync(options.logPath, `${line}\n`, "utf8")
    }
  }
  const session: AgentSession = {
    identity,
    run: (request) =>
      Effect.suspend(() => {
        record(request)
        const response = script.responses[cursor]
        if (response === undefined) {
          return Effect.fail(scriptedError(
            "spawn",
            `the fake script is exhausted: run ${seen.length} has no scripted response ` +
              `(${script.responses.length} declared)`
          ))
        }
        cursor += 1
        if (response.purpose !== undefined && response.purpose !== request.purpose) {
          return Effect.fail(scriptedError(
            "parse",
            `scripted response ${cursor} expects purpose ${JSON.stringify(response.purpose)} ` +
              `but the session asked for ${JSON.stringify(request.purpose)}`
          ))
        }
        if (response.fail !== undefined) {
          return Effect.fail(scriptedError("spawn", response.fail))
        }
        return Effect.succeed({
          findings: response.findings ?? [],
          edits: response.edits ?? [],
          note: response.note
        })
      })
  }
  return {
    open: () =>
      Effect.sync(() => {
        opened += 1
        return session
      }),
    opens: () => opened,
    spawns: () => seen.length,
    requests: () => [...seen]
  }
}

/**
 * The session factory one command should use: the scripted fake when
 * `SMTHRS_AGENT_FAKE` names a script file, the real CLI factory otherwise.
 *
 * A relative script path resolves against the workspace root. The fake
 * appends its spawn log to `<script>.spawns.jsonl` so the invoking test can
 * count sessions from outside the process.
 *
 * @category constructors
 * @since 0.1.0
 */
export const sessionFactoryFromEnvironment = (
  options: CliSessionOptions,
  env: Readonly<Record<string, string | undefined>>
): SessionFactory => {
  const declared = env[fakeEnvironmentVariable]
  if (declared === undefined || declared === "") {
    const timeoutMs = options.timeoutMs ?? sessionTimeoutFromEnvironment(env)
    return makeCliSessionFactory(timeoutMs === undefined ? options : { ...options, timeoutMs })
  }
  const path = NodePath.isAbsolute(declared) ? declared : NodePath.resolve(options.workspaceRoot, declared)
  return makeScriptedSessionFactory(loadFakeScript(path), { logPath: `${path}.spawns.jsonl` })
}

/**
 * One recorded scripted gate-runner call.
 *
 * `files` are the candidate overlay paths the gates were shown, proving the
 * gates ran against the exact candidate tree of the round.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScriptedGateCall {
  readonly round: number
  readonly gates: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
}

/**
 * A scripted gate runner with call accounting.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScriptedGateRunner extends GateRunner {
  readonly calls: () => ReadonlyArray<ScriptedGateCall>
}

/**
 * A gate runner that replays one scripted report per call, in order.
 *
 * Calling past the end of the script fails loudly for the same reason the
 * session fake does: an improvised gate verdict is fake green.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeScriptedGateRunner = (
  reports: ReadonlyArray<ReadonlyArray<AgentTarget.GateReportEntry>>
): ScriptedGateRunner => {
  let cursor = 0
  const seen: Array<ScriptedGateCall> = []
  return {
    run: (gateIdentities, overlay, round) =>
      Effect.suspend(() => {
        seen.push({ round, gates: [...gateIdentities], files: [...overlay.files.keys()].sort() })
        const report = reports[cursor]
        if (report === undefined) {
          return Effect.fail(scriptedError(
            "gate",
            `the scripted gate runner is exhausted: call ${seen.length} has no scripted report ` +
              `(${reports.length} declared)`
          ))
        }
        cursor += 1
        return Effect.succeed(report)
      }),
    calls: () => [...seen]
  }
}
