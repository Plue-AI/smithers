/**
 * A repository file name is data, never shell syntax.
 *
 * The scanner reads tsconfig names off the disk and turns each one into a
 * typecheck command. Before these commands were argv they were lines, and a
 * line is what a shell reads: `tsconfig.;touch pwned;.json` typechecked
 * nothing and ran `touch pwned`. Every case here is a legal POSIX file name
 * and every one has to arrive at the executable as exactly one argument.
 *
 * The proof is three-sided. The derivation produces an argv holding the raw
 * name. The rendering the prompt, the report, and the grant share is the
 * kernel's own rendering of that argv, so the grant matches the spawn. And a
 * real child process, spawned the way `Verify` spawns, sees the name as one
 * argument and leaves no marker behind.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Capability, GrantStore, Workspace } from "@smthrs/kernel"
import * as KernelCommandLine from "@smthrs/kernel/CommandLine"
import * as Contract from "@smthrs/migrate/flow/Contract"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as Verify from "@smthrs/migrate/flow/Verify"
import * as Scan from "@smthrs/migrate/Scan"
import * as Units from "@smthrs/migrate/Units"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, nodeLayer } from "../fixtures/helpers.ts"

/** Every shape of hostile file name a POSIX filesystem accepts. */
const hostileNames: ReadonlyArray<string> = [
  "tsconfig.a b.json",
  "tsconfig.'quoted'.json",
  "tsconfig.\"double\".json",
  "tsconfig.;touch pwned;.json",
  "tsconfig.$(touch pwned).json",
  "tsconfig.`touch pwned`.json",
  "tsconfig.a\nb.json",
  "tsconfig.|touch pwned.json",
  "tsconfig.>pwned.json"
]

/** A copy of the fixture with one valid tsconfig per hostile name, plus one in a directory whose name starts with a dash. */
const hostileProject = (): { readonly root: string; readonly paths: ReadonlyArray<string> } => {
  const root = copyFixture("jsx-single")
  const paths: Array<string> = []
  for (const name of hostileNames) {
    // Windows cannot create these names. Their literal bytes still run
    // through the renderer and the real argv child below on every host.
    if (process.platform === "win32" && /[<>"|\u0000-\u001f]/.test(name)) continue
    writeFileSync(join(root, name), "{}\n")
    paths.push(name)
  }
  mkdirSync(join(root, "-evil"), { recursive: true })
  writeFileSync(join(root, "-evil", "tsconfig.json"), "{}\n")
  paths.push("-evil/tsconfig.json")
  return { root, paths }
}

describe("derived typecheck commands over hostile tsconfig names", () => {
  it.effect("derive one argv per tsconfig, with the raw name as one argument", () =>
    Effect.gen(function*() {
      const { paths, root } = hostileProject()
      const scanned = yield* Scan.scan(root).pipe(Effect.provide(nodeLayer))
      const derived = Units.verifyCommands(scanned.detection)

      const typecheck = derived.typecheck.filter((command) => typeof command !== "string")
      expect(typecheck).toHaveLength(derived.typecheck.length)
      for (const path of paths) {
        expect(typecheck).toContainEqual(Units.argv("tsc", "--noEmit", "-p", path))
      }
      // Nothing was split, joined, or re-quoted on the way in.
      for (const command of typecheck) expect(command.args).toHaveLength(3)
    }))

  it("renders the line the kernel renders for the argv it spawns, so the grant and the spawn agree", () => {
    for (const path of [...hostileNames, "-evil/tsconfig.json", "tsconfig.json"]) {
      const command = Units.argv("tsc", "--noEmit", "-p", path)
      const rendered = Contract.commandLine(command)
      expect(rendered).toBe(KernelCommandLine.render(ChildProcess.make("tsc", ["--noEmit", "-p", path])))
      // The name is one quoted token: nothing in it can end the token early.
      expect(rendered).toBe(`tsc --noEmit -p ${KernelCommandLine.quote(path)}`)
      if (/[^A-Za-z0-9_@%+=:,./-]/.test(path)) expect(rendered.endsWith(`'`)).toBe(true)
    }
  })

  it("grant a shell override as the resource the kernel checks when it spawns the line", () => {
    for (
      const line of [
        "vitest run",
        "tsc -b && eslint .",
        "node -e \"process.exit(0)\"",
        "npm test 2>&1",
        "npm test >/dev/null",
        "npm test > out.txt",
        "a; b",
        "echo $HOME",
        "echo `id`",
        "a | b",
        "a\nb",
        "it's"
      ]
    ) {
      const kernel = KernelCommandLine.resource(ChildProcess.make(line, { shell: true, cwd: "/tmp/project" }), {
        contains: () => true
      })
      expect([line, Contract.grantResource(line)]).toEqual([line, kernel])
    }
    const argv = Units.argv("tsc", "--noEmit", "-p", "tsconfig.;touch pwned;.json")
    expect(Contract.grantResource(argv)).toBe(
      KernelCommandLine.resource(ChildProcess.make(argv.executable, [...argv.args], { cwd: "/tmp/project" }), {
        contains: () => true
      })
    )
  })

  it.effect("refuse every process spawn, the project's own verification lines included", () =>
    Effect.gen(function*() {
      const root = "/tmp/project"
      const hostile = "tsconfig.;touch pwned;.json"
      const commands: Contract.Commands = {
        typecheck: [Units.argv("tsc", "--noEmit", "-p", hostile)],
        test: Units.argv("node", "-e", "process.exit(0)"),
        flowsDir: "flows"
      }
      const grants = yield* GrantStore.GrantStore
      const outcome = (resource: string) =>
        grants.check(Capability.make("proc:spawn", resource)).pipe(
          Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "granted" })
        )

      // 401d89f9 removed every migration-agent process grant (verification runs in the orchestrator), so an unattended spawn check fails PermissionRequired.
      for (const line of Layers.verificationCommands(commands)) {
        expect([line, yield* outcome(line)]).toEqual([line, "@smthrs/capability/PermissionRequired"])
      }
      expect(yield* outcome(`tsc --noEmit -p ${hostile}`)).toBe("@smthrs/capability/PermissionRequired")
      expect(yield* outcome("touch pwned")).toBe("@smthrs/capability/PermissionRequired")
      expect(yield* outcome("tsc --noEmit -p tsconfig.json")).toBe("@smthrs/capability/PermissionRequired")
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({
          root: Effect.runSync(Layers.migrationRoot("/tmp/project")),
          runStatePaths: [],
          commands: {
            typecheck: [Units.argv("tsc", "--noEmit", "-p", "tsconfig.;touch pwned;.json")],
            test: Units.argv("node", "-e", "process.exit(0)"),
            flowsDir: "flows"
          }
        })
      }).pipe(Layer.provide(Workspace.layer("/tmp/project")), Layer.orDie)
    )))

  it.live("spawn the executable with the name as one argument and run nothing else", () =>
    Effect.gen(function*() {
      const { paths, root } = hostileProject()
      const record = join(root, "argv.txt")
      const recorder = join(root, "record-argv.cjs")
      writeFileSync(
        recorder,
        `require("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n")`
      )
      // Resolve only the fixture's tsc to a real Node child. Preserve the
      // derived argv and spawn options without relying on a POSIX shim.
      const native = yield* ChildProcessSpawner.pipe(Effect.provide(NodeServices.layer))
      const recording = makeSpawner((command) => {
        expect(command._tag).toBe("StandardCommand")
        if (command._tag !== "StandardCommand") return native.spawn(command)
        expect(command.command).toBe("tsc")
        expect(command.options.shell).not.toBe(true)
        return native.spawn(ChildProcess.make(process.execPath, [recorder, ...command.args], command.options))
      })
      const scanned = yield* Scan.scan(root).pipe(Effect.provide(nodeLayer))
      const commands = Layers.commandsFor(scanned.detection, {}, "flows")
      const result = yield* Verify.run({
        root,
        commands: { ...commands, install: undefined, format: undefined, test: undefined },
        expectFlows: false
      }, { command: 30_000 }).pipe(
        Effect.provideService(ChildProcessSpawner, recording),
        Effect.provide(NodeServices.layer)
      )

      expect(result.typecheck.map((entry) => entry.exitCode)).toEqual(result.typecheck.map(() => 0))
      const calls = readFileSync(record, "utf8").trimEnd().split("\n").map((call) => JSON.parse(call))
      for (const path of paths) expect(calls).toContainEqual(["--noEmit", "-p", path])
      expect(calls).toHaveLength(commands.typecheck.length)
      // None of the markers the names name were touched.
      expect(existsSync(join(root, "pwned"))).toBe(false)
      for (const path of paths) expect(existsSync(join(root, path))).toBe(true)
    }))
})

