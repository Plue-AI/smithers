/** The repository's private preview target owns builds, deployment and login. */
import { Action, Fault, Flow } from "@smthrs/flow"
import { Journal } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { TaggedError } from "effect/Schema"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as ContainedProcess from "../../packages/smithers/build/build-cli/src/internal/ContainedProcess.ts"

export class PreviewFailed extends TaggedError<PreviewFailed>()("preview/Failed", {
  code: Schema.Literals([
    "no_target",
    "ambiguous_target",
    "revision_not_checked_out",
    "builder_unavailable",
    "credentials_missing",
    "build_failed",
    "deploy_failed",
    "public_access_off"
  ]),
  step: Schema.Literals(["build", "deploy"]),
  message: Schema.String,
  retryable: Schema.Boolean
}) {}
Fault.register(
  "preview/Failed",
  {
    no_target: "dependency",
    ambiguous_target: "bug",
    revision_not_checked_out: "bug",
    builder_unavailable: "dependency",
    credentials_missing: "dependency",
    build_failed: "dependency",
    deploy_failed: "dependency",
    public_access_off: "bug"
  } satisfies Fault.Rows<PreviewFailed["code"]>
)
export const Success = Schema.Struct({
  revision: Schema.String,
  expiresAt: Schema.String,
  access: Schema.Literal("private"),
  open: Schema.Struct({ command: Schema.String, localUrl: Schema.String })
})
const fail = (
  code: PreviewFailed["code"],
  message: string,
  step: PreviewFailed["step"] = "deploy",
  retryable = false
) => new PreviewFailed({ code, step, message, retryable })

