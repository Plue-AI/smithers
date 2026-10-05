import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { startNativeBackend } from "./NativeBackendProcess"

const roots: Array<string> = []
const webRoot = "/packaged/views/mainview"

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const packagedRuntime = (): { backend: string; postgresBin: string; root: string; state: string } => {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), "smithers-owned-")))
  roots.push(packageRoot)
  const root = join(packageRoot, "bin")
  const postgresBin = join(packageRoot, "postgres", "bin")
  mkdirSync(postgresBin, { recursive: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(packageRoot, "postgres", "bundle.json"), '{"version":1,"bin":"bin"}\n')
  writeFileSync(join(root, "smithers-server"), "x", { mode: 0o755 })
  writeFileSync(join(root, "msb"), "x", { mode: 0o755 })
  const backend = join(root, "smithers-backend")
  writeFileSync(backend, "x", { mode: 0o755 })
  const coding = join(root, "smithers-coding-host")
  writeFileSync(join(root, "node"), "x", { mode: 0o755 })
  writeFileSync(coding, "coding", { mode: 0o755 })
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex")
  writeFileSync(join(root, "flow-hosts.json"), `${JSON.stringify({
    version: 1,
    hosts: {
      coding: { executable: "smithers-coding-host", sha256: digest("coding"), flows: ["coding/dispatch"] },
      jjExport: { executable: "linux-arm64/smithers-jj-export", sha256: digest("linux-helper"), flows: [] }
    }
  })}\n`)
  writeFileSync(join(root, "smithers-jj-export"), "x", { mode: 0o755 })
  mkdirSync(join(root, "linux-arm64"))
  writeFileSync(join(root, "linux-arm64", "smithers-jj-export"), "linux-helper", { mode: 0o755 })
  writeFileSync(join(root, "jj"), "x", { mode: 0o755 })
  writeFileSync(join(root, "git"), "x", { mode: 0o755 })
  const modelHost = join(root, "smithers-model-host")
  writeFileSync(modelHost, "model-host", { mode: 0o755 })
  writeFileSync(`${modelHost}.sha256`, `${digest("model-host")}  smithers-model-host\n`)
  const gitExec = join(packageRoot, "libexec", "git-core")
  const gitTemplates = join(packageRoot, "share", "git-core", "templates")
  mkdirSync(gitExec, { recursive: true })
  mkdirSync(gitTemplates, { recursive: true })
  writeFileSync(join(gitExec, "git-remote-http"), "x", { mode: 0o755 })
  writeFileSync(
    join(
      root,
      process.platform === "darwin"
        ? "libsmithers_ffi.dylib"
        : process.platform === "linux"
        ? "libsmithers_ffi.so"
        : "smithers_ffi.dll"
    ),
    "x"
  )
  for (const tool of ["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"]) {
    writeFileSync(join(postgresBin, tool), tool, { mode: 0o755 })
  }
  return { backend, postgresBin, root, state: join(packageRoot, "state") }
}

/** Launches owned mode from `launcher` and returns the environment the backend child received. */
const ownedEnvironment = async (
  runtime: ReturnType<typeof packagedRuntime>,
  launcher: Readonly<Record<string, string>>
): Promise<Record<string, string>> => {
  let env: Record<string, string> = {}
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExit = resolve })
  const instance = await startNativeBackend({
    executablePath: join(runtime.root, "smithers-server"),
    stateDir: runtime.state,
    webRoot,
    env: launcher,
    spawn: (_, options) => {
      env = options.env
      return { exited, kill: () => resolveExit(0) }
    },
    fetch: async () => new Response(null, { status: 200 })
  })
  await instance.stop()
  return env
}

