/** The repository's private preview target owns builds, deployment and login. */
import { Action, Fault, Flow } from "@smthrs/flow"
import { Journal } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { TaggedError } from "effect/Schema"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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
const launch = (label: string, results: string, signal: AbortSignal) =>
  new Promise<{ status: number; stderr: string }>((done, reject) => {
    const child = spawn("pnpm", ["exec", "smthrs", "run", label, "--results-file", results], {
      stdio: ["ignore", "pipe", "pipe"],
      signal
    })
    let stderr = ""
    let stdout = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (status) => done({ status: status ?? 1, stderr: stderr + "\n" + stdout }))
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
    !/^http:\/\/(?:preview\.localhost|localhost|127\.0\.0\.1):\d+\/?$/.test(output.open.localUrl) ||
    !/^gcloud run services proxy [\w .:/=-]+$/.test(output.open.command) ||
    diagnostic(JSON.stringify(output)) !== JSON.stringify(output)
  ) {
    throw fail("deploy_failed", "Invalid preview opener")
  }
  return output
}
export const layer = Deploy.toLayer((input) =>
  Effect.tryPromise({
    try: async (signal) => {
      const row = target()
      const commit = head()
      if (input.revision !== undefined && input.revision !== commit) {
        throw fail("revision_not_checked_out", "Revision is not checked out")
      }
      if (input.branch !== undefined) {
        let branch: string
        try {
          branch = execFileSync("git", ["branch", "--show-current"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          }).trim()
        } catch {
          throw fail("revision_not_checked_out", "Branch is not checked out")
        }
        if (branch !== input.branch) {
          throw fail("revision_not_checked_out", "Branch is not checked out")
        }
      }
      const file = join(row.package, "cloud-run-preview", `${row.name}.json`)
      try {
        return await validateReceipt(file, row.label, commit)
      } catch { /* Only a current private receipt can replay. */ }
      const directory = await mkdtemp(join(tmpdir(), "smthrs-preview-"))
      try {
        const results = join(directory, "results.json")
        const result = await launch(row.label, results, signal).catch(() => {
          throw fail("builder_unavailable", "Package manager unavailable", "build", true)
        })
        if (result.status !== 0) {
          let step: PreviewFailed["step"] = "deploy"
          try {
            const rows = JSON.parse(await readFile(results, "utf8")).results as Array<{ label: string; status: string }>
            if (rows.some((r) => r.status === "failed" && r.label !== row.label)) step = "build"
          } catch { /* A launch refusal may precede results-file creation. */ }
          const message = diagnostic(result.stderr)
          if (/tool_missing|docker.*(?:not found|unavailable)|command not found/i.test(result.stderr)) {
            throw fail("builder_unavailable", message, "build", true)
          }
          if (
            /gcloud.*(?:auth|login|active account)|(?:credentials|authentication).*\b(?:missing|invalid|required)|reauthentication/i
              .test(result.stderr)
          ) {
            throw fail("credentials_missing", message)
          }
          if (/public_access_off|public_surface/.test(result.stderr)) throw fail("public_access_off", message)
          throw fail(step === "build" ? "build_failed" : "deploy_failed", message, step, true)
        }
        return await validateReceipt(file, row.label, commit)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    catch: (error) =>
      error instanceof PreviewFailed ? error : fail("deploy_failed", "Cannot read preview receipt", "deploy", true)
  }), { implementationVersion: "preview/v1" })
