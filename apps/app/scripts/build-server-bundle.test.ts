import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { availableParallelism } from "node:os"
import {
  bundleBuildEnvironment,
  materializeBundleFileLinks,
  webBundleCommand,
  createBundleManifest,
  compileServerLauncher,
  copyGitCoreResources,
  preparePostgresArm64,
  runBundleCommand,
  validateBuildSHA,
  validateMsbVersion,
  validateNodeVersion,
  validatePostgresVersion,
  verifyBundleManifest,
} from "./build-server-bundle"
import { foreignLibraries } from "./system-linkage"
import { validateGitBundle } from "./validate-git-bundle"
import { bundlePostgres } from "./bundle-postgres"

const REVISION = "0123456789abcdef".repeat(2) + "01234567"
const TEST_TIMEOUT = 30_000
const script = resolve(import.meta.dir, "build-server-bundle.ts")
let root = ""

beforeAll(() => {
  const temporary = resolve(import.meta.dir, "..", ".server-bundle-unit-tests")
  mkdirSync(temporary, { recursive: true })
  root = mkdtempSync(join(temporary, "case-"))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
}, TEST_TIMEOUT)

const fixture = (): string => mkdtempSync(join(root, "bundle-"))
const put = (bundle: string, path: string, content: string): void => {
  const destination = join(bundle, path)
  mkdirSync(resolve(destination, ".."), { recursive: true })
  writeFileSync(destination, content)
}
const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")
const bunBuildTemporaries = (directory: string): Array<string> => readdirSync(directory).filter((name) => name.endsWith(".bun-build")).sort()
const saveManifest = (bundle: string, stages: Readonly<Record<string, string>> = { bin: "runtime" }): ReturnType<typeof createBundleManifest> => {
  const manifest = createBundleManifest(bundle, REVISION, stages)
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest))
  return manifest
}
const editManifest = (bundle: string, edit: (manifest: ReturnType<typeof createBundleManifest>) => void): void => {
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as ReturnType<typeof createBundleManifest>
  edit(manifest)
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest))
}
const buildEnvironment = (overrides: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("SMITHERS_")) env[name] = value
  }
  return { ...env, ...overrides }
}
const build = (overrides: Readonly<Record<string, string>> = {}): { exitCode: number; stderr: string; stdout: string } => {
  const result = Bun.spawnSync([process.execPath, script], {
    env: buildEnvironment(overrides), stdout: "pipe", stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  }
}

const fixtureTool = (argv: ReadonlyArray<string>): string => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const postgresFixture = (): { source: string; directory: string; thin: string; options: { cwd: string; env: { PATH: string } } } => {
  const directory = fixture()
  const source = join(directory, "source")
  mkdirSync(join(source, "bin"), { recursive: true })
  mkdirSync(join(source, "lib/postgresql"), { recursive: true })
  put(source, "share/postgresql/fixture.txt", "SQL fixture")
  put(directory, "tool.c", `
    #include <mach-o/dyld.h>
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    int main(int argc, char **argv) {
      if (argc == 2 && !strcmp(argv[1], "--version")) { puts("postgres (PostgreSQL) 18.6"); return 0; }
      char executable[4096], prefix[4096]; unsigned int size = sizeof(executable);
      if (_NSGetExecutablePath(executable, &size) || !realpath(executable, prefix)) return 2;
      *strrchr(prefix, '/') = 0; *strrchr(prefix, '/') = 0;
      const char *suffix = argc == 2 && !strcmp(argv[1], "--bindir") ? "bin"
        : argc == 2 && !strcmp(argv[1], "--sharedir") ? "share/postgresql"
        : argc == 2 && !strcmp(argv[1], "--pkglibdir") ? "lib/postgresql" : NULL;
      if (!suffix) return 3;
      printf("%s/%s\\n", prefix, suffix); return 0;
    }
  `)
  const thin = join(directory, "thin-arm64")
  fixtureTool(["/usr/bin/clang", "-arch", "arm64", join(directory, "tool.c"), "-o", thin])
  for (const tool of ["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore", "pg_config"]) cpSync(thin, join(source, "bin", tool))
  fixtureTool(["/usr/bin/clang", "-arch", "arm64", "-arch", "x86_64", join(directory, "tool.c"), "-Wl,-rpath," + join(source, "lib"), "-o", join(source, "bin/nearblack")])
  put(directory, "library.c", "int fixture(void) { return 1; }\n")
  fixtureTool(["/usr/bin/clang", "-dynamiclib", "-arch", "arm64", "-arch", "x86_64", join(directory, "library.c"), "-Wl,-install_name,@rpath/plugin.dylib", "-o", join(source, "lib/postgresql/plugin.dylib")])
  return { directory, source, thin, options: { cwd: directory, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } } }
}

