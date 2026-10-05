import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { EXTERNAL_SESSIONS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { CHUNK_LIMIT, LINE_LIMIT, externalSessions, findSession, readChunk, sessionRoots } from "./ExternalSessions"
import { localPreviewLoopback, startLocalServer, type LocalServer } from "./server"

const ID = "0199aaaa-1111-7222-8333-444455556666"
const OTHER = "0199bbbb-1111-7222-8333-444455556666"
const CLAUDE = "5b2c9e10-4d3a-4f6e-9a1b-7c8d9e0f1a2b"
const rolloutPath = (root: string, id: string) => join(root, "2026", "10", "05", `rollout-2026-10-05T11-45-26-${id}.jsonl`)

let home: string
const codexRoot = () => join(home, ".codex", "sessions")
const claudeRoot = () => join(home, ".claude", "projects")
const write = async (path: string, content: string, modified?: number) => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content)
  if (modified !== undefined) await utimes(path, new Date(modified), new Date(modified))
  return path
}

beforeAll(async () => {
  // The real path: a link in any component of a transcript's path is refused, and /var is one on macOS.
  home = await realpath(await mkdtemp(join(tmpdir(), "agent-home-")))
  await write(rolloutPath(codexRoot(), ID), "own\n", 1_000)
  await write(rolloutPath(codexRoot(), OTHER), "other\n", 1_000)
  // Another seat's home is never read.
  await write(rolloutPath(join(home, ".smithers", "accounts", "codex-2", "sessions"), ID), "seat\n", 2_000)
  await write(join(claudeRoot(), "-Users-ben-repo", `${CLAUDE}.jsonl`), "own claude\n", 1_000)
  await write(join(home, ".smithers", "accounts", "claude-1", "projects", "-Users-ben-repo", `${CLAUDE}.jsonl`), "seat claude\n", 2_000)
  // A subagent's transcript under the session's directory is not the session.
  await write(join(claudeRoot(), "-Users-ben-repo", CLAUDE, "subagents", `agent-${CLAUDE}.jsonl`), "", 3_000)
})
afterAll(() => rm(home, { recursive: true, force: true }))

describe("finding a session", () => {
  test("roots are the running user's own configured home, else the default one", async () => {
    expect(await sessionRoots("codex", home, { CODEX_HOME: "/custom" })).toEqual(["/custom/sessions"])
    expect(await sessionRoots("codex", home, {})).toEqual([codexRoot()])
    expect(await sessionRoots("claude-code", home, { CLAUDE_CONFIG_DIR: "/custom" })).toEqual(["/custom/projects"])
    expect(await sessionRoots("claude-code", home, {})).toEqual([claudeRoot()])
  })

  test("a full id or unique prefix reads the own-home copy", async () => {
    const own = { id: ID, path: rolloutPath(codexRoot(), ID), root: codexRoot() }
    expect(await findSession("codex", ID, [codexRoot()])).toEqual(own)
    expect(await findSession("codex", "0199aaaa", [codexRoot()])).toEqual(own)
    expect(await findSession("claude-code", "5b2c", [claudeRoot()])).toEqual({ id: CLAUDE, path: join(claudeRoot(), "-Users-ben-repo", `${CLAUDE}.jsonl`), root: claudeRoot() })
  })

  test("an unknown, ambiguous or malformed id says which", async () => {
    expect(await findSession("codex", "ffff", [codexRoot()])).toEqual({ refusal: { status: 404, code: "source_not_found", message: "No Codex session ffff on this machine." } })
    expect(await findSession("codex", "0199", [codexRoot()])).toEqual({ refusal: { status: 409, code: "ambiguous_session", message: `0199 matches 2 Codex sessions: ${ID}, ${OTHER}.` } })
    expect(await findSession("claude-code", "0199", [claudeRoot()])).toMatchObject({ refusal: { message: "No Claude Code session 0199 on this machine." } })
    for (const bad of ["", "019", "../etc", "0199AAAA", "a".repeat(37)]) expect(await findSession("codex", bad, [codexRoot()])).toMatchObject({ refusal: { status: 400 } })
  })

  test("symlinked transcripts, directories and roots are never read", async () => {
    const seat = join(home, ".smithers", "accounts", "codex-2", "sessions")
    const links = join(home, "links", "sessions")
    await mkdir(links, { recursive: true })
    await symlink(rolloutPath(seat, ID), join(links, `rollout-2026-10-05T11-45-26-${ID}.jsonl`))
    await symlink(seat, join(links, "x"))
    expect(await findSession("codex", ID, [links])).toMatchObject({ refusal: { status: 404 } })
    await symlink(seat, join(home, "linked-sessions"))
    expect(await findSession("codex", ID, [join(home, "linked-sessions")])).toMatchObject({ refusal: { status: 404 } })
    const project = join(home, "linked-claude", "projects", "-repo")
    await mkdir(project, { recursive: true })
    await symlink(join(home, ".smithers", "accounts", "claude-1", "projects", "-Users-ben-repo", `${CLAUDE}.jsonl`), join(project, `${CLAUDE}.jsonl`))
    expect(await findSession("claude-code", CLAUDE, [join(home, "linked-claude", "projects")])).toMatchObject({ refusal: { status: 404 } })
  })

  test("a linked default or configured home exposes no sessions", async () => {
    const dotfiles = join(home, "dotfiles")
    await mkdir(dotfiles)
    await symlink(join(home, ".codex"), join(dotfiles, ".codex"))
    await symlink(join(home, ".claude"), join(dotfiles, ".claude"))
    for (const env of [{}, { CODEX_HOME: join(dotfiles, ".codex"), CLAUDE_CONFIG_DIR: join(dotfiles, ".claude") }]) {
      const read = externalSessions(agent => sessionRoots(agent, dotfiles, env))
      expect(await read("codex", ID, 0)).toEqual({ refusal: { status: 404, code: "source_not_found", message: `No Codex session ${ID} on this machine.` } })
      expect(await read("claude-code", CLAUDE, 0)).toMatchObject({ refusal: { status: 404 } })
    }
  })
})

