/**
 * A repository with no Smithers declarations still serves coding requests
 * (mvp.md J1.4, spec §11.2, T-FLW-02): the host takes the built-in
 * implementation and one required check per command the existing detector
 * finds, and registers those checks as built-in flows. Expected values are
 * literal; none is derived from the detector under test.
 */
import { NodeServices } from "@effect/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { test, type TestContext } from "node:test"
import { checkDelegate } from "../coding/checks.ts"
import { configuredCodingRoutes, missingCodingExecutables, provisionHostBuiltins } from "../coding/host.ts"
import { loadProject } from "../coding/project-config.ts"
import { bindRepositoryRegistry, repositoryCatalog } from "../repository/registry.ts"
import { RunJob, RunSetup } from "../repository/setup.ts"
import { RunTrigger } from "../repository/triggers.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
const policy = "d".repeat(64)
const load = (root: string, filename?: string) =>
  Effect.runPromise(loadProject(root, filename).pipe(Effect.provide(platform)))

const repository = async (t: TestContext, files: Readonly<Record<string, string>>) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-project-defaults-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  for (const [name, text] of Object.entries({ "README.md": "# fixture\n", ...files })) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), text)
  }
  return { root, stateRoot: join(temporary, "state") }
}

const goChecks = [
  { id: "test", target: ".", flow: "checks/test", tier: "slow", required: true },
  { id: "lint", target: ".", flow: "checks/lint", tier: "fast", required: true },
  { id: "build", target: ".", flow: "checks/build", tier: "fast", required: true }
]
const goDetected = [
  { flow: "checks/test", argv: ["go", "test", "./..."], timeoutMs: 1_800_000 },
  { flow: "checks/lint", argv: ["go", "vet", "./..."], timeoutMs: 1_800_000 },
  { flow: "checks/build", argv: ["go", "build", "./..."], timeoutMs: 1_800_000 }
]
const goModule = { "go.mod": "module example.com/journey\n\ngo 1.23\n", "main.go": "package main\n\nfunc main() {}\n" }

test("a repository with no Smithers files and no detectable command gets the built-in implementation and no checks", async (t) => {
  const { root } = await repository(t, { "JOURNEY.md": "Add a greeting to JOURNEY.md\n" })
  assert.deepEqual(await load(root), { wiki: false, implementation: "coding/implementation", checks: [] })
})

test("a Go repository with no Smithers files runs go test, go vet and go build as required checks", async (t) => {
  const { root } = await repository(t, goModule)
  assert.deepEqual(await load(root), {
    wiki: false,
    implementation: "coding/implementation",
    checks: goChecks,
    detected: goDetected
  })
})

test("a pnpm repository's scripts run through pnpm; a placeholder test script is no check", async (t) => {
  const scripts = { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc -b" }
  const { root } = await repository(t, {
    "package.json": JSON.stringify({ name: "fixture", scripts }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"
  })
  assert.deepEqual(await load(root), {
    wiki: false,
    implementation: "coding/implementation",
    checks: [
      { id: "test", target: ".", flow: "checks/test", tier: "slow", required: true },
      { id: "lint", target: ".", flow: "checks/lint", tier: "fast", required: true },
      { id: "typecheck", target: ".", flow: "checks/typecheck", tier: "fast", required: true },
      { id: "build", target: ".", flow: "checks/build", tier: "fast", required: true }
    ],
    detected: [
      { flow: "checks/test", argv: ["pnpm", "run", "test"], timeoutMs: 1_800_000 },
      { flow: "checks/lint", argv: ["pnpm", "run", "lint"], timeoutMs: 1_800_000 },
      { flow: "checks/typecheck", argv: ["pnpm", "run", "typecheck"], timeoutMs: 1_800_000 },
      { flow: "checks/build", argv: ["pnpm", "run", "build"], timeoutMs: 1_800_000 }
    ]
  })
  const placeholder = await repository(t, {
    "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1", build: "tsc" } })
  })
  assert.deepEqual(await load(placeholder.root), {
    wiki: false,
    implementation: "coding/implementation",
    checks: [{ id: "build", target: ".", flow: "checks/build", tier: "fast", required: true }],
    detected: [{ flow: "checks/build", argv: ["npm", "run", "build"], timeoutMs: 1_800_000 }]
  })
})

