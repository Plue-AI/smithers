import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRollout, page, sessionRoots } from "./codex-session"

let home: string
const id = "0199aaaa-1111-7222-8333-444455556666"
const other = "0199bbbb-1111-7222-8333-444455556666"
const rollout = (root: string, session: string) => join(root, "2026", "10", "05", `rollout-2026-10-05T11-45-26-${session}.jsonl`)

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-home-"))
  for (const path of [rollout(join(home, ".codex", "sessions"), id), rollout(join(home, ".smithers", "accounts", "codex-2", "sessions"), id),
    rollout(join(home, ".smithers", "accounts", "codex-2", "sessions"), other)]) {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "{}\n")
  }
  await mkdir(join(home, ".smithers", "accounts", "claude-1", "sessions"), { recursive: true })
  // The account copy was written last: it is the live one.
  await utimes(rollout(join(home, ".codex", "sessions"), id), new Date(1_000), new Date(1_000))
})
afterAll(() => rm(home, { recursive: true, force: true }))

test("session roots: CODEX_HOME first, then the default home and every Codex account, never Claude's", async () => {
  expect(await sessionRoots(home, { CODEX_HOME: "/custom" })).toEqual([
    "/custom/sessions", join(home, ".codex", "sessions"), join(home, ".smithers", "accounts", "codex-2", "sessions")
  ])
  expect(await sessionRoots(join(home, "missing"), {})).toEqual([join(home, "missing", ".codex", "sessions")])
})

test("a full id or a unique prefix finds the most recently written copy", async () => {
  const roots = await sessionRoots(home, {})
  const live = rollout(join(home, ".smithers", "accounts", "codex-2", "sessions"), id)
  expect(await findRollout(id, roots)).toBe(live)
  expect(await findRollout("0199aaaa", roots)).toBe(live)
  expect(await findRollout("/x/rollout.jsonl", roots)).toBe("/x/rollout.jsonl")
})

test("an ambiguous or unknown id is refused with what it matched", async () => {
  const roots = await sessionRoots(home, {})
  await expect(findRollout("0199", roots)).rejects.toThrow(`0199 matches 2 sessions: ${id}, ${other}`)
  await expect(findRollout("ffff", roots)).rejects.toThrow("No Codex rollout for ffff")
})

test("the page cannot be closed early by the session's own text", () => {
  const html = page("<b>t</b>", "", "const a = '</script>'", { json: JSON.stringify({ text: "</script><img src=x onerror=alert(1)>" }) })
  expect(html.match(/<\/script>/g)).toHaveLength(2)
  expect(html).toContain("<title>b>t/b></title>")
  expect(html).toContain('\\u003c/script>\\u003cimg')
  expect(page("t", "", "", { live: "/session.json" })).toContain('id="codex-session" data-live="/session.json">null</script>')
})