describe("native backend ownership", () => {
  test("owned refuses a modified Linux arm64 jj-export helper", async () => {
    const runtime = packagedRuntime()
    writeFileSync(join(runtime.root, "linux-arm64", "smithers-jj-export"), "tampered", { mode: 0o755 })
    await expect(startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      env: { SMITHERS_BACKEND_MODE: "own", SMITHERS_BACKEND_BINARY: runtime.backend,
        SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..") }
    })).rejects.toThrow("Packaged Linux arm64 jj-export checksum failed")
  })

  test("owned passes packaged postgres", async () => {
    const runtime = packagedRuntime()
    let env: Record<string, string> = {}
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const signals: Array<string> = []
    const instance = await startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      env: {
        SMITHERS_BACKEND_MODE: "own",
        SMITHERS_BACKEND_BINARY: runtime.backend,
        SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..")
      },
      spawn: (_, options) => {
        env = options.env
        return {
          exited,
          kill: (signal) => {
            signals.push(signal)
            resolveExit(0)
          }
        }
      },
      fetch: async () => new Response(null, { status: 200 })
    })
    expect(env.SMITHERS_NATIVE_POSTGRES_BIN).toBe(realpathSync(runtime.postgresBin))
    expect(env.SMITHERS_NATIVE_POSTGRES_MAJOR).toBe("18")
    expect(env.SMITHERS_DATA_ROOT).toBe(runtime.state)
    expect(env.SMITHERS_PUBLIC_URL).toBeUndefined()
    expect(env.SMITHERS_AUTH_MODE).toBe("selfhost")
    expect(env.SMITHERS_AUTH_BOOTSTRAP_TOKEN).toBeUndefined()
    expect(env.SMITHERS_FFI_LIBRARY_PATH).toBe(join(runtime.root,
      process.platform === "darwin" ? "libsmithers_ffi.dylib" : process.platform === "linux" ? "libsmithers_ffi.so" : "smithers_ffi.dll"
    ))
    expect(env.SMITHERS_MODEL_HOST_BUNDLE).toEndWith("smithers-model-host")
    expect(env.SMITHERS_FLOW_HOST_MANIFEST).toEndWith("flow-hosts.json")
    expect(env.PATH?.split(delimiter)[0]).toBe(runtime.root)
    expect(env.SMITHERS_CODING_LOCAL_OWNER).toBeUndefined()
    expect(env.SMITHERS_WORKSPACE_ISOLATION).toBe("microvm")
    expect(env.GIT_EXEC_PATH).toEndWith(join("libexec", "git-core"))
    expect(env.GIT_TEMPLATE_DIR).toEndWith(join("share", "git-core", "templates"))
    expect(env.SMITHERS_FFI_LIBRARY).toBeUndefined()
    expect(env.SMITHERS_CODING_HOST_PATH).toBeUndefined()
    // The backend reads every path it is handed only to verify it against
    // the installed bundle; nothing it does not verify is passed.
    for (const name of ["SMITHERS_MICROSANDBOX_BIN", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "SMITHERS_JJ_PATH",
      "SMITHERS_WORKSPACE_CODING_HOST_BINARY", "SMITHERS_WORKSPACE_CODING_HOST_SHA256"]) {
      expect(env[name]).toBeUndefined()
    }
    expect(instance.origin).toBe("http://127.0.0.1:4000")
    expect(instance.bootstrapToken).toBeUndefined()
    await instance.stop()
    expect(await instance.failure).toBeUndefined()
    expect(signals).toEqual(["SIGTERM"])
  })

  test("owned backend death is observable after readiness", async () => {
    const runtime = packagedRuntime()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { resolveExit = resolve })
    const instance = await startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      env: {
        SMITHERS_BACKEND_MODE: "own",
        SMITHERS_BACKEND_BINARY: runtime.backend,
        SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..")
      },
      spawn: () => ({ exited, kill: () => resolveExit(0) }),
      fetch: async () => new Response(null, { status: 200 })
    })
    resolveExit(19)
    expect((await instance.failure)?.message).toContain("code 19")
    await instance.stop()
  })

  test("a stop gives the backend 25 s to stop its PostgreSQL before it kills it", async () => {
    const runtime = packagedRuntime()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { resolveExit = resolve })
    const signals: Array<string> = []
    const slept: Array<number> = []
    const instance = await startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      // SIGTERM starts a teardown that never finishes; only SIGKILL ends it.
      spawn: () => ({
        exited,
        kill: (signal) => {
          signals.push(signal)
          if (signal === "SIGKILL") resolveExit(137)
        }
      }),
      fetch: async () => new Response(null, { status: 200 }),
      sleep: (milliseconds) => {
        slept.push(milliseconds)
        return milliseconds === 25_000 ? Promise.resolve() : new Promise<void>(() => {})
      }
    })
    await instance.stop()
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(slept).toContain(25_000)
    expect(slept).not.toContain(10_000)
  })

  // The bundle boot proof's launcher exited 25.5 s after SIGTERM although
  // its backend and PostgreSQL had stopped within a second: the pending
  // grace timer held the event loop.
  test("a stopped launcher exits with its backend, not at the end of the stop grace", async () => {
    const runtime = packagedRuntime()
    const script = join(runtime.root, "..", "launch.ts")
    writeFileSync(script, [
      `import { startNativeBackend } from ${JSON.stringify(join(import.meta.dir, "NativeBackendProcess.ts"))}`,
      "let resolveExit: (code: number) => void = () => {}",
      "const exited = new Promise<number>((resolve) => { resolveExit = resolve })",
      "const backend = await startNativeBackend({",
      `  executablePath: ${JSON.stringify(join(runtime.root, "smithers-server"))},`,
      `  stateDir: ${JSON.stringify(runtime.state)},`,
      `  webRoot: ${JSON.stringify(webRoot)},`,
      "  spawn: () => ({ exited, kill: () => { setTimeout(() => resolveExit(0), 50) } }),",
      "  fetch: async () => new Response(null, { status: 200 })",
      "})",
      "await backend.stop()",
      "console.log(\"stopped\")"
    ].join("\n"))
    const started = Date.now()
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain("stopped")
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 40_000)

  // The real-GitHub walk's first boot at load 67 failed: 116 migrations took
  // 29.5 s against a fixed 30 s deadline. Each migration step now restarts it.
  const migratingBackend = (steps: number, advance: boolean) => {
    const runtime = packagedRuntime()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { resolveExit = resolve })
    const signals: Array<string> = []
    let probes = 0
    const launch = startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      spawn: () => ({
        exited,
        kill: (signal) => {
          signals.push(signal)
          resolveExit(0)
        }
      }),
      fetch: async () => {
        await Bun.sleep(10)
        probes += 1
        if (probes > steps) return new Response(null, { status: 200 })
        return Response.json(
          { status: "starting", phase: "migrating", applied: advance ? probes : 1, total: steps },
          { status: 503 }
        )
      },
      startupTimeoutMs: 300
    })
    return { launch, signals, probes: () => probes }
  }

  test("each migration step restarts the startup deadline", async () => {
    const { launch, signals, probes } = migratingBackend(20, true)
    const instance = await launch
    expect(probes()).toBe(21)
    expect(signals).toEqual([])
    await instance.stop()
  })

  test("a starting page that stops advancing still meets the startup deadline", async () => {
    const { launch, signals } = migratingBackend(1_000, false)
    await expect(launch).rejects.toThrow("startup deadline")
    expect(signals).toEqual(["SIGTERM"])
  })

  test("hung readiness is bounded by the startup deadline", async () => {
    const runtime = packagedRuntime()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const signals: Array<string> = []
    const launch = startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      env: {
        SMITHERS_BACKEND_MODE: "own",
        SMITHERS_BACKEND_BINARY: runtime.backend,
        SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..")
      },
      spawn: () => ({
        exited,
        kill: (signal) => {
          signals.push(signal)
          resolveExit(0)
        }
      }),
      fetch: () => new Promise<Response>(() => {}),
      startupTimeoutMs: 5
    })
    await expect(launch).rejects.toThrow("startup deadline")
    expect(signals).toEqual(["SIGTERM"])
  })

  test("the owned backend receives only its environment contract", async () => {
    const runtime = packagedRuntime()
    const launcher = {
      HOME: "/Users/owner",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/owner",
      CODEX_HOME: "/Users/owner/.codex-work",
      CLAUDE_CONFIG_DIR: "/Users/owner/.claude-work",
      HTTPS_PROXY: "http://proxy.internal:3128",
      no_proxy: "localhost",
      ANTHROPIC_API_KEY: "canary",
      OPENAI_API_KEY: "canary",
      AI_GATEWAY_API_KEY: "canary",
      SMITHERS_CLOUD_TOKEN: "canary",
      SMITHERS_API_TOKEN: "canary",
      GITHUB_TOKEN: "canary",
      SMITHERS_GITHUB_TOKEN: "canary",
      SMITHERS_GITHUB_APP_ID: "canary",
      SMITHERS_GITHUB_APP_PRIVATE_KEY: "canary",
      SMITHERS_GITHUB_APP_INSTALL_URL: "canary",
      SMITHERS_GITHUB_APP_API_BASE_URL: "canary",
      SMITHERS_GITHUB_GIT_BASE_URL: "canary",
      SMITHERS_GITHUB_APP_PERMISSIONS_URL: "canary",
      SMITHERS_WEBHOOK_GITHUB_APP_SECRET: "canary",
      SMITHERS_AUTH_GITHUB_API_BASE_URL: "canary",
      SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL: "canary",
      SMITHERS_AUTH_GITHUB_CLIENT_ID: "canary",
      SMITHERS_AUTH_GITHUB_CLIENT_SECRET: "canary",
      SMITHERS_AUTH_BOOTSTRAP_TOKEN: "canary",
      SMITHERS_AUTH_SESSION_SECRET: "canary",
      SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY: "canary",
      SMITHERS_ENABLE_E2E_TEST_ROUTES: "canary",
      SMITHERS_WEB_ROOT: "canary",
      NODE_OPTIONS: "canary",
      GIT_SSH_COMMAND: "canary",
      GIT_CONFIG_PARAMETERS: "canary",
      PGPASSWORD: "canary"
    }
    const env = await ownedEnvironment(runtime, launcher)
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_EXEC_PATH",
      "GIT_TEMPLATE_DIR",
      "HOME",
      "HTTPS_PROXY",
      "PATH",
      "SMITHERS_AUTH_MODE",
      "SMITHERS_DATA_ROOT",
      "SMITHERS_EGRESS_RELAY_PORT",
      "SMITHERS_FFI_LIBRARY_PATH",
      "SMITHERS_FLOW_HOST_MANIFEST",
      "SMITHERS_MODEL_HOST_BUNDLE",
      "SMITHERS_NATIVE_POSTGRES_BIN",
      "SMITHERS_NATIVE_POSTGRES_MAJOR",
      "SMITHERS_NATIVE_STATE_DIR",
      "SMITHERS_NODE_BINARY",
      "SMITHERS_SERVER_ADDR",
      "SMITHERS_SSH_ADDR",
      "SMITHERS_WEB_ROOT",
      "SMITHERS_WORKSPACE_ISOLATION",
      "TMPDIR",
      "no_proxy"
    ])
    expect(Object.values(env)).not.toContain("canary")
    expect(env.HOME).toBe("/Users/owner")
    expect([env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]).toEqual(["/Users/owner/.codex-work", "/Users/owner/.claude-work"])
    expect(env.HTTPS_PROXY).toBe("http://proxy.internal:3128")
    expect(env.PATH).toBe([runtime.root, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter))
    expect(env.SMITHERS_WEB_ROOT).toBe(webRoot)
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
  })

  test("a launcher without PATH still gives the backend the system tools", async () => {
    const runtime = packagedRuntime()
    const env = await ownedEnvironment(runtime, {})
    expect(env.PATH).toBe([runtime.root, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter))
  })

  test.each([undefined, "process", "microvm", "invalid", ""])(
    "owned always selects microVM isolation, ignoring shell override %s", async (value) => {
      const env = await ownedEnvironment(packagedRuntime(), value === undefined ? {} : {
        SMITHERS_WORKSPACE_ISOLATION: value
      })
      expect(env.SMITHERS_WORKSPACE_ISOLATION).toBe("microvm")
    })

  test("the spawn log names the backend environment without its values", async () => {
    const lines: Array<string> = []
    const log = spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)) })
    try {
      const env = await ownedEnvironment(packagedRuntime(), { HOME: "/Users/owner" })
      expect(lines).toEqual([`owned backend env: ${Object.keys(env).sort().join(" ")}`])
      expect(lines[0]).not.toContain("/Users/owner")
      expect(env.SMITHERS_AUTH_BOOTSTRAP_TOKEN).toBeUndefined()
    } finally {
      log.mockRestore()
    }
  })

  test("owned refuses a modified canonical Flow host", async () => {
    const runtime = packagedRuntime()
    writeFileSync(join(runtime.root, "smithers-coding-host"), "modified", { mode: 0o755 })
    await expect(startNativeBackend({
      executablePath: join(runtime.root, "smithers-server"),
      stateDir: runtime.state,
      webRoot,
      env: {
        SMITHERS_BACKEND_MODE: "own",
        SMITHERS_BACKEND_BINARY: runtime.backend,
        SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..")
      }
    })).rejects.toThrow("checksum failed")
  })
})

 test.each([undefined, "socket"] as const)("bundled launch ignores shell and inherits output (%s)", async (setupHandoff) => {
  const runtime = packagedRuntime()
  const link = join(runtime.state, "server-link")
  mkdirSync(runtime.state)
  symlinkSync(join(runtime.root, "smithers-server"), link)
  const hostile = Object.fromEntries([
   "SMITHERS_BACKEND_BINARY", "SMITHERS_POSTGRES_BUNDLE_DIR", "SMITHERS_FLOW_HOST_MANIFEST",
   "SMITHERS_OWNED_BACKEND_ORIGIN", "SMITHERS_MICROSANDBOX_BIN", "SMITHERS_EGRESS_RELAY_PORT",
   "SMITHERS_SERVER_ADDR", "SMITHERS_SSH_ADDR", "SMITHERS_PUBLIC_URL", "SMITHERS_MICROVM_MEMORY_MIB",
   "SMITHERS_PLATFORM_MODEL_KEYS_FILE"
  ].map((name) => [name, "hostile"]))
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExit = resolve })
  let argv: ReadonlyArray<string> = []
  let childOptions: unknown
  const instance = await startNativeBackend({
   executablePath: link, stateDir: runtime.state, webRoot, setupHandoff,
   env: { ...hostile, SMITHERS_BACKEND_MODE: "plue", SMITHERS_WORKSPACE_ISOLATION: "process", PATH: "/opt/homebrew/bin:/hostile/bin" },
   spawn: (args, options) => {
    argv = args; childOptions = options
    expect(Object.values(options.env)).not.toContain("hostile")
    expect(options.env.PATH).toBe([runtime.root, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter))
    expect(options.env.SMITHERS_MICROSANDBOX_BIN).toBeUndefined()
    expect(options.env.SMITHERS_WORKSPACE_ISOLATION).toBe("microvm")
    expect(options.env.SMITHERS_EGRESS_RELAY_PORT).toBe("4001")
    expect(options.env.SMITHERS_SERVER_ADDR).toBe("127.0.0.1:4000")
    expect(options.env.SMITHERS_SSH_ADDR).toBe("127.0.0.1:2222")
    return { exited, kill: () => resolveExit(0) }
   }, fetch: async () => new Response(null, { status: 200 })
  })
  expect(argv).toEqual(setupHandoff === "socket" ? [runtime.backend, "--setup-handoff=socket"] : [runtime.backend])
  expect(childOptions).toMatchObject({ stdout: "inherit", stderr: "inherit" })
  expect(instance.mode).toBe("own")
  await instance.stop()
 })

 test("missing bundled msb refuses before spawning", async () => {
  const runtime = packagedRuntime()
  rmSync(join(runtime.root, "msb"))
  let spawned = false
  await expect(startNativeBackend({ executablePath: join(runtime.root, "smithers-server"),
   stateDir: runtime.state, webRoot, spawn: () => { spawned = true; throw new Error("spawn") }
  })).rejects.toThrow("Bundled microVM runtime is unavailable")
  expect(spawned).toBe(false)
 })
