/**
 * The Node composition root: argument and environment configuration, the
 * durable local stack the `smithers` process actually assembles, the output layer
 * that transfers a rendered status to the process exit code, and the server
 * binds that must stay confined to loopback.
 */
import { NodeServices } from "@effect/platform-node"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import type * as Undici from "@effect/platform-node/Undici"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Control as ControlService } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Path from "@smthrs/kernel/Path"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Registry } from "@smthrs/registry"
import * as Container from "@smthrs/std/Container"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option } from "effect"
import { HttpServer } from "effect/unstable/http"
import { existsSync, fstatSync, readdirSync, statSync } from "node:fs"
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as CliError from "../src/CliError.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"

let root = ""

const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"

const openHandles = (filename: string): number => {
  const target = statSync(filename)
  let open = 0
  for (const entry of readdirSync(descriptorDirectory)) {
    try {
      const descriptor = fstatSync(Number(entry))
      if (descriptor.dev === target.dev && descriptor.ino === target.ino) open += 1
    } catch {
      // The descriptor listing can include its own already-closed handle.
      // A handle gone before inspection cannot hold this database open.
    }
  }
  return open
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-cli-composition-"))
})

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true })
})

/**
 * `makeConfig` also resolves the two roots every invocation needs: the rc.0
 * project root the durable layers are built over, and the 0.x root `migrate`
 * converts. These cases are about the flag and environment ladder, so each one
 * pins the roots separately and compares the rest.
 */
const configuration = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
) => {
  const { login: _login, migrationRoot: _migrationRoot, root: _root, ...rest } = NodeControl.makeConfig(
    args,
    environment,
    "/work"
  )
  return rest
}

