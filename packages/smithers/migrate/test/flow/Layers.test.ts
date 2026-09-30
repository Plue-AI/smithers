/**
 * The grant rules a migration runs under, asked of a real kernel grant store.
 *
 * The rules are the only place the tool's two promises about run state are
 * *enforced* rather than asserted, so they are tested by asking the store the
 * same questions the kernel asks it: may this write land, and may this command
 * run. The store is unattended, which is what a migration is, so anything the
 * rules do not name is refused rather than queued for a person.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Capability, GrantStore, Workspace } from "@smthrs/kernel"
import * as Command from "@smthrs/migrate/flow/Command"
import type * as Contract from "@smthrs/migrate/flow/Contract"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as Transform from "@smthrs/migrate/flow/Transform"
import * as Verify from "@smthrs/migrate/flow/Verify"
import * as Scan from "@smthrs/migrate/Scan"
import * as Units from "@smthrs/migrate/Units"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, nodeLayer } from "../fixtures/helpers.ts"

const root = Effect.runSync(Layers.migrationRoot("/tmp/project"))

const commands: Contract.Commands = {
  install: "pnpm install --frozen-lockfile",
  format: "dprint fmt",
  typecheck: ["tsc --noEmit -p tsconfig.json", "tsc --noEmit -p test/tsconfig.json"],
  test: "vitest run",
  flowsDir: "flows"
}

const runStatePaths = [
  ".smithers/claude-mirror-subscriptions.json",
  ".smithers/executions",
  ".smithers/smithers.db"
]

const store = GrantStore.layer({
  attended: false,
  rules: Layers.rules({ root, runStatePaths, commands })
}).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)

/** Whether the store lets one capability through. */
const permitted = (action: Capability.Action, resource: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const grants = yield* GrantStore.GrantStore
    return yield* grants.check(Capability.make(action, resource)).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    )
  }).pipe(Effect.provide(store))

describe("Layers composition contracts", () => {
  it("keeps composition checks out of the public API", () => {
    // @ts-expect-error the compilation assertion is an implementation detail
    type InternalAssertion = Layers.CompositionRootsAreComplete
    expectTypeOf<InternalAssertion>().toEqualTypeOf<InternalAssertion>()
  })

  it("provides every service required by each composition root", () => {
    expectTypeOf<Layer.Services<ReturnType<typeof Layers.layerNode>>>().toEqualTypeOf<never>()
    expectTypeOf<Layer.Services<ReturnType<typeof Layers.layerNodeScanned>>>().toEqualTypeOf<never>()
    expectTypeOf<Layer.Services<ReturnType<typeof Layers.layerScripted>>>().toEqualTypeOf<never>()
  })
})

describe("Layers.verificationCommands", () => {
  it("is every command a verification runs, once each", () => {
    expect(Layers.verificationCommands(commands)).toEqual([
      "pnpm install --frozen-lockfile",
      "dprint fmt",
      "tsc --noEmit -p tsconfig.json",
      "tsc --noEmit -p test/tsconfig.json",
      "vitest run"
    ])
  })

  it("omits what the project does not configure", () => {
    expect(Layers.verificationCommands({ typecheck: [], flowsDir: "flows" })).toEqual([])
  })

  it("keeps one grant for a command that is both the typecheck and the test", () => {
    expect(
      Layers.verificationCommands({ typecheck: ["bun run check"], test: "bun run check", flowsDir: "flows" })
    ).toEqual(["bun run check"])
  })
})

describe("Layers.commandsFor over a real project", () => {
  it.effect("reads the project's own commands when the operator names none", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(project)

      const derived = Layers.commandsFor(scanned.detection, {}, "flows")

      expect(derived.flowsDir).toBe("flows")
      expect(derived.typecheck.length).toBeGreaterThan(0)
      expect(derived.test).toEqual(Units.argv("npm", "run", "test"))
      // What the host grants is the rendered line of the same argv.
      expect(Layers.verificationCommands(derived)).toContain("npm run test")
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("takes the operator's overrides, so the host permits what the brief lists", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(project)

      // The same overrides the live and scripted runs pass. Before these
      // must reach both the unit brief and the orchestrator's verification.
      const derived = Layers.commandsFor(
        scanned.detection,
        { typecheck: [], test: "node -e \"process.exit(0)\"" },
        "flows"
      )

      expect(derived.typecheck).toEqual([])
      expect(derived.test).toBe("node -e \"process.exit(0)\"")
      expect(Layers.verificationCommands(derived)).toContain("node -e \"process.exit(0)\"")
    }).pipe(Effect.provide(nodeLayer)))
})

