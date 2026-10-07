import { Effect } from "effect"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { make } from "./fixtures/rehearsal-mutations.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
test("controlled rehearsal provider publishes one file and refuses stale or unsupported mutations without changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-mutations-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = await mkdtemp(join(tmpdir(), "rehearsal-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(root, "file"), "original")
  await writeFile(join(outside, "file"), "outside")
  await symlink(outside, join(root, "link"))
  const provider = make(root)
  const change = (path = "file", base_digest = hash("original"), text: string | null = "updated") => ({
    path,
    base_digest,
    content: text === null ? null : new TextEncoder().encode(text)
  })
  for (
    const [session, changes] of [
      ["", [change()]],
      ["run", []],
      ["run", [change(), change("other", "absent")]],
      ["run", [change("file", hash("original"), null)]],
      ["run", [change("../file", "absent")]],
      ["run", [change(".jj/state", "absent")]],
      ["run", [change("big", "absent", "x".repeat(1024 * 1024 + 1))]],
      ["run", [change(join(outside, "file"), hash("outside"))]],
      ["run", [change("link/file", hash("outside"))]]
    ] as const
  ) {
    const failure = await Effect.runPromise(Effect.flip(provider.commit(session, changes)))
    assert.equal(failure.code, "provider_unavailable")
    assert.equal(await readFile(join(root, "file"), "utf8"), "original")
    assert.equal(await readFile(join(outside, "file"), "utf8"), "outside")
  }
  const stale = await Effect.runPromise(Effect.flip(provider.commit("run", [change("file", "absent")])))
  assert.equal(stale.code, "stale_read")
  assert.equal(stale.current_digest, hash("original"))
  const absentStale = await Effect.runPromise(
    Effect.flip(provider.commit("run", [change("missing/file", hash("original"))]))
  )
  assert.equal(absentStale.code, "stale_read")
  assert.equal((await readdir(root)).includes("missing"), false)
  await Effect.runPromise(provider.commit("run", [change()]))
  assert.equal(await readFile(join(root, "file"), "utf8"), "updated")
  await Effect.runPromise(provider.commit("run", [change("created", "absent", "new")]))
  assert.equal(await readFile(join(root, "created"), "utf8"), "new")
  await Effect.runPromise(provider.commit("run", [change("flows/todo/flow.ts", "absent", "flow")]))
  assert.equal(await readFile(join(root, "flows/todo/flow.ts"), "utf8"), "flow")
  assert.deepEqual((await readdir(root)).sort(), ["created", "file", "flows", "link"])
})
