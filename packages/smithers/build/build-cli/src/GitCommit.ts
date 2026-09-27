/**
 * Executes one `Git.Commit` target: stage, gate, message, commit.
 *
 * The sequence is fixed. A change the invocation does not own refuses it
 * before anything is staged; the owned paths are then staged and the staged
 * index is written as one git tree, the candidate. The gates run through the
 * injected {@link GateRunner} against that tree, materialized over a scratch
 * copy, never against the live working tree: an unstaged or untracked file
 * outside the scope is not in the commit, so it can neither pass nor fail a
 * gate. A red gate refuses the commit with a typed error and creates nothing. The
 * message is the `-m` override when the invoker passed one, the declared fixed
 * text otherwise, or the injected {@link AgentMessage} composition when the
 * declaration names an agent. Only then is the commit created, and it must
 * record exactly the judged tree: an index that changed after the gates ran,
 * or a hook that restaged a path, refuses with `candidate_changed` and leaves
 * HEAD where it was.
 *
 * Both collaborators are interfaces because their real implementations are
 * integration concerns: the real GateRunner is the executor running gate
 * targets against a scratch copy holding the candidate tree, and the real AgentMessage is the
 * workspace agent stack. This module owns the ordering, the git plumbing,
 * and the typed refusals; tests drive it with fakes in a throwaway
 * repository.
 *
 * @since 0.1.0
 */

import * as Exec from "@smthrs/targets/Exec"
import * as GitTarget from "@smthrs/targets/GitTarget"
import type * as Target from "@smthrs/targets/Target"
import * as PlatformError from "effect/PlatformError"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import * as Diagnostic from "./Diagnostic.ts"
import * as ContainedProcess from "./internal/ContainedProcess.ts"

/**
 * The refusal codes one commit invocation can fail with.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode =
  | "not_a_git_repository"
  | "invalid_paths"
  | "unrelated_changes"
  | "nothing_to_commit"
  | "gates_failed"
  | "candidate_changed"
  | "agent_message_unavailable"
  | "empty_message"
  | "git_failed"
  | "spawn_failed"

/**
 * One typed commit refusal.
 *
 * @category errors
 * @since 0.1.0
 */
export class GitCommitError extends Error {
  override readonly name = "GitCommitError"
  readonly code: ErrorCode
  /** The per-gate failures behind a `gates_failed` refusal. */
  readonly failures: ReadonlyArray<GateFailure>

  constructor(code: ErrorCode, message: string, failures: ReadonlyArray<GateFailure> = []) {
    super(`${code}: ${message}`)
    this.code = code
    this.failures = failures
  }
}

/**
 * Checks whether a value is a commit refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isGitCommitError = (value: unknown): value is GitCommitError => value instanceof GitCommitError

/**
 * One red gate: the gate target's rule id and its failure text.
 *
 * @category models
 * @since 0.1.0
 */
export interface GateFailure {
  readonly target: string
  readonly message: string
}

/**
 * The tree a commit will record, handed to the gates that approve it.
 *
 * @category models
 * @since 0.1.0
 */
export interface CandidateTree {
  /** The git tree object id the commit records. */
  readonly tree: string
  /**
   * Makes `directory`, a copy of the working tree without `.git`, hold
   * exactly the candidate's tracked content: every path whose working-tree
   * content differs from the tree is rewritten from the tree or removed, and
   * every untracked, non-ignored path is removed. Ignored files, such as
   * installed dependencies and build outputs, stay as copied. Returns the
   * repository-relative paths it rewrote or removed.
   */
  readonly materialize: (directory: string) => Promise<ReadonlyArray<string>>
}