describe("NodeControl.makeConfig", () => {
  it("resolves nothing from an empty invocation and an empty environment", () => {
    expect(configuration([], {})).toEqual({ remote: undefined, credential: undefined, mcpServers: undefined })
  })

  it("resolves the project root from --root, against the invocation directory", () => {
    expect(NodeControl.makeConfig(["--root", "project"], {}, "/work").root).toBe(join("/work", "project"))
    expect(NodeControl.makeConfig(["--root", "/elsewhere"], {}, "/work").root).toBe("/elsewhere")
  })

  it("resolves the migration root from the same --root, and never from an rc.0 ancestor", () => {
    expect(NodeControl.makeConfig(["--root", "/elsewhere"], {}, "/work").migrationRoot).toBe("/elsewhere")
    // No 0.x marker anywhere above `/work`, so the walk falls back to the
    // invocation directory instead of climbing to whatever `.flows/` it finds.
    expect(NodeControl.makeConfig([], {}, "/work").migrationRoot).toBe("/work")
  })

  it("falls back to the environment only when the flag is absent", () => {
    expect(configuration([], { SMITHERS_REMOTE: "https://env.example.test" })).toEqual({
      remote: "https://env.example.test",
      credential: undefined,
      mcpServers: undefined
    })
    expect(
      configuration(["--remote", "https://flag.example.test"], { SMITHERS_REMOTE: "https://env.example.test" })
    ).toEqual({ remote: "https://flag.example.test", credential: undefined, mcpServers: undefined })
  })

  it("treats `--remote` as the last argument as no value at all", () => {
    // There is no argument after it, so the flag contributes nothing and the
    // environment fallback still applies.
    expect(configuration(["--remote"], { SMITHERS_REMOTE: "https://env.example.test" })).toEqual({
      remote: "https://env.example.test",
      credential: undefined,
      mcpServers: undefined
    })
  })

  it("refuses an explicitly empty or relative remote before building transports", () => {
    expect(() => configuration(["--remote="], { SMITHERS_REMOTE: "https://env.example.test" }))
      .toThrow("--remote must be an http:// or https:// URL; got \"\"")
    expect(() => configuration(["--remote", "nota"], {}))
      .toThrow("--remote must be an http:// or https:// URL; got \"nota\"")
  })

  it("takes the first occurrence when a flag is repeated", () => {
    expect(configuration(["--remote", "https://first.test", "--remote", "https://second.test"], {}))
      .toEqual({ remote: "https://first.test", credential: undefined, mcpServers: undefined })
  })

  it("refuses a following flag as an invalid remote before opening any layer", () => {
    expect(() => configuration(["--remote", "--credential", "secret"], {}))
      .toThrow("--remote must be an http:// or https:// URL; got \"--credential\"")
  })

  it("does not resolve credentials for local execution", () => {
    expect(configuration([], { SMITHERS_TOKEN: "secret" })).toEqual({
      remote: undefined,
      credential: undefined,
      mcpServers: undefined
    })
  })

  it("does not treat a longer flag with the same prefix as a match", () => {
    expect(configuration(["--remotely", "x"], {})).toEqual({
      remote: undefined,
      credential: undefined,
      mcpServers: undefined
    })
  })

  it("reads the shared Smithers token for remote calls", () => {
    expect(configuration(["--remote=https://api.test"], { SMITHERS_TOKEN: "from-environment" }).credential).toBe(
      "from-environment"
    )
  })

  it("reads the MCP servers named by --mcp-config, and by the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-cli-mcp-"))
    try {
      const file = join(directory, "servers.json")
      const entry = { server: "docs", command: "docs-mcp", args: ["--stdio"], cwd: directory }
      await writeFile(file, JSON.stringify([entry]))

      expect(NodeControl.makeConfig(["--mcp-config", file], {}, "/work").mcpServers).toEqual([entry])
      expect(NodeControl.makeConfig([], { SMITHERS_MCP_CONFIG: file }, "/work").mcpServers).toEqual([entry])
      // A typo'd config must not look like "no MCP servers configured".
      const malformed = join(directory, "malformed.json")
      await writeFile(malformed, JSON.stringify([{ server: "docs" }]))
      expect(() => NodeControl.makeConfig(["--mcp-config", malformed], {}, "/work")).toThrow(malformed)
      const absent = join(directory, "absent.json")
      expect(() => NodeControl.makeConfig(["--mcp-config", absent], {}, "/work"))
        .toThrow(`--mcp-config ${absent}: file not found`)

      // Each way the file can be wrong names the file and says which way, so
      // an operator fixes the config instead of reading an ENOENT or a bare
      // SyntaxError with a byte offset in it.
      const unparseable = join(directory, "unparseable.json")
      await writeFile(unparseable, "{ not json")
      expect(() => NodeControl.makeConfig(["--mcp-config", unparseable], {}, "/work"))
        .toThrow(`--mcp-config ${unparseable} is not valid JSON`)

      const notAnArray = join(directory, "object.json")
      await writeFile(notAnArray, JSON.stringify({ server: "docs", command: "docs-mcp" }))
      expect(() => NodeControl.makeConfig(["--mcp-config", notAnArray], {}, "/work"))
        .toThrow("must contain a JSON array of MCP server entries")

      const scalarEntry = join(directory, "scalars.json")
      await writeFile(scalarEntry, JSON.stringify(["docs-mcp", null]))
      expect(() => NodeControl.makeConfig(["--mcp-config", scalarEntry], {}, "/work"))
        .toThrow("must contain a JSON array of MCP server entries")

      // A directory exists, so the missing-file refusal does not apply and the
      // read is what fails.
      expect(() => NodeControl.makeConfig(["--mcp-config", directory], {}, "/work"))
        .toThrow(`--mcp-config ${directory} could not be read (EISDIR)`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("preserves MCP connection limits and projection options from the config file", async () => {
    const file = join(root, "projected-servers.json")
    const entry = {
      server: "docs",
      command: "docs-mcp",
      args: ["--stdio"],
      env: { TOKEN: "test-token" },
      handshakeTimeoutMs: 1,
      requestTimeoutMs: 2,
      queueCapacity: 3,
      maxFrameBytes: 4,
      maxOutboundFrameBytes: 5,
      maxStderrBytes: 6,
      maxTools: 7,
      maxToolNameBytes: 8,
      maxCatalogPages: 9,
      include: ["read", "delete"],
      exclude: ["delete"],
      namePrefix: "docs"
    }
    await writeFile(file, JSON.stringify([entry]))
    expect(NodeControl.makeConfig(["--mcp-config", file], {}, "/work").mcpServers).toEqual([entry])
    expect(NodeControl.makeConfig([], { SMITHERS_MCP_CONFIG: file }, "/work").mcpServers).toEqual([entry])
  })

  it.each([
    { maxTools: 0 },
    { maxOutboundFrameBytes: 0 },
    { maxStderrBytes: -1 },
    { maxToolNameBytes: 1.5 },
    { maxCatalogPages: 0 },
    { server: "" },
    { command: "" },
    { cwd: "" },
    { env: ["token"] }
  ])("rejects invalid persisted MCP options at flag parse time: %o", async (options) => {
    const file = join(root, "invalid-server.json")
    await writeFile(file, JSON.stringify([{ server: "docs", command: "docs-mcp", args: [], ...options }]))
    const error = new CliError.UsageError({
      message: `--mcp-config ${file} must contain a JSON array of MCP server entries`
    })
    expect(() => NodeControl.makeConfig(["--mcp-config", file], {}, "/work")).toThrow(error)
    expect(() => NodeControl.makeConfig([], { SMITHERS_MCP_CONFIG: file }, "/work")).toThrow(error)
  })

  it("refuses a remote whose scheme is not http or https", () => {
    // The transports this configures are HTTP and WebSocket-over-HTTP, so a
    // scheme neither can dial is a usage error at parse time rather than a
    // connection failure on the first command.
    for (const remote of ["ftp://control.test", "file:///control", "ws://control.test"]) {
      expect(() => NodeControl.makeConfig(["--remote", remote], {}, "/work"))
        .toThrow(`--remote must be an http:// or https:// URL; got ${JSON.stringify(remote)}`)
    }
  })
})

describe("NodeControl.config", () => {
  it("reads the current process arguments and environment", () => {
    const argv = process.argv
    const previous = process.env.SMITHERS_REMOTE
    const previousToken = process.env.SMITHERS_TOKEN
    try {
      process.argv = [process.execPath, "smthrs"]
      process.env.SMITHERS_TOKEN = "shared-token"
      process.env.SMITHERS_REMOTE = "https://from-environment.test"
      const resolved = Effect.runSync(NodeControl.config)
      expect(resolved.remote).toBe("https://from-environment.test")
      expect(resolved.credential).toBe("shared-token")
      expect(typeof resolved.root).toBe("string")
    } finally {
      process.argv = argv
      if (previousToken === undefined) delete process.env.SMITHERS_TOKEN
      else process.env.SMITHERS_TOKEN = previousToken
      if (previous === undefined) delete process.env.SMITHERS_REMOTE
      else process.env.SMITHERS_REMOTE = previous
    }
  })

  it("preserves a configuration usage error as a typed failure", async () => {
    const argv = process.argv
    try {
      process.argv = [process.execPath, "smthrs", "--remote", "nota", "ps"]
      const exit = await Effect.runPromise(Effect.exit(NodeControl.config))

      // The entrypoint reports this one and exits 2. Letting the raw
      // `TypeError: Invalid URL` out of the layer builder instead told an
      // operator nothing about which flag they mistyped.
      expect(exit._tag).toBe("Failure")
      const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
      expect(failure).toBeInstanceOf(CliError.UsageError)
      expect((failure as CliError.UsageError).message).toBe(
        "--remote must be an http:// or https:// URL; got \"nota\""
      )
    } finally {
      process.argv = argv
    }
  })
})

describe("NodeControl database locations", () => {
  it("keeps the control plane and the execution engine in separate files", () => {
    expect(NodeControl.databasePath("/work")).toBe(join("/work", ".flows", "control.db"))
    expect(NodeControl.executionDatabasePath("/work")).toBe(join("/work", ".flows", "engine.db"))
    expect(NodeControl.databasePath("/work")).not.toBe(NodeControl.executionDatabasePath("/work"))
  })
})

describe("NodeControl.checkpointStore", () => {
  it("pins on the workspace, under both the names a container gives it", () => {
    // One directory, two names. The host checks a checkpoint out under the
    // workspace and the container reaches the same directory through the mount
    // it already has, which is why the scratch lives inside the workspace at
    // all, and why the store needs both paths.
    expect(NodeControl.checkpointStore({ SMITHERS_TEST_CWD: "/testbed" }, "/work/repo")).toEqual({
      root: "/work/repo",
      cwd: "/testbed"
    })
  })

  it("still pins for a host that runs its own tree directly", () => {
    // No container, so the two names of the one directory are the same name.
    // A host that declares nothing still gets checkpoints; it is the workspace
    // root that decides, not the container.
    for (const environment of [{}, { SMITHERS_TEST_CWD: "" }, { SMITHERS_TEST_CWD: "  " }]) {
      expect(NodeControl.checkpointStore(environment, "/work/repo")).toEqual({ root: "/work/repo" })
    }
  })
})

describe("NodeControl.testRunner", () => {
  it("declares no runner until the host names a command", () => {
    // A `test` flow bound over a declaration that can only refuse is worse than
    // no flow at all: the catalog then advertises a call whose every answer is
    // "not configured", and a run spends a frame finding that out.
    expect(NodeControl.testRunner({}, "/work")).toBeUndefined()
    expect(NodeControl.testRunner({ SMITHERS_TEST_COMMAND: "   " }, "/work")).toBeUndefined()
  })

  it("reads the runner, its container and its two directories off the environment", () => {
    // The container path and the host path are the same tree under two names:
    // the runner runs at `cwd` inside the container, and a baseline worktree is
    // checked out from `root` on the host.
    expect(
      NodeControl.testRunner(
        {
          SMITHERS_TEST_COMMAND: "./tests/runtests.py --settings=test_sqlite",
          SMITHERS_TEST_CONTAINER: "swebench-1",
          SMITHERS_TEST_CWD: "/testbed",
          SMITHERS_TEST_TIMEOUT_MS: "600000"
        },
        "/work/repo"
      )
    ).toEqual({
      command: "./tests/runtests.py --settings=test_sqlite",
      container: "swebench-1",
      cwd: "/testbed",
      root: "/work/repo",
      timeoutMs: 600_000
    })
  })

  it("defaults the runner's directory to the repository and drops an unusable timeout", () => {
    expect(NodeControl.testRunner({ SMITHERS_TEST_COMMAND: "pytest -q" }, "/work/repo")).toEqual({
      command: "pytest -q",
      cwd: "/work/repo",
      root: "/work/repo"
    })
    for (const timeout of ["", "soon", "0", "-1"]) {
      expect(
        NodeControl.testRunner({ SMITHERS_TEST_COMMAND: "pytest -q", SMITHERS_TEST_TIMEOUT_MS: timeout }, "/work/repo")
      ).not.toHaveProperty("timeoutMs")
    }
  })

  it("declares the checkout a resumed fork executes in, not the project it forked from", () => {
    // A fork runs in its own worktree under the project. `TestRun` executes at
    // `cwd` and checks the pristine baseline out of `root`, so both have to
    // name that worktree; the project's tree holds the files the forked agent
    // never touched.
    expect(
      NodeControl.testRunner({ SMITHERS_TEST_COMMAND: "pytest -q" }, "/work/repo", "/work/repo/.flows/forks/child")
    ).toEqual({
      command: "pytest -q",
      cwd: "/work/repo/.flows/forks/child",
      root: "/work/repo/.flows/forks/child"
    })
  })

  it("names the fork's checkout under the mount the container knows the project by", () => {
    // `SMITHERS_TEST_CWD` names the project root inside the container, so a
    // directory inside the project is reachable at the same relative path
    // under it. `root` stays a host path: that is where the baseline worktree
    // is checked out.
    expect(
      NodeControl.testRunner(
        {
          SMITHERS_TEST_COMMAND: "pytest -q",
          SMITHERS_TEST_CONTAINER: "swebench-1",
          SMITHERS_TEST_CWD: "/testbed/"
        },
        "/work/repo",
        "/work/repo/.flows/forks/child"
      )
    ).toEqual({
      command: "pytest -q",
      container: "swebench-1",
      cwd: "/testbed/.flows/forks/child",
      root: "/work/repo/.flows/forks/child"
    })
  })

  it("declares no runner for a workspace the declared mount cannot name", () => {
    // A workspace outside the project has no relative path under the mount, so
    // there is no honest `cwd` to declare. Refusing the flow costs a run one
    // "no runner" answer; declaring one costs it a suite that graded another
    // tree and reported the result as its own.
    expect(
      NodeControl.testRunner(
        { SMITHERS_TEST_COMMAND: "pytest -q", SMITHERS_TEST_CWD: "/testbed" },
        "/work/repo",
        "/elsewhere/child"
      )
    ).toBeUndefined()
  })

  it("offers the `test` flow to a run exactly when a runner was declared", async () => {
    // The r91 finding about this flow is not that it was wrong, it is that no
    // composition offered it: 45 graded runs, zero `test` calls, while the cell
    // contract's doctrine assumed the call existed. Everything else about the
    // flow was already covered, so this is the assertion that was missing:
    // the declaration decides, and what it decides is what `ctx.flows` lists.
    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const services = yield* Effect.context<
          Evaluator.Evaluator | KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
        >()
        const container = Container.makeCommand()
        expect(NodeControl.testFlows(services, container, undefined)).toEqual([])
        const offered = NodeControl.testFlows(
          services,
          container,
          NodeControl.testRunner(
            { SMITHERS_TEST_COMMAND: "pytest -q", SMITHERS_TEST_CONTAINER: "swebench-1" },
            "/work/repo"
          )
        )
        const bound = yield* Effect.forEach(offered, (source) => source.bindings())
        return bound.flat().map((binding) => binding.descriptor.name)
      }).pipe(
        // The judge the flow attributes a non-zero exit with, built the one
        // classifier outage fixture. This case only inspects a flow catalog;
        // no agent host or completion is started.
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Evaluator.layerUnavailable()
          )
        ),
        Effect.orDie
      ) as Effect.Effect<ReadonlyArray<string>>
    )
    expect(names).toEqual(["test"])
  })
})