describe("Verify over an argv command", () => {
  it.effect("hands every argument through literally, whatever it contains", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const hostile = [
        ...hostileNames,
        "a b",
        "'q'",
        "\"d\"",
        ";touch pwned;",
        "$(touch pwned)",
        "`touch pwned`",
        "line\nbreak",
        "-dash",
        "--",
        "|",
        ">pwned",
        "*"
      ]
      const script = "require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(1)))"

      const result = yield* Verify.run({
        root,
        commands: { typecheck: [], test: Units.argv("node", "-e", script, "--", ...hostile), flowsDir: "flows" },
        expectFlows: false
      }).pipe(Effect.provide(NodeServices.layer))

      expect(result.tests?.exitCode).toBe(0)
      expect(JSON.parse(readFileSync(join(root, "argv.json"), "utf8"))).toEqual(hostile)
      expect(existsSync(join(root, "pwned"))).toBe(false)
      // The report shows the line the grant was written for, quoted.
      expect(result.tests?.command).toBe(Contract.commandLine(Units.argv("node", "-e", script, "--", ...hostile)))
    }))

  it.effect("keeps an operator override a shell line, because the operator wrote it", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const result = yield* Verify.run({
        root,
        commands: {
          typecheck: [],
          test: "node -e \"process.exit(0)\" && node -e \"process.exit(0)\"",
          flowsDir: "flows"
        },
        expectFlows: false
      }).pipe(Effect.provide(NodeServices.layer))

      expect(result.tests?.exitCode).toBe(0)
      expect(result.tests?.command).toBe("node -e \"process.exit(0)\" && node -e \"process.exit(0)\"")
    }))
})

describe("Units.simpleCommand", () => {
  it("accepts a plain word list and nothing a shell would interpret", () => {
    expect(Units.simpleCommand("bun test tests")).toEqual(Units.argv("bun", "test", "tests"))
    expect(Units.simpleCommand("  pnpm run check --filter=@app/core  ")).toEqual(
      Units.argv("pnpm", "run", "check", "--filter=@app/core")
    )
    for (
      const line of [
        "bun test && rm -rf /",
        "bun test; touch pwned",
        "bun test $(touch pwned)",
        "bun test `touch pwned`",
        "bun test | tee log",
        "bun test > out",
        "bun test 'a b'",
        "bun test \"a b\"",
        "bun test\ntouch pwned",
        "-rf /",
        "",
        "   "
      ]
    ) {
      expect([line, Units.simpleCommand(line)]).toEqual([line, undefined])
    }
  })
})