// Oracle: .specs/product/mvp.md M-10; T-INS-01 Scope > In requires the unchanged
// PostgreSQL relocation helper. Real Mach-O dependencies expose per-slice LC_RPATH duplication.
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("PostgreSQL arm64 source preparation", () => {
  test("prepares universal executables and libraries for the unchanged relocation helper without altering source", () => {
    const { directory, source, thin, options } = postgresFixture()
    const universal = readFileSync(join(source, "bin/nearblack"))
    const library = readFileSync(join(source, "lib/postgresql/plugin.dylib"))
    expect(fixtureTool(["/usr/bin/otool", "-l", join(source, "bin/nearblack")]).match(/cmd LC_RPATH/g)).toHaveLength(2)
    expect(() => bundlePostgres(source, join(directory, "unprepared"))).toThrow("no LC_RPATH load command")
    const prepared = join(directory, "prepared")
    preparePostgresArm64(source, prepared, options)
    for (const file of ["bin/nearblack", "lib/postgresql/plugin.dylib"]) expect(fixtureTool(["/usr/bin/lipo", "-archs", join(prepared, file)])).toBe("arm64")
    expect(readFileSync(join(prepared, "bin/postgres"))).toEqual(readFileSync(thin))
    expect(readFileSync(join(source, "bin/nearblack"))).toEqual(universal)
    expect(readFileSync(join(source, "lib/postgresql/plugin.dylib"))).toEqual(library)
    const packaged = join(directory, "packaged")
    expect(() => bundlePostgres(prepared, packaged)).not.toThrow()
    const manifest = JSON.parse(readFileSync(join(packaged, "bundle.json"), "utf8")) as { bin: string }
    const runtimeBin = join(packaged, manifest.bin)
    expect(fixtureTool(["/usr/bin/otool", "-l", join(runtimeBin, "nearblack")])).not.toContain("cmd LC_RPATH")
    expect(fixtureTool([join(runtimeBin, "postgres"), "--version"])).toBe("postgres (PostgreSQL) 18.6")
    fixtureTool(["/usr/bin/codesign", "--verify", join(runtimeBin, "nearblack")])
  }, 120_000)

  // C-INS-05 clean-host contract: optional PL/Python must not require a
  // developer-installed /Library/Frameworks/Python.framework at build/start.
  test("omits optional PL/Python plugins and declarations without requiring global Python", () => {
    const { directory, source, options } = postgresFixture()
    for (const path of ["lib/postgresql/plpython3.dylib", "lib/postgresql/ltree_plpython3.dylib",
      "share/postgresql/extension/plpython3u.control", "share/postgresql/extension/ltree_plpython3u--1.0.sql"]) put(source, path, "optional plugin")
    put(source, "share/postgresql/extension/plpgsql.control", "required core extension")
    const prepared = join(directory, "prepared")
    preparePostgresArm64(source, prepared, options)
    for (const path of ["lib/postgresql/plpython3.dylib", "lib/postgresql/ltree_plpython3.dylib",
      "share/postgresql/extension/plpython3u.control", "share/postgresql/extension/ltree_plpython3u--1.0.sql"]) {
      expect(existsSync(join(prepared, path))).toBe(false)
      expect(existsSync(join(source, path))).toBe(true)
    }
    expect(readFileSync(join(prepared, "share/postgresql/extension/plpgsql.control"), "utf8")).toBe("required core extension")
    expect(() => bundlePostgres(prepared, join(directory, "packaged"))).not.toThrow()
  }, 120_000)

  test("normalizes bare local dylib dependencies before the unchanged relocation helper", () => {
    const { directory, source, options } = postgresFixture()
    put(directory, "dependency.c", "int dependency(void) { return 1; }\n")
    const library = join(source, "lib/postgresql/libdependency.dylib")
    fixtureTool(["/usr/bin/clang", "-dynamiclib", "-arch", "arm64", join(directory, "dependency.c"), "-Wl,-install_name,libdependency.dylib", "-o", library])
    put(directory, "bare-plugin.c", "extern int dependency(void); int plugin(void) { return dependency(); }\n")
    const plugin = join(source, "lib/postgresql/bare-plugin.dylib")
    fixtureTool(["/usr/bin/clang", "-dynamiclib", "-arch", "arm64", join(directory, "bare-plugin.c"), library, "-Wl,-install_name,@rpath/bare-plugin.dylib", "-o", plugin])
    const prepared = join(directory, "prepared")
    preparePostgresArm64(source, prepared, options)
    expect(fixtureTool(["/usr/bin/otool", "-L", join(prepared, "lib/postgresql/bare-plugin.dylib")])).toContain("@loader_path/libdependency.dylib")
    expect(fixtureTool(["/usr/bin/otool", "-L", plugin])).not.toContain("@loader_path/libdependency.dylib")
    fixtureTool(["/usr/bin/codesign", "--verify", join(prepared, "lib/postgresql/bare-plugin.dylib")])
    expect(() => bundlePostgres(prepared, join(directory, "packaged"))).not.toThrow()
    rmSync(library)
    expect(() => preparePostgresArm64(source, join(directory, "missing"), options)).toThrow("local dependency")
    expect(existsSync(join(directory, "missing"))).toBe(false)
  }, 120_000)

  test("rejects a Mach-O without arm64 and removes the owned incomplete copy", () => {
    const { directory, source, options } = postgresFixture()
    const intel = join(source, "bin/intel-only")
    fixtureTool(["/usr/bin/lipo", join(source, "bin/nearblack"), "-thin", "x86_64", "-output", intel])
    const original = readFileSync(intel)
    const prepared = join(directory, "prepared")
    expect(() => preparePostgresArm64(source, prepared, options)).toThrow("arm64")
    expect(existsSync(prepared)).toBe(false)
    expect(readFileSync(intel)).toEqual(original)
  }, 120_000)

  test("preserves non-Mach-O files and existing arm64 bytes", () => {
    const { directory, source, thin, options } = postgresFixture()
    put(source, "share/elf", "\x7fELF unrelated payload")
    put(source, "share/text", "unchanged")
    const prepared = join(directory, "prepared")
    preparePostgresArm64(source, prepared, options)
    expect(readFileSync(join(prepared, "bin/postgres"))).toEqual(readFileSync(thin))
    for (const file of ["share/elf", "share/text", "share/postgresql/fixture.txt"]) expect(readFileSync(join(prepared, file))).toEqual(readFileSync(join(source, file)))
  }, 120_000)

  test("refuses insufficient disk before creating an owned copy", () => {
    const { directory, source, options } = postgresFixture()
    const prepared = join(directory, "prepared")
    expect(() => preparePostgresArm64(source, prepared, { ...options, minimumFreeKiB: Number.MAX_SAFE_INTEGER })).toThrow("free disk")
    expect(existsSync(prepared)).toBe(false)
  }, 120_000)
})

