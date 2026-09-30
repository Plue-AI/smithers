/**
 * What every turn is told before its task: the working directory and the
 * conversation so far, then the project's instruction files, which the agent
 * shows after the host's system text and a judged run may trim.
 *
 * Instruction files follow pi, bounded by the repository: in each directory
 * from the repository root (the nearest ancestor holding `.jj` or `.git`)
 * down to the working directory, the first of `AGENTS.override.md`,
 * `AGENTS.md`, `CLAUDE.md` is read, after the global `~/.smithers/agent/AGENTS.md`.
 * Outside a repository only the working directory is read: a parent such as
 * `/tmp` or `$HOME` never supplies instructions.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const instructionNames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const

/** One earlier piece of the conversation, oldest first. */
export type Entry =
  | { readonly kind: "exchange"; readonly user: string; readonly answer: string }
  | { readonly kind: "shell"; readonly text: string }
  | { readonly kind: "undo"; readonly paths: ReadonlyArray<string> }

/** Instruction files, outermost first. */
export const instructionFiles = (cwd: string, home = homedir()): ReadonlyArray<string> => {
  const found: Array<string> = []
  const global = join(home, ".smithers", "agent", "AGENTS.md")
  if (existsSync(global)) found.push(global)
  const directories: Array<string> = []
  for (let directory = resolve(cwd);; directory = dirname(directory)) {
    directories.unshift(directory)
    if (existsSync(join(directory, ".jj")) || existsSync(join(directory, ".git"))) break
    if (dirname(directory) === directory) {
      directories.splice(0, directories.length - 1)
      break
    }
  }
  for (const directory of directories) {
    const first = instructionNames.map((name) => join(directory, name)).find((path) => existsSync(path))
    if (first !== undefined && !found.includes(first)) found.push(first)
  }
  return found
}

/**
 * Said to every turn inside a jj checkout. A colocated repository still
 * answers git, but git writes there race jj's own snapshots of the tree.
 */
export const jjRule =
  "This repository is managed by jj. Reading with git is fine, but never run git commands that write the index, refs or history (add, commit, stash, reset, rebase, checkout, restore); use jj instead, such as jj restore <path> to restore a file."

/** Said to every turn in a git repository without jj, so no turn probes for jj. */
export const gitRule = "This repository is managed by git, not jj."

/** Said to every turn outside any repository. */
export const noVcsRule = "This directory is not in a git or jj repository."

/** The version control `cwd` sits in: the nearest ancestor holding `.jj` or `.git` decides. */
export const vcs = (cwd: string): "jj" | "git" | undefined => {
  for (let directory = resolve(cwd);; directory = dirname(directory)) {
    if (existsSync(join(directory, ".jj"))) return "jj"
    if (existsSync(join(directory, ".git"))) return "git"
    if (dirname(directory) === directory) return undefined
  }
}

/** The one line every turn is told about the repository's version control. */
export const vcsRule = (cwd: string): string => {
  const found = vcs(cwd)
  return found === "jj" ? jjRule : found === "git" ? gitRule : noVcsRule
}

const text = (entry: Entry): string =>
  entry.kind === "exchange"
    ? `User: ${entry.user}\nYou answered: ${entry.answer}`
    : entry.kind === "undo"
    ? `User reverted earlier edits to: ${entry.paths.join(", ")}. Re-read them before editing.`
    : `User ran a shell command:\n${entry.text}`

/**
 * How many of the oldest entries to drop to free about `tokens` (four
 * characters a token). The newest entry always stays.
 */
export const compactable = (history: ReadonlyArray<Entry>, tokens: number): number => {
  let freed = 0
  let dropped = 0
  while (freed < tokens && dropped < history.length - 1) freed += text(history[dropped++]!).length / 4
  return dropped
}

/**
 * The instruction files a turn is given, with their text. They are the
 * person's own files, so a judged worker withholds the chunks Jev is
 * confident its task does not need; see `Agent.Options.instructions`.
 */
export const instructions = (cwd: string): ReadonlyArray<{ readonly path: string; readonly text: string }> =>
  instructionFiles(cwd).map((path) => ({ path, text: readFileSync(path, "utf8") }))

/** The host's own system text: the working directory, its version control and the conversation. */
export const system = (cwd: string, history: ReadonlyArray<Entry>): Array<string> => {
  const parts = [
    `You are a coding agent working in ${cwd}. Read before you change, keep edits small, and verify with the repository's own commands. Paths are relative to ${cwd}.`
  ]
  parts.push(vcsRule(cwd))
  if (history.length > 0) {
    parts.push(
      "The conversation so far, oldest first:\n\n" + history.map(text).join("\n\n")
    )
  }
  return parts
}
