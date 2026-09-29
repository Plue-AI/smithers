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

/**
 * Security review of the eval harness: `security` reviews the diff against
 * origin/main, `securityAudit` audits every owned file.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["*.ts", "character/*.ts", "character/example/**"],
  checks: [
    {
      id: "live-seat-credentials",
      title: "A live character run signs only with subscription logins and never leaks them",
      threat: "Anyone who reads a results file, trace, or error text obtains the owner's model API keys or Codex/ChatGPT session tokens.",
      lookFor: [
        "`subscriptionEnvironment` keeps an API key variable the resolver reads (OPENROUTER_API_KEY and SMITHERS_ACCOUNT_POOL_KEY are not deleted today; OPENAI_API_KEY and ANTHROPIC_API_KEY are) in the env handed to `NativeEquipment.seatResolver`.",
        "A `Cause.pretty`, `CHARACTER_DEBUG` detail, or `--trace` output that prints request headers, env values, or `$CODEX_HOME/auth.json` contents.",
        "A results JSON or REGRESSION-LOG row that serializes the seat, route, or env rather than only usage counts."
      ],
      paths: ["character/subject.ts", "character/run.ts", "character/rubric.ts"]
    },
    {
      id: "live-seat-grants",
      title: "The live seat's grants cover only model calls, and the turn's tools stay simulated",
      threat: "A prompt-injected role model under test reaches the network, filesystem, or shell of the owner's machine during an eval run.",
      lookFor: [
        "The `GrantStore.layer` rules in `resolveLive` allowing more than `net:*`/`model:*`, or `net:*` reaching tool flows rather than only the request executor.",
        "A world tool handler in `world.ts` that touches the real filesystem, spawns a process, or performs a real fetch (e.g. `web_fetch` not answering from `world.data.web`).",
        "The `Workspace.layer(root)` root set to the repository or home directory in a way the QuickJS cell can write through."
      ],
      paths: ["character/subject.ts", "character/world.ts", "subject.ts"]
    },
    {
      id: "judge-prompt-injection",
      title: "Content under test cannot steer the judge's verdict",
      threat: "Text the role model copies from untrusted world content (web pages, inbox, chat) instructs the judge model to pass a failing turn, corrupting the character suite's gate.",
      lookFor: [
        "`judgedOutput` or the judge request concatenating emission text into the prompt with no delimiting or statement that it is untrusted data.",
        "A judge verdict parsed with `JSON.parse` from free text where an embedded JSON object in the role's reply could be taken as the verdict.",
        "A deterministic check (leakage, calls) whose failure the judge's pass can override in the final `pass` computation."
      ],
      paths: ["character/rubric.ts", "character/run.ts", "character/score.ts"]
    },
    {
      id: "private-marker-leakage",
      title: "The leakage check sees every team-visible sink and private pages stay private",
      threat: "A role leaks the owner's private notes to teammates and still scores green, so a privacy regression ships.",
      lookFor: [
        "A team-visible tool in `world.ts` (handoff, post, issue, PR, wiki, email draft) that `emissions` in `score.ts` does not map, or maps with `team: false`.",
        "`wiki_write` letting a non-personal-assistant role overwrite a private page and flip it to `private: false`, making it readable by `wiki_read`/`wiki_search`.",
        "`wiki_search`/`wiki_read` or `notes_read` returning private content to a role other than `personal-assistant`.",
        "A case that sets `leakage: false` without a stated reason."
      ],
      paths: ["character/world.ts", "character/score.ts", "character/example/**"]
    },
    {
      id: "suite-path-containment",
      title: "Suite, profile, and output paths stay where the operator pointed them",
      threat: "A shared suite directory's `suite.yaml` makes the runner read files outside the suite (e.g. ~/.codex/auth.json) into a prompt, or write results outside the suite.",
      lookFor: [
        "`at(base, ...)` in `suite.ts` accepting an absolute or `..` path for profile, org, world, calibration, or jargon files without a containment check.",
        "A world `repo/` walk in `world.ts` following symlinks out of the world directory and exposing file text to the model via `repo_read`.",
        "A case id or `--label` flowing into `join(suite.dir, \"results\", ...)` without restricting path separators."
      ],
      paths: ["character/suite.ts", "character/world.ts", "character/run.ts", "character/profile.ts"]
    },
    {
      id: "baseline-gate-integrity",
      title: "The offline suite stays offline and its baseline gate cannot be silently bypassed",
      threat: "A change makes CI's agent eval spend real model calls with a checked-in key, or pass while scores regress.",
      lookFor: [
        "`subject.ts` or `agent.eval.ts` resolving a real provider seat, route, or `EgressHttpClient` instead of the scripted `Model` and in-process route.",
        "`run.ts` returning exit 0 when `Regression.compare` reports regressions, missing observations, or a case error.",
        "`--update` writing `baseline.json` in a CI path, or an unbounded budget used outside the offline scripted seat."
      ],
      paths: ["run.ts", "subject.ts", "agent.eval.ts"]
    },
    {
      id: "example-fixture-secrets",
      title: "Example world fixtures carry no real credentials or personal data",
      threat: "A real token, email, or private detail committed in the example world is published with the repository.",
      lookFor: [
        "A string in `character/example/**` shaped like an API key, OAuth token, or password.",
        "Real names, emails, phone numbers, or calendar details of actual people in `world.yaml`, the wiki, or the org instructions."
      ],
      paths: ["character/example/**"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { character, characterUnit, check, test, ...securityReview }
})