describe("assembler process boundary", () => {
  // Oracle: .specs/product/mvp.md M-10 and T-INS-01 Scope > In (darwin-arm64 only).
  // Simulate process metadata only: unsupported builds must stop before discovering tools.
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"], ["win32", "arm64"]]) {
    test(`refuses unsupported ${platform}/${arch} before launching any build stage`, () => {
      const directory = fixture()
      const home = fixture()
      put(directory, "sentinel", "unchanged")
      const result = spawnSync(process.execPath, ["-e", `
        Object.defineProperties(process, {
          platform: { value: ${JSON.stringify(platform)} },
          arch: { value: ${JSON.stringify(arch)} },
        })
        const { buildServerBundle } = await import(${JSON.stringify(script)})
        await buildServerBundle()
      `], {
        cwd: directory,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: home,
          SMITHERS_BUILD_SHA: REVISION, SMITHERS_NODE_BINARY: join(directory, "nonexistent-node"),
        },
        encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("The server bundle must be built on darwin-arm64.")
      expect(result.stdout).toBe("")
      expect(readdirSync(directory)).toEqual(["sentinel"])
      expect(readFileSync(join(directory, "sentinel"), "utf8")).toBe("unchanged")
    }, TEST_TIMEOUT)
  }

  test("importing the assembler does not launch a build or require a revision", () => {
    const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(script)})`], {
      env: buildEnvironment(), stdout: "pipe", stderr: "pipe",
    })
    expect(new TextDecoder().decode(result.stderr)).toBe("")
    expect(new TextDecoder().decode(result.stdout)).toBe("")
    expect(result.exitCode).toBe(0)
  }, TEST_TIMEOUT)

  for (const revision of [undefined, "0123456"]) {
    test(`refuses ${revision === undefined ? "missing" : "short"} SMITHERS_BUILD_SHA before tool discovery`, () => {
      const result = build(revision === undefined ? {} : { SMITHERS_BUILD_SHA: revision })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("SMITHERS_BUILD_SHA")
    }, TEST_TIMEOUT)
  }
})

// Oracle: user QA ruling 2026-10-02 (host cores, workspace caches, inherited controls).
describe("build environment", () => {
  const work = "/bundle/.build"
  const node = "/tools/node/bin/node"

  test("uses host concurrency and keeps default caches in the build workspace", () => {
    const inherited = { PATH: "/usr/bin:/bin", HOME: "/owner", GOFLAGS: "-p=3", KEEP_ME: "inherited" }
    const env = bundleBuildEnvironment(work, node, "/repository", REVISION, inherited)
    expect(env.CARGO_BUILD_JOBS).toBe(String(availableParallelism()))
    expect(env.GOMAXPROCS).toBe(String(availableParallelism()))
    expect(env.CARGO_TARGET_DIR).toBe(join(work, "cargo-target"))
    expect(env.GOCACHE).toBe(join(work, "go-build"))
    expect(env.PATH).toBe("/tools/node/bin:/usr/bin:/bin")
    expect(env.SMITHERS_BUILD_SHA).toBe(REVISION)
    expect(env.GIT_CEILING_DIRECTORIES).toBe("/owner")
    expect(env.GOFLAGS).toBe("-p=3")
    expect(env.KEEP_ME).toBe("inherited")
    expect(inherited).toEqual({ PATH: "/usr/bin:/bin", HOME: "/owner", GOFLAGS: "-p=3", KEEP_ME: "inherited" })
  })

  for (const name of ["CARGO_BUILD_JOBS", "GOMAXPROCS", "GOCACHE"] as const) {
    for (const override of ["1", "", undefined]) {
      test(`${name} ${override === undefined ? "defaults when undefined" : `preserves explicit ${JSON.stringify(override)}`}`, () => {
        const env = bundleBuildEnvironment(work, node, "/repository", REVISION, { [name]: override })
        expect(env[name]).toBe(override ?? (name === "GOCACHE" ? join(work, "go-build") : String(availableParallelism())))
      })
    }
  }

  test("inherits all operator build controls together", () => {
    const overrides = { CARGO_BUILD_JOBS: "8", GOMAXPROCS: "6", GOCACHE: "/operator/go-cache", GOFLAGS: "-p=4 -trimpath" }
    const env = bundleBuildEnvironment(work, node, "/repository", REVISION, overrides)
    for (const [name, value] of Object.entries(overrides)) expect(env[name]).toBe(value)
    expect(env.PATH).toBe("/tools/node/bin:")
    expect(env.GIT_CEILING_DIRECTORIES).toBe("/repository")
  })
})

describe("compiled launcher relocation", () => {
  test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("resolves launcher files from the relocated executable with only OS tools on PATH", async () => {
    const directory = fixture()
    put(directory, "source/serve.ts", 'import { dependencyDir } from "./dependencies/server"\nimport { nativeDir } from "./NativeBackendProcess"\nimport { serverDir } from "./server"\nconsole.log(JSON.stringify({ launcherDir: import.meta.dir, nativeDir, serverDir, dependencyDir }))\n')
    put(directory, "source/NativeBackendProcess.ts", "export const nativeDir = import.meta.dir\n")
    put(directory, "source/server.ts", "export const serverDir = import.meta.dir\n")
    put(directory, "source/dependencies/server.ts", "export const dependencyDir = import.meta.dir\n")
    mkdirSync(join(directory, "original/bin"), { recursive: true })
    const original = join(directory, "original/bin/smithers-server")
    const workingDirectory = process.cwd()
    const previousTemporaries = bunBuildTemporaries(workingDirectory)
    await compileServerLauncher(join(directory, "source/serve.ts"), original)
    expect(process.cwd()).toBe(workingDirectory)
    expect(bunBuildTemporaries(workingDirectory)).toEqual(previousTemporaries)
    expect(bunBuildTemporaries(join(directory, "original/bin"))).toEqual([])
    const relocatedDirectory = join(directory, "relocated/libexec/bin")
    mkdirSync(relocatedDirectory, { recursive: true })
    const relocated = join(relocatedDirectory, "smithers-server")
    renameSync(original, relocated)
    const result = Bun.spawnSync([relocated], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" })
    expect(new TextDecoder().decode(result.stderr)).toBe("")
    expect(result.exitCode).toBe(0)
    const paths = JSON.parse(new TextDecoder().decode(result.stdout)) as { launcherDir: string; nativeDir: string; serverDir: string; dependencyDir: string }
    expect(paths.launcherDir).toBe(relocatedDirectory)
    expect(paths.nativeDir).toBe(relocatedDirectory)
    expect(paths.serverDir).toBe(relocatedDirectory)
    expect(paths.launcherDir).not.toContain(join(directory, "source"))
    // A same-named dependency outside the launcher directory keeps Bun's
    // compiled-module path; the plugin must not rewrite unrelated modules.
    expect(paths.dependencyDir).not.toBe(relocatedDirectory)
  }, TEST_TIMEOUT)

  test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("reports a launcher compilation failure", async () => {
    const directory = fixture()
    put(directory, "serve.ts", "const = invalid syntax\n")
    const workingDirectory = process.cwd()
    const previousTemporaries = bunBuildTemporaries(workingDirectory)
    await expect(compileServerLauncher(join(directory, "serve.ts"), join(directory, "smithers-server"))).rejects.toThrow()
    expect(process.cwd()).toBe(workingDirectory)
    expect(bunBuildTemporaries(workingDirectory)).toEqual(previousTemporaries)
    expect(bunBuildTemporaries(directory)).toEqual([])
  }, TEST_TIMEOUT)
})

describe("build failure cleanup", () => {
  // Raising the required free space and probing a missing path exercise real
  // df failures without filling the developer's disk or mounting an image.
  for (const failure of ["insufficient free space", "failed disk probe"] as const) {
    test(`runs cleanup after ${failure} stops normal build work`, async () => {
      const directory = fixture()
      const buildMarker = join(directory, "build-ran")
      const cleanupMarker = join(directory, "cleanup-ran")
      const options = {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        diskRoot: failure === "failed disk probe" ? join(directory, "missing") : directory,
        minimumFreeKiB: failure === "insufficient free space" ? Number.MAX_SAFE_INTEGER : undefined,
      }
      const markerCommand = (marker: string): ReadonlyArray<string> => ["/bin/sh", "-c", 'printf completed > "$1"', "marker", marker]
      await expect(runBundleCommand("build work", markerCommand(buildMarker), options)).rejects.toThrow(/disk/)
      expect(existsSync(buildMarker)).toBe(false)
      await runBundleCommand("detach PostgreSQL distribution", markerCommand(cleanupMarker), { ...options, kind: "cleanup" })
      expect(readFileSync(cleanupMarker, "utf8")).toBe("completed")
    })
  }

  test("reports cleanup command failure even when disk probing is unavailable", async () => {
    const directory = fixture()
    await expect(runBundleCommand("detach PostgreSQL distribution", ["/bin/sh", "-c", "exit 7"], {
      cwd: directory,
      diskRoot: join(directory, "missing"),
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      kind: "cleanup",
    })).rejects.toThrow("detach PostgreSQL distribution failed with exit code 7")
  })
})

describe("packaged Git resources", () => {
  for (const optionalCommands of [true, false]) {
    test(`preserves required Git links with optional commands ${optionalCommands ? "present" : "absent"} upstream`, () => {
      const directory = fixture()
      const source = join(directory, "upstream")
      const bundle = join(directory, "bundle")
      const sourceCore = join(source, "libexec/git-core")
      const bundledCore = join(bundle, "libexec/git-core")
      mkdirSync(sourceCore, { recursive: true })
      put(source, "bin/git", "required Git command")
      put(bundle, "bin/git", "required Git command")
      for (const command of ["git", "git-receive-pack", "git-upload-pack"]) symlinkSync("../../bin/git", join(sourceCore, command))
      if (optionalCommands) {
        for (const command of ["git-shell", "scalar"]) {
          put(source, `bin/${command}`, "optional upstream command")
          symlinkSync(`../../bin/${command}`, join(sourceCore, command))
        }
      }
      copyGitCoreResources(sourceCore, bundledCore)
      // Before pruning, this fails on the real copied dangling optional link.
      expect(() => validateGitBundle(bundle, [join(bundle, "bin/git"), bundledCore])).not.toThrow()
      expect(readdirSync(bundledCore).sort()).toEqual(["git", "git-receive-pack", "git-upload-pack"])
      for (const command of ["git", "git-receive-pack", "git-upload-pack"]) {
        expect(lstatSync(join(bundledCore, command)).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(bundledCore, command))).toBe("../../bin/git")
      }
      for (const command of ["git-shell", "scalar"]) {
        expect(existsSync(join(bundle, `bin/${command}`))).toBe(false)
        if (optionalCommands) expect(lstatSync(join(sourceCore, command)).isSymbolicLink()).toBe(true)
      }
      saveManifest(bundle, { bin: "git", libexec: "git" })
      expect(() => verifyBundleManifest(bundle)).not.toThrow()
    })
  }
})

// Oracle: .specs/engineering/tickets/T-INS-01.md Scope > In and Tests.
describe("release identity and tool versions", () => {
  for (const length of [40, 41, 63, 64]) {
    test(`accepts a ${length}-digit lowercase build revision without changing it`, () => {
      const revision = "abcdef0123456789".repeat(4).slice(0, length)
      expect(validateBuildSHA(revision)).toBe(revision)
    })
  }
  for (const value of [undefined, "", "a".repeat(39), "a".repeat(65), "A".repeat(40), "g".repeat(40), ` ${REVISION}`, `${REVISION}\n`]) {
    test(`rejects invalid build revision ${JSON.stringify(value)}`, () => {
      expect(() => validateBuildSHA(value)).toThrow()
    })
  }
  for (const version of ["v26.4.0", "v26.4.1", "v26.5.0", "v26.99.99"]) {
    test(`accepts Node ${version}`, () => expect(() => validateNodeVersion(version)).not.toThrow())
  }
  for (const version of ["v26.3.99", "v26.0.0", "v25.99.99", "v27.0.0", "", "v26.4", "v26.4.0-rc.1", "v26.4.0garbage"]) {
    test(`rejects Node ${JSON.stringify(version)}`, () => expect(() => validateNodeVersion(version)).toThrow())
  }
  // Independent oracle: PostgresApp/PostgresApp v2.9.6 release and qualified DMG --version.
  for (const version of ["postgres (PostgreSQL) 18.0", "postgres (PostgreSQL) 18.1", "postgres (PostgreSQL) 18.6 (Postgres.app)"]) {
    test(`accepts ${version}`, () => expect(() => validatePostgresVersion(version)).not.toThrow())
  }
  for (const version of [
    "postgres (PostgreSQL) 17.9", "postgres (PostgreSQL) 19.0", "",
    "postgres (PostgreSQL) 18garbage", "not PostgreSQL 18",
    "postgres (PostgreSQL) 17.9 (Postgres.app)", "postgres (PostgreSQL) 19.0 (Postgres.app)",
    "postgres (PostgreSQL) 18beta1 (Postgres.app)", "postgres (PostgreSQL) 18rc1 (Postgres.app)",
    "postgres (PostgreSQL) 18devel (Postgres.app)", "postgres (PostgreSQL) 18.6-rc.1 (Postgres.app)",
    "postgres (PostgreSQL) 18.6 (unknown)", "postgres (PostgreSQL) 18.6 (Postgres.app)garbage"
  ]) {
    test(`rejects PostgreSQL ${JSON.stringify(version)}`, () => expect(() => validatePostgresVersion(version)).toThrow())
  }
  test("reports the rejected PostgreSQL version", () => {
    const version = "postgres (PostgreSQL) 18rc1 (Postgres.app)"
    expect(() => validatePostgresVersion(version)).toThrow(`The server bundle requires PostgreSQL 18; received ${JSON.stringify(version)}.`)
  })
  test("accepts the backend-qualified msb release", () => {
    expect(() => validateMsbVersion("msb 0.6.16")).not.toThrow()
  })
  for (const version of ["msb 0.6.15", "msb 0.6.17", "msb 0.7.0", "msb 0.6.16-rc.1", "msb 0.6.16garbage", "", "other 0.6.16"]) {
    test(`rejects msb ${JSON.stringify(version)}`, () => expect(() => validateMsbVersion(version)).toThrow())
  }
  test("checks an explicitly supplied backend-qualified msb version", () => {
    expect(() => validateMsbVersion("msb 0.6.17", "0.6.17")).not.toThrow()
    expect(() => validateMsbVersion("msb 0.6.16", "0.6.17")).toThrow()
  })
})

// Oracle: .specs/engineering/tickets/T-INS-01.md Scope > In and Tests;
// .specs/engineering/checks/C-INS-05.md Pass when, step 3.
describe("bundle manifest", () => {
  test("records every payload with independently calculated hashes and the nearest producing stage", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "node payload\n")
    put(bundle, "bin/smithers-server", "launcher payload\n")
    put(bundle, "postgres/share/.hidden", "postgres payload\n")
    put(bundle, "manifest.json", "an earlier manifest must be excluded")
    const manifest = createBundleManifest(bundle, REVISION, { bin: "node-runtime", "bin/smithers-server": "launcher", postgres: "postgres" })
    expect(manifest).toEqual({
      version: 1,
      platform: "darwin-arm64",
      revision: REVISION,
      files: {
        "bin/node": { sha256: sha256("node payload\n"), stage: "node-runtime" },
        "bin/smithers-server": { sha256: sha256("launcher payload\n"), stage: "launcher" },
        "postgres/share/.hidden": { sha256: sha256("postgres payload\n"), stage: "postgres" },
      },
    })
    // Construction returns data; writing belongs to the caller.
    expect(readFileSync(join(bundle, "manifest.json"), "utf8")).toBe("an earlier manifest must be excluded")
  })

  test("verifies a serialized manifest and zero-byte files", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "")
    saveManifest(bundle)
    expect(() => verifyBundleManifest(bundle)).not.toThrow()
  })

  test("records payload filenames that coincide with JavaScript object properties", () => {
    const bundle = fixture()
    put(bundle, "__proto__", "prototype payload")
    put(bundle, "constructor", "constructor payload")
    const manifest = saveManifest(bundle, Object.fromEntries([["__proto__", "runtime"], ["constructor", "runtime"]]))
    expect(Object.keys(manifest.files).sort()).toEqual(["__proto__", "constructor"])
    expect(Object.hasOwn(manifest.files, "__proto__")).toBe(true)
    expect(manifest.files["__proto__"]).toEqual({ sha256: sha256("prototype payload"), stage: "runtime" })
    expect(() => verifyBundleManifest(bundle)).not.toThrow()
  })

  test("rejects a payload without a producing stage", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    expect(() => createBundleManifest(bundle, REVISION, {})).toThrow()
    expect(() => createBundleManifest(bundle, REVISION, { bin: "" })).toThrow()
  })

  test("does not attribute a similarly named directory to the wrong stage", () => {
    const bundle = fixture()
    put(bundle, "binary/node", "runtime")
    expect(() => createBundleManifest(bundle, REVISION, { bin: "node-runtime" })).toThrow()
  })

  test("rejects an invalid revision during manifest construction", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    expect(() => createBundleManifest(bundle, "short", { bin: "runtime" })).toThrow()
  })

  test("rejects an untracked payload added after assembly", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    saveManifest(bundle)
    put(bundle, "bin/untracked", "extra")
    expect(() => verifyBundleManifest(bundle)).toThrow()
  })

  test("rejects a listed payload removed after assembly", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    saveManifest(bundle)
    rmSync(join(bundle, "bin/node"))
    expect(() => verifyBundleManifest(bundle)).toThrow()
  })

  test("rejects a payload whose bytes changed after assembly", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    saveManifest(bundle)
    put(bundle, "bin/node", "tampered")
    expect(() => verifyBundleManifest(bundle)).toThrow()
  })

  test("hashes a contained relative symlink by its target text and verifies it", () => {
    const bundle = fixture()
    put(bundle, "lib/node", "runtime")
    mkdirSync(join(bundle, "bin"))
    symlinkSync("../lib/node", join(bundle, "bin/node"))
    const manifest = saveManifest(bundle, { lib: "runtime", bin: "runtime" })
    expect(manifest.files["bin/node"]).toEqual({ sha256: sha256("../lib/node"), stage: "runtime" })
    expect(() => verifyBundleManifest(bundle)).not.toThrow()
  })

  test("tracks a contained directory symlink without recursively duplicating its payload", () => {
    const bundle = fixture()
    put(bundle, "lib/node", "runtime")
    mkdirSync(join(bundle, "bin"))
    symlinkSync("../lib", join(bundle, "bin/libraries"))
    const manifest = saveManifest(bundle, { lib: "runtime", bin: "runtime" })
    expect(manifest.files).toEqual({
      "lib/node": { sha256: sha256("runtime"), stage: "runtime" },
      "bin/libraries": { sha256: sha256("../lib"), stage: "runtime" },
    })
    expect(() => verifyBundleManifest(bundle)).not.toThrow()
  })

  test("rejects a symlink to an external directory", () => {
    const bundle = fixture()
    mkdirSync(join(bundle, "bin"))
    const outside = join(root, "outside-directory")
    mkdirSync(outside)
    writeFileSync(join(outside, "node"), "external")
    symlinkSync("../../outside-directory", join(bundle, "bin/libraries"))
    expect(() => createBundleManifest(bundle, REVISION, { bin: "runtime" })).toThrow()
  })

  test("rejects retargeting a symlink even when the new payload has identical bytes", () => {
    const bundle = fixture()
    put(bundle, "bin/first", "same bytes")
    put(bundle, "bin/second", "same bytes")
    symlinkSync("first", join(bundle, "bin/node"))
    saveManifest(bundle)
    rmSync(join(bundle, "bin/node"))
    symlinkSync("second", join(bundle, "bin/node"))
    expect(() => verifyBundleManifest(bundle)).toThrow()
  })

  for (const kind of ["absolute", "escaping", "dangling", "indirect escape", "cycle"] as const) {
    test(`rejects a ${kind} symlink during assembly`, () => {
      const bundle = fixture()
      put(bundle, "bin/inside", "runtime")
      const outside = join(root, "outside")
      writeFileSync(outside, "external")
      const target = kind === "absolute" ? join(bundle, "bin/inside")
        : kind === "escaping" ? "../../outside"
        : kind === "dangling" ? "missing"
        : kind === "cycle" ? "node"
        : "alias"
      if (kind === "indirect escape") symlinkSync("../../outside", join(bundle, "bin/alias"))
      symlinkSync(target, join(bundle, "bin/node"))
      expect(() => createBundleManifest(bundle, REVISION, { bin: "runtime" })).toThrow()
    })
  }

  test("verification rejects an escaping symlink even with a matching manifest hash", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    saveManifest(bundle)
    const outside = join(root, "outside-verification")
    writeFileSync(outside, "external")
    rmSync(join(bundle, "bin/node"))
    symlinkSync("../../outside-verification", join(bundle, "bin/node"))
    editManifest(bundle, (manifest) => { manifest.files["bin/node"].sha256 = sha256("../../outside-verification") })
    expect(() => verifyBundleManifest(bundle)).toThrow()
  })

  for (const path of ["../outside", "/absolute", "bin/../outside", "bin//node", "./bin/node", "manifest.json"]) {
    test(`rejects unsafe manifest path ${JSON.stringify(path)}`, () => {
      const bundle = fixture()
      put(bundle, "bin/node", "runtime")
      saveManifest(bundle)
      editManifest(bundle, (manifest) => { manifest.files[path] = { sha256: sha256("runtime"), stage: "runtime" } })
      expect(() => verifyBundleManifest(bundle)).toThrow()
    })
  }

  for (const [label, edit] of [
    ["invalid revision", (manifest: any) => { manifest.revision = "bad" }],
    ["non-string revision", (manifest: any) => { manifest.revision = [REVISION] }],
    ["unsupported platform", (manifest: any) => { manifest.platform = "linux-arm64" }],
    ["unsupported schema", (manifest: any) => { manifest.version = 2 }],
    ["missing stage", (manifest: any) => { delete manifest.files["bin/node"].stage }],
    ["empty stage", (manifest: any) => { manifest.files["bin/node"].stage = "" }],
    ["invalid hash", (manifest: any) => { manifest.files["bin/node"].sha256 = "not-a-hash" }],
    ["missing file map", (manifest: any) => { delete manifest.files }],
  ] as const) {
    test(`rejects a manifest with ${label}`, () => {
      const bundle = fixture()
      put(bundle, "bin/node", "runtime")
      saveManifest(bundle)
      editManifest(bundle, edit)
      expect(() => verifyBundleManifest(bundle)).toThrow()
    })
  }

  test("rejects a missing or malformed manifest", () => {
    const bundle = fixture()
    put(bundle, "bin/node", "runtime")
    expect(() => verifyBundleManifest(bundle)).toThrow()
    put(bundle, "manifest.json", "{invalid")
    expect(() => verifyBundleManifest(bundle)).toThrow()
  })
})

const compile = (argv: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["/usr/bin/cc", ...argv], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}
const fakeNode = (directory: string, foreignLibrary?: string): string => {
  put(directory, "node.c", foreignLibrary === undefined
    ? '#include <stdio.h>\nint main(void) { puts("v26.4.0"); return 0; }\n'
    : '#include <stdio.h>\nint foreign(void);\nint main(void) { puts("v26.4.0"); return foreign(); }\n')
  mkdirSync(join(directory, "bin"), { recursive: true })
  const executable = join(directory, "bin/node")
  compile(["-o", executable, join(directory, "node.c"), ...(foreignLibrary === undefined ? [] : [foreignLibrary])])
  const pnpmPin = (JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8")) as { packageManager: string }).packageManager
  put(directory, "bin/pnpm", `#!/bin/sh\necho ${pnpmPin.slice("pnpm@".length)}\n`)
  chmodSync(join(directory, "bin/pnpm"), 0o755)
  return executable
}

// Oracle: .specs/engineering/tickets/T-INS-01.md Tests;
// .specs/engineering/checks/C-INS-05.md Pass when, step 5.
describe("macOS executable linkage gate", () => {
  // cc's Mach-O output and otool are macOS facilities, so these fixtures
  // deliberately skip on other hosts rather than substituting mocked output.
  test.skipIf(process.platform !== "darwin")("finds a non-system dylib linked by an actual executable", () => {
    const directory = fixture()
    const library = join(directory, "libforeign.dylib")
    put(directory, "foreign.c", "int foreign(void) { return 0; }\n")
    put(directory, "node.c", '#include <stdio.h>\nint foreign(void);\nint main(void) { puts("v26.4.0"); return foreign(); }\n')
    compile(["-dynamiclib", "-install_name", library, "-o", library, join(directory, "foreign.c")])
    compile(["-o", join(directory, "node"), join(directory, "node.c"), library])
    expect(foreignLibraries(join(directory, "node"))).toEqual([library])
    const node = fakeNode(directory, library)
    const result = build({ SMITHERS_BUILD_SHA: REVISION, SMITHERS_NODE_BINARY: node, PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}` })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`loads ${library}`)
  }, TEST_TIMEOUT)

  test.skipIf(process.platform !== "darwin")("accepts an actual executable loading only macOS system libraries", () => {
    const directory = fixture()
    put(directory, "node.c", '#include <stdio.h>\nint main(void) { puts("v26.4.0"); return 0; }\n')
    compile(["-o", join(directory, "node"), join(directory, "node.c")])
    expect(foreignLibraries(join(directory, "node"))).toEqual([])
    const node = fakeNode(directory)
    const result = build({ SMITHERS_BUILD_SHA: REVISION, SMITHERS_NODE_BINARY: node, PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}` })
    expect(result.exitCode).not.toBe(0)
    // Bun also prints neighboring source lines in uncaught-error diagnostics.
    // Match the emitted error, so the preceding linkage branch is not mistaken
    // for a linkage rejection while checking the later license failure.
    expect(result.stderr).not.toContain("error: SMITHERS_NODE_BINARY must link")
    expect(result.stderr).toContain("error: Node license is unavailable")
  }, TEST_TIMEOUT)

  test.skipIf(process.platform !== "darwin")("fails closed when the executable is unavailable to otool", () => {
    const directory = fixture()
    expect(() => foreignLibraries(join(directory, "node"))).toThrow(/otool/)
  }, TEST_TIMEOUT)
})