describe("Layers.rules over a real grant store", () => {
  it.effect("refuses a relative root in the smart constructor rules are built from", () =>
    Effect.gen(function*() {
      // `rules` takes a `MigrationRoot`, so the only way to a rule set is
      // through this constructor and a relative root never reaches a pattern.
      const failure = yield* Effect.flip(Layers.migrationRoot("../project"))

      expect(Command.isMigrateError(failure)).toBe(true)
      if (Command.isMigrateError(failure)) {
        expect(failure.code).toBe("unsupported-project")
        expect(failure.message).toContain("../project")
      }
      // The other half of the same claim, which only a typecheck can make: an
      // unproven string is not a root `rules` accepts, so the relative case is
      // unreachable rather than guarded against. `tsc` fails this file if this
      // call ever compiles.
      // @ts-expect-error a bare string is not a proven-absolute migration root
      expect(() => Layers.rules({ root: "/tmp/project", runStatePaths, commands })).not.toThrow()
    }))

  it.effect("refuses a relative root in the package's own error channel when a host is composed", () =>
    Effect.gen(function*() {
      // A library caller with a relative path gets a `MigrateError` an entry
      // point can map to an exit status, not a defect from inside a layer.
      for (
        const layer of [
          Layers.layerNode({ root: "relative/project", commands, runStatePaths }),
          Layers.layerNodeScanned({ root: "relative/project" })
        ]
      ) {
        const failure = yield* Effect.flip(Effect.scoped(Layer.build(layer)))
        expect(Command.isMigrateError(failure)).toBe(true)
        if (Command.isMigrateError(failure)) {
          expect(failure.code).toBe("unsupported-project")
          expect(failure.message).toContain("relative/project")
        }
      }
    }))

  it.effect("lets a unit write inside the project", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", `${root}/flows/simple/flow.ts`)).toBe(true)
      expect(yield* permitted("fs:read", `${root}/simple-workflow.jsx`)).toBe(true)
    }))

  it.effect("lets a unit write the project root itself, which is a file's parent", () =>
    Effect.gen(function*() {
      // `write` creates the parent directory of its target before writing it,
      // and the parent of `package.json` is the root. A rule set that granted
      // only `<root>/**` let the agent write `flows/x/flow.ts` and refused
      // `package.json`, which is the one file the dependencies unit exists to
      // rewrite. The refusal reached the model as "Could not write
      // package.json", with nothing to say it was a permission.
      expect(yield* permitted("fs:write", root)).toBe(true)
      expect(yield* permitted("fs:write", `${root}/package.json`)).toBe(true)
    }))

  it.effect("refuses a write to the project's 0.x run state", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", `${root}/.smithers/smithers.db`)).toBe(false)
      expect(yield* permitted("fs:write", `${root}/.smithers/executions/run-1/stdout.log`)).toBe(false)
      expect(yield* permitted("fs:write", `${root}/.smithers/claude-mirror-subscriptions.json`)).toBe(false)
    }))

  it.effect("keeps migration-owned lock state outside every agent filesystem grant", () =>
    Effect.gen(function*() {
      for (const action of ["fs:read", "fs:write"] as const) {
        for (
          const target of [".smithers-migrate", ".smithers-migrate/apply.lock", ".smithers-migrate/apply.lock.sqlite"]
        ) {
          expect([action, target, yield* permitted(action, `${root}/${target}`)]).toEqual([action, target, false])
        }
      }
    }))

  it.effect("refuses to read, list, or stat run state too, because a read is a copy into the model", () =>
    Effect.gen(function*() {
      // The contract says "do not read", and a sentence is not an enforcement.
      // Every filesystem action on the exact path and on everything under it
      // is vetoed, and the veto is configured, so no envelope lifts it.
      expect(yield* permitted("fs:read", `${root}/.smithers/smithers.db`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/executions`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/executions/run-1/stdout.log`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/claude-mirror-subscriptions.json`)).toBe(false)
      // The sibling that is source, not state, stays readable and writable.
      expect(yield* permitted("fs:read", `${root}/.smithers/workflows/review.tsx`)).toBe(true)
      expect(yield* permitted("fs:write", `${root}/.smithers/workflows/review.tsx`)).toBe(true)
      expect(yield* permitted("fs:read", `${root}/.smithers`)).toBe(true)
    }))

  it.effect("refuses a write outside the project entirely", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", "/etc/hosts")).toBe(false)
    }))

  it.effect("refuses agent execution even for configured verification commands", () =>
    Effect.gen(function*() {
      for (const command of Layers.verificationResources(commands)) {
        expect([command, yield* permitted("proc:spawn", command)]).toEqual([command, false])
      }
    }))

  it.effect("runs configured verification commands through the trusted orchestrator", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const result = yield* Verify.run({
        root: project,
        commands: { typecheck: ["node -e \"\" && node -e \"\""], flowsDir: "flows" },
        expectFlows: false
      })
      expect(result.typecheck[0]?.exitCode).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)))

  for (const approved of ["npm test -- tests/*", "npm test -- tests/?", "npm test -- *"]) {
    it.effect(`does not turn ${approved} into a wildcard shell grant`, () =>
      Effect.gen(function*() {
        const grants = yield* GrantStore.GrantStore
        // These are permission probes only. No process is spawned.
        for (
          const unexpected of [
            "npm test -- tests/x; rm -rf ~",
            `${approved}; printf PROBE_ONLY`,
            `${approved} && printf PROBE_ONLY`,
            `${approved} | cat`,
            `${approved}\nprintf PROBE_ONLY`,
            `${approved}$(printf PROBE_ONLY)`,
            `${approved}\`printf PROBE_ONLY\``,
            "npm test -- tests/x",
            "npm test --"
          ]
        ) {
          const allowed = yield* grants.check(Capability.make("proc:spawn", unexpected)).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false))
          )
          expect([unexpected, allowed]).toEqual([unexpected, false])
        }
        // The glob grammar cannot express these exact resources. The
        // host-owned verification flow still runs the configured command.
        const refused = yield* Effect.flip(grants.check(Capability.make("proc:spawn", approved)))
        expect(refused.code).toBe("permission_required")
        expect((yield* Effect.flip(grants.check(Capability.make("proc:spawn", "npm run test")))).code).toBe(
          "permission_required"
        )
      }).pipe(Effect.provide(
        GrantStore.layer({
          attended: false,
          rules: Layers.rules({
            root,
            runStatePaths,
            commands: { typecheck: ["npm run test"], test: approved, flowsDir: "flows" }
          })
        }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
      )))
  }

  it.effect("keeps exact glob commands available to deterministic verification", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      mkdirSync(join(project, "grant-tests"))
      writeFileSync(join(project, "grant-tests", "x"), "")
      const approved = "printf '%s' grant-tests/*"
      const result = yield* Verify.run({
        root: project,
        commands: { typecheck: [], test: approved, flowsDir: "flows" },
        expectFlows: false
      })
      expect(result.tests?.command).toBe(approved)
      expect(result.tests?.exitCode).toBe(0)
      expect(result.tests?.stdoutTail).toBe("grant-tests/x")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses every other command, including the ones that would reach run state anyway", () =>
    Effect.gen(function*() {
      // A spawned process writes at the OS level, where no `fs:write` rule can
      // see it. Confining the spawn is the only place that can be stopped.
      expect(yield* permitted("proc:spawn", `sqlite3 ${root}/.smithers/smithers.db "delete from _smithers_runs"`))
        .toBe(false)
      expect(yield* permitted("proc:spawn", `rm -rf ${root}/.smithers`)).toBe(false)
      expect(yield* permitted("proc:spawn", "bash -lc 'pnpm install --frozen-lockfile'")).toBe(false)
      expect(yield* permitted("proc:spawn", "pnpm install")).toBe(false)
      expect(yield* permitted("proc:spawn", "git push")).toBe(false)
    }))

  it.effect("refuses every command when the project configures none", () =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      const allowed = yield* grants.check(Capability.make("proc:spawn", "pnpm install --frozen-lockfile")).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      expect(allowed).toBe(false)
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths, commands: { typecheck: [], flowsDir: "flows" } })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    )))
})