// Resolve exactly the git HEAD used by S.Stamp.commit; never checkout input.
const head = () => {
  try {
    if (!existsSync(".git")) throw Error("No local repository")
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
    if (/^[a-f0-9]{40}$/.test(commit)) return commit
  } catch { /* Refuse unresolved HEAD without exposing child diagnostics. */ }
  throw fail("revision_not_checked_out", "Cannot resolve checked-out revision")
}
interface Target {
  label: string
  package: string
  name: string
  rule: string
}
const target = (): Target => {
  let rows: Array<Target>
  try {
    rows = JSON.parse(readFileSync(".smithers/target-index.json", "utf8"))
  } catch {
    throw fail("no_target", "No preview target")
  }
  if (!Array.isArray(rows)) throw fail("no_target", "No preview target")
  const matches = rows.filter((row) => row?.rule === "CloudRun.Preview")
  if (matches.length === 0) throw fail("no_target", "No preview target")
  if (matches.length !== 1) throw fail("ambiguous_target", "Multiple preview targets")
  const row = matches[0]!
  if (
    typeof row.label !== "string" || typeof row.package !== "string" || typeof row.name !== "string" ||
    !/^\/\/[\w./-]*:[\w.-]+$/.test(row.label) || row.package.split(/[\\/]/).includes("..") ||
    !/^[\w.-]+$/.test(row.name) || resolve(row.package) !== resolve(row.label.slice(2).split(":")[0]!)
  ) {
    throw fail("no_target", "Invalid preview target")
  }
  return row
}
const identity = () => {
  try {
    target()
    return head()
  } catch {
    return "preview-unresolved"
  }
}
export const Deploy = Action.make("preview/deploy", {
  implementationVersion: "preview/v1",
  payload: { branch: Schema.optional(Schema.String), revision: Schema.optional(Schema.String) },
  success: Success,
  error: PreviewFailed,
  tier: "irreversible",
  idempotencyKey: identity
})
export default Flow.make("preview", {
  description: "Preview a branch's app.",
  capabilities: ["deploy:preview"],
  effects: { reads: ["**"], writes: ["preview/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { branch: Schema.optional(Schema.String), revision: Schema.optional(Schema.String) },
  success: Success,
  error: PreviewFailed,
  body: Node.capture({ implementationVersion: "preview/v1" }, (input) => Deploy.call(input))
})

// Diagnostics are persisted. Keep token-shaped values out even if a tool prints one.
const diagnostic = (text: string) =>
  String(Journal.Redaction.redactDiagnostic(
    text.split(/\r?\n/).find((line) => /error|failed|tool_missing|public_access_off/i.test(line)) ??
      text.split(/\r?\n/).find((line) => line.trim()) ?? "Preview failed"
  ))
const launch = (label: string, results: string) =>
  Effect.suspend(() => {
    let stderr = ""
    let stdout = ""
    return ContainedProcess.runEffect({
      command: "pnpm",
      args: ["exec", "smthrs", "run", label, "--results-file", results],
      cwd: process.cwd(),
      maxOutputBytes: 1024 * 1024,
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      }
    }).pipe(Effect.map((status) => ({ status, stderr: stderr + "\n" + stdout })))
  })
export const validateReceipt = async (file: string, label: string, commit: string) => {
  const raw = JSON.parse(await readFile(file, "utf8"))
  if (raw.access !== "private") throw fail("public_access_off", "Preview access must be private")
  if (
    raw.version !== 1 || raw.label !== label || raw.commit !== commit || raw.revision !== commit.slice(0, 7) ||
    !Number.isFinite(Date.parse(raw.expiresAt)) || Date.parse(raw.expiresAt) <= Date.now()
  ) {
    throw fail("deploy_failed", "Invalid preview receipt", "deploy", true)
  }
  const output = Schema.decodeUnknownSync(Success)(raw)
  if (
    output.open.localUrl !== "http://preview.localhost:4100" ||
    ![raw.service, raw.region, raw.project].every((value) =>
      typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value)
    ) ||
    raw.tag !== `r-${commit.slice(0, 7)}` ||
    output.open.command !==
      `gcloud run services proxy ${raw.service} --tag ${raw.tag} --region ${raw.region} --project ${raw.project} --port 4100` ||
    diagnostic(JSON.stringify(output)) !== JSON.stringify(output)
  ) {
    throw fail("deploy_failed", "Invalid preview opener")
  }
  return output
}
export const layer = Deploy.toLayer((input) =>
  Effect.gen(function*() {
    const row = yield* Effect.try({ try: target, catch: (error) => error })
    const commit = yield* Effect.try({ try: head, catch: (error) => error })
    if (input.revision !== undefined && input.revision !== commit) {
      return yield* Effect.fail(fail("revision_not_checked_out", "Revision is not checked out"))
    }
    if (input.branch !== undefined) {
      let branch: string
      try {
        branch = execFileSync("git", ["branch", "--show-current"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim()
      } catch {
        return yield* Effect.fail(fail("revision_not_checked_out", "Branch is not checked out"))
      }
      if (branch !== input.branch) {
        return yield* Effect.fail(fail("revision_not_checked_out", "Branch is not checked out"))
      }
    }
    const file = join(row.package, "cloud-run-preview", `${row.name}.json`)
    const replay = yield* Effect.promise(() => validateReceipt(file, row.label, commit).catch(() => undefined))
    if (replay !== undefined) return replay
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "smthrs-preview-"))),
      (directory) =>
        Effect.gen(function*() {
          const results = join(directory, "results.json")
          const result = yield* launch(row.label, results).pipe(Effect.mapError((error) =>
            error.code === "output_limit"
              ? fail("build_failed", "Preview output limit exceeded", "build", true)
              : fail("builder_unavailable", "Package manager unavailable", "build", true)
          ))
          if (result.status !== 0) {
            let step: PreviewFailed["step"] = "deploy"
            try {
              const rows = JSON.parse(yield* Effect.promise(() => readFile(results, "utf8").catch(() => "{}")))
                .results as Array<{ label: string; status: string }>
              if (rows.some((r) => r.status === "failed" && r.label !== row.label)) step = "build"
            } catch { /* A launch refusal may precede results-file creation. */ }
            const message = diagnostic(result.stderr)
            if (/tool_missing|docker.*(?:not found|unavailable)|command not found/i.test(result.stderr)) {
              return yield* Effect.fail(fail("builder_unavailable", message, "build", true))
            }
            if (
              /gcloud.*(?:auth|login|active account)|(?:credentials|authentication).*\b(?:missing|invalid|required)|reauthentication/i
                .test(result.stderr)
            ) {
              return yield* Effect.fail(fail("credentials_missing", message))
            }
            if (/public_access_off|public_surface/.test(result.stderr)) {
              return yield* Effect.fail(fail("public_access_off", message))
            }
            return yield* Effect.fail(fail(step === "build" ? "build_failed" : "deploy_failed", message, step, true))
          }
          return yield* Effect.tryPromise({
            try: () => validateReceipt(file, row.label, commit),
            catch: (error) => error
          })
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    )
  }).pipe(Effect.catch((error) =>
    Effect.fail(
      error instanceof PreviewFailed ? error : fail("deploy_failed", "Cannot read preview receipt", "deploy", true)
    )
  )), { implementationVersion: "preview/v1" })
