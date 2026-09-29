/**
 * The extra prompt a wrapped harness receives beside its own system prompt.
 *
 * Three parts, static first so a harness's provider-side prefix cache holds
 * across tasks: the shared Smithers brief (without its `ctx.call` sentence,
 * which a wrapped harness cannot follow), the rules (constant per permission
 * mode), then the memory block (`Memory.Output.context` verbatim). The task
 * itself goes on stdin, never here, and AGENTS.md / CLAUDE.md are never copied
 * in: the harnesses read those themselves.
 */
import { brief } from "@smthrs/agent/SmithersPlugin"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"

/** The harnesses with a verified launch adapter. */
export const Harness = Schema.Literals(["claude-code", "codex"])
export type Harness = typeof Harness.Type

/**
 * The Claude Code `--permission-mode` a launch runs under. `plan` is
 * read-only; `acceptEdits` also accepts file edits. Every launch also passes
 * `--tools` with {@link tools}, so no mode has a tool that runs commands and a
 * wrapped launch never commits.
 */
export const Permission = Schema.Literals(["plan", "acceptEdits"])
export type Permission = typeof Permission.Type

/** The `--tools` allowlist per mode: file tools only, never Bash, Monitor or WebFetch. */
export const tools: Record<Permission, string> = {
  plan: "Read,Glob,Grep",
  acceptEdits: "Read,Edit,Write,Glob,Grep"
}

/** A launch edits files and runs no shell commands unless the caller asks for less. */
export const defaultPermission: Permission = "acceptEdits"

/** Part 1: the shared brief without its line that sends the model to `ctx.call("smithers.guide", …)` and jj. */
export const wrappedBrief = brief.split("\n").filter((line) => !line.includes("ctx.call(")).join("\n")

const allowed: Record<Permission, string> = {
  plan: "This launch is read-only: read files, edit none, run no shell commands, and answer in your reply.",
  acceptEdits:
    "This launch may read and edit files in this working copy and runs no shell commands: leave your edits uncommitted and run neither jj nor npx smthrs."
}

/** Part 2: a few constant lines per permission mode. */
export const rules = (permission: Permission): string =>
  [
    "You run inside a Smithers flow. For package facts, CLI flags and authoring, read the package's README.md and docs/.",
    allowed[permission],
    "The memory block below is context Smithers selected for this task; open a cited file before relying on it."
  ].join("\n")

/** The exact bytes: brief, rules, then the memory block when it is not empty. */
export const extraPrompt = (
  options: { readonly permission: Permission; readonly memory: { readonly context: string } }
) =>
  [wrappedBrief, rules(options.permission), ...(options.memory.context === "" ? [] : [options.memory.context])]
    .join("\n\n") + "\n"

/**
 * The largest extra prompt a launch passes: one argv string on Linux is at
 * most `MAX_ARG_STRLEN` (32 pages, 131072 bytes with its NUL terminator).
 */
export const maxExtraBytes = 128 * 1024 - 1

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** `<cwd>/.flows/wrapped/extra/<digest>.md`: content-addressed, so a later launch never rewrites it. */
export const promptPath = (cwd: string, digest: string): string =>
  join(cwd, ".flows", "wrapped", "extra", `${digest}.md`)