// T-INS-01 retained web stage: run pnpm and the real installed Vite parser.
test("web stage writes real Vite assets into the bundle prefix", () => {
  const fixture = mkdtempSync(join(resolve(import.meta.dir, "../../../.artifacts"), "vite-stage-"))
  try {
    const vite = join(dirname(Bun.resolveSync("vite/package.json", resolve(import.meta.dir, ".."))), "bin/vite.js")
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ scripts: { "build:web": `node ${JSON.stringify(vite)} build --configLoader runner` } }))
    writeFileSync(join(fixture, "index.html"), '<script type="module" src="/main.js"></script>')
    writeFileSync(join(fixture, "main.js"), 'document.body.textContent = "bundle"')
    const bundle = join(fixture, "output")
    const result = spawnSync("pnpm", webBundleCommand("pnpm", bundle).slice(1), { cwd: fixture, encoding: "utf8", timeout: 30_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(bundle, "views/mainview/index.html"))).toBe(true)
    expect(readdirSync(join(bundle, "views/mainview/assets")).some((name) => name.endsWith(".js"))).toBe(true)
    expect(existsSync(join(fixture, "dist"))).toBe(false)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
}, 40_000)

// ToolBuild's declared-output contract rejects links; C-INS-05 requires a
// relocatable payload whose resources never point outside the bundle.
test("materializes contained file links and refuses escaping, cyclic or directory links", () => {
  const root = fixture()
  put(root, "bin/git", "git payload")
  chmodSync(join(root, "bin/git"), 0o755)
  mkdirSync(join(root, "libexec/git-core"), { recursive: true })
  symlinkSync("../../bin/git", join(root, "libexec/git-core/git"))
  materializeBundleFileLinks(root)
  expect(lstatSync(join(root, "libexec/git-core/git")).isFile()).toBe(true)
  expect(readFileSync(join(root, "libexec/git-core/git"), "utf8")).toBe("git payload")
  expect(lstatSync(join(root, "libexec/git-core/git")).mode & 0o777).toBe(0o755)
  symlinkSync(process.execPath, join(root, "outside"))
  expect(() => materializeBundleFileLinks(root)).toThrow("escapes")
  rmSync(join(root, "outside"))
  symlinkSync("cycle", join(root, "cycle"))
  expect(() => materializeBundleFileLinks(root)).toThrow()
  rmSync(join(root, "cycle"))
  symlinkSync("bin", join(root, "directory-link"))
  expect(() => materializeBundleFileLinks(root)).toThrow("regular file")
})