/**
 * Runs the declared gate targets against the candidate tree.
 *
 * The integration binding is the executor: it materializes the candidate
 * over a scratch copy and judges each gate there, so a gate sees the commit's
 * tree and nothing else. A fake satisfies the interface in tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface GateRunner {
  run(gates: ReadonlyArray<Target.AnyTarget>, candidate: CandidateTree): Promise<ReadonlyArray<GateFailure>>
}

/**
 * Composes a commit message for an agent-written `message` declaration.
 *
 * The integration binding resolves the named workspace agent and prompts it
 * with the staged diff. A fake satisfies the interface in tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentMessage {
  compose(context: {
    readonly root: string
    readonly agent: string
    readonly stagedDiff: string
  }): Promise<string>
}

/**
 * The created commit.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommitResult {
  readonly sha: string
  readonly message: string
  /**
   * The paths recorded in the created commit.
   *
   * An acknowledged sweep stages whatever the working tree carries, so callers
   * use this list to report what entered the commit instead of assuming.
   */
  readonly staged: ReadonlyArray<string>
}

/** Maximum staged-diff code units handed to an agent composition. */
const stagedDiffLimit = 200 * 1024

/** Maximum unrelated paths named in an `unrelated_changes` refusal. */
const namedOffenderLimit = 20

/** One `git status --porcelain` entry: its index column, its worktree column, and its path. */
interface StatusEntry {
  readonly index: string
  readonly worktree: string
  readonly path: string
}

interface GitOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs git with bounded output and the shared process-tree owner. */
const git = async (
  options: CommitOptions,
  args: ReadonlyArray<string>,
  extraEnvironment: Readonly<Record<string, string>> = {}
): Promise<GitOutput> => {
  let stdout = ""
  let stderr = ""
  try {
    const exitCode = await ContainedProcess.run({
      command: "git",
      args,
      cwd: options.root,
      maxOutputBytes: 8 * 1024 * 1024,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 60_000,
      environment: {
        ...Exec.toolEnvironment(
          Object.fromEntries(
            Object.entries(options.environment ?? process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          ),
          options.sensitiveNames ?? []
        ),
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        ...extraEnvironment
      },
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      }
    })
    return { exitCode, stdout, stderr }
  } catch (cause) {
    if (!(cause instanceof ContainedProcess.ProcessError)) throw cause
    const detail = cause.code === "cancelled" ?
      "ABORT_ERR"
      : cause.code === "output_limit" ?
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      : cause.code === "process_failed" ?
      cause.cause instanceof PlatformError.PlatformError && cause.cause.reason._tag === "NotFound"
        ? "ENOENT"
        : Diagnostic.describe(cause.cause, cause.message)
      : cause.message
    throw new GitCommitError(
      "spawn_failed",
      `git ${args.join(" ")} could not run: ${detail}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`
    )
  }
}

/** Runs one git command that must succeed. */
const gitOk = async (
  options: CommitOptions,
  args: ReadonlyArray<string>,
  extraEnvironment: Readonly<Record<string, string>> = {}
): Promise<GitOutput> => {
  const output = await git(options, args, extraEnvironment)
  if (output.exitCode !== 0) {
    throw new GitCommitError("git_failed", `git ${args.join(" ")} exited ${output.exitCode}: ${output.stderr.trim()}`)
  }
  return output
}

/** Splits NUL-terminated git output into its fields. */
const nulFields = (text: string): ReadonlyArray<string> => text.split("\0").filter((field) => field !== "")

/** Paths per `git checkout-index` invocation, well under any host's argv limit. */
const checkoutBatch = 500

/**
 * Makes a working-tree copy hold exactly the tracked content of `tree`.
 *
 * `git diff --name-status <tree>` names every path whose working-tree content
 * differs from the tree; `A` entries exist only in the working tree, the rest
 * are written back from the tree through a private index so modes, symlinks
 * and binary content survive. Untracked, non-ignored paths are not in the
 * tree (the index was just written as it) and are removed.
 */
