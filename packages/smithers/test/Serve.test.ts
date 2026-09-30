/**
 * `smthrs serve`, and the bind it refuses.
 *
 * The failure this guards is silent: an unauthenticated control plane on a
 * laptop's LAN address can launch agents with the operator's credentials, and
 * nothing about the running server says so.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { ApprovalAuthority, Control, ControlRpcs } from "@smthrs/control"
import * as ScopedToken from "@smthrs/control/ScopedToken"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import { Cause, Effect, Exit, Layer } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as Bridge from "../src/cli/ControlBridge.ts"
import * as CliError from "../src/CliError.ts"
import * as Failure from "../src/internal/Failure.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Serve from "../src/Serve.ts"
import { invokeCanonical } from "./fixtures/invokeCanonical.ts"

const staged: Array<string> = []

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected a TCP test server"))
        return
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error))
    })
  })

// An in-process host answers on the first poll; a spawned `bin.ts` has to
// type-strip the whole CLI graph first, which takes tens of seconds on a loaded
// machine, so that caller passes its own budget.
const waitForHealth = async (port: number, budget = 20_000): Promise<Response> => {
  const deadline = Date.now() + budget
  let lastFailure: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return response
      lastFailure = new Error(`GET /health returned ${response.status}`)
    } catch (cause) {
      lastFailure = cause
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw lastFailure instanceof Error ? lastFailure : new Error("GET /health did not become ready")
}

const bind = (overrides: Partial<Serve.Bind> = {}): Serve.Bind => ({
  host: "127.0.0.1",
  port: 3000,
  listen: false,
  credential: undefined,
  ...overrides
})

describe("the bind rule", () => {
  it("allows loopback with nothing else", () => {
    for (const host of Serve.loopbackHosts) {
      expect(Serve.isLoopback(host)).toBe(true)
      expect(Serve.refuse(bind({ host }))).toBeUndefined()
    }
    expect(Serve.defaultBind).toEqual({ host: "127.0.0.1", port: 3000 })
  })

  it("refuses a non-loopback bind without --listen", () => {
    const refusal = Serve.refuse(bind({ host: "0.0.0.0" }))

    expect(refusal).toBeInstanceOf(CliError.UnsupportedError)
    expect(refusal?.message).toContain("pass --listen")
    expect(CliError.exitCode(refusal!)).toBe(1)
  })

  it("refuses a non-loopback bind with --listen but no bearer token", () => {
    const refusal = Serve.refuse(bind({ host: "10.0.0.4", listen: true }))

    expect(refusal?.message).toContain("without a bearer token")
    expect(refusal?.message).toContain("SMITHERS_TOKEN")
    expect(Serve.refuse(bind({ host: "10.0.0.4", listen: true, credential: "" }))?.message)
      .toContain("without a bearer token")
  })

  it("allows a non-loopback bind that opted in and carries a token", () => {
    expect(Serve.refuse(bind({ host: "10.0.0.4", listen: true, credential: "secret" }))).toBeUndefined()
    expect(Serve.isLoopback("10.0.0.4")).toBe(false)
  })

  it.each(
    [
      ["127.0.0.1", true],
      ["::1", true],
      ["localhost", true],
      ["0.0.0.0", false],
      ["192.0.2.1", false]
    ] as const
  )("keeps every Node bind boundary in parity for %s", (host, expected) => {
    const auth = { token: "alpha-secret", principal: { id: "alpha", kind: "bearer" as const } }
    const options = { host, port: 0 }
    const boundaries = [
      () => NodeControl.layerServer(ControlRpcs.layerBearerAuth(auth), options),
      () => NodeControl.layerServerBearerAuth(auth, options),
      () => NodeControl.layerServerNoopAuth(options),
      () => NodeControl.layerGateway(Serve.health("/tmp/project"), options, "/tmp/project")
    ]

    expect(Serve.isLoopback(host)).toBe(expected)
    for (const boundary of boundaries) {
      if (expected) expect(boundary).not.toThrow()
      else expect(boundary).toThrow()
    }
  })
})

describe("the mounts", () => {
  it("names every route the gateway assembly hosts", () => {
    // `@smthrs/gateway`'s `GatewayServer.layer` mounts exactly these. The
    // banner is rendered from this list, so an entry that is not hosted cannot
    // be advertised, which is the defect the previous banner had: it printed
    // `/health` while the verb hosted the control server alone.
    expect(Serve.mounts.map((mount) => mount.path)).toEqual([
      "/rpc",
      "/rpc/ws",
      "/projections",
      "/projections/ws",
      "/sync",
      "/sync/ws",
      "/health"
    ])
    expect(Serve.mounts.filter((mount) => mount.protocol === "ws").map((mount) => mount.path)).toEqual([
      "/rpc/ws",
      "/projections/ws",
      "/sync/ws"
    ])
  })

  it("identifies the workspace by its root and nothing else", () => {
    // A supervisor asks `/health` whether the gateway it found belongs to this
    // workspace. The answer must not carry the operator's directory names.
    const identity = Serve.health("/tmp/project-one")

    expect(identity.workspaceHash).toBe(Serve.workspaceHash("/tmp/project-one/"))
    expect(identity.workspaceHash).not.toBe(Serve.workspaceHash("/tmp/project-two"))
    expect(identity.workspaceHash).not.toContain("project-one")
    expect(identity.protocolVersion).toBe("1")
  })
})

describe("the serve command", () => {
  it("fails before composition for a refused bind and defects without a gateway host", async () => {
    const refused = await Effect.runPromiseExit(
      Serve.host(bind({ host: "0.0.0.0", listen: false }), "/work")
    )
    expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toBeInstanceOf(CliError.UnsupportedError)

    const missing = await Effect.runPromiseExit(Serve.host(bind(), "/work"))
    const defect = Exit.isFailure(missing) ? Cause.squash(missing.cause) : undefined
    expect(defect).toBeInstanceOf(CliError.Refused)
    expect(defect).toMatchObject({ fault: "bug", code: "gateway_host_missing" })
    expect(Failure.operatorSentence(defect)).toBe("This smthrs build cannot serve the gateway. Not your fault.")
  })

  it("omits an empty bearer credential from the gateway options", async () => {
    let options: unknown
    const gateway = Layer.succeed(Serve.GatewayHost, {
      launch: (_health, input) =>
        Effect.sync(() => {
          options = input
        }) as Effect.Effect<never>
    })

    await Effect.runPromise(Serve.host(bind({ credential: "" }), "/work").pipe(Effect.provide(gateway)))
    expect(options).not.toHaveProperty("credential")
  })

  it.each([false, true])("requires explicit host delegation for bearer approval (delegated: %s)", async (delegated) => {
    const root = mkdtempSync(join(tmpdir(), "smithers-serve-authority-"))
    staged.push(root)
    const port = await freePort()
    const credential = "serve-authority-test-credential"
    const approvalAuthority = delegated
      ? await Effect.runPromise(ApprovalAuthority.make([
        { principal: NodeGateway.bearerPrincipal, scopes: ["once"], targets: ["Plan"] }
      ]))
      : undefined
    const abort = new AbortController()
    const running = Bridge.host(bind({ port, credential }), { root, quiet: true }, {
      environment: {},
      evaluator: ScriptedJudge.layer,
      approvalAuthority,
      signal: abort.signal
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) throw cause
    })
    try {
      await waitForHealth(port)
      const card = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          // Planning proves the bearer authenticated successfully before its
          // independent approval authority is checked.
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          for (const scope of ["run", "remembered"] as const) {
            expect((yield* Effect.flip(control.approve({ ...card.approval, scope })))._tag)
              .toBe("/control/Unauthorized")
          }
          // Node authority is checked before target lookup, including when
          // the host has delegated Plan-only decisions.
          const nodeApproval = {
            ...card.approval,
            target: {
              _tag: "Node" as const,
              runId: "policy-run",
              requestId: "policy-request",
              digest: card.digest,
              envelope: card.envelope
            }
          }
          for (const scope of ["once", "run", "remembered"] as const) {
            expect((yield* Effect.flip(control.approve({ ...nodeApproval, scope })))._tag)
              .toBe("/control/Unauthorized")
          }
          expect((yield* Effect.flip(control.deny(nodeApproval)))._tag).toBe("/control/Unauthorized")
          if (delegated) {
            yield* control.approve({ ...card.approval, scope: "once" })
          } else {
            expect((yield* Effect.flip(control.approve({ ...card.approval, scope: "once" })))._tag)
              .toBe("/control/Unauthorized")
            expect((yield* Effect.flip(control.deny(card.approval)))._tag).toBe("/control/Unauthorized")
          }
          return card
        }).pipe(
          Effect.provide(NodeControl.layerControl({ remote: `http://127.0.0.1:${port}`, credential })),
          Effect.scoped
        )
      )
      if (!delegated) {
        // The local operator can still decide the unchanged pending approval.
        await Effect.runPromise(
          Effect.flatMap(Control.Control, (control) => control.approve(card.approval)).pipe(
            Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer })),
            Effect.scoped
          )
        )
      }
    } finally {
      abort.abort()
      await running
    }
  }, 60_000)

  it("serves Run.Fork and Run.Verify over the project's history on /projections", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-serve-history-"))
    staged.push(root)
    const port = await freePort()
    const credential = "serve-history-test-credential"
    const abort = new AbortController()
    const running = Bridge.host(bind({ port, credential }), { root, quiet: true }, {
      environment: {},
      evaluator: ScriptedJudge.layer,
      signal: abort.signal
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) throw cause
    })
    // The frame the product relay writes (`runtimebridge.Client.CallRPC`).
    const call = async (tag: string, payload: unknown, token = credential) => {
      const response = await fetch(`http://127.0.0.1:${port}/projections`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: `${JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] })}\n`
      })
      const [line] = (await response.text()).trim().split("\n")
      return JSON.parse(line!) as { readonly exit: { readonly _tag: string; readonly cause?: unknown } }
    }
    try {
      await waitForHealth(port)
      const verified = await call("Run.Verify", { runId: "run-unknown" })
      // The refusal the CLI prints for the same run, with its own stable code.
      expect(verified.exit).toMatchObject({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: "@smthrs/gateway/HistoryRefused", code: "run_not_found" } }]
      })
      const forked = await call("Run.Fork", { runId: "run-unknown", at: 0 })
      expect(forked.exit).toMatchObject({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { _tag: "@smthrs/gateway/HistoryRefused", code: "not_found_row" } }]
      })
      // A read-only token cannot fork.
      const readOnly = await Effect.runPromise(
        ScopedToken.mint({ key: credential, scopes: ["read:runs"], ttlMillis: 60_000 })
      )
      expect(JSON.stringify((await call("Run.Fork", { runId: "run-unknown", at: 0 }, readOnly.token)).exit))
        .toContain("Unauthorized")
      // The address is decoded before the host sees it.
      expect(JSON.stringify((await call("Run.Fork", { runId: "run-unknown", at: -1 })).exit))
        .not.toContain("HistoryRefused")
    } finally {
      abort.abort()
      await running
    }
  }, 60_000)

  it("keeps the legacy gateway alias behind the same approval boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-gateway-authority-"))
    staged.push(root)
    const port = await freePort()
    const credential = "gateway-alias-test-credential"
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--import",
      new URL("./fixtures/scripted-native-host.ts", import.meta.url).href,
      fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
      "--root",
      root,
      "gateway",
      "--port",
      String(port)
    ], {
      cwd: root,
      env: { ...process.env, SMITHERS_TOKEN: credential, SMITHERS_REMOTE: "" },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 150_000,
      killSignal: "SIGKILL"
    })
    let stderr = ""
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk
    })
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    try {
      // Report what the child said; a bare ECONNREFUSED names nothing.
      await waitForHealth(port, 120_000).catch((cause: unknown) => {
        throw new Error(`the gateway subprocess never served /health\n${stderr}`, { cause })
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          expect((yield* Effect.flip(control.approve(card.approval)))._tag).toBe("/control/Unauthorized")
          expect((yield* Effect.flip(control.deny(card.approval)))._tag).toBe("/control/Unauthorized")
        }).pipe(
          Effect.provide(NodeControl.layerControl({ remote: `http://127.0.0.1:${port}`, credential })),
          Effect.scoped
        )
      )
    } finally {
      child.kill("SIGTERM")
      await closed
    }
  }, 180_000)

  it("hosts GET /health until the command fiber is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-serve-"))
    staged.push(root)
    const port = await freePort()
    const controller = new AbortController()
    const running = invokeCanonical(["--root", root, "serve", "--host", "127.0.0.1", "--port", String(port)], {
      signal: controller.signal
    })

    try {
      const response = await waitForHealth(port)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(Serve.health(root))
    } finally {
      controller.abort()
      await running
    }
  }, 60_000)
})

describe("the banner", () => {
  it("is rendered from the mount list, so it cannot advertise a 404", () => {
    const banner = Serve.banner(bind())

    for (const mount of Serve.mounts) {
      const base = mount.protocol === "ws" ? "ws://127.0.0.1:3000" : "http://127.0.0.1:3000"
      expect(banner).toContain(`${base}${mount.path}`)
    }
  })

  it("names every mount and how the server authenticates", () => {
    const banner = Serve.banner(bind())

    expect(banner).toContain("http://127.0.0.1:3000")
    expect(banner).toContain("/rpc")
    expect(banner).toContain("ws://127.0.0.1:3000/rpc/ws")
    expect(banner).toContain("/health")
    expect(banner).toContain("anonymous reads (loopback Host; loopback browser Origin); approval token required")
  })

  it("brackets an IPv6 host and reports bearer authentication", () => {
    const banner = Serve.banner(bind({ host: "::1", credential: "secret" }))

    expect(banner).toContain("http://[::1]:3000")
    expect(banner).toContain("bearer token")
  })
})
