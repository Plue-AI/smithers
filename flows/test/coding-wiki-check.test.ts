import { NodeServices } from "@effect/platform-node"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { CapabilityPattern } from "../../packages/smithers/flows/capability/src/Capability.ts"
import { Rule } from "../../packages/smithers/flows/capability/src/Permission.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { catalogLayers } from "../coding/catalog.ts"
import {
  type Check,
  CodingError,
  type Implementation,
  Receipt,
  receiptMatches,
  type Revision
} from "../coding/schema.ts"
import { wikiCheckDelegate, wikiCheckLayers, wikiCheckPolicy } from "../coding/wiki-check.ts"
import { bindWikiRegistry } from "../coding/wiki-registry.ts"
import { RunCheck } from "../coding/workflow.ts"
import { reuseLayers } from "../wiki/reuse.ts"
import { actionLayers } from "../wiki/runtime.ts"
import type { PageSpec } from "../wiki/schema.ts"
import { ReviewPage } from "../wiki/workflow.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

/** One evidence judge dispatches citation and completion questions for this host. */
const citationsSupported = makeHostJudge().layer

const CheckRun = Flow.make("acceptance/WikiCheck", {
  payload: RunCheck.payloadSchema,
  success: Receipt,
  error: CodingError,
  body: (input) => RunCheck.call(input)
})
const exporter = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY

test("native wiki check captures immutable pages, returns owner findings, reuses reviews and survives cold replay", {
  skip: exporter === undefined
    ? "Set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the existing Plue immutable exporter"
    : false,
  timeout: 300_000
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-wiki-check-"))
  let dispose = async () => {}
  t.after(async () => {
    await dispose()
    await rm(temporary, { recursive: true, force: true })
  })
  const root = join(temporary, "repo"), output = join(temporary, "wiki")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Wiki check fixture")
  jj("config", "set", "--repo", "user.email", "wiki-check@example.com")
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  await writeFile(join(root, "answer.ts"), "export const answer = 42\n")
  await writeFile(join(root, "guide.md"), "# Answer\n\nThe answer is 42.\n")
  await mkdir(join(root, "flows", "checks", "wiki"), { recursive: true })
  await writeFile(
    join(root, "flows", "checks", "wiki", "flow.mdx"),
    "---\ndescription: Semantic wiki check.\nflows: [coding/WikiCheck]\ncapabilities: ['*']\nsmithersCodingWikiPolicy: modeled-override\n---\nReview the configured wiki.\n"
  )
  const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
  const runtime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(platform)))
  const scratch: string[] = []
  const trackedFs: FileSystem.FileSystem = {
    ...fs,
    makeTempDirectoryScoped: (options) =>
      fs.makeTempDirectoryScoped(options)
        .pipe(Effect.tap((directory) =>
          Effect.sync(() => {
            scratch.push(directory)
          })
        ))
  }
  const pages: PageSpec[] = [{
    id: "answer",
    title: "Answer",
    purpose: "Read the answer.",
    kind: "current",
    document: "guide.md",
    inputs: ["answer.ts"],
    related: []
  }]
  let hostPolicy = "artifact:fixture-v1"
  const options = () => ({
    repositoryPath: root,
    wikiOutput: output,
    fs: trackedFs,
    exporterPath: exporter,
    pages,
    reviewer: `scripted:${hostPolicy}`,
    hostPolicy
  })
  const baseRegistry = await Effect.runPromise(
    Registry.make({ sources: [{ source: "project", root: join(root, "flows"), naming: "path" }] })
      .pipe(Effect.provide(Discovery.layer), Effect.provide(platform))
  )
  let registry = bindWikiRegistry(baseRegistry, wikiCheckPolicy(options()))
  const load = () =>
    Effect.runPromise(
      Executable.catalog({ delegates: [wikiCheckDelegate] }).pipe(
        Effect.provideService(Registry.Registry, registry),
        Effect.provide(platform)
      )
    )
  let catalog = await load()
  assert.equal(catalog.refused.length, 0)
  const makeCheck = (): Check => ({
    id: "wiki",
    target: "wiki",
    flow: "checks/wiki",
    flowDigest: Descriptor.executionDigest(catalog.executables[0]!.descriptor)!,
    tier: "slow",
    required: true
  })
  let check = makeCheck(), reviews = 0
  let release!: () => void, started!: () => void
  const reviewing = new Promise<void>((resolve) => {
    started = resolve
  })
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  const make = () =>
    ManagedRuntime.make(
      runtime.layerHost(
        {
          filename: join(root, ".flows", "engine.db"),
          workspaceRoot: root,
          owner: { hostId: "wiki-check-fixture" },
          signals: [],
          rules: [[
            new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" }) })
          ]]
        },
        Layer.mergeAll(
          wikiCheckLayers(options()),
          actionLayers({ root, output, fs: trackedFs, evaluator: citationsSupported }),
          reuseLayers({ root, output, fs: trackedFs, hostPolicy }),
          catalogLayers,
          Interpreter.layer(CheckRun),
          ...catalog.executables.map((entry) => entry.layer),
          ReviewPage.toLayer(({ evidence, correction, priorReview }) =>
            Effect.gen(function*() {
              reviews++
              if (reviews === 1) {
                started()
                yield* Effect.promise(() => resume)
              }
              const source = evidence.sources.find((source) => source.path === "answer.ts")!
              if (reviews === 2) {
                assert.match(correction!, /exact source evidence/)
                assert.equal(priorReview?.sections[0]?.citations[0]?.line, 999)
                assert.equal(
                  source.text,
                  "export const answer = 42\n",
                  "repair keeps the immutable source after the live edit"
                )
              }
              const correct = evidence.markdown.includes(`is ${source.text.match(/= (\d+)/)![1]}.`)
              return {
                sections: evidence.sections.map((section) => ({
                  id: section.id,
                  verdict: correct ? "supported" as const : "unsupported" as const,
                  explanation: correct
                    ? "The exported value supports the page."
                    : "Update the owning guide to match the new value.",
                  citations: correct
                    ? [{ path: "answer.ts", line: reviews === 1 ? 999 : 1, quote: source.text.trim() }]
                    : []
                }))
              }
            })
          )
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(Executable.Catalog, catalog))
        )
      )
        .pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)))
    )
  const revision = async (): Promise<Revision> => {
    jj("status")
    const commit = JSON.parse(jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "json(self)"))
    const tree = JSON.parse(execFileSync(exporter!, [root, commit.commit_id, temporary], { stdio: "pipe" }).toString())
    await rm(tree.path, { recursive: true, force: true })
    return {
      changeId: tree.changeId,
      commitId: tree.commitId,
      treeId: tree.treeId,
      parentCommitIds: commit.parents,
      operationId: JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id
    }
  }
  const source = await revision()
  const implementation = (head: Revision): Implementation => ({
    change: "answer",
    parent: source,
    atoms: [head],
    head,
    reads: [],
    writes: ["answer.ts"]
  })
  let host = make()
  dispose = () => host.dispose()
  const run = (id: string, head = source, selected = check) =>
    host.runPromise(CheckRun.execute({ implementation: implementation(head), check: selected }, { executionId: id }), {
      signal: t.signal
    })
  const first = run("wiki-check-first")
  void first.catch(() => {})
  await Promise.race([
    reviewing,
    first.then(() => {
      throw new Error("Review must begin before completion")
    })
  ])
  for (const directory of scratch) {
    await assert.rejects(access(directory), "source export closes before slow model review")
  }
  await writeFile(join(root, "answer.ts"), "export const answer = 43\n")
  const changed = await revision()
  release()
  const passed = await first
  assert.equal(passed.status, "passed")
  assert.ok(receiptMatches(implementation(source), check, passed))
  await assert.rejects(access(output), "a slow check never publishes a racing wiki pointer")
  await host.dispose()
  host = make()
  assert.deepEqual(await run("wiki-check-first"), passed)
  assert.equal(reviews, 2, "cold replay does not repeat the model or export")
  await run("wiki-check-same-source")
  assert.equal(reviews, 2, "another check reuses the native reviewed-page receipts")
  const failed = await run("wiki-check-stale-prose", changed)
  assert.equal(failed.status, "failed")
  assert.equal(reviews, 3, "valid unsupported prose is a finding, not a citation retry")
  assert.equal(failed.findings[0]?.owner, "answer")
  assert.equal(failed.findings[0]?.sourceCommitId, changed.commitId)
  await host.dispose()
  const old = check
  hostPolicy = "artifact:fixture-v2"
  registry = bindWikiRegistry(baseRegistry, wikiCheckPolicy(options()))
  catalog = await load()
  check = makeCheck()
  assert.notEqual(check.flowDigest, old.flowDigest)
  host = make()
  await assert.rejects(run("wiki-check-old-policy", source, old), /changed since this plan/)
  await run("wiki-check-new-policy", source)
  assert.equal(reviews, 4, "running host policy change requires new review despite unchanged target sources")
  for (const directory of scratch) await assert.rejects(access(directory))
  assert.equal(await readFile(join(root, "answer.ts"), "utf8"), "export const answer = 43\n")
})