describe("NodeControl.layerRegistry failures", () => {
  it("dies on a source root that exists but cannot be scanned", async () => {
    const broken = await mkdtemp(join(tmpdir(), "flows-cli-broken-"))
    try {
      // A file where the `flows/` directory belongs is a real misconfiguration,
      // and it must not be mistaken for "this project has no flows".
      await writeFile(join(broken, "flows"), "not a directory")
      const exit = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(Registry.Registry, (registry) => registry.list()).pipe(
            Effect.provide(NodeControl.layerRegistry(broken)),
            Effect.scoped
          )
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(String(Cause.squash(exit.cause))).toContain("is not a directory")
      }
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.engineDurable with a registry", () => {
  it("knows every discovered project flow as well as the reserved catalog", async () => {
    const project = await mkdtemp(join(tmpdir(), "flows-cli-discovered-"))
    try {
      await mkdir(join(project, "flows", "review"), { recursive: true })
      await writeFile(
        join(project, "flows", "review", "SKILL.md"),
        ["---", "description: Reviews a proposed change.", "---", "", "# Review", ""].join("\n")
      )
      const registry = NodeControl.layerRegistry(project)
      const engine = NodeControl.engineDurable(project, registry)
      const planned = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const discovered = yield* control.plan({ flowId: "review", input: {} })
          const reserved = yield* control.plan({ flowId: "system/test", input: {} })
          return { discovered: discovered.flowId, reserved: reserved.flowId }
        }).pipe(
          Effect.provide(
            Application.layer({}, registry, engine) as Layer.Layer<ControlService.Control>
          ),
          Effect.scoped,
          Effect.orDie
        )
      )

      // Without the registry the durable runtime knew only the reserved
      // catalog, so a project flow planned as `FlowNotFound`.
      expect(planned).toEqual({ discovered: "review", reserved: "system/test" })
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.layerObserver", () => {
  it("measures the workspace on the host platform, not through the kernel's guard", async () => {
    const observed = await mkdtemp(join(tmpdir(), "flows-cli-observer-"))
    try {
      await writeFile(join(observed, "a.py"), "one")
      // A hard link is the discriminator: the kernel refuses a hard-linked
      // regular file outright, so a guarded observer measures neither name.
      // The measurement wants both: an edit through either moves the tree,
      // and the walk that gets them is the one that never opens a file, never
      // follows a link, and never leaves the root it was given.
      await link(join(observed, "a.py"), join(observed, "b.py"))

      const measurement = await Effect.runPromise(
        Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
          Effect.provide(NodeControl.layerObserver(observed)),
          Effect.scoped,
          Effect.orDie
        )
      )

      expect(measurement.paths).toBe(2)
      expect(measurement.complete).toBe(true)

      // The discriminator is real rather than assumed: the same `stat` through
      // the guarded platform is refused, and finding that out costs one helper
      // process per path.
      const refused = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(join(observed, "a.py"))).pipe(
            Effect.provide(NodeControl.layerGuardedPlatform(observed)),
            Effect.scoped
          )
        )
      )

      expect(Exit.isFailure(refused)).toBe(true)
    } finally {
      await rm(observed, { recursive: true, force: true })
    }
  })

  it("leaves the guarded filesystem in place for everything composed beside it", async () => {
    const observed = await mkdtemp(join(tmpdir(), "flows-cli-observer-beside-"))
    try {
      await writeFile(join(observed, "a.py"), "one")
      await link(join(observed, "a.py"), join(observed, "b.py"))

      // `layerExecutor` provides the observer in the same array as the guarded
      // platform, and `StandardFlows.filesystem` then reads `FileSystem` out of
      // that context. The observer runs on the host platform, so this is the
      // question the seam turns on: does the host `FileSystem` it was built
      // from escape into the context the agent-reachable flows resolve from?
      // It must not. That would unguard every tool that opens a file. The hard
      // link is the discriminator again, in the opposite direction.
      const beside = Layer.mergeAll(
        NodeControl.layerGuardedPlatform(observed),
        NodeControl.layerObserver(observed)
      )
      const [measurement, stat] = await Effect.runPromise(
        Effect.all([
          Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(Effect.orDie),
          Effect.exit(Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(join(observed, "a.py"))))
        ]).pipe(Effect.provide(beside), Effect.scoped)
      )

      expect(measurement.paths).toBe(2)
      expect(Exit.isFailure(stat)).toBe(true)
    } finally {
      await rm(observed, { recursive: true, force: true })
    }
  })

  it("asks the grant store the caller supplied, not a default one", async () => {
    const observed = await mkdtemp(join(tmpdir(), "flows-cli-observer-grants-"))
    try {
      await writeFile(join(observed, "a.py"), "one")

      // `layerExecutor` builds one grant store and hands it to both the kernel
      // filesystem and the kernel spawner. A `layerGuardedPlatform` that pinned
      // its own store would leave a composition whose shell is authorized and
      // whose filesystem is not, which no type would catch. A real store with
      // no rules and nobody to ask authorizes nothing, so the same read that
      // the default allow-all store permits is refused when this one is passed
      // instead.
      const read = (grants?: Layer.Layer<GrantStore.GrantStore>) =>
        Effect.runPromise(
          Effect.exit(
            Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(join(observed, "a.py")))
              .pipe(
                Effect.provide(NodeControl.layerGuardedPlatform(observed, grants)),
                Effect.scoped
              )
          )
        )
      const ruleless = Layer.orDie(GrantStore.layer({ attended: false, rules: [] })).pipe(
        Layer.provide(Workspace.layer(observed))
      )

      expect(Exit.isSuccess(await read())).toBe(true)
      expect(Exit.isFailure(await read(ruleless))).toBe(true)
    } finally {
      await rm(observed, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.layerOutput", () => {
  it("transfers each rendered status to the process exit code", async () => {
    const previous = process.exitCode
    try {
      const codes = await Effect.runPromise(
        Effect.gen(function*() {
          const output = yield* Output.Output
          const parked = yield* output.render({
            _tag: "Parked",
            receiptId: "receipt-1",
            planId: "plan-1",
            status: "waiting-approval"
          }, "json")
          const parkedCode = process.exitCode
          const accepted = yield* output.render({ _tag: "Accepted" }, "human")
          return { parked, parkedCode, accepted, acceptedCode: process.exitCode }
        }).pipe(Effect.provide(NodeControl.layerOutput))
      )

      // The rendered text is unchanged by the transfer, and the last render
      // wins the process status.
      expect(codes.parked.text).toBe(
        "{\"_tag\":\"Parked\",\"planId\":\"plan-1\",\"receiptId\":\"receipt-1\",\"status\":\"waiting-approval\"}"
      )
      expect(codes.parkedCode).toBe(3)
      expect(codes.accepted.text).toBe("{\n  \"_tag\": \"Accepted\"\n}")
      expect(codes.acceptedCode).toBe(0)
    } finally {
      process.exitCode = previous
    }
  })
})

describe("NodeControl.rebuildableTransport", () => {
  it("serializes concurrent replacement and closes a client only after its successor is acquired", async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const secondEntered = yield* Deferred.make<void>()
        const releaseSecond = yield* Deferred.make<void>()
        const thirdEntered = yield* Deferred.make<void>()
        const releaseThird = yield* Deferred.make<void>()
        const closed: Array<number> = []
        let acquired = 0
        const acquire = Effect.gen(function*() {
          const id = ++acquired
          yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(id)))
          if (id === 2) {
            yield* Deferred.succeed(secondEntered, undefined)
            yield* Deferred.await(releaseSecond)
          }
          if (id === 3) {
            yield* Deferred.succeed(thirdEntered, undefined)
            yield* Deferred.await(releaseThird)
          }
          return { request: () => Promise.reject(new Error("unused dispatcher")) } as unknown as Undici.Dispatcher
        })
        const transport = yield* NodeControl.rebuildableTransport(acquire)
        const first = yield* Effect.forkChild(transport.rebuild, { startImmediately: true })
        yield* Deferred.await(secondEntered)
        const second = yield* Effect.forkChild(transport.rebuild, { startImmediately: true })

        expect(Option.isSome(yield* Deferred.poll(thirdEntered))).toBe(false)
        expect(closed).toEqual([])

        yield* Deferred.succeed(releaseSecond, undefined)
        yield* Fiber.join(first)
        yield* Deferred.await(thirdEntered)
        expect(closed).toEqual([1])

        yield* Deferred.succeed(releaseThird, undefined)
        yield* Fiber.join(second)
        return { acquired, closed: [...closed] }
      }))
    )

    expect(observed).toEqual({ acquired: 3, closed: [1, 2] })
  })
})