const materializeTree = async (
  options: CommitOptions,
  tree: string,
  directory: string
): Promise<ReadonlyArray<string>> => {
  const fields = nulFields(
    (await gitOk(options, ["diff", "--no-renames", "--no-ext-diff", "--name-status", "-z", tree, "--"])).stdout
  )
  const fromTree: Array<string> = []
  const removed: Array<string> = []
  for (let cursor = 0; cursor + 1 < fields.length; cursor += 2) {
    const path = fields[cursor + 1]!
    if (fields[cursor] === "A") removed.push(path)
    else fromTree.push(path)
  }
  removed.push(...nulFields((await gitOk(options, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout))
  const resolved = NodePath.resolve(directory)
  const inside = (path: string): string => {
    const absolute = NodePath.resolve(resolved, ...path.split("/"))
    if (!absolute.startsWith(resolved + NodePath.sep)) {
      throw new GitCommitError("git_failed", `git named a path outside the tree: ${JSON.stringify(path)}`)
    }
    return absolute
  }
  for (const path of [...removed, ...fromTree]) {
    await Fs.rm(inside(path), { recursive: true, force: true })
  }
  if (fromTree.length > 0) {
    const scratchIndex = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-commit-index-"))
    try {
      const environment = { GIT_INDEX_FILE: NodePath.join(scratchIndex, "index") }
      await gitOk(options, ["read-tree", tree], environment)
      for (let start = 0; start < fromTree.length; start += checkoutBatch) {
        await gitOk(
          options,
          [
            "checkout-index",
            "-f",
            `--prefix=${resolved}${NodePath.sep}`,
            "--",
            ...fromTree.slice(start, start + checkoutBatch)
          ],
          environment
        )
      }
    } finally {
      await Fs.rm(scratchIndex, { recursive: true, force: true })
    }
  }
  return [...new Set([...removed, ...fromTree])].sort()
}

/**
 * Reads the working tree's change set, optionally narrowed by pathspecs.
 *
 * `-z` is the only parseable form: a path with a space, a quote, or a newline
 * is rendered verbatim between NUL separators instead of C-quoted. A rename or
 * copy entry carries its origin path as one extra NUL-separated field, which
 * is read and discarded so the following entry is not misparsed as a path.
 */
const status = async (
  options: CommitOptions,
  pathspecs: ReadonlyArray<string>
): Promise<ReadonlyArray<StatusEntry>> => {
  const raw = (await gitOk(options, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    ...(pathspecs.length === 0 ? [] : ["--", ...pathspecs])
  ])).stdout
  const fields = raw.split("\0")
  const entries: Array<StatusEntry> = []
  for (let cursor = 0; cursor < fields.length; cursor += 1) {
    const field = fields[cursor]!
    if (field.length < 4) continue
    const index = field[0]!
    const worktree = field[1]!
    entries.push({ index, worktree, path: field.slice(3) })
    if (index === "R" || index === "C") cursor += 1
  }
  return entries
}

/**
 * Refuses to commit changes the invocation did not declare.
 *
 * `git add -A` used to run unconditionally, and the comment beside it called
 * the sweep deliberate. That swept every unrelated modification, addition, and
 * deletion sitting in the working tree — a concurrent agent's edits included —
 * into the commit this target creates, and no attr on `Git.Commit` could
 * express a scope, so the target author had no way to stop it. A notice is not
 * a guard: an invocation that cannot name what it owns refuses here instead.
 *
 * A scoped invocation is narrower. `git add -A -- <paths>` scopes only the new
 * staging operation; the commit that follows publishes the whole index, so a
 * path staged before the invocation rides along. Pre-staged paths outside the
 * scope are therefore refused too, while an unstaged unrelated edit is left
 * alone — leaving it in the working tree is exactly what the scope is for.
 */
const refuseUnrelated = async (
  options: CommitOptions,
  paths: ReadonlyArray<string> | undefined,
  sweepWorkingTree: boolean
): Promise<void> => {
  if (sweepWorkingTree) return
  const dirty = await status(options, [])
  if (dirty.length === 0) return
  if (paths === undefined) {
    const named = dirty.map((entry) => entry.path).sort()
    throw new GitCommitError(
      "unrelated_changes",
      `the working tree carries ${named.length} change(s) this commit does not own and no path scope was ` +
        `declared: ${named.slice(0, namedOffenderLimit).join(", ")}` +
        `${named.length > namedOffenderLimit ? `, and ${named.length - namedOffenderLimit} more` : ""}`
    )
  }
  const owned = new Set((await status(options, paths)).map((entry) => entry.path))
  // An untracked path reports `??`; anything else in the index column is staged.
  const staged = dirty
    .filter((entry) => entry.index !== " " && entry.index !== "?" && !owned.has(entry.path))
    .map((entry) => entry.path)
    .sort()
  if (staged.length === 0) return
  throw new GitCommitError(
    "unrelated_changes",
    `the index carries ${staged.length} staged path(s) outside this commit's scope: ` +
      `${staged.slice(0, namedOffenderLimit).join(", ")}` +
      `${staged.length > namedOffenderLimit ? `, and ${staged.length - namedOffenderLimit} more` : ""}`
  )
}

/**
 * Options accepted by {@link commit}.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommitOptions {
  /** The repository root the commit is created in. */
  readonly root: string
  /** Cancels every git subprocess when the run stops. */
  readonly signal?: AbortSignal | undefined
  /** Per-command deadline in milliseconds. @default 60000 */
  readonly timeoutMs?: number | undefined
  /** Host environment supplied by the runner. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** Workspace cache credential names withheld from git and hooks. */
  readonly sensitiveNames?: ReadonlyArray<string> | undefined
  /**
   * The pathspecs this commit owns, or undefined when it owns nothing.
   *
   * A scoped stage leaves a concurrent unrelated edit elsewhere unstaged and
   * uncommitted. A target-driven invocation receives the write set resolved
   * from the target's declared `changes` attr; a rule that declares none
   * arrives here undefined and is refused by {@link refuseUnrelated} rather
   * than sweeping the tree.
   */
  readonly paths?: ReadonlyArray<string> | undefined
  /**
   * Acknowledges that this invocation intends to commit the whole working
   * tree, unrelated concurrent changes included.
   *
   * The acknowledgement exists so the sweep is a caller's stated intent rather
   * than the default a target inherits by declaring nothing. No target-driven
   * invocation passes it.
   */
  readonly sweepWorkingTree?: boolean | undefined
  /** The `Git.Commit` target whose validated attrs drive the invocation. */
  readonly target: Target.AnyTarget
  /** Runs the declared gates against the candidate tree. */
  readonly gateRunner: GateRunner
  /** Composes an agent-written message; optional when the message is fixed text. */
  readonly agentMessage?: AgentMessage | undefined
  /** The `-m` override; when present it wins over the declared message. */
  readonly messageOverride?: string | undefined
}

