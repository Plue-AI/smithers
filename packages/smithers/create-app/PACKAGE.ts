import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets, plus the templates' own suites.
 *
 * The package had none, so none of its gates ran in CI: the workflow runs
 * `smithers-build ci '//packages/...'` and never `pnpm -r test`, and a gate
 * becomes a target in the package that owns it before CI can run it. Its
 * router is the code that decides what a scaffolded app routes, so a silent
 * regression there is a wrong route table in every app cut from this checkout.
 *
 * `cwd` anchors every emitted tool run in this package directory. There is no
 * documentation-generation target: the prose in `docs/` is written by hand and
 * published to create-app.smithers.sh by `apps/docs/create-app`, whose
 * `contentSync` target reads the `docsFiles` filegroup below. Nothing in that
 * pipeline reads the source, so `test/docsParity.test.ts` is what holds the
 * reference page to the export map, the bin's flags, and the pages that
 * exist.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/create-app"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

/**
 * The shipped templates' own suites.
 *
 * A template is a whole app rather than a source tree of this package, so its
 * tests are not in `test/**` and `vitest.config.ts` does not include them. That
 * put every test for the scaffolded Worker's credential check, body cap,
 * session-id rule, settle-once stream wrapper and turn cancellation outside
 * every gate. `vitest.template.config.ts` runs them from this package against
 * workspace sources, and its docstring records what that resolves and what it
 * cannot: the templates' `tsc --noEmit` needs an install and stays a scaffolded
 * app's `pnpm typecheck`.
 *
 * The declared sources are what the suites actually import — the template
 * trees plus this package's `src` behind the `@smthrs/create-app/*` aliases —
 * so an edit to either re-runs the target rather than reporting a cache hit.
 *
 * @since 0.1.0
 * @category test
 */
const templates = Smithers.Vitest({
  tests: [Smithers.glob("template/*/test/**/*.test.ts")],
  sources: [
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/support/**/*.ts"),
    Smithers.glob("template/**/*.ts"),
    Smithers.glob("template/**/*.tsx"),
    Smithers.glob("template/**/*.json")
  ],
  deps: [],
  config: Smithers.file("vitest.template.config.ts"),
  environment: "node",
  // The thresholds in `vitest.config.ts` are measured over `src/**` by the
  // package's own suite. This run's subject is the templates, so it computes
  // no coverage rather than reporting a second, lower number for the same
  // files.
  coverage: false,
  passWithNoTests: false,
  cwd
})

