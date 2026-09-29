/**
 * Targets for the Smithers authoring fine-tune.
 *
 * The deterministic work is graph-owned and cache-eligible: `test` gates the
 * SFT dataset on a program whose exit code is the verdict, and `check`
 * typechecks the validator. Both run from this directory, which is a workspace
 * member (`@smthrs/eval-authoring`), so `bun` and `tsc` read the toolchain the
 * manifest pins.
 *
 * The Fireworks operations are irreversible side effects with no file output,
 * so they are `ToolRun` targets: never cached, gated to the `run` verb, and
 * never pulled into a `ci` graph. Each reads its credential from the
 * `FIREWORKS_API_KEY` secret, never from a literal, so no key enters the plan.
 * Run one explicitly, for example:
 *
 *   pnpm exec smithers-build run '//evals/authoring:sftLaunch'
 *
 * There is no `lint` or `fmt` target: `data/pilot-sft.jsonl` is the training
 * corpus, one JSON object per line, and a formatter would rewrite it.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "evals/authoring"

/** The Fireworks API token, read from the environment at execution time. */
const fireworksKey = Smithers.Secret("FIREWORKS_API_KEY")
const fireworksCredential = Smithers.HttpSecret(fireworksKey, ["https://api.fireworks.ai"])

/** The validator and the dataset it gates. */
const validator = Smithers.file("//evals/authoring/validate.ts")
const validatorTests = Smithers.file("//evals/authoring/validate.test.ts")
const dataset = Smithers.file("//evals/authoring/data/pilot-sft.jsonl")
const workspaceManifests = [
  Smithers.file("//package.json"),
  Smithers.glob("//packages/**/package.json"),
  Smithers.glob("//apps/**/package.json"),
  Smithers.glob("//evals/**/package.json"),
  Smithers.file("//examples/package.json"),
  Smithers.file("//flows/package.json")
]

/**
 * Proves every row of the SFT dataset is a well-formed chat example before it
 * is uploaded or trained on. Offline and deterministic: it reads only the
 * committed dataset and workspace package manifests, so its verdict is
 * reproducible and it belongs in `ci`.
 *
 * @since 0.1.0
 * @category test
 */
const test = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.entrypoint(validator),
  srcs: [validator, dataset, ...workspaceManifests],
  deps: [],
  cwd
})

/**
 * Proves the validator rejects the rows it must: non-object rows and messages,
 * top-level metadata, rows with no user turn, host paths, and credential
 * shapes.
 *
 * @since 0.1.0
 * @category test
 */
const validatorTest = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testRunner([validatorTests]),
  srcs: [validator, validatorTests, dataset, ...workspaceManifests],
  deps: [],
  cwd
})

/**
 * Checks the validator and its tests against their tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: [validator, validatorTests],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * Uploads the SFT dataset to Fireworks. Irreversible: a second run fails
 * because the dataset name already exists, so it is gated to the `run` verb and
 * never cached. It depends on {@link test}, so a malformed dataset
 * never reaches the account.
 *
 * @since 0.1.0
 * @category run
 */
const datasetUpload = Smithers.ToolRun({
  command: "firectl",
  args: ["dataset", "create", "pilot-sft-v0", "data/pilot-sft.jsonl"],
  inputs: [dataset],
  deps: [test],
  secrets: [fireworksCredential],
  cwd
})

/**
 * Launches the supervised fine-tuning job on Kimi K3. Irreversible: every run
 * starts a new billed job, so it is gated to the `run` verb and never cached.
 *
 * @since 0.1.0
 * @category run
 */
const sftLaunch = Smithers.ToolRun({
  command: "firectl",
  args: [
    "supervised-fine-tuning-job",
    "create",
    "--base-model",
    "accounts/fireworks/models/kimi-k3",
    "--dataset",
    "pilot-sft-v0",
    "--output-model",
    "smithers-authoring-pilot-v0",
    "--lora-rank",
    "8",
    "--epochs",
    "3",
    "--display-name",
    "smithers-authoring pilot v0"
  ],
  inputs: [],
  deps: [],
  secrets: [fireworksCredential],
  cwd
})

