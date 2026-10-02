import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"
import { expect, it } from "vitest"
import * as IssueSync from "../src/core/IssueSync.ts"

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { EngineStore, Kernel } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Layer, ManagedRuntime } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Actions from "../src/github/Actions.ts"
import * as Client from "../src/github/GitHubClient.ts"
import { json, startFixture } from "./Fixture.ts"

it("refuses a memory runtime before any connector can claim or send", async () => {
  const runtime = await Effect.runPromise(
    FlowRuntime.FlowRuntime.pipe(Effect.provide(FlowEngine.layerMemory), Effect.scoped)
  )
  expect(() => IssueSync.requireDurableRuntime(runtime)).toThrow("durable engine store")
})

const Post = Flow.make("test/integrations/github/issue-post", {
  payload: Actions.CommentOnIssue.payloadSchema,
  success: Actions.CommentOnIssue.successSchema,
  error: Actions.CommentOnIssue.errorSchema,
  body: (payload) => Actions.CommentOnIssue.call(payload)
})

it("reopens the durable store and replays a lapsed delivery without sending twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "issue-sync-restart-"))
  const server = await startFixture((_req, res) => json(res, 201, { id: 10, url: "https://github.test/comment/10" }))
  const client = Client.make({ token: "fixture", apiBaseUrl: server.origin }, {})
  const registration = Interpreter.layer(Post).pipe(
    Layer.provideMerge(Actions.layer.pipe(Layer.provide(Layer.succeed(Client.GitHubClient, client)))),
    Layer.provideMerge(Action.layerImplementations)
  )
  // External irreversible actions do not snapshot a checkout. SQL/journal/attempt
  // storage are the real production composition; only the workspace ports are inert.
  const host = Layer.mergeAll(
    NodeCrypto.layer,
    NodeFileSystem.layer,
    Layer.succeed(
      Kernel.Jj.Jj,
      Kernel.Jj.make({
        snapshot: () => Effect.die("unexpected snapshot"),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    )
  )
  const boot = () =>
    ManagedRuntime.make(
      NodeRuntime.layer(
        {
          filename: join(root, "engine.sqlite"),
          workspaceRoot: root,
          owner: { hostId: "issue-sync-test" },
          isAlive: () => Effect.succeed(false)
        },
        EngineStore.StepBoundary.layerTest(),
        Layer.effect(
          EngineStore.WorkspaceSandbox.WorkspaceSandbox,
          EngineStore.WorkspaceSandbox.makeMemory().pipe(Effect.map((sandbox) => sandbox.service))
        ),
        registration
      ).pipe(Layer.provide(host))
    )
  let state = "pending", lostReceipt = true
  const request = async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      state = "dispatching"
      return Response.json({ state, token: "stable-claim" })
    }
    if (init?.method === "PUT") {
      if (lostReceipt) return new Response(null, { status: 503 })
      const receipt = JSON.parse(String(init.body))
      expect(receipt).toMatchObject({ state: "sent", token: "stable-claim", message_id: "10" })
      state = receipt.state
      return Response.json({})
    }
    expect(path.endsWith("/deliveries")).toBe(true)
    return Response.json(
      state === "sent" ?
        [] :
        [{
          id: 1,
          key: "key",
          issue_id: 42,
          state,
          claim_token: state === "dispatching" ? "stable-claim" : "",
          event: "comment.created",
          payload: { comment: { id: 7, body: "hello" } },
          message_id: "",
          mapping: {
            provider: "github",
            connection_id: "bot",
            scope_id: "123",
            conversation_id: "-100",
            thread_id: "chat"
          }
        }]
    )
  }
  let hostRuntime = boot()
  try {
    const connector = async () => {
      const runtime = await hostRuntime.runPromise(FlowRuntime.FlowRuntime)
      IssueSync.requireDurableRuntime(runtime)
      return IssueSync.make({
        owner: "owner",
        repo: "repo",
        request,
        connector: {
          accepts: (mapping) => mapping.provider === "github",
          reconcile: async () => undefined,
          deliver: async (delivery, executionId) => {
            const result = await hostRuntime.runPromise(runtime.execute(Post, {
              payload: { owner: "owner", repo: "repo", issueNumber: 42, body: delivery.payload.comment.body ?? "" },
              executionId
            }))
            return { messageId: String(result.id) }
          }
        }
      })
    }
    await expect((await connector()).drain()).rejects.toThrow("receipts did not commit")
    expect(server.requests).toHaveLength(1)
    await hostRuntime.dispose()
    lostReceipt = false
    hostRuntime = boot()
    expect(await (await connector()).drain()).toBe(1)
    expect(server.requests).toHaveLength(1)
  } finally {
    await hostRuntime.dispose()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
