import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTERNAL_SESSIONS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { CHUNK_LIMIT, LINE_LIMIT, externalSessions, findSession, readChunk, sessionRoots } from "./test-support/ExternalSessions"
import { startLocalServer } from "./server"

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

  test("symlinked transcripts and directories beneath roots are never read", async () => {
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

  test("linked default and configured agent homes inside the real user home expose sessions", async () => {
    const dotfiles = join(home, "dotfiles")
    await mkdir(dotfiles)
    await symlink(join(home, ".codex"), join(dotfiles, ".codex"))
    await symlink(join(home, ".claude"), join(dotfiles, ".claude"))
    const linkedHome = join(home, "home-link")
    await symlink(home, linkedHome)
    for (const env of [{}, { CODEX_HOME: join(dotfiles, ".codex"), CLAUDE_CONFIG_DIR: join(dotfiles, ".claude") }]) {
      const read = externalSessions(agent => sessionRoots(agent, dotfiles, env), { home: linkedHome })
      expect(await read("codex", ID, 0)).toMatchObject({ text: "own\n" })
      expect(await read("claude-code", CLAUDE, 0)).toMatchObject({ text: "own claude\n" })
    }
  })

  for (const agent of ["codex", "claude-code"] as const) {
    test(`${agent} root links stay inside the real home, exclude accounts and re-resolve cached reads`, async () => {
      const fixture = await realpath(await mkdtemp(join(home, "root-links-")))
      const outside = await realpath(await mkdtemp(join(tmpdir(), "outside-home-")))
      const id = agent === "codex" ? ID : CLAUDE
      const file = (root: string) => agent === "codex" ? rolloutPath(root, id) : join(root, "-repo", `${id}.jsonl`)
      const first = join(fixture, "first")
      const second = join(fixture, "second")
      const seat = join(fixture, ".smithers", "accounts", "codex-2", "sessions")
      const link = join(fixture, "root")
      try {
        for (const [root, text] of [[first, "first\n"], [second, "second\n"], [seat, "seat\n"], [outside, "outside\n"]] as const) await write(file(root), text)
        await symlink(first, link)
        const read = externalSessions(async () => [link], { home: fixture })
        expect(await read(agent, id, 0)).toMatchObject({ session_id: id, text: "first\n" })
        for (const [target, text] of [[second, "second\n"], [outside, undefined], [seat, undefined], [first, "first\n"]] as const) {
          await rm(link)
          await symlink(target, link)
          const answer = await read(agent, id, 0)
          if (text === undefined) expect(answer).toMatchObject({ refusal: { status: 404, code: "source_not_found" } })
          else expect(answer).toMatchObject({ text })
        }
        // No link beneath an admitted root may be followed, even to an own-home file.
        await symlink(file(second), join(first, agent === "codex" ? `rollout-2026-10-05T11-45-26-${OTHER}.jsonl` : join("-repo", `${OTHER}.jsonl`)))
        expect(await read(agent, OTHER, 0)).toMatchObject({ refusal: { status: 404 } })
      } finally { await rm(outside, { recursive: true, force: true }) }
    })
  }

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
    // Keep discovery's fixture shallow: dated-directory traversal is covered above.
    const root = home
    const path = await write(join(root, `rollout-2026-10-05T11-45-26-${ID}.jsonl`), "first\n")
    let resolves = 0
    const read = externalSessions(async () => [root], { find: async () => {
      resolves++
      return await lstat(path).then(() => ({ id: ID, path, root }), () => ({
        refusal: { status: 404, code: "source_not_found", message: `No Codex session ${ID} on this machine.` }
      }))
    } })
    expect(await read("codex", ID, 0)).toMatchObject({ session_id: ID, text: "first\n" })
    expect(await read("codex", ID, 6)).toMatchObject({ text: "", eof: true })
    expect(resolves).toBe(1)
    // Both files exist before rename, so replacement cannot reuse the cached inode.
    const original = await lstat(path)
    const replacement = await write(`${path}.new`, "replaced\n")
    const next = await lstat(replacement)
    expect(original.dev === next.dev && original.ino === next.ino).toBe(false)
    await rename(replacement, path)
    expect(await read("codex", ID, 0)).toMatchObject({ text: "replaced\n" })
    expect(resolves).toBe(2)
    expect(await read("codex", ID, 9)).toMatchObject({ text: "", eof: true })
    expect(resolves).toBe(2)
    await rm(path)
    expect(await read("codex", ID, 0)).toMatchObject({ refusal: { status: 404 } })
    expect(resolves).toBe(3)
  })
})

describe(`retired GET ${EXTERNAL_SESSIONS_PATH}`, () => {
  test("every composition refuses raw session and legacy Codex reads", async () => {
    const dist = await mkdtemp(join(tmpdir(), "smithers-retired-transcript-"))
    await writeFile(join(dist, "index.html"), "<!doctype html><div id=root></div>")
    const sentinel = join(dist, "history.jsonl")
    await writeFile(sentinel, "unrelated private history\n")
    try {
      for (const mode of [
        { backendApi: null, cloudMode: "offline" as const },
        { backendApi: "http://127.0.0.1:1", cloudMode: "offline" as const },
        { backendApi: null, cloudMode: "hybrid" as const }
      ]) {
        const host = await startLocalServer({ port: 0, distDir: dist, stateDir: dist, log: () => {}, ...mode })
        try {
          for (const path of [EXTERNAL_SESSIONS_PATH, "/api/external/codex"]) {
            for (const agent of ["codex", "claude-code"]) {
              const response = await fetch(`${host.origin}${path}?agent=${agent}&session=${ID}&offset=0`, {
                headers: { [LOCAL_SESSION_HEADER]: host.sessionToken }
              })
              expect(response.status).toBe(404)
              expect(await response.json()).toMatchObject({ error: { code: "not_found" } })
            }
          }
          expect(await readFile(sentinel, "utf8")).toBe("unrelated private history\n")
        } finally { await host.stop() }
      }
    } finally { await rm(dist, { recursive: true, force: true }) }
  })
})
