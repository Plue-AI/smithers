import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, rm, realpath, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { EXTERNAL_CODEX_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { clip, externalSessions, findRollout, sessionRoots } from "./ExternalSessions"
import { startLocalServer, type LocalServer } from "./server"

const ID = "0199aaaa-1111-7222-8333-444455556666"
const OTHER = "0199bbbb-1111-7222-8333-444455556666"
const meta = (id: string, release = "0.160.0") => JSON.stringify({ timestamp: "2026-10-05T18:00:00.000Z", type: "session_meta", payload: { id, cwd: "/repo", cli_version: release } })
const item = (second: number, item: Record<string, unknown>) =>
  JSON.stringify({ timestamp: `2026-10-05T18:00:${String(second).padStart(2, "0")}.000Z`, type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item } })
const prompt = (second: number, text: string) => item(second, { type: "UserMessage", content: [{ type: "text", text }] })
const rolloutPath = (root: string, id: string) => join(root, "2026", "10", "05", `rollout-2026-10-05T11-45-26-${id}.jsonl`)

let home: string
const write = async (path: string, lines: readonly string[]) => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, lines.map(line => `${line}\n`).join(""))
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "codex-home-")))
  await write(rolloutPath(join(home, ".codex", "sessions"), ID), [meta(ID), prompt(1, "stale copy")])
  await write(rolloutPath(join(home, ".smithers", "accounts", "codex-2", "sessions"), ID), [meta(ID), prompt(1, "live copy")])
  await write(rolloutPath(join(home, ".smithers", "accounts", "codex-2", "sessions"), OTHER), [meta(OTHER), prompt(1, "other")])
  await write(rolloutPath(join(home, ".codex", "sessions"), OTHER), [meta(OTHER), prompt(1, "other")])
  await utimes(rolloutPath(join(home, ".codex", "sessions"), ID), new Date(1_000), new Date(1_000))
})
afterAll(() => rm(home, { recursive: true, force: true }))

describe("finding a session", () => {
  test("roots select CODEX_HOME exclusively or the default home", async () => {
    expect(await sessionRoots(home, { CODEX_HOME: "/custom" })).toEqual([
      "/custom/sessions"
    ])
    expect(await sessionRoots(join(home, "missing"), {})).toEqual([join(home, "missing", ".codex", "sessions")])
  })

  test("a full id or unique prefix reads only the own-home copy", async () => {
    const roots = await sessionRoots(home, {})
    const live = { path: rolloutPath(join(home, ".codex", "sessions"), ID) }
    expect(await findRollout(ID, roots)).toEqual(live)
    expect(await findRollout("0199aaaa", roots)).toEqual(live)
  })

  test("other homes and symlinked transcripts or sessions are never read", async () => {
    const own = await externalSessions(() => sessionRoots(home, {}))(ID)
    expect(own).toMatchObject({ entries: [{ part: { text: "stale copy" } }] })
    const account = join(home, ".smithers", "accounts", "codex-2", "sessions")
    const root = join(home, "links", "sessions")
    await mkdir(root, { recursive: true })
    await symlink(rolloutPath(account, ID), join(root, `rollout-2026-10-05T11-45-26-${ID}.jsonl`))
    await symlink(account, join(root, "x"))
    expect(await externalSessions(() => sessionRoots(home, { CODEX_HOME: join(home, "links") }))(ID)).toMatchObject({ error: "unknown" })
    await symlink(account, join(home, "linked-sessions"))
    expect(await externalSessions(async () => [join(home, "linked-sessions")])(ID)).toMatchObject({ error: "unknown" })
  })

  test("an unknown or ambiguous id says which", async () => {
    const roots = await sessionRoots(home, {})
    expect(await findRollout("ffff", roots)).toEqual({ error: "unknown", message: "No Codex session ffff on this machine." })
    expect(await findRollout("0199", roots)).toEqual({ error: "ambiguous", message: `0199 matches 2 Codex sessions: ${ID}, ${OTHER}.` })
  })
})

