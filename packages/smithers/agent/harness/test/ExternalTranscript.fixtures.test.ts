/**
 * Every recorded transcript, decoded through the package's public entry point (T-AGT-01, C-AGT-01).
 *
 * `fixtures/external/manifest.json` lists the captures; each directory's `MANIFEST.md` says how the CLI wrote it
 * and what was redacted. `expected.json` is committed and never produced here: this file only compares. The two
 * larger captures have their own files (`ExternalTranscript.test.ts`, `ExternalTranscript.claude.test.ts`); the
 * assertions below hold for all five, and the literal ones cover the member-machine and signed-out captures.
 */
import { Result, Schema } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ExternalTranscript } from "../src/index.ts"

interface Listed {
  readonly directory: string
  readonly file: string
  readonly agent: ExternalTranscript.AgentKind
  readonly cli_release: string
  readonly format_version: string
  readonly records: number
  readonly entries: number
}
type State = ExternalTranscript.CodexState | ExternalTranscript.ClaudeState
interface Golden {
  readonly state: State
  readonly entries: ReadonlyArray<ExternalTranscript.Entry>
}

const root = new URL("./fixtures/external/", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as {
  readonly version: number
  readonly fixtures: ReadonlyArray<Listed>
}

const load = (listed: Listed) => {
  const directory = new URL(`${listed.directory}/`, root)
  const text = readFileSync(new URL(listed.file, directory), "utf8")
  return {
    text,
    /** The capture's records, each with its newline. */
    records: text.split(/(?<=\n)/),
    golden: JSON.parse(readFileSync(new URL("expected.json", directory), "utf8")) as Golden
  }
}

const decode = (
  agent: ExternalTranscript.AgentKind,
  state: State | undefined,
  chunk: string
): Result.Result<ExternalTranscript.Decoded<State>, ExternalTranscript.ExternalTranscriptError> =>
  agent === "codex"
    ? ExternalTranscript.decodeCodex((state ?? ExternalTranscript.codexStart) as ExternalTranscript.CodexState, chunk)
    : ExternalTranscript.decodeClaude(
      (state ?? ExternalTranscript.claudeStart) as ExternalTranscript.ClaudeState,
      chunk
    )

/** Decode chunks in order, handing each call the previous state as a host that persisted it as JSON would. */
const replay = (agent: ExternalTranscript.AgentKind, chunks: Iterable<string>) => {
  let state: State | undefined
  const entries: Array<ExternalTranscript.Entry> = []
  for (const chunk of chunks) {
    const decoded = Result.getOrThrow(
      decode(agent, state === undefined ? undefined : JSON.parse(JSON.stringify(state)) as State, chunk)
    )
    state = decoded.state
    entries.push(...decoded.entries)
  }
  return { state, entries }
}

const entryAt = (golden: Golden, line: string) =>
  golden.entries.find((entry) => entry.source_id.split(":")[1] === line)!

describe("ExternalTranscript recorded captures", () => {
  it("lists every committed capture and nothing fabricated", () => {
    expect(manifest.version).toBe(2)
    const listed = manifest.fixtures.map((fixture) => fixture.directory).sort()
    expect(listed).toEqual([
      "claude-code-2.1",
      "claude-code-signed-out-2.1",
      "codex-0.160",
      "codex-machine-0.160",
      "codex-signed-out-0.160"
    ])
    // The directory holds exactly the listed captures: a transcript nobody recorded has nowhere to sit.
    expect(readdirSync(root).filter((name) => name !== "manifest.json").sort()).toEqual(listed)
    for (const fixture of manifest.fixtures) {
      const directory = new URL(`${fixture.directory}/`, root)
      for (const name of [fixture.file, "expected.json", "MANIFEST.md"]) {
        expect(existsSync(new URL(name, directory)), `${fixture.directory}/${name}`).toBe(true)
      }
      const release = /^(\d+\.\d+)\.\d+$/.exec(fixture.cli_release)?.[1]
      expect(fixture.format_version).toBe(`${fixture.agent === "codex" ? "codex-rollout" : "claude-code"}/${release}`)
      expect(fixture.agent === "codex" ? ExternalTranscript.codexReleases : ExternalTranscript.claudeReleases)
        .toContain(release)
      expect(readFileSync(new URL("MANIFEST.md", directory), "utf8")).toContain(fixture.cli_release)
    }
  })

  describe.each(manifest.fixtures)("$directory ($agent $cli_release)", (listed) => {
    const { golden, records, text } = load(listed)

    it("names the release its records carry", () => {
      const releases = new Set(records.flatMap((record) => {
        const row = JSON.parse(record) as { type?: string; version?: string; payload?: { cli_version?: string } }
        return listed.agent === "codex"
          ? (row.type === "session_meta" ? [row.payload?.cli_version] : [])
          : (typeof row.version === "string" ? [row.version] : [])
      }))
      expect([...releases]).toEqual([listed.cli_release])
      expect(records).toHaveLength(listed.records)
    })

    it("decodes whole into the committed entries and final state", () => {
      const decoded = replay(listed.agent, [text])
      expect(decoded.entries).toEqual(golden.entries)
      expect(decoded.state).toEqual(golden.state)
      expect(golden.entries).toHaveLength(listed.entries)
      expect(golden.state).toMatchObject({ pending: "", line: listed.records, seq: listed.entries })
    })

    it("stamps every entry external, read-only, in source order, with the profile and its own session", () => {
      const session = golden.entries[0]!.session_id
      golden.entries.forEach((entry, seq) => {
        expect(Schema.decodeUnknownSync(ExternalTranscript.Entry)(entry)).toEqual(entry)
        expect(entry).toMatchObject({
          origin: "external",
          read_only: true,
          agent_kind: listed.agent,
          format_version: listed.format_version,
          session_id: session,
          seq
        })
        expect(entry.source_id).toMatch(new RegExp(`^${session}:\\d+(#\\d+)?$`))
      })
      const lines = golden.entries.map((entry) => Number(entry.source_id.split(":")[1]!.split("#")[0]))
      expect(lines).toEqual([...lines].sort((left, right) => left - right))
      expect(new Set(golden.entries.map((entry) => entry.source_id)).size).toBe(golden.entries.length)
    })

    it("yields the same entries, ids and order from every split at a record boundary", () => {
      for (let boundary = 1; boundary < records.length; boundary++) {
        const decoded = replay(listed.agent, [records.slice(0, boundary).join(""), records.slice(boundary).join("")])
        expect(decoded.entries).toEqual(golden.entries)
        expect(decoded.state).toEqual(golden.state)
      }
    })

    it("yields the same entries one record at a time, each from a state restored from JSON", () => {
      const decoded = replay(listed.agent, records)
      expect(decoded.entries).toEqual(golden.entries)
      expect(decoded.state).toEqual(golden.state)
    })

    it("holds a last record without its newline instead of dropping or judging it", () => {
      const held = replay(listed.agent, [text.slice(0, -1)])
      expect(held.state).toMatchObject({ pending: records.at(-1)!.slice(0, -1), line: records.length - 1 })
      expect(replay(listed.agent, [text.slice(0, -1), "\n"])).toEqual(replay(listed.agent, [text]))
    })

    it("refuses the capture under another release line, at the record that names it", () => {
      const other = listed.agent === "codex"
        ? text.replace(`"cli_version":"${listed.cli_release}"`, "\"cli_version\":\"0.161.0\"")
        : text.replaceAll(`"version":"${listed.cli_release}"`, "\"version\":\"2.2.0\"")
      expect(other).not.toBe(text)
      const result = decode(listed.agent, undefined, other)
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "harness/ExternalTranscriptError",
        code: "unsupported_version"
      })
    })

    it("refuses the capture when one of its records is replaced by a kind it does not name", () => {
      // The last record is complete and well-formed; only its kind is new.
      const future = listed.agent === "codex"
        ? JSON.stringify({ timestamp: "2026-10-08T00:00:00.000Z", type: "future_semantic_record", payload: {} })
        : JSON.stringify({ type: "future-semantic-record", sessionId: golden.entries[0]!.session_id })
      const result = decode(listed.agent, undefined, `${records.slice(0, -1).join("")}${future}\n`)
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        code: "unsupported_record",
        line: records.length
      })
    })
  })

  describe("a member's Codex session in a machine (codex-machine-0.160)", () => {
    const { golden, records } = load(manifest.fixtures.find((fixture) => fixture.directory === "codex-machine-0.160")!)
    const session = "01a1149b-f90c-7833-87d0-6c4ff981df9c"
    const failedCall = "call_dbe0b931f54b4b7bbca20b5236d530ff"

    it("keeps both turns' prompts as the owner's and everything else as the agent's", () => {
      expect(golden.entries.map((entry) => [entry.source_id.split(":")[1], entry.role, entry.part.type])).toEqual([
        ["10", "user", "prompt"],
        ["11", "assistant", "text"],
        ["15", "assistant", "edit"],
        ["16", "assistant", "edit"],
        ["17", "assistant", "tool"],
        ["20", "assistant", "text"],
        ["30", "user", "prompt"],
        ["31", "assistant", "text"],
        ["35", "assistant", "tool"],
        ["35#1", "assistant", "edit"],
        ["38", "assistant", "tool"],
        ["42", "assistant", "text"]
      ])
    })

    it("reports the two applied edits with the diffs Codex recorded", () => {
      expect(entryAt(golden, "15").part).toEqual({
        type: "edit",
        call_id: "exec-b894488e-3c0b-47b4-a3cb-6510db50a6dd",
        outcome: "applied",
        files: [{ path: "/workspace/capture/sample.txt", change: "added", diff: "@@ -0,0 +1,1 @@\n+alpha\n" }]
      })
      expect(entryAt(golden, "16").part).toMatchObject({
        type: "edit",
        outcome: "applied",
        files: [{ path: "/workspace/capture/sample.txt", change: "modified", diff: "@@ -1 +1 @@\n-alpha\n+beta\n" }]
      })
    })

    it("keeps the failed edit: the script's failure report, its request, and the file it named", () => {
      const request = JSON.parse(records[32]!).payload as { call_id: string; input: string; name: string }
      expect(request).toMatchObject({ type: "custom_tool_call", call_id: failedCall, name: "exec" })
      const report = JSON.parse(records[34]!).payload as { call_id: string; output: Array<{ text: string }> }
      expect(report.call_id).toBe(failedCall)
      const tool = entryAt(golden, "35")
      expect(tool).toMatchObject({ source_id: `${session}:35`, seq: 8 })
      expect(tool.part).toMatchObject({
        type: "tool",
        call_id: failedCall,
        command: request.input,
        status: "error",
        reads: [],
        duration_ms: 0
      })
      expect(tool.part.type === "tool" && tool.part.output).toBe(report.output.map((part) => part.text).join("\n"))
      expect(tool.part.type === "tool" && tool.part.output).toMatch(/^Script failed\n/)
      expect(entryAt(golden, "35#1")).toMatchObject({
        source_id: `${session}:35#1`,
        seq: 9,
        part: {
          type: "edit",
          call_id: failedCall,
          outcome: "failed",
          // The report names the file and no change, so no diff is invented.
          files: [{ path: "/workspace/capture/sample.txt", change: "modified", diff: "" }]
        }
      })
    })

    it("reports the command that passed and the one that exited 7", () => {
      expect(entryAt(golden, "17").part).toMatchObject({
        type: "tool",
        command: "cat sample.txt",
        reads: ["Read sample.txt"],
        status: "ok",
        exit_code: 0
      })
      expect(entryAt(golden, "38").part).toMatchObject({
        type: "tool",
        command: "printf 'capture-error\\n'; exit 7",
        status: "error",
        exit_code: 7
      })
    })

    it("holds each script request only until its output", () => {
      const held = (through: number) =>
        Object.keys((replay("codex", records.slice(0, through)).state as ExternalTranscript.CodexState).calls ?? {})
      expect(held(32)).toEqual([])
      expect(held(33)).toEqual([failedCall])
      expect(held(34)).toEqual([failedCall])
      expect(held(35)).toEqual([])
      expect(golden.state).not.toHaveProperty("calls")
    })
  })

  describe("signed-out headless runs in a temporary home", () => {
    it("reads Codex's prompt and the failure its turn ended in (codex-signed-out-0.160)", () => {
      const { golden } = load(manifest.fixtures.find((fixture) => fixture.directory === "codex-signed-out-0.160")!)
      const session = "01a119e7-51a2-7c83-86d2-3f125158d08b"
      expect(golden.entries).toEqual([
        {
          origin: "external",
          agent_kind: "codex",
          format_version: "codex-rollout/0.160",
          session_id: session,
          source_id: `${session}:10`,
          read_only: true,
          seq: 0,
          at: Date.parse("2026-10-08T05:05:53.192Z"),
          turn_id: "01a119e7-51b2-7e83-bc56-854874598532",
          role: "user",
          part: { type: "prompt", text: "Create sample.txt containing the word alpha, then print it." }
        },
        {
          origin: "external",
          agent_kind: "codex",
          format_version: "codex-rollout/0.160",
          session_id: session,
          source_id: `${session}:11`,
          read_only: true,
          seq: 1,
          at: Date.parse("2026-10-08T05:06:10.615Z"),
          turn_id: "01a119e7-51b2-7e83-bc56-854874598532",
          role: "assistant",
          part: {
            type: "error",
            message:
              "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a4729d5f4c74b917-SJC, request id: req_e2160dcbe03b4eae96cc1889277325b5"
          }
        }
      ])
    })

    it("reads Claude Code's prompt and the error it reported (claude-code-signed-out-2.1)", () => {
      const { golden } = load(manifest.fixtures.find((fixture) => fixture.directory === "claude-code-signed-out-2.1")!)
      const session = "889e416d-fda3-42c0-869a-56b3ced78a05"
      expect(golden.entries).toEqual([
        {
          origin: "external",
          agent_kind: "claude-code",
          format_version: "claude-code/2.1",
          session_id: session,
          source_id: `${session}:3`,
          read_only: true,
          seq: 0,
          at: Date.parse("2026-10-08T05:05:51.884Z"),
          turn_id: "1557e249-2b07-4f0f-b42d-5eb6eadbcf1f",
          role: "user",
          part: { type: "prompt", text: "Create sample.txt containing the word alpha, then print it." }
        },
        {
          origin: "external",
          agent_kind: "claude-code",
          format_version: "claude-code/2.1",
          session_id: session,
          source_id: `${session}:16`,
          read_only: true,
          seq: 1,
          at: Date.parse("2026-10-08T05:05:51.929Z"),
          turn_id: "1557e249-2b07-4f0f-b42d-5eb6eadbcf1f",
          role: "assistant",
          part: { type: "error", message: "Not logged in · Please run /login" }
        }
      ])
    })
  })
})
