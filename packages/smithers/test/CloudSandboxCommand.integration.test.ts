import { NodeServices } from "@effect/platform-node"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as CloudSandbox from "@smthrs/cli/CloudSandbox"
import { Control } from "@smthrs/control"
import { Action, Flow } from "@smthrs/flow"
import * as GuardedSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Sandbox } from "@smthrs/sandbox"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import { Effect, FileSystem, Layer, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

class InstallFailure extends Schema.TaggedError<InstallFailure>()("fixture/CloudInstallFailure", {
  cause: Schema.Union([ProviderError, Schema.Defect()])
}) {}

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("CloudSandbox guarded command transport", () => {
  it("runs an installer larger than the default permission bound and preserves environment and credential stdin", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-command-")))
    roots.push(root)
    const ssh = join(root, "ssh")
    // Local SSH stand-in performs SSH's second shell parse. The control API is
    // fake because provisioning a remote VM is outside this transport regression.
    writeFileSync(ssh, "#!/bin/sh\nexec /bin/sh -c \"$*\"\n", { mode: 0o755 })
    const methods: Array<string> = []
    const resources: Array<string> = []
    let grants = 0
    const api: CloudSandbox.WorkspaceApi = {
      request: async (method) => {
        methods.push(method)
        return method === "DELETE" ? null : { id: "ws-guarded", status: "running" }
      },
      sshPrefix: async () => {
        grants++
        return [ssh]
      }
    }
    const host = GuardedSpawner.layer.pipe(
      // The trusted local SSH fixture exercises permission checks, not OS isolation.
      Layer.provide(ProcessConfinement.layerNoop),
      Layer.provide(GrantStore.layer({
        attended: false,
        rules: [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" }) })]
      })),
      Layer.provide(Workspace.layer(root)),
      Layer.provide(NodeServices.layer)
    )
    const installer = `# installer-script-sentinel\n${
      "# install step 'quoted' $HOME ; ".repeat(300)
    }\nprintf '%s' installed`
    expect(installer.length).toBeGreaterThan(4096)
    const credentials = new Uint8Array([0, 255, 10, 13, 128, 39, 36, 92, 0, 65])
    const secret = "credential-env-sentinel ' $HOME;\nsecond line"
    await Effect.runPromise(
      Effect.gen(function*() {
        const guarded = yield* ChildProcessSpawner
        const transport = makeSpawner((command) => {
          resources.push(CommandLine.render(command))
          return guarded.spawn(command)
        })
        const provider = CloudSandbox.make({ spawner: transport, repository: "acme/repo", api, workdir: root })
        yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          const fs = yield* FileSystem.FileSystem
          expect(yield* guest.string(ChildProcess.make("/bin/sh", ["-c", installer]))).toBe("installed")
          expect(yield* guest.string(ChildProcess.make("/bin/sh", ["-c", "printf %s \"$HOME\""]))).toBe(
            "/home/developer"
          )
          expect(
            yield* guest.string(ChildProcess.make("/bin/sh", ["-c", "printf \"%s|%s\" \"$HOME\" \"$TOKEN\""], {
              env: { HOME: "/explicit/home", TOKEN: secret },
              extendEnv: false
            }))
          ).toBe(`/explicit/home|${secret}`)
          const handle = yield* guest.spawn(ChildProcess.make("/bin/cat", [], {
            env: { TOKEN: secret },
            stdin: Stream.make(credentials.slice(0, 3), new Uint8Array(), credentials.slice(3, 7), credentials.slice(7))
          }))
          const chunks = yield* Stream.runCollect(handle.stdout)
          expect(Buffer.concat(Array.from(chunks, (part) => Buffer.from(part)))).toEqual(Buffer.from(credentials))
          expect(yield* handle.exitCode).toBe(0)
          yield* fs.writeFile(join(root, "binary"), credentials)
          expect(yield* fs.readFile(join(root, "binary"))).toEqual(credentials)
        }).pipe(Effect.provide(Sandbox.layerHost(provider, { session: "guarded-installer" })), Effect.scoped)
      }).pipe(Effect.provide(host))
    )
    expect(methods).toEqual(["POST", "GET", "DELETE"])
    expect(grants).toBeGreaterThan(4)
    expect(resources.every((resource) => resource.length <= GrantStore.maximumCapabilityResourceLength)).toBe(true)
    for (const resource of resources) {
      expect(resource).not.toContain("installer-script-sentinel")
      expect(resource).not.toContain(secret)
      expect(resource).not.toContain(Buffer.from(credentials).toString("base64"))
    }
  })

  it.each([
    { mode: "local", live: false, localFiles: true },
    { mode: "local proc-only", live: false, localFiles: false },
    ...(process.env.SMITHERS_CLOUD_SANDBOX_SMOKE === "1" ? [{ mode: "live", live: true, localFiles: false }] : [])
  ])("runs a $mode Cloud installer module through the durable host", async ({ live, localFiles }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cloud-module-command-")))
    roots.push(root)
    const ssh = join(root, "ssh")
    const workdir = join(root, "guest")
    const outsideWrite = join(root, "undeclared-write")
    // A real VM has its own /tmp. This local SSH fixture maps only the guest
    // provider's PID tree into its owned guest directory, leaving the framed
    // installer and binary stdin intact and retaining real host confinement.
    writeFileSync(
      ssh,
      [
        "#!/bin/sh",
        "IFS= read -r frame || exit 1",
        `mapped=$(printf '%s' "$frame" | base64 -d | sed 's|/tmp/.smthrs-sbx|${workdir}/pids|g' | base64 | tr -d '\\n')`,
        "{ printf \"%s\\n\" \"$mapped\"; cat; } | /bin/sh -c \"$*\"",
        ""
      ].join("\n"),
      { mode: 0o755 }
    )
    const repository = live ? process.env.SMITHERS_CLOUD_SANDBOX_REPOSITORY : "acme/repo"
    if (!repository) throw new Error("SMITHERS_CLOUD_SANDBOX_REPOSITORY is required for the live Cloud smoke")
    const methods: Array<string> = []
    const api: CloudSandbox.WorkspaceApi = {
      request: async (method) => {
        methods.push(method)
        return method === "DELETE" ? null : { id: "ws-module", status: "running" }
      },
      sshPrefix: async () => [ssh]
    }
    const capabilities = localFiles
      ? ["proc:spawn:*", `fs:read:${root}/**`, `fs:write:${workdir}`, `fs:write:${workdir}/**`]
      : ["proc:spawn:*"]
    const reads = localFiles ? [root] : []
    const writes = localFiles ? [workdir] : []
    const Install = Action.make("fixture/CloudInstall", { payload: {}, success: Schema.String, error: InstallFailure })
    const definition = {
      description: "Install in the acquired workspace.",
      payload: {},
      success: Schema.String,
      error: InstallFailure,
      capabilities,
      effects: {
        reads,
        writes,
        mode: "expected" as const,
        onConflict: "serialize" as const,
        tier: "irreversible" as const
      },
      body: Node.capture({ action: Install.name }, () => Install.call({}))
    }
    const flow = Flow.make("cloud-install", definition)
    // Registry source discovery and the durable engine are real. A deterministic
    // module loader supplies the exported layer; the SSH control plane stays fake.
    mkdirSync(join(root, "flows", "cloud-install"), { recursive: true })
    writeFileSync(
      join(root, "flows", "cloud-install", "flow.ts"),
      `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("cloud-install", {
  description: "Install in the acquired workspace.", payload: {}, success: Schema.String,
  capabilities: ${JSON.stringify(capabilities)},
  effects: { reads: ${JSON.stringify(reads)}, writes: ${
        JSON.stringify(writes)
      }, mode: "expected", onConflict: "serialize", tier: "irreversible" },
  body: Node.capture({}, () => Node.succeed("unused"))
})
`
    )
    const observed: Array<string> = []
    const implementation = Install.toLayer(() =>
      Effect.gen(function*() {
        const local = yield* ChildProcessSpawner
        const provider = CloudSandbox.make({
          spawner: local,
          repository,
          ...(live ? { readyTimeout: "15 minutes" } : { api, workdir })
        })
        const result = yield* Effect.gen(function*() {
          const guest = yield* ChildProcessSpawner
          expect(yield* guest.string(ChildProcess.make("/bin/sh", ["-c", "printf %s \"$HOME\""]))).toBe(
            "/home/developer"
          )
          const script = `# durable-module-installer\n${
            "# install package 'x' ; ".repeat(300)
          }\nprintf 'module-installed|%s|%s|' "$HOME" "$TOKEN"; base64`
          expect(script.length).toBeGreaterThan(4096)
          if (!live) {
            // The declared guest write tree does not open its parent directory.
            expect(
              yield* guest.string(ChildProcess.make("/bin/sh", [
                "-c",
                `(printf escaped > ${CommandLine.quote(outsideWrite)}) 2>/dev/null && printf escaped || printf confined`
              ]))
            ).toBe("confined")
          }
          const dummy = new Uint8Array([0, 255, 10, 128, 39, 0])
          return yield* guest.string(ChildProcess.make("/bin/sh", ["-c", script], {
            env: { HOME: "/explicit/module-home", TOKEN: "module-dummy-token" },
            extendEnv: false,
            stdin: Stream.make(dummy.slice(0, 2), dummy.slice(2, 5), dummy.slice(5))
          }))
        }).pipe(
          Effect.provide(Sandbox.layerHost(provider, { session: `durable-cloud-install:${root}` })),
          Effect.scoped
        )
        observed.push(result)
        return result
      }).pipe(Effect.mapError((cause) => new InstallFailure({ cause })))
    )
    const modules = Executable.layer({
      delegates: [],
      load: () => Effect.succeed({ default: flow, layer: implementation })
    }).pipe(Layer.orDie)
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "cloud-install", input: {} })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "durable-cloud-install"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected admission")
        return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
          Stream.runCollect,
          Effect.timeout(live ? "15 minutes" : "30 seconds")
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerControl({ root, evaluator: ScriptedJudge.layerAll }, registry, engine, modules)
        ),
        Effect.scoped
      )
    )
    if (!live) expect(existsSync(outsideWrite)).toBe(false)
    if (!live && !localFiles) {
      expect(events.at(-1)?.kind).toBe("control.run.failed")
      expect(observed).toEqual([])
      expect(JSON.stringify(events)).toContain("ProviderError")
      expect(JSON.stringify(events)).toContain("unavailable")
      expect(JSON.stringify(events)).toMatch(/Operation not permitted|Permission denied/)
      expect(existsSync(workdir)).toBe(false)
      expect(JSON.stringify(events)).not.toContain("Expected JSON value")
      expect(methods).toEqual(["POST", "GET", "DELETE"])
      return
    }
    expect(events.at(-1)?.kind).toBe("control.run.completed")
    expect(observed).toEqual(["module-installed|/explicit/module-home|module-dummy-token|AP8KgCcA\n"])
    if (!live) expect(methods).toEqual(["POST", "GET", "DELETE"])
  }, 1_200_000)
})