test("detection opens only the detector's files and reads text only from package.json and Makefile", async (t) => {
  const { root } = await repository(t, {
    ...goModule,
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
    "Makefile": "test:\n\tgo test ./...\n",
    "secret.env": "TOKEN=do-not-read\n"
  })
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const opened: Array<string> = [], read: Array<string> = []
  const recording: FileSystem.FileSystem = {
    ...fs,
    exists: (path) => (opened.push(relative(root, path)), fs.exists(path)),
    stat: (path) => (opened.push(relative(root, path)), fs.stat(path)),
    readFileString: (path, encoding) => (read.push(relative(root, path)), fs.readFileString(path, encoding))
  }
  const project = await Effect.runPromise(
    loadProject(root, undefined).pipe(
      Effect.provideService(FileSystem.FileSystem, recording),
      Effect.provide(NodeServices.layer)
    )
  )
  assert.deepEqual(project.checks.map((check) => check.id), ["lint", "test", "build"])
  assert.deepEqual(
    [...new Set(opened)].sort(),
    [
      ".smithers/coding-project.json",
      "Cargo.toml",
      "Makefile",
      "bun.lock",
      "bun.lockb",
      "go.mod",
      "package.json",
      "pnpm-lock.yaml",
      "pyproject.toml",
      "pytest.ini",
      "setup.py",
      "yarn.lock"
    ]
  )
  assert.deepEqual(read, ["package.json", "Makefile"])
})

test("a partial project keeps every declared field and fills only the omitted ones", async (t) => {
  const { root } = await repository(t, {
    ...goModule,
    ".smithers/coding-project.json": JSON.stringify({ seats: { "coding/implement": "auto" }, historyLimit: 7 })
  })
  assert.deepEqual(await load(root), {
    seats: { "coding/implement": "auto" },
    historyLimit: 7,
    wiki: false,
    implementation: "coding/implementation",
    checks: goChecks,
    detected: goDetected
  })
  const declared = await repository(t, {
    ...goModule,
    ".smithers/coding-project.json": JSON.stringify({ implementation: "custom/implementation", checks: [] })
  })
  assert.deepEqual(await load(declared.root), { implementation: "custom/implementation", checks: [], wiki: false })
  const invalid = await repository(t, {
    ...goModule,
    ".smithers/coding-project.json": JSON.stringify({ checks: "all" })
  })
  await assert.rejects(load(invalid.root), /Invalid SMITHERS_CODING_PROJECT.*\.smithers\/coding-project\.json/)
})

/** The host's own startup composition over a repository with no `flows/` tree. */
const startup = (root: string, stateRoot: string) =>
  Effect.gen(function*() {
    const planning = yield* loadProject(root, undefined)
    const builtins = yield* provisionHostBuiltins(stateRoot, policy, { planning })
    const project = yield* Registry.make({
      sources: [{ root: join(root, "flows"), source: "project", naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer))
    const registry = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    const built = yield* repositoryCatalog(
      { delegates: [RunSetup, RunJob, RunTrigger, checkDelegate] },
      builtins.load
    ).pipe(Effect.provideService(Registry.Registry, registry))
    return { planning, built }
  }).pipe(Effect.provide(platform), Effect.runPromise)

test("a repository with no Smithers files serves coding/request with its detected checks registered", async (t) => {
  const { root, stateRoot } = await repository(t, goModule)
  await mkdir(join(root, "flows"))
  const { planning, built } = await startup(root, stateRoot)
  assert.deepEqual(configuredCodingRoutes({ planning }).map((route) => route.name), [
    "coding/request",
    "coding/verify",
    "flow-load"
  ])
  assert.deepEqual(missingCodingExecutables(built, { planning }), [])
  for (const flow of ["checks/test", "checks/lint", "checks/build"]) {
    const entry = built.executables.find((candidate) => candidate.descriptor.name === flow)
    assert.ok(entry, `${flow} is registered`)
    assert.equal(entry.delegate, "coding/CommandCheck")
    assert.match(Descriptor.executionDigest(entry.descriptor) ?? "", /\S/, `${flow} has an execution identity`)
  }
  assert.equal(
    await readFile(join(stateRoot, "builtin-flows", policy, "checks", "test", "flow.mdx"), "utf8"),
    "---\n" +
      "description: \"Run the detected command go test ./....\"\n" +
      "flows: [coding/CommandCheck]\n" +
      "capabilities: [\"fs:read:**\",\"proc:spawn:go test ./...\"]\n" +
      "---\n" +
      "{\"argv\":[\"go\",\"test\",\"./...\"],\"cwd\":\".\",\"timeoutMs\":1800000}\n"
  )
  // Declaring checks retires the detected ones under the same policy root.
  await mkdir(join(root, ".smithers"))
  await writeFile(join(root, ".smithers", "coding-project.json"), JSON.stringify({ checks: [] }))
  const declared = await startup(root, stateRoot)
  assert.equal(declared.built.executables.some((entry) => entry.descriptor.name.startsWith("checks/")), false)
  await assert.rejects(access(join(stateRoot, "builtin-flows", policy, "checks", "test")), { code: "ENOENT" })
})
