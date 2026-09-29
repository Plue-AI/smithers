/**
 * Wrapped harnesses: Claude Code and Codex run as workers with their own
 * tools. Headless, the vendor's JSON stream is folded into rows drawn in its
 * own glyphs (`⏺ ⎿` for Claude Code, `• └` for Codex). Taking one over hands
 * the terminal to the vendor's own TUI on the same session (`claude --resume`,
 * `codex resume`); when it exits the worker continues headless on that session.
 *
 * The brief (the shared Smithers prompt plus the task's memory) is passed once
 * per session through `--append-system-prompt` or Codex's
 * `developer_instructions`, byte-identical on every resume, so the vendor's
 * prompt cache keeps its prefix. Argv follows the installed CLIs
 * (claude 2.1, codex-cli 0.158) and the 0.x resume table (39d0d2380bd9).
 */
import { codexConfigString } from "@smthrs/cli/Agents"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import * as Log from "./log.ts"
import { stopGroup } from "./subprocess.ts"

export type Vendor = "claude" | "codex"

export const vendors: ReadonlyArray<Vendor> = ["claude", "codex"]

/** What a headless vendor run needs. */
export interface Launch {
  readonly vendor: Vendor
  readonly prompt: string
  readonly cwd: string
  readonly brief: string
  /** Claude Code's session id is chosen up front; Codex's arrives in its stream. */
  readonly session?: string
  /** Continue the session rather than start it. */
  readonly resume: boolean
  /** The TUI's approval mode: only `all` lets the vendor act without asking, which headless it cannot. */
  readonly approve: "all" | "ask" | "deny"
}

/** Codex's `-c` setting that carries the brief. */
const instructions = (brief: string): string => `developer_instructions=${codexConfigString(brief)}`

/**
 * The headless command. The prompt is never an argument: it goes to the vendor on stdin, so a
 * prompt shaped like a flag stays text.
 */
export const headless = (launch: Launch): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  if (launch.vendor === "claude") {
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--append-system-prompt",
        launch.brief,
        ...(launch.resume ? ["--resume", launch.session!] : ["--session-id", launch.session!]),
        "--permission-mode",
        // Headless it cannot ask, so anything short of `all` only reads.
        launch.approve === "all" ? "bypassPermissions" : "plan"
      ]
    }
  }
  const shared = [
    "--json",
    "--skip-git-repo-check",
    "-c",
    instructions(launch.brief),
    ...(launch.approve === "all" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", "read-only"])
  ]
  // `-` reads the prompt from stdin.
  return {
    command: "codex",
    args: launch.resume
      ? ["exec", "resume", launch.session!, ...shared, "-"]
      : ["exec", "-C", launch.cwd, ...shared, "-"]
  }
}

/**
 * The vendor's own interactive TUI on the session, with the same brief: what taking over runs in
 * the terminal.
 */