describe("NodeControl memory", () => {
  it("refuses a remote memory verb instead of writing where nothing reads", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        return yield* Effect.flip(
          store.putFact({ namespace: { kind: "user", id: "cli" }, key: "k", value: 1, provenance: {} })
        )
      }).pipe(Effect.provide(NodeControl.layerMemoryRemote))
    )

    // The control plane owns memory. Building the local store for a `--remote`
    // invocation would open a `.flows/control.db` beside the operator's shell
    // and record a fact the server never reads, which looks like it worked.
    expect(failure.code).toBe("store")
    expect(failure.message).toContain("--remote")
    expect(failure.message).toContain(".flows/control.db")
  })

  it("names the verb the operator typed in every one of the four refusals", async () => {
    // A refusal that named the store rather than the verb sent an operator
    // looking for a `memory` subcommand that did not exist. Each of the four
    // reads and writes the CLI exposes has to say which one it was.
    const namesTheVerb = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const namespace = { kind: "user", id: "cli" } as const
        const messages = [
          yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, provenance: {} })),
          yield* Effect.flip(store.getFact({ namespace, key: "k" })),
          yield* Effect.flip(store.deleteFact({ namespace, key: "k" })),
          yield* Effect.flip(store.listFacts({ namespace }))
        ]
        return messages.map((failure) => failure.message.slice(0, failure.message.indexOf(" is not available")))
      }).pipe(Effect.provide(NodeControl.layerMemoryRemote))
    )

    expect(namesTheVerb).toEqual(["memory set", "memory get", "memory rm", "memory list"])
  })

  it("reads and writes the control database for a local invocation", async () => {
    const project = await mkdtemp(join(tmpdir(), "flows-cli-memory-"))
    try {
      const written = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* MemoryStore.MemoryStore
          yield* store.putFact({ namespace: { kind: "user", id: "cli" }, key: "seat", value: "sol", provenance: {} })
          return yield* store.getFact({ namespace: { kind: "user", id: "cli" }, key: "seat" })
        }).pipe(Effect.provide(NodeControl.layerMemory(project)), Effect.scoped, Effect.orDie)
      )

      expect(written?.value).toBe("sol")
      expect(existsSync(join(project, ".flows", "control.db"))).toBe(true)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.layer", () => {
  it("assembles the local stack over the working directory, executor included", async () => {
    const previousCwd = process.cwd()
    const previousExit = process.exitCode
    const project = join(root, "local-stack")
    await mkdir(project, { recursive: true })
    try {
      process.chdir(project)
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const output = yield* Output.Output
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          const rendered = yield* output.render(card, "json")
          const ownsExecutor = yield* ExecutorOwnership.ExecutorOwnership
          return { flowId: card.flowId, ownsExecutor, rendered: rendered.text.length }
        }).pipe(
          Effect.provide(NodeControl.layer({ evaluator: ScriptedJudge.layer })),
          Effect.scoped,
          Effect.orDie
        )
      )

      // A local composition owns its executor. That fact is what makes the
      // command wait for a run it started to settle.
      expect(result.flowId).toBe("system/test")
      expect(result.ownsExecutor).toBe(true)
      expect(result.rendered).toBeGreaterThan(0)
      // Both databases live under the working directory the process was
      // started in, and each composition creates its own.
      expect(existsSync(NodeControl.databasePath(project))).toBe(true)
      expect(existsSync(NodeControl.executionDatabasePath(project))).toBe(true)
    } finally {
      process.chdir(previousCwd)
      process.exitCode = previousExit
    }
  }, 60_000)

  it("opens one control database connection for the complete local layer", async () => {
    const project = await mkdtemp(join(tmpdir(), "flows-cli-single-control-db-"))
    try {
      const handles = await Effect.runPromise(
        Effect.gen(function*() {
          yield* ControlService.Control
          yield* MemoryStore.MemoryStore
          return openHandles(NodeControl.databasePath(project))
        }).pipe(
          Effect.provide(NodeControl.layer({ root: project, evaluator: ScriptedJudge.layer })),
          Effect.scoped,
          Effect.orDie
        )
      )

      // A descriptor on the main SQLite file is a live connection. The WAL
      // and SHM descriptors are separate inodes and are intentionally absent.
      expect(handles).toBe(1)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  }, 60_000)

  it("does not own an executor when the command targets a remote", async () => {
    const ownsExecutor = await Effect.runPromise(
      ExecutorOwnership.ExecutorOwnership.pipe(
        Effect.provide(NodeControl.layerControl({ remote: "http://127.0.0.1:1" })),
        Effect.scoped
      )
    )

    expect(ownsExecutor).toBe(false)
  })
})

