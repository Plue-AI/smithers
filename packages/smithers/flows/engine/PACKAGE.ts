import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets plus cross-package and dependency-policy edges.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so the dependency runs first and contributes its content
 * key. `dependencyPolicy` adds the package's explicit knip check.
 */
import { Smithers } from "@smthrs/targets"
import { docsWriter, referenceStyle } from "../../../../PACKAGE.ts"
import { Package as flowPackage } from "../flow/PACKAGE.ts"

const flow = flowPackage.lib

const standard = BuildAndCheckTypeScriptPackage({ deps: [flow], cwd: "packages/smithers/flows/engine" })

const lib = standard.lib
const check = standard.check
const test = standard.test
const lint = standard.lint
const fmt = standard.fmt
const docs = standard.docs
const circular = standard.circular
const docsFiles = standard.docsFiles

const dependencyPolicy = Smithers.DepsLint({
  packageJson: Smithers.file("package.json"),
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: [
    "eslint-plugin-jsdoc",
    // scripts/build.mjs delegates to buildLibrary, which resolves esbuild from this package's manifest.
    "esbuild"
  ],
  ignoreBinaries: [],
  cwd: "packages/smithers/flows/engine"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/engine" })

// --- reference docs pipeline ----------------------------------------------
const engineCwd = "packages/smithers/flows/engine"

/** Everything the reference writer may read: sources, README, package docs. */
const docsSources = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*.ts"), Smithers.file("README.md"), Smithers.glob("docs/*.md")],
  cwd: engineCwd
})

/** The committed reference pages, as a set other packages depend on. */
const referencePages = Smithers.Filegroup({ srcs: [Smithers.glob("docs/reference/*.md")], cwd: engineCwd })

/** Every `ts` fence in the page compiles under strict tsc. */
const referenceCodeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("docs/reference/engine.md"),
  lang: ["ts"]
})

/** Writes `docs/reference/engine.md`; run with `smithers-build target //packages/smithers/flows/engine:referenceDocs --write`. */
const referenceDocs = Smithers.Agent.Diff({
  agent: docsWriter,
  prompt: Smithers.file("//apps/site/prompts/reference-package.md"),
  data: [docsSources, referenceStyle],
  changes: ["docs/reference/engine.md"],
  gates: [referenceCodeBlocks, check],
  maxRounds: 3
})
// --- end reference docs pipeline ------------------------------------------

