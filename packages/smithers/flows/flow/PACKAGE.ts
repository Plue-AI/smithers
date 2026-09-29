/**
 * Standard package targets, written as `BuildAndCheckTypeScriptPackage` desugared into its
 * six target calls.
 *
 * These targets are executable and must stay equivalent to what
 * `BuildAndCheckTypeScriptPackage({ cwd: "packages/smithers/flows/flow", deps: [plan, crypto, keys, canonical, capability] })`
 * emits; the file exists to show the expansion, not to diverge from it.
 */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle, rootInvariantsConfig, rootJSDocConfig } from "../../../../PACKAGE.ts"
import { Package as canonicalPackage } from "../canonical/PACKAGE.ts"
import { Package as capabilityPackage } from "../capability/PACKAGE.ts"
import { Package as cryptoPackage } from "../crypto/PACKAGE.ts"
import { Package as keysPackage } from "../keys/PACKAGE.ts"
import { Package as planPackage } from "../plan/PACKAGE.ts"

const capability = capabilityPackage.lib
const plan = planPackage.lib
const crypto = cryptoPackage.lib
const keys = keysPackage.lib
const canonical = canonicalPackage.lib

const cwd = "packages/smithers/flows/flow"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

const lib = Smithers.TsBuild({
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [plan, crypto, keys, canonical, capability],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
  format: "dual",
  outDir: "dist",
  cwd
})