export const interactive = (
  vendor: Vendor,
  session: string,
  cwd: string,
  brief: string,
  approve: Launch["approve"]
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  vendor === "claude"
    ? {
      command: "claude",
      args: [
        "--resume",
        session,
        "--append-system-prompt",
        brief,
        ...(approve === "all" ? ["--permission-mode", "bypassPermissions"] : [])
      ]
    }
    : {
      command: "codex",
      args: [
        "resume",
        session,
        "-C",
        cwd,
        "-c",
        instructions(brief),
        ...(approve === "all" ? ["--dangerously-bypass-approvals-and-sandbox"] : [])
      ]
    }

/** What the worker continues with after the person hands it back. */
export const continuePrompt = "Continue the task from where the person left off."

/** One drawn row: the vendor's own glyph, then text. */
export interface Row {
  readonly glyph: string
  readonly text: string
}

/** What one stream line tells the worker. */
export interface Folded {
  readonly rows: ReadonlyArray<Row>
  /** The session the vendor named; resumable only once a call on it settled. */
  readonly announce?: string
  /** A call on the session settled: it can be resumed from here. */
  readonly settled?: boolean
  /** The session, once resumable: `run` sets it. */
  readonly session?: string
  /** One model call's tokens; `call` names it, as the vendor repeats a message's usage on each of its blocks. */
  readonly usage?: { readonly input: number; readonly output: number; readonly cached: number; readonly call?: string }
  /** The run's final answer. */
  readonly answer?: string
  readonly error?: string
}

const first = (text: string, max = 100): string => {
  const line = text.split("\n").find((each) => each.trim() !== "")?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** `Read(src/x.ts)`: a Claude Code tool call as its TUI shows it. */
const call = (name: string, input: Record<string, unknown>): string => {
  const subject = input["file_path"] ?? input["command"] ?? input["pattern"] ?? input["path"] ?? input["url"] ??
    input["description"]
  return `${name}(${typeof subject === "string" ? first(subject, 80) : ""})`
}

const lines = (content: unknown): string => {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : ""
  const count = text.split("\n").filter((each) => each.trim() !== "").length
  return count > 1 ? `${first(text, 60)} (+${count - 1} lines)` : first(text)
}

/** A field the vendor sends as a list, or no items when it sends anything else. */
const list = (value: unknown): ReadonlyArray<any> => (Array.isArray(value) ? value : [])

/** Folds one parsed line of Claude Code's `stream-json`. */
const claude = (event: Record<string, any>): Folded => {
  if (event.type === "system" && event.subtype === "init") return { rows: [], announce: event.session_id }
  if (event.type === "assistant") {
    const usage = event.message?.usage
    return {
      settled: true,
      rows: list(event.message?.content).flatMap((part: Record<string, any>): Array<Row> =>
        part.type === "text" && String(part.text).trim() !== ""
          ? [{ glyph: "⏺", text: first(part.text, 200) }]
          : part.type === "tool_use"
          ? [{ glyph: "⏺", text: call(part.name, part.input ?? {}) }]
          : []
      ),
      ...(usage === undefined ? {} : {
        usage: {
          input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          output: usage.output_tokens ?? 0,
          cached: usage.cache_read_input_tokens ?? 0,
          ...(typeof event.message?.id === "string" ? { call: event.message.id } : {})
        }
      })
    }
  }
  if (event.type === "user") {
    return {
      rows: list(event.message?.content).flatMap((part: Record<string, any>): Array<Row> =>
        part.type === "tool_result" ? [{ glyph: "  ⎿", text: lines(part.content) }] : []
      )
    }
  }
  if (event.type === "result") {
    return event.is_error === true || event.subtype !== "success"
      ? { rows: [], settled: true, error: String(event.result ?? event.subtype ?? "Claude Code failed") }
      : { rows: [], settled: true, answer: String(event.result ?? "") }
  }
  return { rows: [] }
}

/** Folds one parsed line of `codex exec --json`. */
const codex = (event: Record<string, any>): Folded => {
  if (event.type === "thread.started") return { rows: [], announce: event.thread_id }
  if (event.type === "turn.completed") {
    const usage = event.usage ?? {}
    // Codex names its thread before it can resume it: only a completed turn makes it resumable (0.x).
    return {
      rows: [],
      settled: true,
      usage: {
        input: usage.input_tokens ?? 0,
        output: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
        cached: usage.cached_input_tokens ?? 0
      }
    }
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return { rows: [], error: String(event.error?.message ?? event.message ?? "Codex failed") }
  }
  if (event.type !== "item.completed") return { rows: [] }
  const item = event.item ?? {}
  switch (item.type) {
    case "agent_message":
      return { rows: [{ glyph: "•", text: first(String(item.text ?? ""), 200) }], answer: String(item.text ?? "") }
    case "command_execution":
      return {
        rows: [
          { glyph: "•", text: `Ran ${first(String(item.command ?? ""), 80)}` },
          { glyph: "  └", text: lines(item.aggregated_output) || `exit ${item.exit_code}` }
        ]
      }
    case "file_change":
      return {
        rows: [{
          glyph: "•",
          text: `Edited ${list(item.changes).map((change: { path?: string }) => change.path).join(", ")}`
        }]
      }
    default:
      return { rows: [] }
  }
}

/** Folds one line of a vendor's stream; a line that is not JSON draws nothing. */
export const fold = (vendor: Vendor, line: string): Folded => {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return { rows: [] }
  }
  if (typeof event !== "object" || event === null) return { rows: [] }
  return vendor === "claude" ? claude(event as Record<string, any>) : codex(event as Record<string, any>)
}

export type Outcome =
  | { readonly _tag: "done"; readonly answer: string }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "stopped" }

export interface Handle {
  readonly done: Promise<Outcome>
  /** Ends the headless process: a take-over or a stop. */
  readonly stop: () => void
}

/** Runs a vendor headless, handing each folded line to `onFolded`. */
export const run = (launch: Launch, onFolded: (folded: Folded) => void): Handle => {
  const { command, args } = headless(launch)
  // Its own group, so a stop reaches every process it started.
  const child = spawn(command, [...args], {
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    detached: true
  })
  child.stdin.on("error", () => {})
  child.stdin.end(launch.prompt)
  let stopped = false
  let answer: string | undefined
  let error: string | undefined
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  const reading = new Promise<void>((resolve) => {
    let announced: string | undefined
    createInterface({ input: child.stdout }).on("line", (line) => {
      let folded: Folded
      try {
        folded = fold(launch.vendor, line)
      } catch {
        return
      }
      if (folded.answer !== undefined) answer = folded.answer
      if (folded.error !== undefined) error = folded.error
      announced = folded.announce ?? announced
      onFolded(folded.settled === true && announced !== undefined ? { ...folded, session: announced } : folded)
    }).on("close", resolve)
  })
  const done = new Promise<Outcome>((resolve) => {
    child.once("error", (cause: NodeJS.ErrnoException) => {
      Log.write("wrapped.spawn", cause)
      resolve({
        _tag: "failed",
        message: cause.code === "ENOENT" ? `${command} is not installed` : `${command} could not start`
      })
    })
    child.once("close", (code) => {
      void reading.then(() => {
        if (stopped) return resolve({ _tag: "stopped" })
        if (code === 0 && error === undefined) return resolve({ _tag: "done", answer: answer ?? "" })
        resolve({ _tag: "failed", message: error ?? (first(stderr, 300) || `${command} exited ${code}`) })
      })
    })
  })
  return {
    done,
    stop: () => {
      stopped = true
      if (child.pid !== undefined) void stopGroup(child.pid).catch(() => {})
    }
  }
}