describe("reading a session", () => {
  test("complete lines from an offset; a half-written line waits, even one split inside a character", async () => {
    const path = await write(join(home, "tail.jsonl"), "one\n")
    expect(await readChunk(path, home, 0)).toEqual({ offset: 0, next: 4, text: "one\n", eof: true })
    const line = Buffer.from("two · naïve\n")
    const cut = line.indexOf(Buffer.from("ï")) + 1
    await appendFile(path, line.subarray(0, cut))
    expect(await readChunk(path, home, 4)).toEqual({ offset: 4, next: 4, text: "", eof: true })
    await appendFile(path, line.subarray(cut))
    expect(await readChunk(path, home, 4)).toEqual({ offset: 4, next: 4 + line.length, text: "two · naïve\n", eof: true })
    expect(await readChunk(path, home, 4 + line.length + 1)).toEqual({ refusal: { status: 409, code: "offset_out_of_range",
      message: `The session file is ${4 + line.length} bytes, shorter than offset ${4 + line.length + 1}: it was replaced.` } })
    expect(await readChunk(join(home, "gone.jsonl"), home, 0)).toMatchObject({ refusal: { status: 404 } })
    // A file reached through a link, or outside the root, is gone as far as a read is concerned.
    await symlink(path, join(home, "linked.jsonl"))
    expect(await readChunk(join(home, "linked.jsonl"), home, 0)).toMatchObject({ refusal: { status: 404 } })
    expect(await readChunk(path, codexRoot(), 0)).toMatchObject({ refusal: { status: 404 } })
  })

  test("a chunk is at most 4 MiB and ends at a line boundary", async () => {
    const megabyte = `${"x".repeat((1 << 20) - 1)}\n`
    const path = await write(join(home, "big.jsonl"), megabyte.repeat(9))
    const sizes: number[] = []
    for (let offset = 0; ;) {
      const chunk = await readChunk(path, home, offset)
      if ("refusal" in chunk) throw new Error(chunk.refusal.message)
      expect(chunk.text.endsWith("\n")).toBe(true)
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_LIMIT)
      sizes.push(chunk.text.length >> 20)
      offset = chunk.next
      if (chunk.eof) break
    }
    expect(sizes).toEqual([4, 4, 1])
  })

  test("a line longer than a chunk comes alone, up to 64 MiB", async () => {
    const long = `${"y".repeat(CHUNK_LIMIT + 10)}\n`
    const path = await write(join(home, "long.jsonl"), `${long}short\n`)
    const first = await readChunk(path, home, 0)
    expect(first).toMatchObject({ offset: 0, next: long.length, eof: false })
    expect("text" in first && first.text === long).toBe(true)
    expect(await readChunk(path, home, long.length)).toEqual({ offset: long.length, next: long.length + 6, text: "short\n", eof: true })
    expect(await readChunk(await write(join(home, "writing.jsonl"), "z".repeat(CHUNK_LIMIT + 10)), home, 0)).toEqual({ offset: 0, next: 0, text: "", eof: true })
    expect(await readChunk(await write(join(home, "huge.jsonl"), `${"h".repeat(LINE_LIMIT + 1)}\n`), home, 0)).toEqual({
      refusal: { status: 422, code: "line_too_long", message: "The line at byte 0 is longer than 64 MiB." } })
  })

  test("a file turned into another account's link, or gone, after it was found answers no-session and is forgotten", async () => {
    const seat = rolloutPath(join(home, ".smithers", "accounts", "codex-2", "sessions"), ID)
    for (const swap of [async (path: string) => { await rm(path); await symlink(seat, path) }, (path: string) => rm(path)]) {
      const root = await realpath(await mkdtemp(join(home, "race-")))
      const path = await write(rolloutPath(root, ID), "own prompt\n")
      const read = externalSessions(async () => [root], { find: async (agent, prefix, roots) => {
        const discovered = await findSession(agent, prefix, roots)
        await swap(path)
        return discovered
      } })
      const answer = await read("codex", ID, 0)
      expect(answer).toEqual({ refusal: { status: 404, code: "source_not_found", message: `No Codex session ${ID} on this machine.` } })
      expect(JSON.stringify(answer)).not.toContain("seat")
    }
    // A cached file swapped for a link is not read through it.
    const root = join(home, "cached-race")
    const path = await write(rolloutPath(root, ID), "own prompt\n")
    const read = externalSessions(async () => [root])
    expect(await read("codex", ID, 0)).toMatchObject({ text: "own prompt\n" })
    await rm(path)
    await symlink(seat, path)
    expect(await read("codex", ID, 0)).toEqual({ refusal: { status: 404, code: "source_not_found", message: `No Codex session ${ID} on this machine.` } })
  })

  test("a found session is looked for once; a deleted or replaced file is looked for again", async () => {
    const root = join(home, "cached")
    const path = await write(rolloutPath(root, ID), "first\n")
    let walks = 0
    const read = externalSessions(async () => { walks++; return [root] })
    expect(await read("codex", ID, 0)).toMatchObject({ session_id: ID, text: "first\n" })
    expect(await read("codex", ID, 6)).toMatchObject({ text: "", eof: true })
    expect(walks).toBe(1)
    await rename(path, `${path}.old`)
    await write(path, "replaced\n")
    expect(await read("codex", ID, 0)).toMatchObject({ text: "replaced\n" })
    expect(walks).toBe(2)
    await rm(path)
    expect(await read("codex", ID, 0)).toMatchObject({ refusal: { status: 404 } })
    expect(walks).toBe(3)
  })
})