/**
 * Executes one `Git.Commit` invocation: stage, gate, message, commit.
 *
 * @category execution
 * @since 0.1.0
 */
export const commit = async (options: CommitOptions): Promise<CommitResult> => {
  if (!Number.isFinite(options.timeoutMs ?? 60_000) || (options.timeoutMs ?? 60_000) <= 0) {
    throw new RangeError("Git.Commit timeoutMs must be positive and finite")
  }
  const paths = options.paths
  if (paths !== undefined) {
    if (paths.length === 0) {
      throw new GitCommitError("invalid_paths", "paths is an empty scope; omit it only to stage the whole tree")
    }
    for (const [index, path] of paths.entries()) {
      if (path.trim() === "") {
        throw new GitCommitError("invalid_paths", `pathspec at index ${index} is blank: ${JSON.stringify(path)}`)
      }
    }
  }
  const attrs = GitTarget.commitAttrsOf(options.target)
  const inside = await git(options, ["rev-parse", "--is-inside-work-tree"])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    throw new GitCommitError("not_a_git_repository", `${options.root} is not inside a git work tree`)
  }
  await refuseUnrelated(options, paths, options.sweepWorkingTree === true)
  // Every refusal after staging restores the index this invocation found, so a
  // failed attempt never leaves its own staging behind to poison the next one.
  const saved = await git(options, ["write-tree"])
  const parent = await git(options, ["rev-parse", "--verify", "-q", "HEAD"])
  const stage = async (): Promise<{ readonly message: string; readonly staged: ReadonlyArray<string> }> => {
    // `-A` includes deletions owned by the scope; `--` protects a pathspec that starts with a dash.
    await gitOk(options, paths === undefined ? ["add", "-A"] : ["add", "-A", "--", ...paths])
    const candidate = await git(options, ["diff", "--cached", "--quiet"])
    if (candidate.exitCode === 0) {
      throw new GitCommitError("nothing_to_commit", "the staged tree is identical to HEAD")
    }
    // The gates judge this tree object, and the commit must record exactly it.
    const tree = (await gitOk(options, ["write-tree"])).stdout.trim()
    const failures = await options.gateRunner.run(attrs.gates, {
      tree,
      materialize: (directory) => materializeTree(options, tree, directory)
    })
    if (failures.length > 0) {
      throw new GitCommitError(
        "gates_failed",
        failures.map((failure) => `${failure.target}: ${failure.message}`).join("; "),
        failures
      )
    }
    let message: string
    if (options.messageOverride !== undefined) {
      message = options.messageOverride
    } else if (typeof attrs.message === "string") {
      message = attrs.message
    } else {
      const agentName = attrs.message._tag === "AgentRef"
        ? attrs.message.name
        : attrs.message._tag === "AgentPool"
        ? attrs.message.agents.join(",")
        : `inline:${attrs.message.model}`
      if (options.agentMessage === undefined) {
        throw new GitCommitError(
          "agent_message_unavailable",
          `the declared message agent ${agentName} has no bound AgentMessage implementation`
        )
      }
      const diff = await gitOk(options, ["diff", "--cached"])
      message = await options.agentMessage.compose({
        root: options.root,
        agent: agentName,
        stagedDiff: diff.stdout.slice(0, stagedDiffLimit)
      })
    }
    if (message.trim() === "") {
      throw new GitCommitError("empty_message", "the commit message is empty")
    }
    if ((await gitOk(options, ["write-tree"])).stdout.trim() !== tree) {
      throw new GitCommitError("candidate_changed", "the index changed after the gates judged the candidate tree")
    }
    const staged = (await gitOk(options, ["diff", "--cached", "--name-only", "-z"]))
      .stdout.split("\0").slice(0, -1)
    // The repository's signing policy applies; a signing failure is a typed git_failed refusal.
    await gitOk(options, ["commit", "-m", message])
    const recorded = (await gitOk(options, ["rev-parse", "HEAD^{tree}"])).stdout.trim()
    if (recorded !== tree) {
      // A hook restaged a path the gates never judged: undo the commit, keep HEAD where it was.
      const created = (await gitOk(options, ["rev-parse", "HEAD"])).stdout.trim()
      await gitOk(
        options,
        parent.exitCode === 0
          ? ["update-ref", "HEAD", parent.stdout.trim(), created]
          : ["update-ref", "-d", "HEAD", created]
      )
      throw new GitCommitError(
        "candidate_changed",
        `the commit recorded tree ${recorded}, not the judged tree ${tree}; a hook changed the index, so HEAD was reset`
      )
    }
    return { message, staged }
  }
  let settled: { readonly message: string; readonly staged: ReadonlyArray<string> }
  try {
    settled = await stage()
  } catch (cause) {
    if (saved.exitCode === 0) await git(options, ["read-tree", saved.stdout.trim()]).catch(() => undefined)
    throw cause
  }
  const { message, staged } = settled
  const sha = await gitOk(options, ["rev-parse", "HEAD"])
  return { sha: sha.stdout.trim(), message, staged }
}
