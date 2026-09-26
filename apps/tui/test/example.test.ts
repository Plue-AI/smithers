/** The shipped example (`examples/custom-ui`) through the real registry: metadata only, nothing imported. */
import { afterAll, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Contributions from "../src/contributions.ts"
import * as Extension from "../src/extension.ts"
import * as FlowControl from "../src/flow-control.ts"
import * as Host from "../src/host.ts"
import * as Keys from "../src/keys.ts"

const root = join(import.meta.dir, "..", "examples", "custom-ui")
const stateRoot = mkdtempSync(join(tmpdir(), "tui-example-"))
const host = Host.make({ cwd: root, environment: {}, approvals: "ask" })
const port = FlowControl.make({ cwd: root, environment: {}, stateRoot, approvals: host.approvals! })
afterAll(async () => {
  await port.dispose()
  await host.dispose()
  rmSync(stateRoot, { recursive: true, force: true })
})

it("declares alt+p and a status item from the example's flow.mdx, and the key runs its agent", async () => {
  const listed = await port.discover()
  expect(listed.map((each) => [each.name, each.kind])).toEqual([["release-plan", "markdown"]])
  const store = new Contributions.Store({ taken: Keys.taken })
  store.repo(listed.map(Extension.declared))
  const snapshot = store.snapshot()
  expect(snapshot.problems).toEqual([])
  expect(snapshot.keys).toEqual([{
    owner: "repo:release-plan",
    key: {
      id: "repo:release-plan/alt+p",
      key: "alt+p",
      label: "Plan release",
      context: "global",
      action: { kind: "agent", agent: "release-plan", prompt: "Plan release" }
    }
  }])
  expect(snapshot.watched).toEqual(["release-plan"])
  expect(Keys.bindingFor({ name: "p", meta: true }, "composer", Keys.bindings(snapshot.keys))?.label).toBe(
    "Plan release"
  )
})
