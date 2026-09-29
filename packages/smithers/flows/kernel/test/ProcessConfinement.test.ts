/**
 * The profile a confinement derives from the grants in force: how each rule
 * shape opens or closes a tree, and which rules cannot be spelled as one.
 */
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { type Action, CapabilityPattern } from "@smthrs/capability/Capability"
import { GrantStoreError, Rule } from "@smthrs/capability/Permission"
import { Effect, Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { GrantStore, type Service } from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"

const rule = (effect: "allow" | "deny", action: Action, resource: string) =>
  new Rule({ effect, pattern: new CapabilityPattern({ action, resource }) })

/** A store whose rules in force are scripted per action; nothing else is consulted. */
const store = (rules: ReadonlyArray<Rule>): Service =>
  GrantStore.of({
    check: () => Effect.die("profiles never check"),
    reply: () => Effect.die("profiles never reply"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void,
    rules: (action) => Effect.succeed(rules.filter((rule) => rule.pattern.action === action))
  })

const profile = (rules: ReadonlyArray<Rule>, root = "/workspace") =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return yield* ProcessConfinement.profile(store(rules), root, path)
  }).pipe(Effect.provide(Path.layer))

describe("ProcessConfinement.profile", () => {
  it.effect("opens the tree a glob starts in, relative to the workspace", () =>
    Effect.gen(function*() {
      const derived = yield* profile([
        rule("allow", "fs:write", "/workspace/src/**"),
        rule("allow", "fs:write", "/workspace/src/**"),
        rule("allow", "fs:write", "src/*.ts"),
        rule("allow", "fs:write", "/workspace/dist*/x"),
        rule("allow", "fs:write", "**"),
        rule("allow", "fs:read", "/workspace/docs/**"),
        rule("allow", "fs:read", "/workspace/README.md")
      ])
      expect(derived).toEqual({
        workspaceRoot: "/workspace",
        reads: ["docs", "README.md"],
        writes: ["src", "."],
        writeFiles: [],
        readOnly: [],
        network: "none"
      })
    }))

  it.effect("keeps a literal write apart from the trees, so a file opens only its parent", () =>
    Effect.gen(function*() {
      const derived = yield* profile([
        rule("allow", "fs:write", "/workspace/notes.md"),
        rule("allow", "fs:write", "out")
      ])
      expect(derived.writes).toEqual([])
      expect(derived.writeFiles).toEqual(["notes.md", "out"])
    }))

  it.effect("opens nothing for a grant outside the workspace", () =>
    Effect.gen(function*() {
      const derived = yield* profile([
        rule("allow", "fs:write", "/elsewhere/**"),
        rule("allow", "fs:write", "../sibling/**"),
        rule("allow", "fs:read", "/workspace-two/**"),
        rule("deny", "fs:write", "/elsewhere/closed/**")
      ])
      expect(derived).toMatchObject({ reads: [], writes: [], writeFiles: [], readOnly: [] })
    }))

  it.effect("drops a grant on another drive of a Windows workspace", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const derived = yield* ProcessConfinement.profile(
        store([rule("allow", "fs:write", "E:/other/**"), rule("allow", "fs:write", "D:/work/src/**")]),
        "D:\\work",
        path
      )
      expect(derived.workspaceRoot).toBe("D:\\work")
      expect(derived.writes).toEqual(["src"])
    }).pipe(Effect.provide(NodePath.layerWin32)))

  it.effect("re-closes a whole tree or one literal path a deny names, and leaves a narrower deny to the check", () =>
    Effect.gen(function*() {
      const derived = yield* profile([
        rule("allow", "fs:write", "/workspace/**"),
        rule("deny", "fs:write", "/workspace/secrets/**"),
        rule("deny", "fs:write", "/workspace/.env"),
        rule("deny", "fs:write", "/workspace/src/*.ts"),
        rule("deny", "fs:write", "/workspace/secrets/**")
      ])
      expect(derived.writes).toEqual(["."])
      expect(derived.readOnly).toEqual(["secrets", ".env"])
    }))

  it.effect("opens the network when any network allow is in force, and only then", () =>
    Effect.gen(function*() {
      expect((yield* profile([rule("allow", "net:post", "https://api.example.com/**")])).network).toBe("open")
      expect((yield* profile([rule("allow", "net:private", "10.0.0.0/8")])).network).toBe("open")
      expect((yield* profile([rule("deny", "net:get", "**")])).network).toBe("none")
      expect((yield* profile([])).network).toBe("none")
    }))

  it.effect("fails with the store's own error", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const failing = GrantStore.of({
        ...store([]),
        rules: () => Effect.fail(new GrantStoreError({ code: "store_closed" }))
      })
      const failure = yield* Effect.flip(ProcessConfinement.profile(failing, "/workspace", path))
      expect(failure.code).toBe("store_closed")
    }).pipe(Effect.provide(Path.layer)))
})

describe("ProcessConfinement.makeNoop", () => {
  it.effect("returns every command as it was given", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const service = yield* ProcessConfinement.ProcessConfinement
        const command = ChildProcess.make("tool", ["--flag"], { cwd: "/workspace" })
        const confined = yield* service.confine(command, {
          workspaceRoot: "/workspace",
          reads: [],
          writes: ["."],
          writeFiles: [],
          readOnly: [],
          network: "none"
        })
        expect(confined).toBe(command)
      })
    ).pipe(Effect.provide(ProcessConfinement.layerNoop)))
})