// --- security review --------------------------------------------------------
/** `security` reviews the diff against origin/main; `securityAudit` audits every owned source file. */
const securityReview = Smithers.SecurityReview({
  cwd: engineCwd,
  include: ["src/**"],
  checks: [
    {
      id: "proxy-execution-id-scope",
      title:
        "A served execute, discard, resume, or interrupt never reaches an execution outside the caller's namespace",
      threat:
        "A remote client of a FlowProxy HTTP or RPC server joins, reads the result of, or re-drives another tenant's flow execution by guessing or reusing its execution id.",
      lookFor: [
        "A handler in FlowProxyServer.ts that passes request.executionId to flow.execute, flow.resume, or FlowRuntime.interrupt without routing it through scopeExecutionId or resumeExecutionId.",
        "resumeExecutionId falling back to the client value when a configured ExecutionIdScope returns undefined.",
        "A new operation (beyond execute, discard, resume, interrupt) added to operationAddresses or toRpcGroup that is not wired through the same scope."
      ],
      paths: ["src/FlowProxyServer.ts", "src/FlowProxy.ts"]
    },
    {
      id: "proxy-defect-redaction",
      title: "A handler defect crosses the proxy boundary only as the redacted FlowHandlerDefect",
      threat:
        "A remote caller who triggers a failing flow reads the API key, bearer token, or request headers an action's HTTP or SDK error carried.",
      lookFor: [
        "A proxy handler path that is not wrapped in guardDefects, so Schema.Defect encodes the raw defect object to the caller.",
        "A log or error message that interpolates the raw defect, cause, or payload instead of renderDiagnostic output.",
        "A secret spelling sanitizeDiagnosticText misses that a realistic HTTP client error embeds in message: `Authorization: Basic <b64>`, `cookie: session=<v>`, URL userinfo `https://user:pass@host`, and a `?key=<v>` query parameter all pass through unredacted today.",
        "A secret split across the 512-character slice boundary, or placed in a field outside diagnosticKeys that a nested cause re-exposes through message."
      ],
      paths: [
        "src/FlowProxyServer.ts",
        "src/internal/Diagnostic.ts",
        "src/FlowEngine/make.ts",
        "src/FlowEngine/Dispatch.ts"
      ]
    },
    {
      id: "diagnostic-renderer-safety",
      title: "renderDiagnostic never runs caller code and stays bounded on hostile values",
      threat:
        "A flow implementation or remote payload that raises a crafted error object hangs, floods, or executes code in the server process when the engine renders it.",
      lookFor: [
        "A property read in projectDiagnostic that uses normal access (value[key], toString, JSON.stringify of the raw object) instead of Object.getOwnPropertyDescriptor data values.",
        "A depth, array length, or output length bound that is removed or applied after unbounded work.",
        "A redaction regex applied before slicing to diagnosticTextLimit or with catastrophic backtracking on long input."
      ],
      paths: ["src/internal/Diagnostic.ts"]
    },
    {
      id: "execution-id-reuse-identity",
      title: "A reused execution id joins only the same flow, payload, and lineage",
      threat:
        "A caller reusing another run's execution id with a different flow or payload receives that run's settled result or corrupts its journal.",
      lookFor: [
        "An execute or deferredDone path in layerMemory.ts that joins an existing execution without comparing flow tag, samePayload, round, and parent.",
        "An ExecutionIdentityConflict whose message or expected/actual fields echo the recorded payload instead of a fixed description.",
        "poll returning a settlement recorded under a different flow declaration instead of Option.none."
      ],
      paths: [
        "src/FlowEngine/layerMemory.ts",
        "src/FlowEngine/make.ts",
        "src/FlowEngine/Round.ts",
        "src/FlowEngine/Trampoline.ts"
      ]
    },
    {
      id: "action-key-collision",
      title: "Distinct actions, schemas, runs, and boundaries never derive the same persisted action key",
      threat:
        "A flow author or caller-owned idempotency object makes one action replay another action's recorded outcome, including a charge or irreversible side effect.",
      lookFor: [
        "A key input in actionKey or ordinalScope that concatenates strings without length framing or a form tag, so two different inputs encode identically.",
        "A cache-kind key that omits the environment, declaration digest, boundary digest, implementationVersion, or nondeterministic flag it is documented to include.",
        "A WeakMap cache in ActionKey.ts that returns a digest for mutated metadata without re-checking the JSON snapshot."
      ],
      paths: ["src/FlowEngine/ActionKey.ts", "src/FlowEngine/Dispatch.ts"]
    },
    {
      id: "replay-decode-before-trust",
      title: "Recorded outcomes from a durable store are schema-decoded before a flow consumes them",
      threat:
        "Anyone able to write the durable store injects a forged action or deferred result that the flow trusts as a real completion.",
      lookFor: [
        "An actionExecute or deferredResult value returned to the body without decoding through exitSchemaPartial or the deferred exitSchema.",
        "A deferredDoneIfWaiting path that completes a deferred without passing through the waiting token check.",
        "An irreversible-tier action re-dispatched on retry without an idempotency key or journal hit check."
      ],
      paths: [
        "src/FlowEngine/make.ts",
        "src/FlowEngine/Dispatch.ts",
        "src/FlowEngine/Encoded.ts",
        "src/FlowEngine/SnapshotBoundary.ts"
      ]
    },
    {
      id: "proxy-http-route-encoding",
      title: "Generated HTTP routes are unambiguous and injective in the flow tag",
      threat:
        "A flow tag containing slashes, percent escapes, or lone surrogates routes a request to a different flow's handler.",
      lookFor: [
        "tagToPath emitting any character outside the hex-encoded single segment, or accepting ill-formed UTF-16 without InvalidFlowTag.",
        "assertNoCollisions skipped for a prefix or group that toHttpApiGroup or layerRpcHandlers builds.",
        "ExecutionId schema bounds (1..4096, well-formed UTF-16) loosened or bypassed for a payload."
      ],
      paths: ["src/FlowProxy.ts", "src/internal/Utf16.ts"]
    }
  ]
})
// --- end security review ----------------------------------------------------

export const Package = Smithers.Package({
  targets: {
    bunTest,
    check,
    circular,
    dependencyPolicy,
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