describe(`GET ${EXTERNAL_SESSIONS_PATH}`, () => {
  let server: LocalServer
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
    await writeFile(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>")
    server = await startLocalServer({ port: 0, distDir: dist, home: "/fake/home", log: () => {}, externalSessions: externalSessions(agent => sessionRoots(agent, home, {})) })
  })
  afterAll(async () => { await server.stop(); await rm(dist, { recursive: true, force: true }) })
  const get = (query: string, session = true) =>
    fetch(`${server.origin}${EXTERNAL_SESSIONS_PATH}${query}`, { headers: session ? { [LOCAL_SESSION_HEADER]: server.sessionToken } : {} })
  const os = { login: userInfo().username, name: userInfo().username }

  test("answers the session's lines from the offset, named for the OS user", async () => {
    const response = await get("?agent=codex&session=0199bbbb")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ agent: "codex", session_id: OTHER, owner: os, offset: 0, next: 6, text: "other\n", eof: true })
    expect(await (await get("?agent=codex&session=0199bbbb&offset=6")).json()).toMatchObject({ offset: 6, next: 6, text: "", eof: true })
    expect(await (await get("?agent=claude-code&session=5b2c")).json()).toMatchObject({ agent: "claude-code", session_id: CLAUDE, text: "own claude\n" })
  })

  test("refuses a bad agent, id or offset, an unknown id, an ambiguous prefix and a request without the local session", async () => {
    for (const query of ["", "?agent=codex", "?agent=gemini&session=0199bbbb", "?agent=codex&session=../../etc", "?agent=codex&session=0199bbbb&offset=-1",
      "?agent=codex&session=0199bbbb&offset=01", "?agent=codex&session=0199bbbb&offset=x"]) expect((await get(query)).status, query).toBe(400)
    const unknown = await get("?agent=codex&session=ffffffff")
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ message: "No Codex session ffffffff on this machine." })
    expect((await get("?agent=codex&session=0199")).status).toBe(409)
    expect((await get("?agent=codex&session=0199bbbb&offset=99")).status).toBe(409)
    expect((await get("?agent=codex&session=0199bbbb", false)).status).toBe(401)
  })

  test("refuses non-loopback targets and peers", async () => {
    expect(localPreviewLoopback("127.0.0.1", "192.168.1.2")).toBe(false)
    expect(localPreviewLoopback("192.168.1.2", "127.0.0.1")).toBe(false)
    expect(localPreviewLoopback("127.0.0.1", undefined)).toBe(false)
    expect(localPreviewLoopback("127.0.0.1", "127.0.0.1")).toBe(true)
    const response = await fetch(`${server.origin}${EXTERNAL_SESSIONS_PATH}?agent=codex&session=${ID}`, {
      headers: { host: "192.168.1.2", [LOCAL_SESSION_HEADER]: server.sessionToken }
    })
    expect(response.status).toBe(421)
  })

  test("install-connected and hybrid routers never mount the preview", async () => {
    for (const mode of [{ backendApi: "http://127.0.0.1:1" }, { cloudMode: "hybrid" as const }]) {
      let reads = 0
      const host = await startLocalServer({ port: 0, distDir: dist, log: () => {}, ...mode,
        externalSessions: async () => { reads++; throw new Error("must not read a home") } })
      try {
        const response = await fetch(`${host.origin}${EXTERNAL_SESSIONS_PATH}?agent=codex&session=${ID}`, { headers: { [LOCAL_SESSION_HEADER]: host.sessionToken } })
        expect(response.status).toBe(404)
        expect(reads).toBe(0)
      } finally { await host.stop() }
    }
  })
})
