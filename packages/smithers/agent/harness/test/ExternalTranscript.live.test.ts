/**
 * The installed Codex and Claude Code CLIs as the session source (T-AGT-01, C-AGT-01).
 *
 * Each case runs the real CLI headless in an empty temporary home, lets the CLI write its own transcript, and
 * decodes that file through the package's public entry point the way a tailing host does. Nothing of the
 * person's own agent home is read or written, and no login is copied: a run with no login of its own records
 * the prompt and the failure the CLI reported, which is the path the two `*-signed-out-*` fixtures were captured
 * from. A person who exports their own API key gets a full turn instead.
 *
 * The cases reach the network and take up to a minute, so they run only when `SMITHERS_REAL_AGENT_CLI=1`:
 *
 *   SMITHERS_REAL_AGENT_CLI=1 pnpm exec vitest run test/ExternalTranscript.live.test.ts
 */
import { Result } from "effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { ExternalTranscript } from "../src/index.ts"

const enabled = process.env["SMITHERS_REAL_AGENT_CLI"] === "1"
const prompt = "Create sample.txt containing the word alpha, then print it."
const scratch = mkdtempSync(join(tmpdir(), "external-transcript-live-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** The person's own key, when they exported one. A subscription login in their agent home is never copied. */
const ownKeys = (names: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name]
    return value === undefined || value === "" ? [] : [[name, value]]
  }))

/** Every regular file under `directory` that `match` accepts. */
const files = (directory: string, match: (name: string) => boolean): Array<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? files(path, match) : match(name) ? [path] : []
  })

/** Run the CLI with only a home, a path and its own temporary agent home; return the one transcript it wrote. */
const capture = (
  name: string,
  argv: ReadonlyArray<string>,
  agentHome: { readonly variable: string; readonly transcripts: string },
  keys: ReadonlyArray<string>,
  match: (name: string) => boolean
): string => {
  const home = join(scratch, `${name}-home`), work = join(scratch, `${name}-work`)
  mkdirSync(home)
  mkdirSync(work)
  const run = spawnSync(argv[0]!, argv.slice(1), {
    cwd: work,
    env: { HOME: homedir(), PATH: process.env["PATH"] ?? "", [agentHome.variable]: home, ...ownKeys(keys) },
    encoding: "utf8",
    timeout: 110_000
  })
  expect(run.error, `${argv[0]} did not start`).toBeUndefined()
  const written = files(join(home, agentHome.transcripts), match)
  expect(written, `${argv[0]} wrote ${written.length} transcripts`).toHaveLength(1)
  return readFileSync(written[0]!, "utf8")
}

/** Decode the way a tail does: a few bytes at a time, each call from the state the last one returned. */
const tail = <State>(
  start: State,
  decode: (
    state: State,
    chunk: string
  ) => Result.Result<ExternalTranscript.Decoded<State>, ExternalTranscript.ExternalTranscriptError>,
  text: string
) => {
  let state = start
  const entries: Array<ExternalTranscript.Entry> = []
  for (let offset = 0; offset < text.length; offset += 4096) {
    const decoded = Result.getOrThrow(
      decode(JSON.parse(JSON.stringify(state)) as State, text.slice(offset, offset + 4096))
    )
    state = decoded.state
    entries.push(...decoded.entries)
  }
  return { state, entries }
}

/** What every live session must show, whoever is or is not logged in. */
const expectSession = (
  entries: ReadonlyArray<ExternalTranscript.Entry>,
  agent: ExternalTranscript.AgentKind,
  profile: RegExp
) => {
  expect(entries.length).toBeGreaterThanOrEqual(2)
  expect(entries[0]).toMatchObject({ role: "user", part: { type: "prompt", text: prompt } })
  // The agent answered, worked, or said why it could not: something of its own follows the prompt.
  expect(entries.slice(1).filter((entry) => entry.role === "assistant").length).toBeGreaterThanOrEqual(1)
  expect(entries.filter((entry) => entry.part.type === "prompt")).toHaveLength(1)
  entries.forEach((entry, seq) => {
    expect(entry).toMatchObject({ origin: "external", read_only: true, agent_kind: agent, seq })
    expect(entry.format_version).toMatch(profile)
    expect(entry.source_id.startsWith(`${entry.session_id}:`)).toBe(true)
  })
}

describe.skipIf(!enabled)("ExternalTranscript with the installed CLIs", () => {
  it("decodes the transcript Claude Code writes for a headless run in a temporary home", () => {
    const text = capture(
      "claude",
      ["claude", "-p", prompt],
      { variable: "CLAUDE_CONFIG_DIR", transcripts: "projects" },
      ["ANTHROPIC_API_KEY"],
      (name) => name.endsWith(".jsonl")
    )
    const whole = Result.getOrThrow(ExternalTranscript.decodeClaude(ExternalTranscript.claudeStart, text))
    expectSession(whole.entries, "claude-code", /^claude-code\/\d+\.\d+$/)
    expect(tail(ExternalTranscript.claudeStart, ExternalTranscript.decodeClaude, text)).toEqual(whole)
  }, 120_000)

  it("decodes the rollout Codex writes for a headless run in a temporary home", () => {
    const text = capture(
      "codex",
      ["codex", "exec", "--skip-git-repo-check", prompt],
      { variable: "CODEX_HOME", transcripts: "sessions" },
      ["OPENAI_API_KEY", "CODEX_API_KEY"],
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl")
    )
    const whole = Result.getOrThrow(ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, text))
    expectSession(whole.entries, "codex", /^codex-rollout\/\d+\.\d+$/)
    expect(tail(ExternalTranscript.codexStart, ExternalTranscript.decodeCodex, text)).toEqual(whole)
  }, 120_000)
})