describe("Layers.rules over run-state paths outside the project", () => {
  const gateway = "/tmp/smithers-gateway/workspaces.json"

  it.effect("carries a gateway state file from the scan to a deny on its own absolute path", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const temporary = copyFixture("jsx-single")
      mkdirSync(join(temporary, "smithers-gateway"), { recursive: true })
      writeFileSync(
        join(temporary, "smithers-gateway", "gateway.json"),
        JSON.stringify({ workspace: project, port: 7331 })
      )

      const scanned = yield* Scan.scan(project, { runState: { tmpdir: temporary } }).pipe(Effect.provide(nodeLayer))
      const paths = Transform.runStatePaths(scanned)
      const built = Layers.rules({ root, runStatePaths: paths, commands })
      const denied = built.filter((rule) => rule.effect === "deny").map((rule) => rule.pattern.resource)

      const file = join(temporary, "smithers-gateway", "gateway.json")
      expect(paths).toContain(file)
      expect(denied).toContain(file)
      expect(denied).toContain(`${file}/**`)
    }).pipe(Effect.provide(nodeLayer)))

  it("denies an absolute gateway state path by its own path, not by one joined under the root", () => {
    const built = Layers.rules({ root, runStatePaths: [gateway], commands })
    const denied = built.filter((rule) => rule.effect === "deny").map((rule) => rule.pattern.resource)

    // Joined under the root the pattern is `${root}//tmp/...`, which matches
    // nothing: the file would sit outside every rule while the report calls
    // it covered.
    expect(denied).toContain(gateway)
    expect(denied).toContain(`${gateway}/**`)
    expect(denied.some((resource) => resource.includes("//tmp"))).toBe(false)
  })

  it.effect("keeps the store's answer for the gateway file a refusal", () =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      const allowed = yield* grants.check(Capability.make("fs:write", gateway)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      expect(allowed).toBe(false)
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths: [gateway], commands })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    )))
})

