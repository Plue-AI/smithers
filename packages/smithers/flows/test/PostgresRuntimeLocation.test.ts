/**
 * A PostgreSQL URL is a connection identity, not a file path. The runtime must
 * hand it to the platform's database verbatim (never `resolve` it into a path
 * under the current directory) and must place the workspace and artifact
 * objects on the local disk rather than beside a "file" that does not exist.
 * The platform database is recorded and backed by in-memory SQLite, so no
 * server is needed to observe what the composition asks for.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { expect, it } from "@effect/vitest"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as Jj from "@smthrs/jj/Jj"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Effect, FileSystem, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeNative } from "../src/internal/NativeRuntime.ts"
import * as Runtime from "../src/Runtime.ts"

const url = "postgresql://smithers@db.invalid:5432/flows?schema=runtime_location"

const recordingNative = () => {
  const opened: Array<string> = []
  const native = makeNative({
    name: "RecordingRuntime",
    database: (filename) => {
      opened.push(filename)
      return NodeDatabase.layer({ filename: ":memory:" })
    },
    host: NodeHost,
    crypto: NodeCrypto.layer
  })
  return { native, opened }
}

const workspaceRoot = Effect.map(Workspace.Workspace, (workspace) => workspace.root)

/** The workspace sandbox requires a host that attests filesystem isolation. */
const isolatedFileSystem = Layer.succeed(
  FileSystem.FileSystem,
  KernelFileSystem.withIsolatedFileSystem(FileSystem.makeNoop({}))
)

const hostServices = Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer)

it.effect("roots a PostgreSQL store's workspace in the configured root", () =>
  Effect.gen(function*() {
    const root = mkdtempSync(join(tmpdir(), "flows-postgres-location-"))
    try {
      const layer = Runtime.storage(url, root).pipe(
        Layer.provide(NodeDatabase.layer({ filename: ":memory:" }))
      )
      expect(yield* workspaceRoot.pipe(Effect.provide(layer))).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }).pipe(Effect.provide(hostServices), Effect.scoped))

it.effect("roots a PostgreSQL store without a workspace under the current directory's .flows", () =>
  Effect.gen(function*() {
    const layer = Runtime.storage(url).pipe(Layer.provide(NodeDatabase.layer({ filename: ":memory:" })))
    expect(yield* workspaceRoot.pipe(Effect.provide(layer))).toBe(join(resolve("."), ".flows"))
  }).pipe(Effect.provide(hostServices), Effect.scoped))

it.effect("passes a PostgreSQL URL to the native database verbatim from storage", () =>
  Effect.gen(function*() {
    const root = mkdtempSync(join(tmpdir(), "flows-postgres-native-storage-"))
    const { native, opened } = recordingNative()
    try {
      expect(yield* workspaceRoot.pipe(Effect.provide(native.storage(url, root)))).toBe(root)
      expect(opened).toEqual([url])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }).pipe(Effect.provide(hostServices), Effect.scoped))

it.effect("passes a PostgreSQL URL to the native database verbatim from the runtime layer", () =>
  Effect.gen(function*() {
    const root = mkdtempSync(join(tmpdir(), "flows-postgres-native-layer-"))
    const { native, opened } = recordingNative()
    try {
      const layer = native.layer(
        {
          filename: url,
          workspaceRoot: root,
          owner: { hostId: "postgres-location" },
          isAlive: () => Effect.succeed(false)
        },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.empty
      ).pipe(Layer.provide(Layer.mergeAll(isolatedFileSystem, Jj.layerNoop({}))))
      expect(yield* workspaceRoot.pipe(Effect.provide(layer))).toBe(root)
      expect(opened).toEqual([url])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }).pipe(Effect.provide(hostServices), Effect.scoped))
