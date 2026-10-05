#!/usr/bin/env bun
/**
 * Generate the proof page (proof-page.ts) from the recorded proof run.
 *
 *   bun apps/app/proof/page.ts [--features <json>] [--results <json>] [--mock <json>] [--out <dir>]
 *
 * Defaults: .specs/product/features.json, apps/app/test-results/proof/results.json,
 * apps/app/proof/mock-steps.json (the mock's journeys when absent) and
 * apps/app/test-results/proof-page/index.html.
 *
 * Exit 1 when features.json disagrees with the results (a feature marked
 * implemented that did not pass, or one that passed but is marked
 * not-implemented); the page is still written so the disagreement is visible.
 */
import { existsSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { generate, VERDICT_LABEL, type GenerateOptions } from "./proof-page.ts"

const flag = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? undefined : args[at + 1]
}

const main = async (): Promise<void> => {
  const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..")
  const args = process.argv.slice(2)
  const app = join(root, "apps/app")
  const options: GenerateOptions = {
    root,
    features: resolve(flag(args, "features") ?? join(root, ".specs/product/features.json")),
    results: resolve(flag(args, "results") ?? join(app, "test-results/proof/results.json")),
    mock: resolve(flag(args, "mock") ?? join(app, "proof/mock-steps.json")),
    out: resolve(flag(args, "out") ?? join(app, "test-results/proof-page"))
  }
  for (const [name, path] of [["features", options.features], ["results", options.results]] as const) {
    if (!existsSync(path)) {
      console.error(`proofPage: no ${name} at ${relative(process.cwd(), path)}`)
      process.exit(1)
    }
  }
  const model = await generate(options)
  const page = join(options.out, "index.html")
  console.log(`proofPage: ${model.counts.works}/${model.counts.total} features work at ${model.sha.slice(0, 10)}; ${model.reels.length} reels; ${relative(process.cwd(), page)}`)
  for (const each of model.unknownSteps) console.error(`proofPage: ${each.id} names mock step ${each.ref}, which the mock does not have`)
  if (model.disagreements.length > 0) {
    for (const each of model.disagreements) console.error(`proofPage: ${each.id} is ${each.status} in features.json but the run says ${VERDICT_LABEL[each.verdict]}`)
    process.exit(1)
  }
}

if (import.meta.main) void main()
