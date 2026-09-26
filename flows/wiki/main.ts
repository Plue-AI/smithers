/** Executable boundary only: Node-compatible process APIs also run under Bun. */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import { operations } from "./operations.ts"
import { type Input, PageSpec } from "./schema.ts"

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    root: { type: "string" },
    output: { type: "string" },
    verified: { type: "boolean" },
    model: { type: "string", default: "openai:gpt-6-sol" },
    run: { type: "string" },
    database: { type: "string" },
    help: { type: "boolean" },
    "reuse-run": { type: "string" }
  }
})
if (values.help) {
  console.log(
    "node --experimental-strip-types flows/wiki/main.ts [--verified] [--model provider:model] [--output path] [--database .flows/engine.db] [--run id] [--reuse-run terminal-run-id]\nDefault: a clearly unreviewed preview. --verified performs real AgentAction semantic review and fails if any section lacks support. Runtime host is selected from the actual Node/Bun executable."
  )
} else {
  const root = resolve(values.root ?? process.cwd()), output = resolve(root, values.output ?? ".flows/wiki")
  // The one page catalog: the `pages` of the repository's coding project,
  // the same declaration the Cloud refresh (coding/wiki) publishes.
  const project = JSON.parse(await readFile(resolve(root, ".smithers/coding-project.json"), "utf8")) as {
    pages?: unknown
  }
  const pages = Schema.decodeUnknownSync(Schema.Array(PageSpec).check(Schema.isMinLength(1), Schema.isMaxLength(30)))(
    project.pages
  )
  const sourceFiles = [...new Set(pages.flatMap((page) => [page.document, ...page.inputs]))]
  if (values.check) {
    console.log(
      JSON.stringify(
        await Effect.runPromise(
          operations({ root, output }).check(pages, values.verified).pipe(Effect.provide(NodeServices.layer))
        ),
        null,
        2
      )
    )
  } else {
    const destination = relative(root, output)
    if (!destination || destination === ".." || destination.startsWith(`..${sep}`) || isAbsolute(destination)) {
      throw new Error(
        "Generation output must be a dedicated directory inside --root. Publish the resulting immutable snapshot separately; --check can inspect an exported snapshot."
      )
    }
    const [{ Action, Interpreter }, { Capability }, { default: Wiki }, { actionLayers, agentLayers, hostEvaluator }] =
      await Promise.all([
        import("@smthrs/flow"),
        import("@smthrs/flows"),
        import("./flow.ts"),
        import("./runtime.ts")
      ])
    const incremental = values["reuse-run"] ? await import("./reuse.ts") : undefined
    if (incremental && !values.verified) {
      throw new Error("--reuse-run requires --verified and the existing database containing that terminal run")
    }
    const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
      ? await import("@smthrs/flows/NodeRuntime")
      : await import("@smthrs/flows/BunRuntime")
    // Credentials stay in the existing seat resolver. The receipt distinguishes
    // its subscription route so a different provider route cannot reuse approval.
    const reviewer = values.model.startsWith("openai:") && process.env.SMITHERS_OPENAI_AUTH === "chatgpt"
      ? `openai-chatgpt:${values.model.slice("openai:".length)}` :
      values.model
    const input: Input = { pages, mode: values.verified ? "verified" : "preview", reviewer }
    // A preflight source capture validates the declared evidence before admission;
    // actions independently recapture and the write gate rechecks it after review.
    const evaluator = values.verified ? hostEvaluator() : undefined
    const layers = Layer.mergeAll(
      actionLayers({ root, output, verify: !!values.verified, evaluator }),
      Interpreter.layer(Wiki),
      ...(incremental ? [incremental.reuseLayers({ root, output })] : []),
      ...(values.verified
        ? [agentLayers((await import("../release-support/runtime.ts")).liveSeats(values.model), 900_000, evaluator)]
        : [])
    )
      .pipe(Layer.provideMerge(Action.layerImplementations))
    await Effect.runPromise(
      Effect.forEach(pages, (page) => operations({ root, output }).collect(page)).pipe(
        Effect.provide(NodeServices.layer)
      )
    )
    const rule = (action: "fs:read" | "fs:write", resource: string) =>
      new Capability.Permission.Rule({
        effect: "allow",
        pattern: new Capability.Capability.CapabilityPattern({ action, resource })
      })
    const rules = [
      ...[
        ...new Set([
          root,
          ...sourceFiles.map((file) => resolve(root, file)),
          output,
          `${output}/**`,
          resolve(output, "..")
        ])
      ].map((resource) => rule("fs:read", resource)),
      ...[output, `${output}/**`].map((resource) => rule("fs:write", resource))
    ]
    const runId = values.run ?? `wiki-${crypto.randomUUID()}`
    console.log(
      JSON.stringify({
        runId,
        output,
        mode: input.mode,
        model: values.verified ? values.model : null,
        reviewer: values.verified ? reviewer : null
      })
    )
    const execute = Effect.gen(function*() {
      if (incremental) {
        return yield* incremental.IncrementalWiki.execute({
          ...input,
          mode: "verified",
          priorRunId: values["reuse-run"]!
        }, { executionId: runId })
      }
      return yield* Wiki.execute(input, { executionId: runId })
    })
    const result = await Effect.runPromise(Effect.scoped(execute.pipe(Effect.provide(runtime.layerHost({
      filename: resolve(root, values.database ?? ".flows/engine.db"),
      workspaceRoot: root,
      owner: { hostId: `wiki-${process.pid}` },
      signals: [],
      rules: [rules]
    }, layers)))))
    console.log(JSON.stringify({ runId, result }, null, 2))
  }
}
