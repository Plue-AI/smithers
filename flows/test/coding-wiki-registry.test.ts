import { NodeServices } from "@effect/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Option } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { checkDelegate } from "../coding/checks.ts"
import { jevCheckDelegate } from "../coding/jev-check.ts"
import { loadProject } from "../coding/project-config.ts"
import { wikiCheckDelegate } from "../coding/wiki-check.ts"
import { bindWikiRegistry } from "../coding/wiki-registry.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

test("the actual Smithers check declarations and the wiki check lower under the configured host delegates", async () => {
  const config = await Effect.runPromise(
    loadProject(fileURLToPath(new URL("../../", import.meta.url)), undefined).pipe(Effect.provide(platform))
  )
  assert.ok(config)
  // An operator may add the semantic wiki check; it lowers like the others.
  const checks = [...config.checks, {
    id: "wiki",
    target: "public engineering wiki",
    flow: "checks/wiki",
    tier: "slow" as const,
    required: true
  }]
  const names = new Set(checks.map((check) => check.flow))
  const base = await Effect.runPromise(
    Registry.make({
      sources: [{ source: "project", root: fileURLToPath(new URL("../", import.meta.url)), naming: "path" }]
    })
      .pipe(Effect.provide(Discovery.layer), Effect.provide(platform))
  )
  const registry = bindWikiRegistry(base, "fixture-deployed-policy")
  const selected = {
    ...registry,
    list: () => registry.list().pipe(Effect.map((values) => values.filter((value) => names.has(value.name))))
  }
  const built = await Effect.runPromise(
    Executable.catalog({ delegates: [checkDelegate, jevCheckDelegate, wikiCheckDelegate] })
      .pipe(Effect.provideService(Registry.Registry, selected), Effect.provide(platform))
  )
  assert.deepEqual(built.refused, [])
  assert.equal(built.executables.length, names.size)
  for (const check of checks) {
    const entry = built.executables.find((entry) => entry.descriptor.name === check.flow)
    assert.ok(entry, `${check.id} must resolve its actual declaration`)
    assert.equal(
      entry.delegate,
      check.id === "wiki" ? wikiCheckDelegate._tag : check.id === "lint" ? jevCheckDelegate._tag : checkDelegate._tag
    )
    assert.equal(
      Descriptor.executionDigest(entry.descriptor),
      Descriptor.executionDigest(await Effect.runPromise(registry.get(check.flow)))
    )
  }
})

test("one wiki Registry identity fences approval, exact source loading and refresh without trusting modeled metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-wiki-registry-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, "wiki", "flow.mdx")
  await mkdir(join(root, "wiki"))
  await mkdir(join(root, "ordinary"))
  const declaration = (text: string) =>
    "---\ndescription: Wiki check.\nflows: [coding/WikiCheck]\nsmithersCodingWikiPolicy: modeled-override\n---\n" +
    text + "\n"
  await writeFile(file, declaration("Review captured pages."))
  await writeFile(join(root, "ordinary", "flow.mdx"), "---\ndescription: Ordinary prompt.\n---\nRead the request.\n")
  const base = await Effect.runPromise(
    Registry.make({ sources: [{ source: "project", root, naming: "path" }] })
      .pipe(Effect.provide(Discovery.layer), Effect.provide(platform))
  )
  const registry = bindWikiRegistry(base, "trusted-host-v1")
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const original = await run(base.get("wiki")), derived = await run(registry.get("wiki"))
  const digest = Descriptor.executionDigest(derived)!
  assert.equal(original.frontmatter.smithersCodingWikiPolicy, "modeled-override")
  assert.equal(derived.frontmatter.smithersCodingWikiPolicy, "trusted-host-v1")
  assert.notEqual(digest, Descriptor.executionDigest(original))
  assert.deepEqual(await run(registry.get("ordinary")), await run(base.get("ordinary")))
  for (const values of [await run(registry.list()), await run(registry.visible())]) {
    assert.equal(Descriptor.executionDigest(values.find((value) => value.name === "wiki")!), digest)
  }
  const option = await run(registry.getOption("wiki"))
  assert.ok(Option.isSome(option))
  assert.equal(Descriptor.executionDigest(option.value), digest)
  assert.equal((await run(registry.loadBody("wiki", digest)))._tag, "Prompt")
  await assert.rejects(run(registry.loadBody("wiki", Descriptor.executionDigest(original))), /changed after planning/)
  const updatedHost = bindWikiRegistry(base, "trusted-host-v2")
  await assert.rejects(run(updatedHost.loadBody("wiki", digest)), /changed after planning/)
  await writeFile(file, declaration("Changed source body."))
  await assert.rejects(run(registry.loadBody("wiki", digest)), /after discovery/)
  await run(registry.refresh())
  const changed = await run(registry.get("wiki"))
  assert.notEqual(Descriptor.executionDigest(changed), digest)
  await assert.rejects(run(registry.loadBody("wiki", digest)), /changed after planning/)
  assert.equal((await run(registry.loadBody("wiki", Descriptor.executionDigest(changed))))._tag, "Prompt")
  assert.deepEqual(await run(registry.warnings()), await run(base.warnings()))
})
