/**
 * A long-lived host checks drift against the flow's code on disk, not its
 * cached catalog.
 *
 * The registry is a snapshot taken at startup. A flow edited or deleted while
 * the host stays up leaves that snapshot unchanged, so a drift check that read
 * it let the resume claim the run, and the executor then found the changed
 * bytes and failed the run (#1807).
 */
import { ControlRuntime } from "@smthrs/control"
import { CodeDrift } from "@smthrs/control/ControlError"
import type { RunId } from "@smthrs/control/ControlSchema"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const writeFlow = (root: string, prompt: string) => {
  const directory = join(root, "flows", "review")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "flow.mdx"),
    `---\ndescription: ${prompt}\nmodel: anthropic:test-model\n---\n${prompt}\n`
  )
}

/** Launches and parks a `review` run, runs `edit`, and reads the drift and the run. */
const afterEdit = async (edit: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-drift-live-"))
  try {
    writeFlow(root, "Original review")
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    return await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "review", input: {} })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal(), "run")
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die(`expected a started run, got ${launched._tag}`)
        const runId: RunId = launched.run.runId
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "parked")
        yield* Effect.sync(() => edit(root))
        const drift = yield* runtime.codeDrift(runId)
        const discovery = yield* Registry.Registry
        // Rescanned here only to learn the digest now on disk.
        yield* discovery.refresh()
        const current = yield* discovery.getOption("review")
        return {
          card,
          drift,
          after: yield* runtime.getRun(runId),
          current: current._tag === "Some" ? Descriptor.executionDigest(current.value) : undefined
        }
      }).pipe(Effect.provide(Layer.merge(engine.runtime, registry)), Effect.scoped)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it("refuses a flow edited on disk while the host stayed up", async () => {
  const { card, drift, after, current } = await afterEdit((root) => writeFlow(root, "Edited review"))
  expect(current).not.toBe(card.executionDigest)
  expect(drift).toEqual(
    new CodeDrift({ runId: after.runId, flowId: "review", recorded: card.executionDigest, current })
  )
  expect(after.status).toBe("parked")
  expect(after.ownerId).toBeUndefined()
})

it("refuses a flow deleted from disk while the host stayed up", async () => {
  const { card, drift, after } = await afterEdit((root) => rmSync(join(root, "flows", "review"), { recursive: true }))
  expect(drift).toEqual(new CodeDrift({ runId: after.runId, flowId: "review", recorded: card.executionDigest }))
  expect(after.status).toBe("parked")
})

it("passes a flow whose bytes on disk did not change", async () => {
  const { drift } = await afterEdit(() => undefined)
  expect(drift).toBeUndefined()
})