describe("Layers.rules over host-owned and secret paths", () => {
  const probe = (reportDir: string | undefined, action: Capability.Action, resource: string) =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      return yield* grants.check(Capability.make(action, resource)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths, commands, ...(reportDir === undefined ? {} : { reportDir }) })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    ))

  it.effect("denies the configured report directory, not only the default one", () =>
    Effect.gen(function*() {
      // A custom `--report-dir` holds the backups, the tree manifests, and
      // pending-unit.json that restore trusts. The agent must not reach them.
      for (const action of ["fs:read", "fs:write"] as const) {
        for (
          const target of [
            "build/migrate",
            "build/migrate/report.json",
            "build/migrate/pending-unit.json",
            "build/migrate/backup/workflow/demo.tree.json",
            ".smithers-migrate/apply.lock.sqlite"
          ]
        ) {
          expect([action, target, yield* probe("build/migrate", action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      expect(yield* probe("build/migrate", "fs:write", `${root}/build/other.ts`)).toBe(true)
    }))

  it.effect("denies version-control metadata, so a rewrite cannot plant a hook", () =>
    Effect.gen(function*() {
      for (const action of ["fs:read", "fs:write"] as const) {
        for (const target of [".git", ".git/hooks/pre-commit", ".git/config", ".jj", ".jj/repo/config.toml"]) {
          expect([action, target, yield* probe(undefined, action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      expect(yield* probe(undefined, "fs:write", `${root}/.gitignore`)).toBe(true)
    }))

  it.effect("denies every case spelling of the fixed names, which a case-insensitive volume resolves to one file", () =>
    Effect.gen(function*() {
      // The kernel keeps the caller's spelling and the matcher is literal,
      // so on APFS `.GIT/hooks/pre-commit` would otherwise miss the deny.
      for (const action of ["fs:read", "fs:write"] as const) {
        for (
          const target of [
            ".GIT/hooks/pre-commit",
            ".Git/config",
            ".gIT",
            ".JJ/repo/config.toml",
            ".jJ",
            ".ENV",
            ".Env.local",
            "apps/web/.eNV.production"
          ]
        ) {
          expect([action, target, yield* probe(undefined, action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      expect(yield* probe(undefined, "fs:write", `${root}/.GITIGNORE`)).toBe(true)
      expect(yield* probe(undefined, "fs:write", `${root}/src/ENVIRONMENT.ts`)).toBe(true)
    }))

  it.effect("denies every dotenv file, at the root and nested, so injected text cannot read a key", () =>
    Effect.gen(function*() {
      for (const action of ["fs:read", "fs:write"] as const) {
        for (const target of [".env", ".env.local", "apps/web/.env", "apps/web/.env.production"]) {
          expect([action, target, yield* probe(undefined, action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      // `*` crosses `/`, so a directory whose name starts with `.env` is
      // denied whole. That over-deny is deliberate and fails closed.
      expect(yield* probe(undefined, "fs:read", `${root}/.envoy/config.ts`)).toBe(false)
      expect(yield* probe(undefined, "fs:read", `${root}/src/environment.ts`)).toBe(true)
      expect(yield* probe(undefined, "fs:read", `${root}/.envrc.example.md`)).toBe(false)
    }))
})
