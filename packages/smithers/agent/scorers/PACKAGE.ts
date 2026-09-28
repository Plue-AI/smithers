import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/agent/scorers"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/scorers",
  include: ["src/**"],
  checks: [
    {
      id: "score-store-parameterized-sql",
      title: "Every score store query binds caller values as parameters",
      threat: "A flow that controls a step key, scorer key, or page option injects SQL into the shared run database.",
      lookFor: [
        "A sql template in SqlScoreStore.ts that splices a caller string through sql.unsafe, sql.literal, or string concatenation.",
        "A page limit, offset, before, or prune cutoff that reaches LIMIT, OFFSET, or DELETE without the safe-integer validation."
      ],
      paths: ["src/SqlScoreStore.ts", "src/Migrations.ts", "src/migrations/**"]
    },
    {
      id: "observation-redaction",
      title: "Every persisted observation reason and metadata passes redaction before the insert",
      threat:
        "A scorer that echoes a model output or error cause writes an API key or token into the durable score table readable by anyone with the run database.",
      lookFor: [
        "An insert path in SqlScoreStore.ts (record, recordOnce) that stores reason or metadata_json without redactReason or Redaction.redactJsonString.",
        "Runner.inconclusive or RunnerLive building a reason from an error cause that bypasses the store's redaction path.",
        "The byte bound measured before redaction so a scrub-grown payload is stored past maxMetadataBytes."
      ],
      paths: ["src/SqlScoreStore.ts", "src/Runner.ts", "src/RunnerLive.ts", "src/internal/**"]
    },
    {
      id: "judge-prompt-injection",
      title: "Judged output and context cannot rewrite the rubric instructions or forge the verdict",
      threat:
        "An agent whose output is being scored embeds instructions or a fake JSON verdict that makes the judge pass a failing run and opens a quality gate.",
      lookFor: [
        "A caller-controlled field (context, focus, output, example transcript) placed into the system or prompt text outside the backtick fence from fenced().",
        "fenced() choosing a fence the text can close, for example backticks counted per line rather than per longest run.",
        "parse() taking the first JSON object in the reply so a judge that quotes the output reads the quoted scores instead of its own."
      ],
      paths: ["src/Rubric.ts"]
    },
    {
      id: "caller-regex-redos",
      title: "Caller-supplied check patterns cannot hang the scoring process",
      threat:
        "A check author or a flow payload supplies a catastrophic regex that blocks the event loop and stalls every scorer in the run.",
      lookFor: [
        "phrase() compiling a /.../ entry with new RegExp and matching it against unbounded model output.",
        "linkedReferences compiling ref.pattern with new RegExp on every call without a length or timeout bound."
      ],
      paths: ["src/Checks.ts"]
    },
    {
      id: "leakage-check-fidelity",
      title: "The leakage check fails whenever a marker appears in any sink and does not republish the marker",
      threat:
        "An agent leaks a canary secret into a public sink and the leakage check passes, or the failing check copies the secret into a stored reason.",
      lookFor: [
        "Word-boundary lookarounds in phrase() that miss a marker embedded inside a longer token.",
        "leakage() quoting the full marker text in its failure detail, which flows into a persisted reason."
      ],
      paths: ["src/Checks.ts"]
    },
    {
      id: "gate-fails-closed",
      title: "Score gates never report a pass for invalid, missing, or unstated failures",
      threat:
        "A broken or adversarial scorer returns NaN, out-of-range, or empty results and the CI gate exits 0, shipping an unscored change.",
      lookFor: [
        "A path in ScoreGate.ts where a NaN, Infinity, or out-of-range score or threshold reaches the comparison without validateSamples or validateThreshold.",
        "combine or grade mapping a Failed or Inconclusive verdict to exit code 0.",
        "Rubric.decide or Scorer.validate accepting an empty score set or a non-finite score as a pass."
      ],
      paths: ["src/ScoreGate.ts", "src/Rubric.ts", "src/Scorer.ts"]
    },
    {
      id: "scorer-identity-integrity",
      title: "Scorer keys and job identities are content-derived and cannot collide",
      threat:
        "A changed scorer config or a crafted job identity reuses another scorer's key, so recordOnce drops a real observation as a duplicate or sampling skips it.",
      lookFor: [
        "scorerKey derived from anything other than Digest over the canonical id, version, and config.",
        "Sampling material() or job identity built by joining parts without length prefixes, so two part lists hash to the same string."
      ],
      paths: ["src/Scorer.ts", "src/Sampling.ts", "src/Binding.ts", "src/SqlScoreStore.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