/**
 * Plumbing-proof variant of {@link sftLaunch} on a small base model.
 *
 * Kimi K3 (2.8T) needs 32 GPUs of fine-tuning quota; the pilot account tier
 * allows 16. This target trains the same dataset on Llama 3.1 8B, which fits
 * that quota, so it validates the whole dataset to checkpoint path for cents
 * without a tier upgrade. Swap back to {@link sftLaunch} for the real run.
 *
 * @since 0.1.0
 * @category run
 */
const sftLaunchPilot = Smithers.ToolRun({
  command: "firectl",
  args: [
    "supervised-fine-tuning-job",
    "create",
    "--base-model",
    "accounts/fireworks/models/llama-v3p1-8b-instruct",
    "--dataset",
    "pilot-sft-v0",
    "--output-model",
    "smithers-authoring-pilot-llama8b-v0",
    "--lora-rank",
    "8",
    "--epochs",
    "3",
    "--display-name",
    "smithers-authoring pilot llama8b v0"
  ],
  inputs: [],
  deps: [],
  secrets: [fireworksCredential],
  cwd
})

/**
 * Security review of the fine-tune assets. `security` reviews the diff against
 * `origin/main`; `securityAudit` audits every reviewed file.
 *
 * @since 0.1.0
 * @category test
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["validate.ts", "validate.test.ts", "PACKAGE.ts", "README.md", "data/**"],
  checks: [
    {
      id: "fireworks-key-scoping",
      title: "The Fireworks key reaches only firectl targets and only api.fireworks.ai",
      threat: "Anyone reading the plan, logs, or a new target exfiltrates the owner's billed Fireworks API key.",
      lookFor: [
        "A FIREWORKS_API_KEY or fw_ literal in PACKAGE.ts, README.md, or data/ instead of Smithers.Secret.",
        "Smithers.HttpSecret allowlisting any origin other than https://api.fireworks.ai.",
        "fireworksCredential passed to a target other than a firectl ToolRun, or to a cached or ci-reachable target."
      ],
      paths: ["PACKAGE.ts", "README.md"]
    },
    {
      id: "irreversible-ops-gated",
      title: "Billed Fireworks operations run only from the run verb and after the validator",
      threat: "A CI run or agent triggers billed fine-tuning jobs or uploads an unvalidated dataset to the owner's Fireworks account.",
      lookFor: [
        "A firectl upload or fine-tuning target declared with something other than Smithers.ToolRun, making it cacheable or ci-reachable.",
        "datasetUpload losing its deps on test, so an invalid dataset ships.",
        "A target wired into Package targets that runs firectl on commit or in ci."
      ],
      paths: ["PACKAGE.ts"]
    },
    {
      id: "training-data-leak",
      title: "The SFT corpus carries no secrets, private paths, or private code",
      threat: "Fireworks, or anyone with access to the trained model, extracts credentials, home paths, or private repository code the owner uploaded as training data.",
      lookFor: [
        "An API key, token, cookie, or password string inside any message content in data/pilot-sft.jsonl.",
        "Absolute host paths such as /Users/<name> or internal hostnames in message content or in top-level row metadata such as source_path.",
        "Top-level row fields besides messages (role, source_path) that firectl uploads alongside the training examples.",
        "Code copied from private repositories (plue, deployment repo) rather than public Smithers sources."
      ],
      paths: ["data/**"]
    },
    {
      id: "training-data-poisoning",
      title: "Assistant turns teach safe flow authoring, and the validator rejects rows it cannot prove",
      threat: "A contributor who edits the dataset trains the authoring model to emit flows that run unsandboxed shell, disable approvals, or leak secrets for every downstream user.",
      lookFor: [
        "An assistant message whose code runs shell with request-derived strings, bypasses approvals, or reads secrets into prompts.",
        "Instruction-like text in system or user turns that tells the model to ignore safety controls.",
        "validate.ts accepting rows it should reject: extra top-level keys, a message with extra keys, or no user turn before the final assistant turn.",
        "validate.ts exiting 0 on an input it failed to read or parse, so the datasetUpload gate passes an unchecked file."
      ],
      paths: ["data/**", "validate.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, datasetUpload, sftLaunch, sftLaunchPilot, test, validatorTest, ...securityReview }
})