describe("tailing a session", () => {
  test("each read decodes only what was appended, and since skips what was sent", async () => {
    const root = join(home, "tail")
    const path = rolloutPath(root, ID)
    await write(path, [meta(ID), prompt(1, "first")])
    const read = externalSessions(async () => [root])
    const first = await read(ID)
    if (!("entries" in first)) throw new Error("expected a session")
    expect(first).toMatchObject({ session_id: ID, format_version: "codex-rollout/0.160", cwd: "/repo", next: 1 })
    expect(first.entries.map(entry => entry.part)).toEqual([{ type: "prompt", text: "first" }])
    // A half-written line waits; a multi-byte character split between writes survives.
    const line = prompt(2, "second · naïve")
    const bytes = Buffer.from(`${line}\n`)
    const cut = bytes.indexOf(Buffer.from("ï")) + 1
    await appendFile(path, bytes.subarray(0, cut))
    const waiting = await read(ID, first.next)
    expect("entries" in waiting && waiting.entries).toEqual([])
    await appendFile(path, bytes.subarray(cut))
    const second = await read(ID, first.next)
    if (!("entries" in second)) throw new Error("expected a session")
    expect(second.entries.map(entry => [entry.seq, entry.part])).toEqual([[1, { type: "prompt", text: "second · naïve" }]])
    expect(second.next).toBe(2)
    expect(await read(ID, 0)).toMatchObject({ next: 2 })
  })

  test("a malformed line stops the import with its error and keeps what came before", async () => {
    const root = join(home, "broken")
    await write(rolloutPath(root, ID), [meta(ID), prompt(1, "kept"), "{not json"])
    const read = await externalSessions(async () => [root])(ID)
    expect(read).toMatchObject({ next: 1, entries: [{ part: { type: "prompt", text: "kept" } }],
      error: { code: "malformed_record", message: "Codex rollout line 3 is not a JSON record." } })
  })

  test("an unsupported release is refused, not guessed", async () => {
    const root = join(home, "old")
    await write(rolloutPath(root, ID), [meta(ID, "0.120.0"), prompt(1, "never read")])
    expect(await externalSessions(async () => [root])(ID)).toMatchObject({ entries: [], error: { code: "unsupported_version" } })
  })

  test("command output keeps its start and end; long diffs end at a whole line", async () => {
    const root = join(home, "clip")
    const diff = Array.from({ length: 4_000 }, (_, index) => `+line ${index}`).join("\n")
    await write(rolloutPath(root, ID), [meta(ID),
      item(1, { type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "make"], status: "completed", exit_code: 0, aggregated_output: `${"x".repeat(9_000)}END` }),
      item(2, { type: "FileChange", id: "f1", status: "completed", changes: { "/repo/a.ts": { type: "update", unified_diff: `@@ -1,1 +1,4000 @@\n${diff}` } } })])
    const read = await externalSessions(async () => [root])(ID)
    if (!("entries" in read)) throw new Error("expected a session")
    const [command, edit] = read.entries.map(entry => entry.part)
    expect(command?.type === "tool" && command.output.endsWith("END")).toBe(true)
    expect(command?.type === "tool" && command.output.includes("lines omitted")).toBe(true)
    const shown = edit?.type === "edit" ? edit.files[0]!.diff : ""
    expect(shown.length).toBeLessThanOrEqual(24_000)
    expect(shown.endsWith("\n")).toBe(true)
    expect(clip("short")).toBe("short")
  })
})

describe(`GET ${EXTERNAL_CODEX_PATH}`, () => {
  let server: LocalServer
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
    await writeFile(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>")
    server = await startLocalServer({ port: 0, distDir: dist, home: "/fake/home", log: () => {},
      externalSessions: externalSessions(async () => sessionRoots(home, {})) })
  })
  afterAll(async () => { await server.stop(); await rm(dist, { recursive: true, force: true }) })
  const get = (query: string, session = true) =>
    fetch(`${server.origin}${EXTERNAL_CODEX_PATH}${query}`, { headers: session ? { [LOCAL_SESSION_HEADER]: server.sessionToken } : {} })

  test("answers the session with its owner", async () => {
    const response = await get(`?session=0199bbbb`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ session_id: OTHER, owner: { login: userInfo().username, name: userInfo().username }, next: 1,
      entries: [{ origin: "external", agent_kind: "codex", read_only: true, role: "user", part: { type: "prompt", text: "other" } }] })
  })

  test("refuses a missing id, an unknown id, an ambiguous prefix and a request without the local session", async () => {
    expect((await get("")).status).toBe(400)
    expect((await get("?session=../../etc")).status).toBe(400)
    const unknown = await get("?session=ffffffff")
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { message: "No Codex session ffffffff on this machine." } })
    expect((await get("?session=0199")).status).toBe(400)
    expect((await get("?session=0199bbbb", false)).status).toBe(401)
  })
})