describe("NodeControl server binds", () => {
  it("defaults an options record with no host to loopback", async () => {
    const hostname = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return server.address._tag === "InetAddressV4" ? server.address.address.toString() : ""
      }).pipe(
        Effect.provide(NodeControl.layerServerNoopAuth({ port: 0 }).pipe(Layer.provide(TestControl.layer()))),
        Effect.scoped
      )
    )

    expect(hostname).toBe("127.0.0.1")
  })

  it("accepts the IPv6 loopback under permissive authentication", () => {
    expect(() => NodeControl.layerServerNoopAuth({ host: "::1", port: 0 })).not.toThrow()
  })

  it("refuses a non-loopback bind under permissive authentication whatever --listen says", () => {
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0 })).toThrow(
      expect.objectContaining({ fault: "policy", code: "permissive_bind_refused" })
    )
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0, listen: true })).toThrow(
      /permissive authentication/
    )
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0, listen: false })).toThrow(
      /permissive authentication/
    )
  })

  it.each(
    [
      ["a missing --listen", undefined],
      ["an explicit --listen=false", false]
    ] as const
  )("refuses an authenticated non-loopback bind with %s", (_label, listen) => {
    const auth = { token: "alpha-secret", principal: { id: "alpha", kind: "bearer" as const } }
    expect(() =>
      NodeControl.layerServerBearerAuth(
        auth,
        listen === undefined ? { host: "10.0.0.1", port: 0 } : {
          host: "10.0.0.1",
          port: 0,
          listen
        }
      )
    ).toThrow(expect.objectContaining({ _tag: "/cli/UsageError", message: expect.stringMatching(/--listen/) }))
  })

  it("accepts both loopback spellings without an opt-in", () => {
    const auth = { token: "alpha-secret", principal: { id: "alpha", kind: "bearer" as const } }
    expect(() => NodeControl.layerServerBearerAuth(auth, { host: "127.0.0.1", port: 0 })).not.toThrow()
    expect(() => NodeControl.layerServerBearerAuth(auth, { host: "::1", port: 0 })).not.toThrow()
  })
})

describe("Application remote endpoint resolution", () => {
  it("reaches the same endpoint whether or not the remote already names /rpc", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        const address = server.address
        if (address._tag !== "InetAddressV4") return yield* Effect.fail(new Error("expected a TCP control server"))
        const base = `http://127.0.0.1:${address.port}`
        const plan = (remote: string) =>
          Effect.flatMap(ControlService.Control, (control) => control.plan({ flowId: "system/test", input: {} })).pipe(
            Effect.provide(NodeControl.layerControl({ remote }))
          )
        const bare = yield* plan(base)
        const suffixed = yield* plan(`${base}/rpc`)
        const trailing = yield* plan(`${base}/`)
        return [bare.flowId, suffixed.flowId, trailing.flowId]
      }).pipe(
        Effect.provide(
          NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(
            Layer.provide(TestControl.layer({ now: () => 0 }))
          )
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer)
      )
    )

    // An operator who pastes the RPC URL and one who pastes the origin must
    // land on the same endpoint rather than on `/rpc/rpc`.
    expect(results).toEqual(["system/test", "system/test", "system/test"])
  })
})
