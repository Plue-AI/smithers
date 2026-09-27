/**
 * Targets for the offline agent evaluation suite.
 *
 * The suite is a program whose exit code is the verdict — it scores the agent
 * against `baseline.json` and fails on drift — so it is a test target, and its
 * own typecheck is a build target. Both run from this directory, which is a
 * workspace member (`@smthrs/eval-agent`): `tsc` resolves through the declared
 * package manager against the `typescript` and `@types/node` this package pins,
 * and the suite names the Bun runtime, so neither `bun` nor `npx` is spelled
 * anywhere.
 *
 * There is no `lint` or `fmt` target, and adding one would break the suite
 * rather than tidy it. `baseline.json` is the canonical JSON `Baseline.write`
 * emits byte for byte, and the repository's dprint configuration reformats it,
 * so a formatting gate here would permanently disagree with the program that
 * writes the artifact.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/agent"

/** The suite, its subject, and the committed baseline it gates on. */
const sources = [Smithers.glob("//evals/agent/*.ts"), Smithers.file("//evals/agent/baseline.json")]

/** The character runner and its example suite (world, profile, cases). */
const characterSources = [Smithers.glob("//evals/agent/character/*.ts"), Smithers.glob("//evals/agent/character/example/**")]

/**
 * Runs the evaluation suite and gates it on the committed baseline.
 *
 * The run is offline: the only replaced pieces are the model behind the seat
 * resolver and the route it seals against, so no API key, network access, or
 * global CLI install is involved and every score is reproducible.
 *
 * @since 0.1.0
 * @category test
 */
const test = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(Smithers.file("//evals/agent/run.ts")),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Replays the example character suite offline: every golden transcript must
 * pass and every counterexample must fail, through the real agent loop with
 * a scripted model. No network, no model spend.
 *
 * @since 0.1.0
 * @category test
 */
const character = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(Smithers.file("//evals/agent/character/run.ts")),
  srcs: characterSources,
  deps: [],
  cwd
})

/**
 * The character runner's own `bun:test` suites: the world's patching and
 * tools, the deterministic checks, and what the judge sees and re-judges.
 * Pure and fast; no model, no network.
 *
 * @since 0.1.0
 * @category test
 */
const characterUnit = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["character/world.test.ts", "character/score.test.ts", "character/rubric.test.ts"]),
  srcs: characterSources,
  deps: [],
  cwd
})

/**
 * Checks the suite's own sources against its tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [...sources, ...characterSources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const Package = Smithers.Package({
  targets: { character, characterUnit, check, test }
})
