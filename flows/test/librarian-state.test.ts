import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import * as State from "../librarian/state.ts"

test("librarian Control state is durable and outside the served repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "smithers-librarian-state-"))
  const root = join(parent, "repo")
  await mkdir(root)
  assert.equal(State.resolveStateRoot({ root }), join(parent, ".smithers-librarian-state", "repo"))
  assert.equal(State.resolveStateRoot({ root, explicit: join(parent, "runtime") }), join(parent, "runtime"))
  assert.throws(() => State.resolveStateRoot({ root, explicit: ".flows" }), /inside the served repository/)
  assert.equal(
    State.resolveStateRoot({ root, explicit: ".flows", environment: { [State.inRootVariable]: "1" } }),
    join(root, ".flows")
  )
})