/**
 * Security review of the code this package ships into every scaffolded app.
 *
 * `template/aomi` and `template/default` have their own PACKAGE.ts and
 * reviewer, so `include` stops at this package's own sources, bin, and docs.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "bin/**", "docs/**", "README.md"],
  checks: [
    {
      id: "turn-endpoint-admission",
      title: "The public turn and flow-run handlers refuse oversized, unauthenticated, or malformed requests before spending model calls",
      threat: "An anonymous internet caller posts to a scaffolded Worker's /api/turn and runs paid model turns on the app owner's provider keys.",
      lookFor: [
        "turnResponse or runTurn reading request.json() with no byte cap on the body before Schema decode.",
        "turnResponse doing no caller authentication itself while docs/api.md presents it as the complete handler to mount.",
        "A request-supplied flow id reaching a pipeline or non-chat route through runTurn instead of the flow_not_chat refusal.",
        "runFlow executing a pipeline flow for an unauthenticated caller, or reaching a chat route instead of flow_not_pipeline."
      ],
      paths: ["src/worker.ts", "docs/api.md"]
    },
    {
      id: "turn-error-disclosure",
      title: "Turn refusals and error frames carry no provider bodies, keys, stack text, or internal paths",
      threat: "Any turn caller reads provider error text, internal layer messages, or configuration detail about the app owner's deployment from the NDJSON stream.",
      lookFor: [
        "messageOf(cause) forwarding a raw provider or interpreter error message into an error frame or a host_unconfigured body.",
        "A seatsFromEnv refusal message that interpolates the key value rather than the binding name.",
        "A call frame copying tool input or an outcome message that includes a secret a TOOLS.ts source returned."
      ],
      paths: ["src/worker.ts", "src/runtime.ts"]
    },
    {
      id: "seat-credential-routing",
      title: "Provider keys from env are sent only to their own provider's fixed endpoint",
      threat: "An app author or seat id string causes the Worker to send ANTHROPIC_API_KEY or OPENAI_API_KEY to a host other than that provider.",
      lookFor: [
        "seatsFromEnv choosing a provider or base URL from any part of the seat id after the prefix.",
        "A key read from env without Redacted.make, or a Redacted key unwrapped into a log, frame, or error.",
        "A provider entry whose route builder accepts a caller-controlled base URL."
      ],
      paths: ["src/worker.ts"]
    },
    {
      id: "capability-envelope",
      title: "Every routed flow runs under exactly the TOOLS.ts grant, empty by default, and bounded limits",
      threat: "A prompt-injected model in one turn calls tool flows or capabilities the app author never granted, or spends unbounded model budget on the owner's account.",
      lookFor: [
        "layerFor passing a capabilityEnvelope other than tools.grant mapped through patternOf, or a default that is not the empty envelope.",
        "patternOf accepting an action outside Capability.PatternAction or a resource longer than Capability.maxResourceLength.",
        "Budget.layerUnbounded combined with no call, frame, or wall-clock limit reachable from AGENT.ts and SANDBOX.ts.",
        "The host tools override in runTurn replacing route.tools with a ToolsSpec whose grant is wider than the route's."
      ],
      paths: ["src/runtime.ts", "src/worker.ts", "src/app.ts"]
    },
    {
      id: "generated-route-injection",
      title: "File names in an app tree cannot inject code into routes.gen.ts or routes.ui.gen.ts",
      threat: "A contributor or checked-in dependency adds a file whose path breaks out of a generated import literal and runs code in the app's Worker and browser bundles.",
      lookFor: [
        "Any render or renderUi line interpolating a file path, route, pane name, or flow id without JSON.stringify.",
        "A page, pane, or flow segment reaching the output without passing isRouteSegment.",
        "walk following a symbolic link or leaving the resolved root, or resolveLayer returning a layer file outside the root."
      ],
      paths: ["src/router.ts", "src/app.ts"]
    },
    {
      id: "route-table-writes",
      title: "Route regeneration writes only the two tables and their .tmp staging files under the app root",
      threat: "A crafted --root, --app, or dirs value makes smithers-routes or the Vite plugin overwrite files outside the developer's app directory.",
      lookFor: [
        "writeRoutes or publishTables writing a path not derived from resolve(options.root, 'routes.gen.ts' | 'routes.ui.gen.ts').",
        "A pre-existing symlinked routes.gen.ts.tmp being followed by writeFileSync.",
        "runRoutesBin passing a flag value through without the empty-value and missing-value refusals."
      ],
      paths: ["src/router.ts", "src/routesBin.ts", "bin/routes.mjs", "src/vite.ts"]
    },
    {
      id: "brand-css-injection",
      title: "Brand tokens and Google Fonts families cannot inject CSS rules or load unexpected origins",
      threat: "A brand value copied from an untrusted theme adds arbitrary CSS or an @import from an attacker origin to every page of the app.",
      lookFor: [
        "brandCss writing a token or font value containing ';', '}', or newline verbatim into the rule.",
        "A googleFonts family interpolated into the @import url without encodeURIComponent or a quote check.",
        "The manifest virtual module emitting anything other than JSON.stringify of the loaded manifest."
      ],
      paths: ["src/vite.ts"]
    },
    {
      id: "fixture-secret-capture",
      title: "Recorded model fixtures store no credentials, headers, or secrets from tool results",
      threat: "A developer running SMTHRS_RECORD=1 commits a fixture that exposes a provider key or a tool's secret output to everyone who can read the repository.",
      lookFor: [
        "recordModel or toRequestLike copying request headers, the Redacted key, or the prepared request into a RecordedCall.",
        "Tool-result content or ModelError messages written to the fixture without any redaction while docs tell users to commit it.",
        "The staging file path.recording left behind on a failed recording."
      ],
      paths: ["src/testing.ts", "docs/**"]
    },
    {
      id: "deploy-target-secrets",
      title: "CreateApp's deploy target keeps Cloudflare credentials scoped and approval-gated",
      threat: "A build step or dev server exfiltrates the app owner's Cloudflare API token, or deploys without the owner's approval.",
      lookFor: [
        "deploy losing approval: 'required' or its gate on build.",
        "An HttpSecret whose allowed origins include anything but https://api.cloudflare.com.",
        "dev or build receiving the Cloudflare secrets, or dev running with network and access to secrets."
      ],
      paths: ["src/package.ts"]
    },
    {
      id: "manifest-eval-scope",
      title: "loadManifest evaluates only the app root's own PACKAGE.ts",
      threat: "A Vite root pointed at an untrusted checkout runs arbitrary code in the developer's shell through tsx.",
      lookFor: [
        "loadManifest importing a path other than join(root, 'PACKAGE.ts').",
        "Docs recommending createApp() on a directory the developer did not author without noting PACKAGE.ts is executed."
      ],
      paths: ["src/vite.ts", "docs/**"]
    },
    {
      id: "docs-unsafe-snippets",
      title: "Copyable docs examples carry no real keys and no wildcard capability grant as a default",
      threat: "A user copies a docs snippet and ships a Worker with a hard-coded key or an all-action grant that lets injected prompts call every tool.",
      lookFor: [
        "A string shaped like a provider key or Cloudflare token in docs/*.md.",
        "An example TOOLS.ts using [{ action: \"*\", resource: \"*\" }] without the trusted-local-use caveat."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, templates, test, ...securityReview }
})
