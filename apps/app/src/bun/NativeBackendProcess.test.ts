import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { nativeBackendMode, startNativeBackend } from "./NativeBackendProcess"

const roots: Array<string> = []
const webRoot = "/packaged/views/mainview"

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const packagedRuntime = (): { backend: string; postgresBin: string; root: string; state: string } => {
  const packageRoot = mkdtempSync(join(tmpdir(), "smithers-owned-"))
  roots.push(packageRoot)
  const root = join(packageRoot, "bin")
  const postgresBin = join(packageRoot, "postgres", "bin")
  mkdirSync(postgresBin, { recursive: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(packageRoot, "postgres", "bundle.json"), '{"version":1,"bin":"bin"}\n')
  const backend = join(root, "smithers-backend")
  writeFileSync(backend, "x", { mode: 0o755 })
  const coding = join(root, "smithers-coding-host")
  const librarian = join(root, "smithers-librarian-host")
  writeFileSync(join(root, "node"), "x", { mode: 0o755 })
  writeFileSync(coding, "coding", { mode: 0o755 })
  writeFileSync(librarian, "librarian", { mode: 0o755 })
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex")
  writeFileSync(join(root, "flow-hosts.json"), `${JSON.stringify({
    version: 1,
    hosts: {
      coding: { executable: "smithers-coding-host", sha256: digest("coding"), flows: ["coding/dispatch"] },
      librarian: {
        executable: "smithers-librarian-host",
        sha256: digest("librarian"),
        flows: []
      }
    }
  })}\n`)
  writeFileSync(join(root, "smithers-jj-export"), "x", { mode: 0o755 })
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
    stateDir: runtime.state,
    webRoot,
    env: {
      ...launcher,
      SMITHERS_BACKEND_MODE: "own",
      SMITHERS_BACKEND_BINARY: runtime.backend,
      SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..")
    },
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
  test("plue starts neither process", async () => {
    let spawned = false
    const backend = await startNativeBackend({
      stateDir: "/unused",
      webRoot,
      env: { SMITHERS_BACKEND_MODE: "plue" },
      spawn: () => {
        spawned = true
        throw new Error("spawn")
      }
    })
    expect(spawned).toBe(false)
    expect(backend.origin).toBeUndefined()
    expect(backend.failure).toBeUndefined()
    await backend.stop()
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
      stateDir: runtime.state,
      webRoot,
      env: {
        SMITHERS_BACKEND_MODE: "own",
        SMITHERS_BACKEND_BINARY: runtime.backend,
        SMITHERS_POSTGRES_BUNDLE_DIR: join(runtime.postgresBin, "..")
      },
      bootstrapToken: "native-bootstrap",
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
    expect(env.SMITHERS_PUBLIC_URL).toBe("http://127.0.0.1:4000")
    expect(env.SMITHERS_AUTH_MODE).toBe("selfhost")
    expect(env.SMITHERS_AUTH_BOOTSTRAP_TOKEN).toBe("native-bootstrap")
    expect(env.SMITHERS_FFI_LIBRARY_PATH).toBe(join(runtime.root,
      process.platform === "darwin" ? "libsmithers_ffi.dylib" : process.platform === "linux" ? "libsmithers_ffi.so" : "smithers_ffi.dll"
    ))
    expect(env.SMITHERS_WORKSPACE_CODING_HOST_BINARY).toEndWith("smithers-coding-host")
    expect(env.SMITHERS_WORKSPACE_LIBRARIAN_HOST_BINARY).toEndWith("smithers-librarian-host")
    expect(env.SMITHERS_MODEL_HOST_BUNDLE).toEndWith("smithers-model-host")
    expect(env.SMITHERS_FLOW_HOST_MANIFEST).toEndWith("flow-hosts.json")
    expect(env.PATH?.split(delimiter)[0]).toBe(runtime.root)
    expect(env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY).toEndWith("smithers-jj-export")
    expect(env.SMITHERS_CODING_LOCAL_OWNER).toBe("1")
    expect(env.SMITHERS_JJ_PATH).toEndWith("jj")
    expect(env.GIT_EXEC_PATH).toEndWith(join("libexec", "git-core"))
    expect(env.GIT_TEMPLATE_DIR).toEndWith(join("share", "git-core", "templates"))
    expect(env.SMITHERS_FFI_LIBRARY).toBeUndefined()
    expect(env.SMITHERS_CODING_HOST_PATH).toBeUndefined()
    expect(instance.origin).toBe("http://127.0.0.1:4000")
    expect(instance.bootstrapToken).toBe("native-bootstrap")
    await instance.stop()
    expect(await instance.failure).toBeUndefined()
    expect(signals).toEqual(["SIGTERM"])
  })

  test("owned backend death is observable after readiness", async () => {
    const runtime = packagedRuntime()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { resolveExit = resolve })
    const instance = await startNativeBackend({
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

  test("hung readiness is bounded by the startup deadline", async () => {
    const runtime = packagedRuntime()
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const signals: Array<string> = []
    const launch = startNativeBackend({
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
      HTTPS_PROXY: "http://proxy.internal:3128",
      no_proxy: "localhost",
      ANTHROPIC_API_KEY: "canary",
      OPENAI_API_KEY: "canary",
      AI_GATEWAY_API_KEY: "canary",
      SMITHERS_CLOUD_TOKEN: "canary",
      SMITHERS_API_TOKEN: "canary",
      GITHUB_TOKEN: "canary",
      SMITHERS_GITHUB_TOKEN: "canary",
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
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_EXEC_PATH",
      "GIT_TEMPLATE_DIR",
      "HOME",
      "HTTPS_PROXY",
      "PATH",
      "SMITHERS_AUTH_BOOTSTRAP_TOKEN",
      "SMITHERS_AUTH_MODE",
      "SMITHERS_CODING_LOCAL_OWNER",
      "SMITHERS_DATA_ROOT",
      "SMITHERS_FFI_LIBRARY_PATH",
      "SMITHERS_FLOW_HOST_MANIFEST",
      "SMITHERS_JJ_PATH",
      "SMITHERS_MODEL_HOST_BUNDLE",
      "SMITHERS_NATIVE_POSTGRES_BIN",
      "SMITHERS_NATIVE_POSTGRES_MAJOR",
      "SMITHERS_NATIVE_STATE_DIR",
      "SMITHERS_NODE_BINARY",
      "SMITHERS_PUBLIC_URL",
      "SMITHERS_SERVER_ADDR",
      "SMITHERS_WEB_ROOT",
      "SMITHERS_WORKSPACE_CODING_HOST_BINARY",
      "SMITHERS_WORKSPACE_CODING_HOST_SHA256",
      "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY",
      "SMITHERS_WORKSPACE_LIBRARIAN_HOST_BINARY",
      "SMITHERS_WORKSPACE_LIBRARIAN_HOST_SHA256",
      "TMPDIR",
      "no_proxy"
    ])
    expect(Object.values(env)).not.toContain("canary")
    expect(env.HOME).toBe("/Users/owner")
    expect(env.HTTPS_PROXY).toBe("http://proxy.internal:3128")
    expect(env.PATH).toBe(`${runtime.root}${delimiter}/usr/bin:/bin`)
    expect(env.SMITHERS_WEB_ROOT).toBe(webRoot)
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
  })

  test("a launcher without PATH still gives the backend the system tools", async () => {
    const runtime = packagedRuntime()
    const env = await ownedEnvironment(runtime, {})
    expect(env.PATH).toBe([runtime.root, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter))
  })

  test("the first-owner token comes from the owned state, never the launcher", async () => {
    const runtime = packagedRuntime()
    mkdirSync(join(runtime.state, "config"), { recursive: true })
    writeFileSync(
      join(runtime.state, "config", "secrets.json"),
      JSON.stringify({ version: 1, values: { SMITHERS_AUTH_BOOTSTRAP_TOKEN: "persisted-owner-token" } }),
      { mode: 0o600 }
    )
    const env = await ownedEnvironment(runtime, { SMITHERS_AUTH_BOOTSTRAP_TOKEN: "shell-export" })
    expect(env.SMITHERS_AUTH_BOOTSTRAP_TOKEN).toBe("persisted-owner-token")
    const fresh = await ownedEnvironment(packagedRuntime(), { SMITHERS_AUTH_BOOTSTRAP_TOKEN: "shell-export" })
    expect(fresh.SMITHERS_AUTH_BOOTSTRAP_TOKEN).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the spawn log names the backend environment without its values", async () => {
    const lines: Array<string> = []
    const log = spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)) })
    try {
      const env = await ownedEnvironment(packagedRuntime(), { HOME: "/Users/owner" })
      expect(lines).toEqual([`owned backend env: ${Object.keys(env).sort().join(" ")}`])
      expect(lines[0]).not.toContain("/Users/owner")
      expect(lines[0]).not.toContain(env.SMITHERS_AUTH_BOOTSTRAP_TOKEN)
    } finally {
      log.mockRestore()
    }
  })

  test("unknown mode is refused", () => {
    expect(() => nativeBackendMode({ SMITHERS_BACKEND_MODE: "unknown" })).toThrow(
      "own or plue"
    )
  })

  test("owned refuses a modified canonical Flow host", async () => {
    const runtime = packagedRuntime()
    writeFileSync(join(runtime.root, "smithers-coding-host"), "modified", { mode: 0o755 })
    await expect(startNativeBackend({
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