const check = Smithers.Typecheck({
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib, plan, crypto, keys, canonical, capability],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib, plan, crypto, keys, canonical, capability],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = Smithers.EsLint({
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

const fmt = Smithers.Dprint({
  sources: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/**
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
const circular = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources],
  deps: [],
  cwd
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd })

// --- reference docs pipeline ----------------------------------------------
// The colocated reference page `docs/reference/flow.md` is written by an
// agent from these sources and the shared style rubric, then ingested into
// apps/site by `//apps/site:referenceIngest`. The committed page is the cache.

/** Everything the reference writer may read: sources, README, package docs. */
const docsSources = Smithers.Filegroup({
  srcs: [sources, Smithers.file("README.md"), Smithers.glob("docs/*.md")],
  cwd
})

/** The package documentation as a file group, the `docsFiles` target `BuildAndCheckTypeScriptPackage` emits. */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** The committed reference pages, as a set other packages depend on. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/*.md")], cwd })

/** Every `ts` fence in the page compiles under strict tsc. */
const referenceCodeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("docs/reference/flow.md"),
  lang: ["ts"]
})

/** Writes `docs/reference/flow.md`; run with `smithers-build target //packages/smithers/flows/flow:referenceDocs --write`. */
const referenceDocs = Smithers.Agent.Diff({
  agent: docsWriter,
  prompt: Smithers.file("//apps/site/prompts/reference-package.md"),
  data: [docsSources, referenceStyle],
  changes: ["docs/reference/flow.md"],
  gates: [referenceCodeBlocks, check],
  maxRounds: 3
})
// --- end reference docs pipeline ------------------------------------------

// --- security review -------------------------------------------------------
// `security` reviews the diff against origin/main; `securityAudit` audits every
// source file. Both share these checks; the macro appends `general`.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "deferred-token-addressing",
      title: "A completion token settles only the wait point it was minted for",
      threat:
        "A caller holding any flow's token completes another execution's approval, wait, or human task with a forged value.",
      lookFor: [
        "A completion path that builds its deferred from the caller's token without refusing a foreign flow name, execution id, or deferred name.",
        "HumanTask.answerableDeferred accepting a deferred name that HumanTask.deferred could not produce (non-canonical attempt suffix, missing WaitFor/ prefix, queue item address).",
        "WaitFor accepting a token whose flowName or executionId differs from the running instance, or accepting both token and name.",
        "TokenParsed.FromString accepting a JSON array whose members are not exactly three strings."
      ],
      paths: ["src/DurableDeferred.ts", "src/WaitFor.ts", "src/HumanTask.ts"]
    },
    {
      id: "queue-item-trust",
      title: "A DurableQueue worker completes only its own queue's deferreds with decoded items",
      threat:
        "Anyone who can write the persisted queue store settles an arbitrary execution's deferred or injects a trace parent into another tenant's spans.",
      lookFor: [
        "The worker casting item_ to a typed shape instead of decoding payload, token, traceId, and spanId through a schema.",
        "The worker completing the deferred named by item.token without checking it is this queue's DurableDeferred name.",
        "A token-invalid or handler failure that logs the full payload or token instead of a bounded excerpt."
      ],
      paths: ["src/DurableQueue.ts"]
    },
    {
      id: "human-answer-bounds",
      title: "Human answers and question schemas are bounded before durable storage",
      threat:
        "The person answering a task, or a flow author, exhausts the host's memory, CPU, or journal with an oversized or deeply nested answer or schema.",
      lookFor: [
        "An answer recorded or validated before maxAnswerBytes, maxAnswerDepth, maxAnswerNodes, or maxJsonMembers is enforced.",
        "A JSON Schema walk that recurses without the maxSchemaDepth or maxSchemaNodes bound, or follows $ref.",
        "A rejection reason retained longer than maxRetainedRejectionChars or echoing the whole answer."
      ],
      paths: ["src/HumanTask.ts", "src/internal/JsonSchemaSubset.ts", "src/internal/BoundedJson.ts"]
    },
    {
      id: "execution-identity-collision",
      title: "Derived execution and step identities cannot collide across callers or payloads",
      threat:
        "A payload author makes a re-driven parent land on another invocation's child execution and read or overwrite its recorded result.",
      lookFor: [
        "childExecutionId or a step key built by string concatenation instead of a canonical tuple digest.",
        "A digest input that omits the callee tag, node id, parent execution id, or canonical payload.",
        "A structural node id or placeholder that enters a hashed value non-canonically (key order, undefined vs missing)."
      ],
      paths: ["src/Interpreter.ts", "src/Graph.ts"]
    },
    {
      id: "recorded-content-reuse",
      title: "Recorded results are reused only under a matching implementation version and decoded schema",
      threat:
        "A code change or a tampered journal row replays a stale or forged action result into a later execution as if it were computed now.",
      lookFor: [
        "A sealed action with an idempotency key dispatched without the implementationVersion refusal in Interpreter.ts.",
        "A replayed or cached value handed to downstream nodes without decoding through the action's success schema.",
        "A replaying registration path (layerWithImplementations or its callers) that defaults callbackIdentity to \"process-local\" instead of \"stable\"."
      ],
      paths: ["src/Interpreter.ts", "src/Graph.ts", "src/Action/Implementations.ts"]
    },
    {
      id: "graph-payload-bounds",
      title: "Graph building and plan paging refuse cyclic, deep, or oversized payloads",
      threat:
        "A flow payload supplied by a trigger or caller hangs or crashes the host that builds and hashes the plan.",
      lookFor: [
        "A payload walk without the maximumPayloadDepth or cycle check before hashing.",
        "A comparison or placement loop that is not capped by maxComparisonPairs, maxPlacementDepth, or maxPlacementMembers.",
        "A node record larger than maximumPageBytes written to the journal instead of refused."
      ],
      paths: ["src/Graph.ts", "src/Interpreter.ts"]
    },
    {
      id: "wait-and-retry-bounds",
      title: "Sleeps, polls, retries, and stalls reject non-finite or unbounded schedules",
      threat:
        "A payload or author-supplied duration parks a run forever, busy-loops a worker, or wakes it immediately past its deadline.",
      lookFor: [
        "A duration or deadline accepted when NaN, Infinity, or negative in Sleep, Poll, Stall, or DurableClock.",
        "A retry or poll loop whose attempt budget is not a safe integer of at least one, or whose backoff overflows to Infinity.",
        "A worker loop that retries a failing store take without a pause."
      ],
      paths: [
        "src/Sleep.ts",
        "src/Poll.ts",
        "src/RetryPolicy.ts",
        "src/Stall.ts",
        "src/DurableClock.ts",
        "src/DurableQueue.ts"
      ]
    },
    {
      id: "file-boundary-confinement",
      title: "Declared read, write, and remove paths stay workspace-relative",
      threat:
        "A payload author makes replay delete or overwrite files outside the workspace through an absolute or upward path in a payload-derived file boundary.",
      lookFor: [
        "A fileBoundary produced from the payload (make.ts toLayer path) reaching the action without FileBoundary.make decoding it.",
        "A readSet, writeSet, or removes entry typed as a plain string instead of FileSet.Pattern, Glob, or Entry.",
        "The disjointWritesAndRemoves filter bypassed by constructing the boundary without the schema."
      ],
      paths: ["src/Action/FileBoundary.ts", "src/Action/FileInput.ts", "src/Action/make.ts"]
    }
  ]
})
// --- end security review ---------------------------------------------------

export const Package = Smithers.Package({
  targets: {
    bunTest,
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    docsSources,
    referenceCodeBlocks,
    referenceDocs,
    referencePages,
    ...securityReview
  }
})
